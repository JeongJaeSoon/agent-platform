/**
 * The runtime this image stamps a checkpoint with, per claim, for
 * `scripts/verify-restore.sh --image` (94S-452). The engine build is the
 * image's constant; the profile digest is computed here by this image's own
 * code, so an image that hashes a profile differently from the one that
 * sealed a checkpoint shows as incompatible before a worker is asked to
 * restore it.
 *
 *   docker run --rm -i --network none --entrypoint bun <image> \
 *     run apps/worker/src/image-runtime.ts < claims.json
 *
 * stdin: `{ "<session id>": { "principal": …, "runtime_config": … } }`, the
 * claim fields the digest reads, as the API would hand them out.
 */

import { bootstrapClaimResponseSchema } from "@agent-platform/contracts";
import { CLAUDE_RUNTIME_FINGERPRINT } from "@agent-platform/runtime-claude";
import type { RuntimeFingerprint } from "@agent-platform/runtime-core";

import { claudeClaimFingerprint } from "./composition.ts";
import type { WorkerConfig } from "./config.ts";

const claimSchema = bootstrapClaimResponseSchema.pick({
  principal: true,
  runtime_config: true,
});

export type ImageProfile = { profileSha256: string } | { error: string };

// Where the engine runs is the launcher's per host, not the claim's; these
// stand in for it.
const HOST_STAND_IN: Pick<WorkerConfig, "egressCredentialUrl" | "runtime"> = {
  egressCredentialUrl: "http://egress-proxy.invalid",
  runtime: {
    claudeConfigDir: "/home/bun/.claude",
    cwd: "/workspace",
    home: "/home/bun",
    providerMaxRetries: 0,
  },
};

export const imageClaimFingerprint = claudeClaimFingerprint(HOST_STAND_IN);

export function imageRuntimeOf(
  claims: unknown,
  fingerprint: (
    claim: Parameters<typeof imageClaimFingerprint>[0],
  ) => RuntimeFingerprint = imageClaimFingerprint,
) {
  if (typeof claims !== "object" || claims === null || Array.isArray(claims)) {
    throw new Error("claims must be an object keyed by session id");
  }
  const profiles: Record<string, ImageProfile> = {};
  for (const [sessionId, claim] of Object.entries(claims)) {
    const parsed = claimSchema.safeParse(claim);
    try {
      profiles[sessionId] = parsed.success
        ? { profileSha256: fingerprint(parsed.data).profileSha256 }
        : {
            error: `claim refused: ${parsed.error.issues
              .map((issue) => `${issue.path.join(".")} ${issue.message}`)
              .join("; ")}`,
          };
    } catch (error) {
      profiles[sessionId] = { error: (error as Error).message };
    }
  }
  return { ...CLAUDE_RUNTIME_FINGERPRINT, profiles };
}

if (import.meta.main) {
  console.log(
    JSON.stringify(imageRuntimeOf(JSON.parse(await Bun.stdin.text()))),
  );
}
