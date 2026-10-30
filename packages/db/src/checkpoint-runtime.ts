import type { FinalizeInput } from "@werft-ai/platform";
import { and, eq } from "drizzle-orm";
import type { Database } from "./queries.ts";
import { checkpoints, sessions } from "./schema.ts";

export type RuntimeFingerprint = NonNullable<
  FinalizeInput["checkpointRuntime"]
>;

type RuntimeColumns = {
  runtimeEngine: string | null;
  runtimeSdkVersion: string | null;
  runtimeCliVersion: string | null;
  runtimeProfileSha256: string | null;
};

export function runtimeColumns(
  runtime: RuntimeFingerprint | undefined,
): RuntimeColumns {
  return {
    runtimeEngine: runtime?.engine ?? null,
    runtimeSdkVersion: runtime?.sdkVersion ?? null,
    runtimeCliVersion: runtime?.cliVersion ?? null,
    runtimeProfileSha256: runtime?.profileSha256 ?? null,
  };
}

// Null when any column is: a row from before them, or one committed without
// a verified fingerprint. A launch reads that as the current image.
export function runtimeOfColumns(
  row: RuntimeColumns,
): RuntimeFingerprint | null {
  if (
    row.runtimeEngine === null ||
    row.runtimeSdkVersion === null ||
    row.runtimeCliVersion === null ||
    row.runtimeProfileSha256 === null
  ) {
    return null;
  }
  return {
    engine: row.runtimeEngine,
    sdkVersion: row.runtimeSdkVersion,
    cliVersion: row.runtimeCliVersion,
    profileSha256: row.runtimeProfileSha256,
  };
}

/**
 * The fingerprint of the checkpoint the session's pointer names, which a
 * restore will be held to. Null for a session with no pointer and for a
 * pointer committed before the fingerprint was recorded: both run on the
 * current image.
 */
export async function readPointerRuntime(
  db: Database,
  sessionId: string,
): Promise<RuntimeFingerprint | null> {
  const [row] = await db
    .select({
      runtimeEngine: checkpoints.runtimeEngine,
      runtimeSdkVersion: checkpoints.runtimeSdkVersion,
      runtimeCliVersion: checkpoints.runtimeCliVersion,
      runtimeProfileSha256: checkpoints.runtimeProfileSha256,
    })
    .from(sessions)
    .innerJoin(
      checkpoints,
      and(
        eq(checkpoints.sessionId, sessions.id),
        eq(checkpoints.revision, sessions.checkpointRevision),
      ),
    )
    .where(eq(sessions.id, sessionId))
    .limit(1);
  return row === undefined ? null : runtimeOfColumns(row);
}
