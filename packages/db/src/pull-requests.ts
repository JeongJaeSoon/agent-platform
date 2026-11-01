import { randomUUID } from "node:crypto";
import type {
  GitHubPullRequestOutcomeMetadata,
  PullRequest,
  PullRequestReceiptResult,
  PushRequestState,
} from "@werft-ai/contracts";
import {
  PULL_REQUEST_REFUSAL_ERRORS,
  type PullRequestReceipt,
  type PullRequestStore,
} from "@werft-ai/platform";
import { and, desc, eq, isNotNull } from "drizzle-orm";
import type { Database } from "./queries.ts";
import {
  agentReleases,
  pullRequests,
  pushRequests,
  receipts,
  sessionOutcomes,
  sessions,
} from "./schema.ts";

type Row = typeof pullRequests.$inferSelect;

function publicPullRequest(row: Row): PullRequest {
  if (
    row.pushRequestId === null ||
    row.sessionId === null ||
    row.repositoryId === null ||
    row.number === null ||
    row.head === null ||
    row.base === null ||
    row.receiptId === null ||
    row.createdAt === null
  ) {
    throw new Error("pull request row predates push requests");
  }
  return {
    push_request_id: row.pushRequestId,
    session_id: row.sessionId,
    repository_id: row.repositoryId,
    number: row.number,
    url: row.url,
    head: row.head,
    base: row.base,
    created_at: row.createdAt.toISOString(),
    receipt_id: row.receiptId,
  };
}

async function insertReceipt(
  tx: Database,
  input: PullRequestReceipt,
): Promise<string> {
  const id = randomUUID();
  const { refusal } = input.result;
  await tx.insert(receipts).values({
    id,
    ownerId: input.ownerId,
    operation: input.operation,
    targetRef: {
      session_id: input.sessionId,
      turn_id: null,
      request_id: input.result.push_request_id,
    },
    status: refusal === null ? "succeeded" : "failed",
    result: input.result,
    error: refusal === null ? null : PULL_REQUEST_REFUSAL_ERRORS[refusal],
    actor: input.actor,
  });
  return id;
}

/**
 * The `github_pull_request` outcome of a recorded pull request, its agent
 * copied from the session's release. Kept if the session already has one
 * for the URL.
 */
export async function insertPullRequestOutcome(
  tx: Database,
  input: {
    ownerId: string;
    sessionId: string;
    url: string;
    repositoryId: string;
    number: number;
    head: string;
    base: string;
    adopted: boolean | null;
    receiptId: string;
    createdAt: Date;
  },
): Promise<void> {
  const [release] = await tx
    .select({
      agentReleaseId: sessions.agentReleaseId,
      agentId: agentReleases.agentId,
    })
    .from(sessions)
    .leftJoin(agentReleases, eq(agentReleases.id, sessions.agentReleaseId))
    .where(eq(sessions.id, input.sessionId))
    .limit(1);
  await tx
    .insert(sessionOutcomes)
    .values({
      id: randomUUID(),
      ownerId: input.ownerId,
      sessionId: input.sessionId,
      agentReleaseId: release?.agentReleaseId ?? null,
      agentId: release?.agentId ?? null,
      type: "github_pull_request",
      url: input.url,
      repositoryId: input.repositoryId,
      externalId: String(input.number),
      state: "open",
      stateChangedAt: input.createdAt,
      metadata: {
        head: input.head,
        base: input.base,
        adopted: input.adopted,
        merge_commit_sha: null,
        additions: null,
        deletions: null,
        changed_files: null,
        commits: null,
      } satisfies GitHubPullRequestOutcomeMetadata,
      receiptId: input.receiptId,
      createdAt: input.createdAt,
    })
    .onConflictDoNothing({
      target: [
        sessionOutcomes.sessionId,
        sessionOutcomes.type,
        sessionOutcomes.url,
      ],
    });
}

// Every push request of a session shares its branch, and so its pull request.
async function lockSession(tx: Database, id: string): Promise<void> {
  await tx
    .select({ id: sessions.id })
    .from(sessions)
    .where(eq(sessions.id, id))
    .for("update");
}

async function findSessionRowByUrl(
  tx: Database,
  sessionId: string,
  url: string,
): Promise<Row | undefined> {
  const [row] = await tx
    .select()
    .from(pullRequests)
    .where(
      and(eq(pullRequests.sessionId, sessionId), eq(pullRequests.url, url)),
    )
    .limit(1);
  return row;
}

export function createPostgresPullRequests(db: Database): PullRequestStore {
  async function findPullRequest(
    tx: Database,
    ownerId: string,
    pushRequestId: string,
  ): Promise<PullRequest | null> {
    const [row] = await tx
      .select()
      .from(pullRequests)
      .where(
        and(
          eq(pullRequests.pushRequestId, pushRequestId.toLowerCase()),
          eq(pullRequests.ownerId, ownerId),
        ),
      )
      .limit(1);
    return row ? publicPullRequest(row) : null;
  }

  return {
    async findSource(ownerId, sessionId, pushRequestId) {
      const [row] = await db
        .select()
        .from(pushRequests)
        .where(
          and(
            eq(pushRequests.id, pushRequestId.toLowerCase()),
            eq(pushRequests.sessionId, sessionId.toLowerCase()),
            eq(pushRequests.ownerId, ownerId),
          ),
        )
        .limit(1);
      if (!row) return null;
      return {
        id: row.id,
        sessionId: row.sessionId,
        repositoryId: row.repositoryId,
        repositoryBinding: row.repositoryBinding,
        state: row.state as PushRequestState,
        targetBranch: row.targetBranch,
        gitCommit: row.gitCommit,
      };
    },

    findPullRequest(ownerId, pushRequestId) {
      return findPullRequest(db, ownerId, pushRequestId);
    },

    async findBranchPullRequest(ownerId, sessionId, head) {
      const [row] = await db
        .select()
        .from(pullRequests)
        .where(
          and(
            eq(pullRequests.ownerId, ownerId),
            eq(pullRequests.sessionId, sessionId.toLowerCase()),
            eq(pullRequests.head, head),
            isNotNull(pullRequests.pushRequestId),
          ),
        )
        .orderBy(desc(pullRequests.createdAt))
        .limit(1);
      return row ? publicPullRequest(row) : null;
    },

    recordReceipt(input) {
      return insertReceipt(db, input);
    },

    savePullRequest(input) {
      return db.transaction(async (tx) => {
        await lockSession(tx, input.sessionId);
        const same = await findSessionRowByUrl(tx, input.sessionId, input.url);
        const recorded =
          (await findPullRequest(tx, input.ownerId, input.pushRequestId)) ??
          (same?.pushRequestId != null ? publicPullRequest(same) : null);
        const shown = recorded ?? {
          repository_id: input.repositoryId,
          number: input.number,
          url: input.url,
          head: input.head,
          base: input.base,
        };
        const created =
          recorded === null && same === undefined && input.created;
        const receiptId = await insertReceipt(tx, {
          ...input,
          operation: "open_pull_request",
          result: {
            push_request_id: input.pushRequestId,
            verdict: "allow",
            refusal: null,
            repository_id: shown.repository_id,
            number: shown.number,
            url: shown.url,
            head: shown.head,
            base: shown.base,
            created,
          } satisfies PullRequestReceiptResult,
        });
        if (recorded !== null) {
          return { pullRequest: recorded, created: false, receiptId };
        }
        const values = {
          sessionId: input.sessionId,
          url: input.url,
          pushRequestId: input.pushRequestId,
          ownerId: input.ownerId,
          repositoryId: input.repositoryId,
          number: input.number,
          head: input.head,
          base: input.base,
          receiptId,
        };
        // A row from before push requests is filled in, not duplicated.
        const [row] =
          same === undefined
            ? await tx.insert(pullRequests).values(values).returning()
            : await tx
                .update(pullRequests)
                .set({ ...values, createdAt: new Date() })
                .where(
                  and(
                    eq(pullRequests.sessionId, input.sessionId),
                    eq(pullRequests.url, input.url),
                  ),
                )
                .returning();
        if (!row) throw new Error("pull request insert returned no row");
        await insertPullRequestOutcome(tx, {
          ownerId: input.ownerId,
          sessionId: input.sessionId,
          url: input.url,
          repositoryId: input.repositoryId,
          number: input.number,
          head: input.head,
          base: input.base,
          adopted: !input.created,
          receiptId,
          createdAt: row.createdAt ?? new Date(),
        });
        return { pullRequest: publicPullRequest(row), created, receiptId };
      });
    },
  };
}
