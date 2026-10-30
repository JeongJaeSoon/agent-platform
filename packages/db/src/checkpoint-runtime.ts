import {
  type FinalizeInput,
  type PointerRuntime,
  recordedPointer,
} from "@werft-ai/platform";
import { and, eq, type SQL, sql } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
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

/**
 * The session's runtime columns for a pointer update: the fingerprint goes
 * in only while the session has none, all four together, so the first
 * committed checkpoint that carries one decides it.
 */
export function sessionRuntimeOnce(
  runtime: RuntimeFingerprint | undefined,
): Partial<Record<keyof RuntimeColumns, SQL>> {
  if (runtime === undefined) return {};
  const once = (column: AnyPgColumn, value: string) =>
    sql`CASE WHEN ${sessions.runtimeEngine} IS NULL THEN ${value} ELSE ${column} END`;
  return {
    runtimeEngine: once(sessions.runtimeEngine, runtime.engine),
    runtimeSdkVersion: once(sessions.runtimeSdkVersion, runtime.sdkVersion),
    runtimeCliVersion: once(sessions.runtimeCliVersion, runtime.cliVersion),
    runtimeProfileSha256: once(
      sessions.runtimeProfileSha256,
      runtime.profileSha256,
    ),
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
 * The image combination the session's pointer was sealed under, for
 * choosing the image its next launch runs on, and the revision it was read
 * at (0 with no pointer).
 */
export async function readPointerImageRuntime(
  db: Database,
  sessionId: string,
): Promise<{ pointer: PointerRuntime; checkpointRevision: number }> {
  const [row] = await db
    .select({
      checkpointRevision: sessions.checkpointRevision,
      runtimeEngine: checkpoints.runtimeEngine,
      runtimeSdkVersion: checkpoints.runtimeSdkVersion,
      runtimeCliVersion: checkpoints.runtimeCliVersion,
      runtimeProfileSha256: checkpoints.runtimeProfileSha256,
      runtimeProfileScheme: checkpoints.runtimeProfileScheme,
    })
    .from(sessions)
    .leftJoin(
      checkpoints,
      and(
        eq(checkpoints.sessionId, sessions.id),
        eq(checkpoints.revision, sessions.checkpointRevision),
      ),
    )
    .where(eq(sessions.id, sessionId))
    .limit(1);
  if (row === undefined || row.checkpointRevision === null) {
    return { pointer: { kind: "none" }, checkpointRevision: 0 };
  }
  const runtime = runtimeOfColumns(row);
  return {
    pointer:
      runtime === null
        ? { kind: "unrecorded" }
        : recordedPointer(runtime, row.runtimeProfileScheme),
    checkpointRevision: row.checkpointRevision,
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
