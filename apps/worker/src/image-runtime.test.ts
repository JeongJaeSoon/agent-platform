import { describe, expect, test } from "bun:test";
import { CLAUDE_RUNTIME_FINGERPRINT } from "@agent-platform/runtime-claude";

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
