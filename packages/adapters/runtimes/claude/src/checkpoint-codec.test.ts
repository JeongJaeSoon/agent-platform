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
import { digestParts } from "./transcript-digest.ts";

const profileSha256 = "a".repeat(64);
const runtime = { ...CLAUDE_RUNTIME_FINGERPRINT, profileSha256 };

function revision(key: string) {
  const parts = [{ bytes: 42, key, sha256: "b".repeat(64) }];
  return { entryCount: 1, parts, sha256: digestParts(parts) };
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
    version: 2,
    workspace: {
      bundle: {
        bytes: 1024,
        key: "sessions/s1/workspace/workspace.bundle",
        sha256: "c".repeat(64),
      },
      gitCommit: "0".repeat(40),
      untracked: [
        {
          bytes: 7,
          key: "sessions/s1/workspace/n",
          path: "notes.md",
          sha256: "b".repeat(64),
        },
      ],
    },
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

  test("refuses a manifest whose part list was edited after capture", () => {
    const { bytes } = encodeCheckpointManifest(manifest());
    const body = JSON.parse(new TextDecoder().decode(bytes));
    body.transcripts.root.parts.push({
      bytes: 1,
      key: "smuggled.jsonl",
      sha256: "d".repeat(64),
    });

    expect(() =>
      decodeCheckpointManifest(new TextEncoder().encode(JSON.stringify(body))),
    ).toThrow(/part list does not match its digest/);
  });

  test("refuses a subagent revision whose part list was edited", () => {
    const { bytes } = encodeCheckpointManifest(manifest());
    const body = JSON.parse(new TextDecoder().decode(bytes));
    body.transcripts.subagents["agents/reviewer"].parts = [];

    expect(() =>
      decodeCheckpointManifest(new TextEncoder().encode(JSON.stringify(body))),
    ).toThrow(/Invalid Claude checkpoint manifest/);
  });

  test("refuses a version 1 manifest instead of reading it as this shape", () => {
    // Version 1 pinned a commit with no bundle behind it. Decoding one here
    // would mean inventing a bundle that was never uploaded, so the version
    // literal is what rejects it — not a missing-field error further down.
    const { bytes } = encodeCheckpointManifest(manifest());
    const body = JSON.parse(new TextDecoder().decode(bytes));
    body.version = 1;
    delete body.workspace.bundle;

    expect(() =>
      decodeCheckpointManifest(new TextEncoder().encode(JSON.stringify(body))),
    ).toThrow(/Invalid Claude checkpoint manifest/);
  });

  test("refuses a manifest whose workspace commit is not a full sha", () => {
    expect(() =>
      encodeCheckpointManifest(
        manifest({
          workspace: { ...manifest().workspace, gitCommit: "abc1234" },
        }),
      ),
    ).toThrow();
  });

  test("refuses a manifest that pins a commit without the bundle carrying it", () => {
    // The commit alone is unverifiable, so a manifest that omits the bundle is
    // not a manifest this codec will produce or accept.
    const { bundle: _bundle, ...workspace } = manifest().workspace;

    expect(() =>
      encodeCheckpointManifest(
        manifest({ workspace: workspace as CheckpointManifest["workspace"] }),
      ),
    ).toThrow(/bundle/);
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

  test("changes when an MCP server is repointed under the same name", () => {
    const before = {
      ...config,
      mcpServers: { review: { command: "review-server", args: ["--safe"] } },
    };
    const after = {
      ...config,
      mcpServers: { review: { command: "review-server", args: ["--all"] } },
    };

    expect(claudeProfileFingerprint(after)).not.toBe(
      claudeProfileFingerprint(before),
    );
  });

  test("ignores the order MCP servers were declared in", () => {
    const one = {
      ...config,
      mcpServers: { a: { command: "a" }, b: { command: "b" } },
    };
    const other = {
      ...config,
      mcpServers: { b: { command: "b" }, a: { command: "a" } },
    };

    expect(claudeProfileFingerprint(other)).toBe(claudeProfileFingerprint(one));
  });

  test("changes when a plugin is added", () => {
    expect(
      claudeProfileFingerprint({
        ...config,
        plugins: [{ path: "/plugins/review", type: "local" }],
      }),
    ).not.toBe(claudeProfileFingerprint(config));
  });

  test("survives an in-process MCP server the SDK accepts", () => {
    // `createSdkMcpServer` hands back a live object graph with cycles in it;
    // hashing it verbatim throws, which would stop the session checkpointing.
    class McpServer {
      self: unknown;
      constructor(readonly name: string) {
        this.self = this;
      }
    }
    const inProcess = {
      ...config,
      mcpServers: { review: new McpServer("review") },
    };

    expect(claudeProfileFingerprint(inProcess)).toMatch(/^[0-9a-f]{64}$/);
    expect(claudeProfileFingerprint(inProcess)).not.toBe(
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
