import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import {
  PASS_LOOP_ROLES,
  type PassLoopEnvironment,
  type PassLoopLogger,
  statusFileFromEnv,
} from "../pass-loop/loop.ts";

/**
 * Where a pass notes the settings the workspace quota preflight passed
 * under, beside the loop's status file (94S-393). The loop removes it when
 * it starts, so a restarted loop — a rebooted host, a daemon swapped
 * underneath — probes again once.
 */
export function quotaPreflightMarkerPath(
  environment: PassLoopEnvironment,
): string {
  return `${statusFileFromEnv(environment, PASS_LOOP_ROLES.scheduler)}.quota-verified`;
}

/**
 * Runs `verify` unless a pass of this loop already passed it on the same
 * `settings`. The probe is a volume and a CAP_SYS_ADMIN helper, several
 * Docker round trips; repeated every few seconds on settings the daemon
 * already answered for, it only spends the pass budget. A failure notes
 * nothing, so the next pass probes again.
 */
export async function verifyWorkspaceQuotaOnce(input: {
  marker: string;
  settings: unknown;
  verify: () => Promise<void>;
  logger: Pick<PassLoopLogger, "warn">;
}): Promise<void> {
  const fingerprint = createHash("sha256")
    .update(JSON.stringify(input.settings))
    .digest("hex");
  const noted = await readFile(input.marker, "utf8").catch(() => null);
  if (noted === fingerprint) return;
  await input.verify();
  await writeFile(input.marker, fingerprint).catch((error: unknown) => {
    input.logger.warn(
      "Workspace quota preflight passed but could not be noted; the next pass probes again",
      {
        error: error instanceof Error ? error.message : String(error),
        path: input.marker,
      },
    );
  });
}
