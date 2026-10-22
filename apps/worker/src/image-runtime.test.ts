import { describe, expect, test } from "bun:test";
import { CLAUDE_RUNTIME_FINGERPRINT } from "@werft-ai/runtime-claude";

import { claudeClaimFingerprint } from "./composition.ts";
import { imageRuntimeOf } from "./image-runtime.ts";

const claim = {
  principal: { owner_scope: "owner-a" },
  runtime_config: {
    model: "claude-sonnet-5",
    tools: ["Read", "Edit"],
    permission_mode: "default" as const,
    provider: {
      kind: "anthropic" as const,
      endpoint: "http://fake-messages:4010",
      auth: { kind: "egress_token" as const, token: "[REDACTED]" },
    },
  },
};

// Computed on main before remote MCP: a claim without one must keep it.
const NO_MCP_FINGERPRINT =
  "d12b869e3f65a58193274b04ea1ab40d3cfd962a4d82e38b4f3f63190c2ef186";

describe("imageRuntimeOf", () => {
  test("stamps each claim with the digest a worker on any host computes for it", () => {
    const onAHost = claudeClaimFingerprint({
      egressCredentialUrl: "http://egress-proxy:3129",
      runtime: {
        claudeConfigDir: "/home/worker/.claude",
        cwd: "/srv/workspace",
        home: "/home/worker",
        providerMaxRetries: 2,
      },
    })(claim);

    expect(imageRuntimeOf({ s1: claim })).toEqual({
      ...CLAUDE_RUNTIME_FINGERPRINT,
      profiles: { s1: { profileSha256: onAHost.profileSha256 } },
    });
  });

  test("a remote MCP server is fingerprinted by its binding, never its token", () => {
    const fingerprint = claudeClaimFingerprint({
      egressCredentialUrl: "http://egress-proxy:3129",
      runtime: {
        claudeConfigDir: "/home/worker/.claude",
        cwd: "/srv/workspace",
        home: "/home/worker",
        providerMaxRetries: 2,
      },
    });
    const withMcp = (binding: string, token: string) =>
      fingerprint({
        ...claim,
        runtime_config: {
          ...claim.runtime_config,
          tools: [...claim.runtime_config.tools, "mcp__fake__whoami"],
          mcp_servers: [
            {
              name: "fake",
              endpoint: "http://fake-mcp:4020/mcp",
              binding,
              access: { kind: "egress_token" as const, token },
            },
          ],
        },
      }).profileSha256;
    const one = `sha256:${"1".repeat(64)}`;
    const two = `sha256:${"2".repeat(64)}`;
    expect(withMcp(one, "wem_a")).toBe(withMcp(one, "wem_b"));
    expect(withMcp(one, "wem_a")).not.toBe(withMcp(two, "wem_a"));
    expect(withMcp(one, "wem_a")).not.toBe(fingerprint(claim).profileSha256);
    // A claim without one hashes as it did before remote MCP existed.
    expect(fingerprint(claim).profileSha256).toBe(NO_MCP_FINGERPRINT);
  });

  test("a claim this image's protocol refuses gets an error, not a digest", () => {
    const { profiles } = imageRuntimeOf({
      bad: { ...claim, principal: {} },
      good: claim,
    });

    expect(profiles.bad).toEqual({
      error:
        "claim refused: principal.owner_scope Invalid input: expected string, received undefined",
    });
    expect(profiles.good).toHaveProperty("profileSha256");
    expect(() => imageRuntimeOf([])).toThrow("keyed by session id");
  });
});
