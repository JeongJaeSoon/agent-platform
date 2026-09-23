/**
 * Development fixture for scripts/backup.sh → restore.sh → verify-restore.sh.
 *
 * Writes one session with one committed checkpoint into an installation the
 * way a worker and the control plane would (94S-124 contracts): transcript
 * parts through the mirror, a real `git bundle`, the manifest sealed by the
 * Claude codec and uploaded create-only, then the DB pointer. Nothing in the
 * product writes checkpoints yet (94S-201/246), so this is how a backup gets
 * something for the verifier to compare.
 *
 * Only for a local compose installation. Every write goes to a fresh random
 * session id, so running it twice adds a second session.
 *
 *   DATABASE_URL=postgresql://postgres:dev@127.0.0.1:5432/sessions \
 *   AWS_ENDPOINT_URL=http://127.0.0.1:4566 AWS_REGION=ap-northeast-1 \
 *   AWS_ACCESS_KEY_ID=test AWS_SECRET_ACCESS_KEY=test S3_BUCKET=claude-sessions \
 *   bun run scripts/dev/seed-checkpoint.ts
 */

import { createHash, randomUUID } from "node:crypto";
import { manifestRefFor } from "@agent-platform/platform";
import {
  CLAUDE_RUNTIME_FINGERPRINT,
  ClaudeSessionStore,
  claudeCheckpointCodec,
} from "@agent-platform/runtime-claude";
import type {
  CheckpointManifest,
  CheckpointTranscripts,
  ObjectRef,
  TranscriptRevision,
} from "@agent-platform/runtime-core";
import {
  createCheckpointObjectStore,
  createStorageS3Client,
  storageConfigFromEnv,
} from "@agent-platform/storage";
import { createGitBundle } from "@agent-platform/testkit/git-bundle";
import { Pool } from "pg";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");

const config = storageConfigFromEnv({
  ...process.env,
  GIT_AUTHOR_EMAIL: "seed@example.invalid",
  GIT_AUTHOR_NAME: "seed",
  GIT_TOKEN: "unused",
  GIT_USERNAME: "seed",
});
const objects = createCheckpointObjectStore({
  bucket: config.bucket,
  client: createStorageS3Client(config),
});

const sessionId = randomUUID();
const attemptId = `attempt-${randomUUID().slice(0, 8)}`;
const revision = 0;
const projectKey = "-workspace";
// Transcripts are filed under the engine's session name, which the manifest
// carries as `resume` — not the platform's session id.
const engineSession = `sdk-session-${sessionId.slice(0, 8)}`;
const mirror = new ClaudeSessionStore({
  generation: 1,
  objects,
  prefix: `sessions/${sessionId}/mirror`,
});

const root = { projectKey, sessionId: engineSession };
await mirror.append(root, [
  { type: "user", uuid: randomUUID(), message: { content: "first turn" } },
  { type: "assistant", uuid: randomUUID(), message: { content: "done" } },
]);
await mirror.append({ ...root, subpath: "agents/reviewer" }, [
  { type: "user", uuid: randomUUID(), message: { content: "review" } },
]);

const captured = await mirror.captureTranscripts(engineSession);
if (captured === null) throw new Error("root transcript was not captured");

// Every ref names the version it was written as, as a locked finalize
// requires (94S-229). The mirror does not report part versions yet (94S-246),
// so each part's current version is read back; nothing else writes these keys.
async function withVersion<T extends ObjectRef>(ref: T): Promise<T> {
  const head = await objects.head(ref.key);
  if (head?.version === undefined) {
    throw new Error(`${ref.key} has no version; the bucket needs versioning`);
  }
  return { ...ref, version: head.version };
}
const pinRevision = async (
  revision: TranscriptRevision,
): Promise<TranscriptRevision> => ({
  ...revision,
  parts: await Promise.all(revision.parts.map(withVersion)),
});
const transcripts: CheckpointTranscripts = {
  root: await pinRevision(captured.root),
  subagents: Object.fromEntries(
    await Promise.all(
      Object.entries(captured.subagents).map(
        async ([subpath, revision]) =>
          [subpath, await pinRevision(revision)] as const,
      ),
    ),
  ),
};

// A publish id like the one requestCheckpoint mints, so the key has the
// shape the gateway verifies.
const manifestRef = manifestRefFor(
  sessionId,
  revision,
  attemptId,
  randomUUID().replaceAll("-", ""),
);
const attemptPrefix = manifestRef.slice(0, manifestRef.lastIndexOf("/") + 1);
const bundle = await createGitBundle({ message: `seed ${sessionId}` });
const bundleKey = `${attemptPrefix}workspace.bundle`;
const bundlePut = await objects.putImmutable(bundleKey, bundle.bytes);
if (bundlePut.outcome !== "created" || bundlePut.version === undefined) {
  throw new Error(`bundle upload: ${bundlePut.outcome}, no version`);
}

const manifest: CheckpointManifest = {
  createdAt: new Date().toISOString(),
  cwd: "/workspace",
  engine: "claude",
  resume: engineSession,
  revision,
  runtime: {
    ...CLAUDE_RUNTIME_FINGERPRINT,
    profileSha256: createHash("sha256").update("seed").digest("hex"),
  },
  sessionId,
  transcripts,
  version: 2,
  workspace: {
    bundle: {
      bytes: bundle.bytes.byteLength,
      key: bundleKey,
      sha256: bundle.sha256,
      version: bundlePut.version,
    },
    gitCommit: bundle.commit,
    untracked: [],
  },
};
const sealed = claudeCheckpointCodec.encode(manifest);
const manifestPut = await objects.putImmutable(manifestRef, sealed.bytes);
if (manifestPut.outcome !== "created" || manifestPut.version === undefined) {
  throw new Error(`manifest upload: ${manifestPut.outcome}, no version`);
}
// What a locked finalize does before it moves the pointer, so the row below
// may say versions_held.
const hold = objects.hold;
if (hold === undefined) throw new Error("object store cannot hold versions");
for (const ref of [
  ...transcripts.root.parts,
  ...Object.values(transcripts.subagents).flatMap((revision) => revision.parts),
  manifest.workspace.bundle,
  { key: manifestRef, version: manifestPut.version },
]) {
  if (ref.version === undefined) throw new Error(`${ref.key} has no version`);
  await hold(ref.key, ref.version);
}

const pool = new Pool({ connectionString: databaseUrl, max: 1 });
try {
  await pool.query("BEGIN");
  await pool.query(
    `INSERT INTO sessions (id, owner_id, repo_url, branch, status, admission_state, checkpoint_revision, checkpoint_committed_at)
     VALUES ($1, 'seed', 'http://gitea:3000/seed/workspace.git', 'main', 'idle', 'paused', $2, now())`,
    [sessionId, revision],
  );
  await pool.query(
    `INSERT INTO checkpoints (session_id, revision, manifest_ref, manifest_sha256, manifest_version, versions_held)
     VALUES ($1, $2, $3, $4, $5, true)`,
    [sessionId, revision, manifestRef, sealed.sha256, manifestPut.version],
  );
  await pool.query("COMMIT");
} catch (error) {
  await pool.query("ROLLBACK");
  throw error;
} finally {
  await pool.end();
}

console.log(
  JSON.stringify({
    sessionId,
    revision,
    manifestRef,
    manifestSha256: sealed.sha256,
    manifestVersion: manifestPut.version,
    bundleKey,
    gitCommit: bundle.commit,
  }),
);
