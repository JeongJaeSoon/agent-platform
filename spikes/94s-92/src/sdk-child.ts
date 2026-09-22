import type {
  SDKMessage,
  SessionKey,
  SessionStore,
  SessionStoreEntry,
} from "@anthropic-ai/claude-agent-sdk";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { S3Client } from "@aws-sdk/client-s3";
import { deadline } from "./deadline.ts";
import { s3MaxAttempts, s3RequestBounds } from "./localstack.ts";
import { S3CallTracker, startStallReporter } from "./s3-diagnostics.ts";
import { S3SessionStoreProbe } from "./s3-session-store.ts";

const required = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
};

const calls = new S3CallTracker();
// The parent reads this child's stderr incrementally, so a stall reported here
// survives even when the parent's own wait is cut short.
startStallReporter("child", calls);
let stage = "starting";

const client = new S3Client({
  credentials: {
    accessKeyId: required("AWS_ACCESS_KEY_ID"),
    secretAccessKey: required("AWS_SECRET_ACCESS_KEY"),
  },
  endpoint: required("AWS_ENDPOINT_URL"),
  forcePathStyle: true,
  maxAttempts: s3MaxAttempts,
  region: required("AWS_REGION"),
  requestHandler: s3RequestBounds,
});
calls.instrument(client);
const durableStore = new S3SessionStoreProbe({
  bucket: required("S3_BUCKET"),
  client,
  prefix: required("SESSION_STORE_PREFIX"),
});
const appendMode = process.env.APPEND_MODE ?? "success";
let appendAttempts = 0;
// Writes the adapter has already given up on but that are still on the wire.
// They keep this process alive after the query loop ends, so a stuck one is
// indistinguishable from a hung query unless it is accounted for separately.
const lateWrites = new Set<Promise<void>>();
/** Longer than a bounded S3 attempt chain, so a real write is never cut off. */
const LATE_WRITE_DRAIN_MS = 15_000;

type DrainOutcome = {
  /** False when the deadline won, i.e. writes were still on the wire. */
  readonly drained: boolean;
  readonly rejected: number;
};

/**
 * Waits for `promises`, giving up after `ms`, and says which of the two
 * happened. Collapsing both into "done" is how a lost write would pass for a
 * landed one — the exact invariant the timeout mode exists to check.
 */
async function settleWithin(
  promises: readonly Promise<unknown>[],
  ms: number,
): Promise<DrainOutcome> {
  if (promises.length === 0) return { drained: true, rejected: 0 };
  const drain = deadline(ms);
  const results = await Promise.race([
    Promise.allSettled(promises),
    drain.expired.then(() => undefined),
  ]);
  drain.cancel();
  if (results === undefined) return { drained: false, rejected: 0 };
  return {
    drained: true,
    rejected: results.filter((result) => result.status === "rejected").length,
  };
}
const store: SessionStore = {
  append: async (key: SessionKey, entries: SessionStoreEntry[]) => {
    appendAttempts += 1;
    if (appendMode === "fail") throw new Error("injected append failure");
    if (appendMode === "hang") await new Promise<never>(() => {});
    if (appendMode === "timeout") {
      const lateWrite = Bun.sleep(150).then(() =>
        durableStore.append(key, entries),
      );
      lateWrites.add(lateWrite);
      const settled = calls.begin(`lateWrite#${appendAttempts}`);
      lateWrite.then(settled, settled);
      await Promise.race([
        lateWrite,
        Bun.sleep(25).then(() => {
          throw new Error("injected append timeout");
        }),
      ]);
      return;
    }
    await durableStore.append(key, entries);
  },
  load: (key) => durableStore.load(key),
  listSessions: (projectKey) => durableStore.listSessions(projectKey),
  listSubkeys: (key) => durableStore.listSubkeys(key),
};

// A parent that gives up on this child asks for its state first; answering on
// the way out is the only way the reason reaches the log.
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    process.stderr.write(
      `CHILD_DIAG stage=${stage} attempts=${appendAttempts} lateWrites=${lateWrites.size} s3=${calls.describe()}\n`,
    );
    process.exit(3);
  });
}

try {
  stage = "query";
  const messages: SDKMessage[] = [];
  const resume = process.env.RESUME_SESSION_ID;
  for await (const message of query({
    prompt: required("PROMPT"),
    options: {
      cwd: required("WORKSPACE_PATH"),
      env: {
        ...process.env,
        ANTHROPIC_API_KEY: "test-key",
        ANTHROPIC_BASE_URL: required("ANTHROPIC_BASE_URL"),
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
        CLAUDE_CODE_PROJECT_DIR_NAME: "tenant-workspace",
        CLAUDE_CONFIG_DIR: required("CLAUDE_CONFIG_DIR"),
        HOME: required("CLAUDE_CONFIG_DIR"),
      },
      loadTimeoutMs: 2_000,
      maxTurns: 1,
      model: "claude-sonnet-4-5",
      ...(resume ? { resume } : {}),
      sessionStore: store,
      sessionStoreFlush: "eager",
      settingSources: ["project"],
    },
  })) {
    messages.push(message);
  }
  const result = messages.findLast((message) => message.type === "result");
  const mirrorErrors = messages.filter(
    (message) =>
      message.type === "system" && message.subtype === "mirror_error",
  ).length;
  const sequence = messages.map((message) =>
    message.type === "system"
      ? `system:${message.subtype}`
      : message.type === "result"
        ? `result:${message.subtype}`
        : message.type,
  );
  console.log(
    `CHILD_RESULT:${JSON.stringify({ appendAttempts, mirrorErrors, result, sequence })}`,
  );
} catch (error) {
  console.log(
    `CHILD_RESULT:${JSON.stringify({ appendAttempts, error: String(error) })}`,
  );
  process.exitCode = 1;
} finally {
  // The writes the adapter already gave up on are the whole point of the
  // timeout mode: they must still land exactly once. Settle them before the
  // client goes away, so the contract does not depend on whether the process
  // happens to outlive them — but bound the wait, or one stuck write turns
  // this process into a child that never exits.
  stage = `draining(${lateWrites.size} late writes)`;
  const drain = await settleWithin([...lateWrites], LATE_WRITE_DRAIN_MS);
  if (!drain.drained || drain.rejected > 0) {
    process.stderr.write(
      `CHILD_DRAIN_FAILED of=${lateWrites.size} drained=${drain.drained} rejected=${drain.rejected}\n`,
    );
    process.exitCode = 1;
  }
  stage = "done";
  client.destroy();
}
