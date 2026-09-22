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
const mirror = new ClaudeSessionStore({
  objects,
  prefix: `sessions/${sessionId}/mirror`,
});

const root = { projectKey, sessionId };
await mirror.append(root, [
  { type: "user", uuid: randomUUID(), message: { content: "first turn" } },
  { type: "assistant", uuid: randomUUID(), message: { content: "done" } },
]);
await mirror.append({ ...root, subpath: "agents/reviewer" }, [
  { type: "user", uuid: randomUUID(), message: { content: "review" } },
]);

const captured = await mirror.captureRevision(root);
if (captured === null) throw new Error("root transcript was not captured");
const subagents: Record<string, TranscriptRevision> = {};
for (const subpath of await mirror.listSubkeys(root)) {
  const sub = await mirror.captureRevision({ ...root, subpath });
  if (sub !== null) subagents[subpath] = sub;
}

const manifestRef = manifestRefFor(sessionId, revision, attemptId);
const attemptPrefix = manifestRef.slice(0, manifestRef.lastIndexOf("/") + 1);
const bundle = await createGitBundle({ message: `seed ${sessionId}` });
const bundleKey = `${attemptPrefix}workspace.bundle`;
const bundlePut = await objects.putImmutable(bundleKey, bundle.bytes);
if (bundlePut.outcome !== "created") {
  throw new Error(`bundle upload: ${bundlePut.outcome}`);
}

const manifest: CheckpointManifest = {
  createdAt: new Date().toISOString(),
  cwd: "/workspace",
  engine: "claude",
  resume: `sdk-session-${sessionId.slice(0, 8)}`,
  revision,
  runtime: {
    ...CLAUDE_RUNTIME_FINGERPRINT,
    profileSha256: createHash("sha256").update("seed").digest("hex"),
  },
  sessionId,
  transcripts: { root: captured, subagents },
  version: 2,
  workspace: {
    bundle: {
      bytes: bundle.bytes.byteLength,
      key: bundleKey,
      sha256: bundle.sha256,
    },
    gitCommit: bundle.commit,
    untracked: [],
  },
};
const sealed = claudeCheckpointCodec.encode(manifest);
const manifestPut = await objects.putImmutable(manifestRef, sealed.bytes);
if (manifestPut.outcome !== "created") {
  throw new Error(`manifest upload: ${manifestPut.outcome}`);
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
    `INSERT INTO checkpoints (session_id, revision, manifest_ref, manifest_sha256)
     VALUES ($1, $2, $3, $4)`,
    [sessionId, revision, manifestRef, sealed.sha256],
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
    bundleKey,
    gitCommit: bundle.commit,
  }),
);
