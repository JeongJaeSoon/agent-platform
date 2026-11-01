import { afterAll, beforeAll, expect, test } from "bun:test";
import type { PGlite } from "@electric-sql/pglite";
import * as schema from "@werft-ai/db";
import { createLogger } from "@werft-ai/observability";
import { migratedPGlite } from "@werft-ai/testkit/pglite";
import { drizzle } from "drizzle-orm/pglite";
import {
  DEFAULT_SESSION_ARCHIVE_AFTER_DAYS,
  runSessionArchive,
  sessionArchiveAfterDays,
} from "./session-archive.ts";

function logger() {
  const lines: Array<{ fields?: unknown; message: string }> = [];
  return Object.assign(
    createLogger({
      sinks: [
        {
          write({ fields, message }) {
            lines.push({ fields, message });
          },
        },
      ],
    }),
    { lines },
  );
}

const s3 = {
  AWS_ACCESS_KEY_ID: "id",
  AWS_REGION: "ap-northeast-1",
  AWS_SECRET_ACCESS_KEY: "secret",
  S3_BUCKET: "claude-sessions",
};
const locked = { ...s3, CHECKPOINT_OBJECT_PROTECTION: "locked" };

let client: PGlite;
beforeAll(async () => {
  client = await migratedPGlite();
});
afterAll(async () => {
  await client.close();
});

function stores() {
  const calls: string[] = [];
  return {
    calls,
    connect: async () => ({
      db: drizzle(client, { schema }),
      objects: {
        get: async () => undefined,
        hold: async () => {
          calls.push("hold");
        },
        putImmutable: async () => {
          calls.push("put");
          return { outcome: "created" as const, version: "v1" };
        },
      },
      close: async () => {
        calls.push("close");
      },
    }),
  };
}

test("SESSION_ARCHIVE_AFTER_DAYS: unset is 180, 0 is off, 30–3650 is taken", () => {
  expect(sessionArchiveAfterDays(undefined)).toBe(
    DEFAULT_SESSION_ARCHIVE_AFTER_DAYS,
  );
  expect(DEFAULT_SESSION_ARCHIVE_AFTER_DAYS).toBe(180);
  expect(sessionArchiveAfterDays("0")).toBe(0);
  expect(sessionArchiveAfterDays("30")).toBe(30);
  expect(sessionArchiveAfterDays("3650")).toBe(3650);
});

test.each(["1", "29", "3651", "-30", "30.5", "abc", " 30"])(
  "SESSION_ARCHIVE_AFTER_DAYS=%p is refused before anything connects",
  async (value) => {
    const { calls, connect } = stores();
    await expect(
      runSessionArchive({
        connect,
        environment: {
          ...locked,
          DATABASE_URL: "postgres://unused",
          SESSION_ARCHIVE_AFTER_DAYS: value,
        },
        logger: logger(),
      }),
    ).rejects.toThrow("SESSION_ARCHIVE_AFTER_DAYS must be 0 (off)");
    expect(calls).toEqual([]);
  },
);

test.each([
  [{ CHECKPOINT_OBJECT_STORE: "disabled" }, "CHECKPOINT_OBJECT_STORE=disabled"],
  [
    { ...s3, CHECKPOINT_OBJECT_PROTECTION: "unversioned" },
    "CHECKPOINT_OBJECT_PROTECTION=unversioned cannot hold archived events",
  ],
  [
    { ...locked, SESSION_ARCHIVE_AFTER_DAYS: "0" },
    "SESSION_ARCHIVE_AFTER_DAYS=0",
  ],
])(
  "exits 0 without connecting when it cannot or must not archive: %p",
  async (environment, reason) => {
    const log = logger();
    const { calls, connect } = stores();
    expect(await runSessionArchive({ connect, environment, logger: log })).toBe(
      0,
    );
    expect(calls).toEqual([]);
    expect(log.lines).toEqual([
      { message: "Session archive skipped", fields: { reason } },
    ]);
  },
);

test("restore is refused where nothing could have been archived", async () => {
  await expect(
    runSessionArchive({
      argv: ["restore", "00000000-0000-0000-0000-000000000001"],
      environment: { CHECKPOINT_OBJECT_STORE: "disabled" },
      logger: logger(),
    }),
  ).rejects.toThrow("Cannot restore archived events");
});

test.each([[["purge"]], [["restore"]], [["restore", "a", "b"]]])(
  "an unknown command line is refused: %p",
  async (argv) => {
    await expect(
      runSessionArchive({ argv, environment: locked, logger: logger() }),
    ).rejects.toThrow("Usage: session-archive.ts");
  },
);

test("a dry run is the default and logs the counts it would move", async () => {
  const log = logger();
  const { calls, connect } = stores();
  const code = await runSessionArchive({
    connect,
    environment: { ...locked, DATABASE_URL: "postgres://unused" },
    logger: log,
  });
  expect(code).toBe(0);
  expect(calls).toEqual(["close"]);
  expect(log.lines.at(-1)).toEqual({
    message: "Session archive completed",
    fields: {
      after_days: 180,
      bytes: 0,
      chunks: 0,
      dry_run: true,
      events: 0,
      failed: 0,
      sessions: 0,
    },
  });
});

test("restore runs against the stores and logs what came back", async () => {
  const log = logger();
  const { connect } = stores();
  const sessionId = "00000000-0000-0000-0000-000000000001";
  expect(
    await runSessionArchive({
      argv: ["restore", sessionId],
      connect,
      environment: { ...locked, DATABASE_URL: "postgres://unused" },
      logger: log,
    }),
  ).toBe(0);
  expect(log.lines.at(-1)).toEqual({
    message: "Session archive restored",
    fields: { chunks: 0, events: 0, session_id: sessionId },
  });
});
