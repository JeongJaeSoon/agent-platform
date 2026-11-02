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
    attached?: string[] | null;
    waitMs?: number;
    onSleep?: () => Promise<void> | void;
    readMs?: number;
  } = {},
) {
  const store = memoryAttachmentStore(options.attempts, options.attached);
  let clock = 0;
  let reads = 0;
  const find = store.find;
  store.find = async (sessionId, repositoryId) => {
    reads += 1;
    clock += options.readMs ?? 0;
    return find(sessionId, repositoryId);
  };
  const attachments = createRepositoryAttachmentService({
    store,
    context: { context: async () => attachmentContext(options.context) },
    catalog: attachCatalog,
    waitMs: options.waitMs ?? 0,
    pollMs: 10,
    sleep: async (ms) => {
      clock += ms;
      await options.onSleep?.();
    },
    now: () => clock,
  });
  const attach = (repositoryId: string, attemptId = "att_1") =>
    attachments.attach({ sessionId: SESSION, attemptId, actor, repositoryId });
  return {
    store,
    attach,
    list: () => attachments.list(SESSION),
    reads: () => reads,
  };
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

describe("list", () => {
  test("names the session's own and every other one the release allows, unattached ones included", async () => {
    const s = service();
    expect(await s.list()).toEqual({
      repositories: [
        { id: "app", name: "acme/app", branch: "main", status: "primary" },
        { id: "docs", name: "acme/docs", branch: "trunk", status: "available" },
        {
          id: "tools",
          name: "acme/tools",
          branch: "main",
          status: "available",
        },
      ],
    });
  });

  test("an attach in flight is pending; a start list or a null list counts as attached", async () => {
    const pending = service();
    await pending.attach("docs");
    expect(
      (await pending.list()).repositories.map((entry) => entry.status),
    ).toEqual(["primary", "pending", "available"]);

    expect(
      (
        await service({ context: { attachedRepositoryIds: ["tools"] } }).list()
      ).repositories.map((entry) => entry.status),
    ).toEqual(["primary", "available", "attached"]);
    expect(
      (
        await service({ context: { attachedRepositoryIds: null } }).list()
      ).repositories.map((entry) => entry.status),
    ).toEqual(["primary", "attached", "attached"]);
  });

  test("the agent's GitHub off, or no release list, leaves only the session's own", async () => {
    for (const context of [
      {
        agent: { id: "agent-1", workspaceId: "owner-a", githubEnabled: false },
      },
      { release: { id: "release-1", github: null } },
    ]) {
      expect((await service({ context }).list()).repositories).toEqual([
        { id: "app", name: "acme/app", branch: "main", status: "primary" },
      ]);
    }
  });

  test("never carries a credential an old session URL held", async () => {
    const listed = await service({
      context: {
        repository: {
          url: "https://x-access-token:hunter2@github.com/acme/app.git",
          branch: "main",
        },
      },
    }).list();
    expect(listed.repositories[0]?.name).toBe("acme/app");
    expect(JSON.stringify(listed)).not.toContain("hunter2");
    expect(JSON.stringify(listed)).not.toContain("https://");
  });

  test("a session without a repository lists none of its own", async () => {
    expect(
      (
        await service({
          context: { repositoryId: null, repository: null },
        }).list()
      ).repositories.map((entry) => entry.id),
    ).toEqual(["app", "docs", "tools"]);
  });
});

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

  test("one on the list the session started with, or on a null list, is attached already: no row, no receipt, no fetch", async () => {
    for (const attached of [["docs"], null]) {
      const s = service({ attached });
      expect(await s.attach("docs")).toEqual({
        repository_id: "docs",
        status: "attached",
        branch: "trunk",
        commit: null,
        failure: null,
        already_attached: true,
        receipt_id: null,
      });
      expect(s.store.receipts).toEqual([]);
      expect(await s.store.pending(SESSION)).toEqual([]);
      expect(s.store.attached()).toEqual(attached);
    }
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
    expect(s.store.attached()).toEqual(["tools"]);
  });

  test("attaching it again changes nothing and succeeds, pending or attached", async () => {
    const s = service();
    const first = await s.attach("docs");
    expect(first).toMatchObject({ status: "pending", already_attached: false });
    expect(await s.attach("docs")).toEqual(first);
    await s.store.settle(SESSION, [
      {
        repository_id: "docs",
        receipt_id: first.receipt_id ?? "",
        status: "attached",
        commit: COMMIT,
      },
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
            {
              repository_id: "docs",
              receipt_id: "receipt-1",
              status: "attached",
              commit: COMMIT,
            },
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
    expect(sleeps).toBe(4);
    await s.store.settle(SESSION, [
      {
        repository_id: "docs",
        receipt_id: "receipt-1",
        status: "failed",
        failure: "fetch_timeout",
      },
    ]);
    expect(s.store.attached()).toEqual([]);
    expect(await s.attach("docs")).toMatchObject({
      status: "pending",
      receipt_id: "receipt-2",
    });
    expect(s.store.receipts.map((r) => r.status)).toEqual([
      "failed",
      "accepted",
    ]);
  });

  test("the wait counts the time its reads take, not only its sleeps", async () => {
    const s = service({ waitMs: 8_000, readMs: 3_000 });
    expect((await s.attach("docs")).status).toBe("pending");
    // Sleeps alone would read 800 times; three slow reads spend the budget.
    expect(s.reads()).toBe(3);
  });

  test("a read still running at the deadline is cut, and the last state answered", async () => {
    const store = memoryAttachmentStore();
    store.find = () => new Promise(() => {});
    const attachments = createRepositoryAttachmentService({
      store,
      context: { context: async () => attachmentContext() },
      catalog: attachCatalog,
      waitMs: 100,
      pollMs: 10,
    });
    const started = performance.now();
    const answered = await attachments.attach({
      sessionId: SESSION,
      attemptId: "att_1",
      actor,
      repositoryId: "docs",
    });
    expect(answered.status).toBe("pending");
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  test("a resent failure for an earlier request does not settle the request after it", async () => {
    const s = service();
    await s.attach("docs");
    const failed = {
      repository_id: "docs",
      receipt_id: "receipt-1",
      status: "failed" as const,
      failure: "fetch_failed" as const,
    };
    await s.store.settle(SESSION, [failed]);
    // The report's answer was lost; the agent asks again before it is resent.
    const again = await s.attach("docs");
    expect(again).toMatchObject({ status: "pending", receipt_id: "receipt-2" });
    await s.store.settle(SESSION, [failed]);
    expect(s.store.rows.get("docs")).toMatchObject({
      status: "pending",
      receiptId: "receipt-2",
    });
    expect(s.store.attached()).toEqual(["docs"]);
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
    const receipt_id = first.receipt_id ?? "";
    await s.store.settle(SESSION, [
      { repository_id: "docs", receipt_id, status: "attached", commit: COMMIT },
    ]);
    await s.store.settle(SESSION, [
      {
        repository_id: "docs",
        receipt_id,
        status: "failed",
        failure: "fetch_failed",
      },
    ]);
    expect(s.store.rows.get("docs")).toMatchObject({
      status: "attached",
      commit: COMMIT,
    });
    expect(s.store.receipts.map((r) => r.status)).toEqual(["succeeded"]);
  });
});
