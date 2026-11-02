import { describe, expect, test } from "bun:test";
import type { ReceiptActor } from "@werft-ai/contracts";
import type { GitHubSessionContext } from "../ports/github-gate.ts";
import {
  attachCatalog,
  attachGitHub,
  attachmentContext,
  memoryAttachmentStore,
} from "../testing/repository-attachment-fakes.ts";
import { createRepositoryAttachmentService } from "./repository-attachment-service.ts";
import { SessionServiceError } from "./session-service.ts";

const SESSION = "11111111-1111-4111-8111-111111111111";
const COMMIT = "c".repeat(40);
const actor: ReceiptActor = {
  principal: { kind: "user", id: "user-1" },
  actor_user_id: "user-1",
  agent_id: "agent-1",
};

function service(
  options: {
    context?: Partial<GitHubSessionContext>;
    attempts?: Set<string>;
    waitMs?: number;
    onSleep?: () => Promise<void> | void;
  } = {},
) {
  const store = memoryAttachmentStore(options.attempts);
  const attachments = createRepositoryAttachmentService({
    store,
    context: { context: async () => attachmentContext(options.context) },
    catalog: attachCatalog,
    waitMs: options.waitMs ?? 0,
    pollMs: 10,
    sleep: async () => {
      await options.onSleep?.();
    },
  });
  const attach = (repositoryId: string, attemptId = "att_1") =>
    attachments.attach({ sessionId: SESSION, attemptId, actor, repositoryId });
  return { store, attach };
}

async function refusal(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    if (error instanceof SessionServiceError) {
      return { code: error.code, details: error.details };
    }
    throw error;
  }
  throw new Error("expected a refusal");
}

describe("attach", () => {
  test("the session's own repository is attached already: no row, no receipt", async () => {
    const s = service();
    expect(await s.attach("app")).toEqual({
      repository_id: "app",
      status: "attached",
      branch: "main",
      commit: null,
      failure: null,
      already_attached: true,
      receipt_id: null,
    });
    expect(s.store.receipts).toEqual([]);
  });

  test("the cap is the release's list, the profile and the agent's switch, and every refusal leaves a receipt", async () => {
    for (const [repository, context] of [
      ["secret", {}],
      ["unknown", {}],
      ["docs", { release: { id: "r", github: attachGitHub(["app"]) } }],
      ["docs", { agent: { id: "a", workspaceId: "w", githubEnabled: false } }],
      ["docs", { release: null }],
    ] as Array<[string, Partial<GitHubSessionContext>]>) {
      const s = service({ context });
      expect(await refusal(s.attach(repository))).toEqual({
        code: "GITHUB_REFUSED",
        details: {
          reason_code: "repository_not_allowed",
          receipt_id: "receipt-1",
        },
      });
      expect(s.store.receipts.map((r) => r.status)).toEqual(["failed"]);
      expect(s.store.rows.size).toBe(0);
    }
  });

  test("the list the session started with does not limit what it may attach", async () => {
    const s = service({ context: { attachedRepositoryIds: [] } });
    expect((await s.attach("tools")).status).toBe("pending");
  });

  test("attaching it again changes nothing and succeeds, pending or attached", async () => {
    const s = service();
    const first = await s.attach("docs");
    expect(first).toMatchObject({ status: "pending", already_attached: false });
    expect(await s.attach("docs")).toEqual(first);
    await s.store.settle(SESSION, [
      { repository_id: "docs", status: "attached", commit: COMMIT },
    ]);
    expect(await s.attach("docs")).toEqual({
      repository_id: "docs",
      status: "attached",
      branch: "trunk",
      commit: COMMIT,
      failure: null,
      already_attached: true,
      receipt_id: first.receipt_id,
    });
    expect(s.store.receipts).toHaveLength(1);
  });

  test("an ended attempt's call is refused with a receipt", async () => {
    const s = service({ attempts: new Set(["att_2"]) });
    expect(await refusal(s.attach("docs", "att_1"))).toEqual({
      code: "STALE_EPOCH",
      details: { reason_code: "attempt_ended", receipt_id: "receipt-1" },
    });
    expect(s.store.receipts[0]?.result).toMatchObject({
      attempt_id: "att_1",
      repository_id: "docs",
      reason_code: "attempt_ended",
    });
    expect(s.store.rows.size).toBe(0);
  });

  test("waits for the worker's report and answers what it fetched", async () => {
    let store: ReturnType<typeof memoryAttachmentStore> | undefined;
    let sleeps = 0;
    const s = service({
      waitMs: 1_000,
      onSleep: async () => {
        if (++sleeps === 3) {
          await store?.settle(SESSION, [
            { repository_id: "docs", status: "attached", commit: COMMIT },
          ]);
        }
      },
    });
    store = s.store;
    expect(await s.attach("docs")).toMatchObject({
      status: "attached",
      commit: COMMIT,
      already_attached: false,
    });
    expect(sleeps).toBe(3);
  });

  test("answers pending once the wait runs out, and the outcome on a later call", async () => {
    let sleeps = 0;
    const s = service({
      waitMs: 50,
      onSleep: () => {
        sleeps += 1;
      },
    });
    expect((await s.attach("docs")).status).toBe("pending");
    expect(sleeps).toBe(5);
    await s.store.settle(SESSION, [
      { repository_id: "docs", status: "failed", failure: "fetch_timeout" },
    ]);
    expect(await s.attach("docs")).toMatchObject({
      status: "pending",
      receipt_id: "receipt-2",
    });
    expect(s.store.receipts.map((r) => r.status)).toEqual([
      "failed",
      "accepted",
    ]);
  });

  test("a retry from the next attempt after a crash attaches nothing twice", async () => {
    const attempts = new Set(["att_1"]);
    const s = service({ attempts });
    const first = await s.attach("docs", "att_1");
    // The worker died before reporting; the next attempt's agent asks again.
    attempts.delete("att_1");
    attempts.add("att_2");
    const retried = await s.attach("docs", "att_2");
    expect(retried).toEqual(first);
    expect(s.store.receipts).toHaveLength(1);
    // Both workers report; only the first report settles.
    await s.store.settle(SESSION, [
      { repository_id: "docs", status: "attached", commit: COMMIT },
    ]);
    await s.store.settle(SESSION, [
      { repository_id: "docs", status: "failed", failure: "fetch_failed" },
    ]);
    expect(s.store.rows.get("docs")).toMatchObject({
      status: "attached",
      commit: COMMIT,
    });
    expect(s.store.receipts.map((r) => r.status)).toEqual(["succeeded"]);
  });
});
