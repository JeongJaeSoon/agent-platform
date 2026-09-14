import type {
  SDKMessage,
  SessionKey,
  SessionStore,
  SessionStoreEntry,
} from "@anthropic-ai/claude-agent-sdk";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { S3Client } from "@aws-sdk/client-s3";
import { S3SessionStoreProbe } from "./s3-session-store.ts";

const required = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
};

const client = new S3Client({
  credentials: {
    accessKeyId: required("AWS_ACCESS_KEY_ID"),
    secretAccessKey: required("AWS_SECRET_ACCESS_KEY"),
  },
  endpoint: required("AWS_ENDPOINT_URL"),
  forcePathStyle: true,
  region: required("AWS_REGION"),
});
const durableStore = new S3SessionStoreProbe({
  bucket: required("S3_BUCKET"),
  client,
  prefix: required("SESSION_STORE_PREFIX"),
});
const appendMode = process.env.APPEND_MODE ?? "success";
let appendAttempts = 0;
const store: SessionStore = {
  append: async (key: SessionKey, entries: SessionStoreEntry[]) => {
    appendAttempts += 1;
    if (appendMode === "fail") throw new Error("injected append failure");
    if (appendMode === "hang") await new Promise<never>(() => {});
    if (appendMode === "timeout") {
      const lateWrite = Bun.sleep(150).then(() =>
        durableStore.append(key, entries),
      );
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

try {
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
  client.destroy();
}
