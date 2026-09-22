import { describe, expect, test } from "bun:test";
import type { CheckpointManifest } from "@agent-platform/runtime-core";

import {
  CLAUDE_RUNTIME_FINGERPRINT,
  claudeCheckpointCodec,
  claudeProfileFingerprint,
  decodeCheckpointManifest,
  encodeCheckpointManifest,
  validateCompatibility,
} from "./checkpoint-codec.ts";
import type { ClaudeRuntimeConfig } from "./config.ts";

const profileSha256 = "a".repeat(64);
const runtime = { ...CLAUDE_RUNTIME_FINGERPRINT, profileSha256 };

function revision(key: string) {
  return {
    entryCount: 1,
    parts: [{ key, sha256: "b".repeat(64) }],
    sha256: "c".repeat(64),
  };
}

function manifest(
  overrides: Partial<CheckpointManifest> = {},
): CheckpointManifest {
  return {
    createdAt: "2026-09-22T00:00:00.000Z",
    cwd: "/workspace",
    engine: "claude",
    resume: "sdk-session-1",
    revision: 3,
    runtime,
    sessionId: "session-1",
    transcripts: {
      root: revision("root/part-1.jsonl"),
      subagents: { "agents/reviewer": revision("sub/part-1.jsonl") },
    },
    version: 1,
    workspace: { gitCommit: "0".repeat(40), untracked: [] },
    ...overrides,
  };
}

const config: Pick<
  ClaudeRuntimeConfig,
  | "appendSystemPrompt"
  | "mcpServers"
  | "model"
  | "permissionMode"
  | "plugins"
  | "profile"
  | "settingSources"
  | "tools"
> = {
  model: "claude-sonnet-4-5",
  profile: {
    kind: "anthropic",
    endpoint: "https://api.anthropic.test",
    auth: { kind: "api_key", value: "secret-one" },
  },
  tools: ["Bash", "Read"],
};

describe("Claude checkpoint codec", () => {
  test("round-trips a manifest", () => {
    const original = manifest();

    const { bytes } = encodeCheckpointManifest(original);

    expect(decodeCheckpointManifest(bytes)).toEqual(original);
  });

  test("encodes the same manifest to the same bytes whatever the key order", () => {
    const ordered = manifest();
    const shuffled = Object.fromEntries(
      Object.entries(ordered).reverse(),
    ) as CheckpointManifest;

    expect(encodeCheckpointManifest(shuffled)).toEqual(
      encodeCheckpointManifest(ordered),
    );
  });

  test("the reported digest is the digest of the encoded bytes", async () => {
    const { bytes, sha256 } = encodeCheckpointManifest(manifest());

    expect(new Bun.CryptoHasher("sha256").update(bytes).digest("hex")).toBe(
      sha256,
    );
  });

  test("refuses bytes that are not a manifest", () => {
    expect(() =>
      decodeCheckpointManifest(new TextEncoder().encode("not json")),
    ).toThrow(/not JSON/);
  });

  test("refuses a manifest carrying a field this build does not know", () => {
    const { bytes } = encodeCheckpointManifest(manifest());
    const extended = {
      ...JSON.parse(new TextDecoder().decode(bytes)),
      futureField: 1,
    };

    expect(() =>
      decodeCheckpointManifest(
        new TextEncoder().encode(JSON.stringify(extended)),
      ),
    ).toThrow(/Invalid Claude checkpoint manifest/);
  });

  test("refuses a manifest whose workspace commit is not a full sha", () => {
    expect(() =>
      encodeCheckpointManifest(
        manifest({ workspace: { gitCommit: "abc1234", untracked: [] } }),
      ),
    ).toThrow();
  });

  test("accepts a manifest written by the same runtime", () => {
    expect(validateCompatibility(manifest(), runtime)).toEqual({
      status: "compatible",
    });
  });

  test("reports every version and profile field that moved", () => {
    const stale = manifest({
      runtime: {
        cliVersion: "2.0.0",
        engine: "claude",
        profileSha256: "d".repeat(64),
        sdkVersion: "0.3.100",
      },
    });

    expect(validateCompatibility(stale, runtime)).toEqual({
      status: "incompatible",
      mismatches: [
        { expected: runtime.sdkVersion, field: "sdkVersion", found: "0.3.100" },
        { expected: runtime.cliVersion, field: "cliVersion", found: "2.0.0" },
        {
          expected: profileSha256,
          field: "profileSha256",
          found: "d".repeat(64),
        },
      ],
    });
  });

  test("the codec exposes the engine it decodes", () => {
    expect(claudeCheckpointCodec.engine).toBe("claude");
    expect(
      claudeCheckpointCodec.decode(encodeCheckpointManifest(manifest()).bytes),
    ).toEqual(manifest());
  });
});

describe("Claude profile fingerprint", () => {
  test("ignores a rotated credential", () => {
    const rotated = {
      ...config,
      profile: {
        ...config.profile,
        auth: { kind: "api_key" as const, value: "secret-two" },
      },
    };

    expect(claudeProfileFingerprint(rotated)).toBe(
      claudeProfileFingerprint(config),
    );
  });

  test("ignores the order tools were listed in", () => {
    expect(
      claudeProfileFingerprint({ ...config, tools: ["Read", "Bash"] }),
    ).toBe(claudeProfileFingerprint(config));
  });

  test("changes when the endpoint changes", () => {
    expect(
      claudeProfileFingerprint({
        ...config,
        profile: { ...config.profile, endpoint: "https://other.test" },
      }),
    ).not.toBe(claudeProfileFingerprint(config));
  });

  test("changes when the tool allowlist changes", () => {
    expect(claudeProfileFingerprint({ ...config, tools: ["Bash"] })).not.toBe(
      claudeProfileFingerprint(config),
    );
  });

  test("changes when the appended system prompt changes", () => {
    expect(
      claudeProfileFingerprint({ ...config, appendSystemPrompt: "extra" }),
    ).not.toBe(claudeProfileFingerprint(config));
  });

  test("treats an explicit default permission mode as the default", () => {
    expect(
      claudeProfileFingerprint({ ...config, permissionMode: "default" }),
    ).toBe(claudeProfileFingerprint(config));
  });
});
