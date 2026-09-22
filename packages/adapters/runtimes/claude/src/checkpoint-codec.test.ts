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
import { UnidentifiedComponentError } from "./component-identity.ts";
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
  | "identities"
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
    principal: { ownerScope: "owner-a" },
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
        principal: { ownerScope: "owner-a" },
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
        identities: { plugins: { "/plugins/review": "review@1.0.0" } },
        plugins: [{ path: "/plugins/review", type: "local" }],
      }),
    ).not.toBe(claudeProfileFingerprint(config));
  });

  test("changes when a plugin at the same path declares a new identity", () => {
    // The path is all the SDK sees, and the same path can hold different
    // code tomorrow; the declared identity is what stands in for its contents.
    const plugins = [{ path: "/plugins/review", type: "local" as const }];
    const v1 = {
      ...config,
      identities: { plugins: { "/plugins/review": "review@1.0.0" } },
      plugins,
    };
    const v2 = {
      ...config,
      identities: { plugins: { "/plugins/review": "review@1.1.0" } },
      plugins,
    };

    expect(claudeProfileFingerprint(v2)).not.toBe(claudeProfileFingerprint(v1));
  });

  test("refuses a plugin with no declared identity", () => {
    const unnamed = {
      ...config,
      plugins: [{ path: "/plugins/review", type: "local" as const }],
    };

    expect(() => claudeProfileFingerprint(unnamed)).toThrow(
      UnidentifiedComponentError,
    );
    expect(() => claudeProfileFingerprint(unnamed)).toThrow(
      /Plugin "\/plugins\/review" has no identity/,
    );
  });

  test("changes when the principal changes on the same endpoint", () => {
    // Two tenants on one shared LiteLLM endpoint differ only in credential,
    // which the digest ignores on purpose; the principal is what tells them
    // apart so one cannot resume the other's checkpoint.
    const tenantA = {
      ...config,
      profile: {
        kind: "litellm" as const,
        endpoint: "https://litellm.test",
        auth: { kind: "bearer" as const, value: "token-a" },
        principal: { ownerScope: "owner-a" },
      },
    };
    const tenantB = {
      ...tenantA,
      profile: {
        ...tenantA.profile,
        auth: { kind: "bearer" as const, value: "token-b" },
        principal: { ownerScope: "owner-b" },
      },
    };
    const tenantARotated = {
      ...tenantA,
      profile: {
        ...tenantA.profile,
        auth: { kind: "bearer" as const, value: "token-a-rotated" },
      },
    };

    expect(claudeProfileFingerprint(tenantB)).not.toBe(
      claudeProfileFingerprint(tenantA),
    );
    expect(claudeProfileFingerprint(tenantARotated)).toBe(
      claudeProfileFingerprint(tenantA),
    );
  });

  test("ignores a rotated MCP header value but not a new header", () => {
    const http = (headers: Record<string, string>) => ({
      ...config,
      mcpServers: {
        notion: { type: "http", url: "https://mcp.notion.test", headers },
      },
    });

    expect(
      claudeProfileFingerprint(http({ Authorization: "Bearer new" })),
    ).toBe(claudeProfileFingerprint(http({ Authorization: "Bearer old" })));
    expect(
      claudeProfileFingerprint(
        http({ Authorization: "Bearer old", "X-Workspace": "w1" }),
      ),
    ).not.toBe(claudeProfileFingerprint(http({ Authorization: "Bearer old" })));
  });

  test("ignores a rotated stdio environment value but not a new variable", () => {
    const stdio = (env: Record<string, string>) => ({
      ...config,
      mcpServers: { github: { command: "github-mcp", env } },
    });

    expect(claudeProfileFingerprint(stdio({ GITHUB_TOKEN: "ghp_new" }))).toBe(
      claudeProfileFingerprint(stdio({ GITHUB_TOKEN: "ghp_old" })),
    );
    expect(
      claudeProfileFingerprint(
        stdio({ GITHUB_TOKEN: "ghp_old", GITHUB_HOST: "ghe.test" }),
      ),
    ).not.toBe(claudeProfileFingerprint(stdio({ GITHUB_TOKEN: "ghp_old" })));
  });

  test("still changes when a serializable MCP server is repointed", () => {
    const url = (url: string) => ({
      ...config,
      mcpServers: {
        notion: { type: "http", url, headers: { Authorization: "Bearer t" } },
      },
    });

    expect(claudeProfileFingerprint(url("https://mcp.other.test"))).not.toBe(
      claudeProfileFingerprint(url("https://mcp.notion.test")),
    );
  });

  // `createSdkMcpServer` hands back a live object graph with cycles in it;
  // hashing it verbatim throws, which would stop the session checkpointing.
  class McpServer {
    self: unknown;
    constructor(readonly name: string) {
      this.self = this;
    }
  }

  test("hashes an in-process MCP server by its declared identity", () => {
    const inProcess = (identity: string) => ({
      ...config,
      identities: { mcpServers: { review: identity } },
      mcpServers: {
        review: { type: "sdk", name: "review", instance: new McpServer("r") },
      },
    });

    expect(claudeProfileFingerprint(inProcess("review@1"))).toMatch(
      /^[0-9a-f]{64}$/,
    );
    expect(claudeProfileFingerprint(inProcess("review@1"))).toBe(
      claudeProfileFingerprint(inProcess("review@1")),
    );
    expect(claudeProfileFingerprint(inProcess("review@1"))).not.toBe(
      claudeProfileFingerprint(config),
    );
    expect(claudeProfileFingerprint(inProcess("review@2"))).not.toBe(
      claudeProfileFingerprint(inProcess("review@1")),
    );
  });

  test("tells two tenants' in-process servers of one class apart by identity", () => {
    // Same class, same registry name, different tenant state inside: the
    // class name alone called these compatible (94S-209).
    const tenant = (identity: string) => ({
      ...config,
      identities: { mcpServers: { review: identity } },
      mcpServers: { review: new McpServer("review") },
    });

    expect(claudeProfileFingerprint(tenant("review:owner-b"))).not.toBe(
      claudeProfileFingerprint(tenant("review:owner-a")),
    );
  });

  test("refuses an in-process MCP server with no declared identity", () => {
    const unnamed = {
      ...config,
      mcpServers: { review: new McpServer("review") },
    };

    let thrown: unknown;
    try {
      claudeProfileFingerprint(unnamed);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(UnidentifiedComponentError);
    const error = thrown as UnidentifiedComponentError;
    expect(error.reason).toBe("unidentified_component");
    expect(error.component).toBe("mcp_server");
    expect(error.name).toBe("review");
    expect(error.detail).toMatch(/MCP server "review" is not plain data/);
  });

  test("treats a function inside an otherwise plain MCP config as opaque", () => {
    const withCallback = {
      ...config,
      mcpServers: { hooks: { command: "x", onStart: () => undefined } },
    };

    expect(() => claudeProfileFingerprint(withCallback)).toThrow(
      UnidentifiedComponentError,
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
