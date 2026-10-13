import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { ReceiptActor } from "@agent-platform/contracts";
import type {
  PullRequestStore,
  PushRequestStore,
  PushWriteResult,
} from "@agent-platform/platform";
import {
  createTempDatabase,
  type TempDatabase,
  testDatabaseUrl,
} from "@agent-platform/testkit/postgres";
import { eq } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { createPostgresPullRequests } from "./pull-requests.ts";
import { createPostgresPushRequests } from "./push-requests.ts";
import * as schema from "./schema.ts";
import { receipts, sessions } from "./schema.ts";

const integration = testDatabaseUrl() ? describe : describe.skip;

const OWNER = "owner-pull";
const COMMIT = "c".repeat(40);
const HUMAN: ReceiptActor = {
  principal: { kind: "api_key", id: "key-approver" },
  actor_user_id: null,
  agent_id: null,
};

function written(result: PushWriteResult) {
  if (result.outcome !== "written") {
    throw new Error(`expected a write, got ${JSON.stringify(result)}`);
  }
  return result.request;
}

integration("postgres pull requests", () => {
  let database: TempDatabase;
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;
  let pushes: PushRequestStore;
  let store: PullRequestStore;

  beforeAll(async () => {
    database = await createTempDatabase({ prefix: "pull_requests_it" });
    pool = new Pool({ connectionString: database.url, max: 4 });
    db = drizzle(pool, { schema });
    pushes = createPostgresPushRequests(db);
    store = createPostgresPullRequests(db);
  });

  afterAll(async () => {
    await pool?.end();
    await database?.drop();
  });

  async function pushed() {
    const sessionId = crypto.randomUUID();
    await db.insert(sessions).values({
      id: sessionId,
      ownerId: OWNER,
      repoUrl: "https://github.com/acme/app.git",
      branch: "main",
      repositoryId: "app",
      checkpointRevision: 1,
    });
    const request = written(
      await pushes.create({
        ownerId: OWNER,
        sessionId,
        actor: HUMAN,
        idempotencyKey: `k-${sessionId}`,
        payloadHash: "h",
        repositoryId: "app",
        repositoryBinding: "sha256:binding",
        checkpointRevision: 1,
        gitCommit: COMMIT,
      }),
    );
    written(
      await pushes.decide({
        ownerId: OWNER,
        sessionId,
        pushRequestId: request.id,
        actor: HUMAN,
        decision: "approve",
        gitCommit: COMMIT,
        reason: null,
        idempotencyKey: `d-${sessionId}`,
        payloadHash: "h",
      }),
    );
    const job = await pushes.claimNextApproved(60_000);
    if (job?.id !== request.id) throw new Error("claimed another request");
    await pushes.finish(job, {
      state: "pushed",
      remoteUrl: "https://github.com/acme/app.git",
      remoteRef: `refs/heads/agent/${sessionId}`,
      previousCommit: null,
    });
    return { sessionId, pushRequestId: request.id };
  }

  const save = (
    source: { sessionId: string; pushRequestId: string },
    number = 7,
  ) =>
    store.savePullRequest({
      ownerId: OWNER,
      sessionId: source.sessionId,
      pushRequestId: source.pushRequestId,
      actor: HUMAN,
      repositoryId: "app",
      number,
      url: `https://github.com/acme/app/pull/${number}`,
      head: `agent/${source.sessionId}`,
      base: "main",
      created: true,
    });

  test("reads the pushed request it opens from, only for its owner", async () => {
    const source = await pushed();
    expect(
      await store.findSource(
        OWNER,
        source.sessionId.toUpperCase(),
        source.pushRequestId,
      ),
    ).toMatchObject({
      id: source.pushRequestId,
      state: "pushed",
      repositoryBinding: "sha256:binding",
      targetBranch: `agent/${source.sessionId}`,
      gitCommit: COMMIT,
    });
    expect(
      await store.findSource(
        "someone-else",
        source.sessionId,
        source.pushRequestId,
      ),
    ).toBeNull();
  });

  test("records one pull request per push request with its receipt; racing saves keep the first", async () => {
    const source = await pushed();
    const [a, b] = await Promise.all([save(source, 7), save(source, 8)]);
    const winner = a?.created ? a : b;
    const loser = a?.created ? b : a;
    expect(winner?.created).toBe(true);
    expect(loser?.created).toBe(false);
    expect(loser?.pullRequest).toEqual(winner?.pullRequest);
    expect(await store.findPullRequest(OWNER, source.pushRequestId)).toEqual(
      winner?.pullRequest ?? null,
    );
    expect(
      await store.findPullRequest("someone-else", source.pushRequestId),
    ).toBeNull();

    const [row] = await db
      .select()
      .from(receipts)
      .where(eq(receipts.id, winner?.receiptId ?? ""));
    expect(row).toMatchObject({
      ownerId: OWNER,
      operation: "open_pull_request",
      status: "succeeded",
      actor: HUMAN,
      targetRef: {
        session_id: source.sessionId,
        turn_id: null,
        request_id: source.pushRequestId,
      },
      result: { verdict: "allow", created: true, refusal: null },
    });
  });

  test("a later push request answered with the same pull request shares its row", async () => {
    const first = await pushed();
    const opened = await save(first, 11);
    const again = await store.savePullRequest({
      ownerId: OWNER,
      sessionId: first.sessionId,
      pushRequestId: crypto.randomUUID(),
      actor: HUMAN,
      repositoryId: "app",
      number: 11,
      url: "https://github.com/acme/app/pull/11",
      head: `agent/${first.sessionId}`,
      base: "main",
      created: false,
    });
    expect(again).toMatchObject({
      pullRequest: opened.pullRequest,
      created: false,
    });
    expect(
      await store.findBranchPullRequest(
        OWNER,
        first.sessionId.toUpperCase(),
        `agent/${first.sessionId}`,
      ),
    ).toEqual(opened.pullRequest);
    expect(
      await store.findBranchPullRequest(
        "someone-else",
        first.sessionId,
        `agent/${first.sessionId}`,
      ),
    ).toBeNull();
    expect(
      await store.findBranchPullRequest(OWNER, first.sessionId, "agent/other"),
    ).toBeNull();
  });

  test("a refusal receipt is failed with the refusal's error", async () => {
    const source = await pushed();
    const id = await store.recordReceipt({
      ownerId: OWNER,
      sessionId: source.sessionId,
      pushRequestId: source.pushRequestId,
      actor: HUMAN,
      operation: "comment_pull_request",
      result: {
        push_request_id: source.pushRequestId,
        verdict: "refuse",
        refusal: "no_pull_request",
        repository_id: "app",
        number: null,
        url: null,
        head: null,
        base: null,
        created: null,
        marker: "status",
      },
    });
    const [row] = await db.select().from(receipts).where(eq(receipts.id, id));
    expect(row).toMatchObject({
      operation: "comment_pull_request",
      status: "failed",
      error: { code: "PULL_REQUEST_MISSING" },
    });
  });
});
