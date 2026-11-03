import { randomUUID } from "node:crypto";
import {
  agentGitHubSchema,
  GITHUB_MCP_TOOL_ARGUMENTS,
  type GitHubMcpTool,
  OPEN_PUSH_REQUEST_STATES,
  type PushDecider,
  type PushReceiptResult,
  type PushRequest,
  type PushRequestState,
  pushBranchFor,
  type ReceiptActor,
} from "@werft-ai/contracts";
import {
  PUSH_REFUSAL_ERRORS,
  type PushJob,
  type PushRefusalRecord,
  type PushRequestDisplayReader,
  type PushRequestStore,
  type PushWriteResult,
  type ToolSummaryContext,
} from "@werft-ai/platform";
import { and, desc, eq, inArray, type SQL, sql } from "drizzle-orm";
import {
  findIdempotent,
  type IdempotencyScope,
  lockIdempotencyScope,
} from "./control-shared.ts";
import type { Database } from "./queries.ts";
import {
  agentReleases,
  agents,
  catalogRepositories,
  idempotencyKeys,
  pushRequests,
  receipts,
  sessions,
} from "./schema.ts";

type Row = typeof pushRequests.$inferSelect;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const GITHUB_TOOL = "mcp__github__";

/** The catalog's owner/name for a repository id, null without a row. */
export const catalogName = (repositoryId: SQL) => sql<string | null>`(
  SELECT c.owner || '/' || c.name FROM ${catalogRepositories} c
  WHERE c.id = ${repositoryId}
)`;

async function repositoryName(
  db: Database,
  repositoryId: string,
): Promise<string> {
  const [row] = await db
    .select({
      owner: catalogRepositories.owner,
      name: catalogRepositories.name,
    })
    .from(catalogRepositories)
    .where(eq(catalogRepositories.id, repositoryId))
    .limit(1);
  return row ? `${row.owner}/${row.name}` : repositoryId;
}

/**
 * What a GitHub tool's input points at, read from the platform's rows: a
 * push request's repository and branch, or the repository an id names (the
 * id itself when the catalog has no row for it). Empty for any other tool,
 * an input that does not parse, or a push request of another session.
 */
export async function toolSummaryContext(
  db: Database,
  sessionId: string,
  tool: string,
  input: unknown,
): Promise<ToolSummaryContext> {
  const name = tool.startsWith(GITHUB_TOOL)
    ? tool.slice(GITHUB_TOOL.length)
    : "";
  if (!Object.hasOwn(GITHUB_MCP_TOOL_ARGUMENTS, name)) return {};
  const parsed =
    GITHUB_MCP_TOOL_ARGUMENTS[name as GitHubMcpTool].safeParse(input);
  if (!parsed.success) return {};
  const args = parsed.data as {
    push_request_id?: string;
    repository_id?: string;
    branch?: string;
  };
  if (args.push_request_id !== undefined) {
    if (!UUID.test(args.push_request_id) || !UUID.test(sessionId)) return {};
    const [row] = await db
      .select({
        repositoryId: pushRequests.repositoryId,
        repositoryName: catalogName(sql`${pushRequests.repositoryId}`),
        targetBranch: pushRequests.targetBranch,
      })
      .from(pushRequests)
      .where(
        and(
          eq(pushRequests.id, args.push_request_id.toLowerCase()),
          eq(pushRequests.sessionId, sessionId.toLowerCase()),
        ),
      )
      .limit(1);
    return row
      ? {
          repository: row.repositoryName ?? row.repositoryId,
          branch: row.targetBranch,
        }
      : {};
  }
  if (name === "attach_repository" && args.repository_id !== undefined) {
    return { repository: await repositoryName(db, args.repository_id) };
  }
  if (name !== "request_push" || !UUID.test(sessionId)) return {};
  let repositoryId = args.repository_id ?? null;
  if (repositoryId === null) {
    const [session] = await db
      .select({ repositoryId: sessions.repositoryId })
      .from(sessions)
      .where(eq(sessions.id, sessionId.toLowerCase()))
      .limit(1);
    repositoryId = session?.repositoryId ?? null;
  }
  return {
    ...(repositoryId === null
      ? {}
      : { repository: await repositoryName(db, repositoryId) }),
    branch: pushBranchFor(sessionId.toLowerCase(), args.branch),
  };
}

function publicPushRequest(row: Row): PushRequest {
  return {
    id: row.id,
    session_id: row.sessionId,
    repository_id: row.repositoryId,
    checkpoint_revision: row.checkpointRevision,
    git_commit: row.gitCommit,
    target_branch: row.targetBranch,
    state: row.state as PushRequestState,
    requested_by: row.requestedBy as ReceiptActor,
    requested_at: row.createdAt.toISOString(),
    resolved_by: (row.decidedBy as PushDecider | null) ?? null,
    resolved_at: row.decidedAt?.toISOString() ?? null,
    resolution_reason: row.decisionReason,
    request_receipt_id: row.requestReceiptId,
    resolution_receipt_id: row.decisionReceiptId,
    finished_at: row.finishedAt?.toISOString() ?? null,
    push_receipt_id: row.pushReceiptId,
  };
}

function resultOf(
  row: Row | null,
  fields: Pick<
    PushReceiptResult,
    "action" | "verdict" | "refusal" | "decider_key"
  >,
): PushReceiptResult {
  return {
    push_request_id: row?.id ?? null,
    ...fields,
    repository_id: row?.repositoryId ?? null,
    checkpoint_revision: row?.checkpointRevision ?? null,
    git_commit: row?.gitCommit ?? null,
    target_branch: row?.targetBranch ?? null,
  };
}

async function insertRefusal(
  tx: Database,
  input: PushRefusalRecord,
): Promise<string> {
  const id = randomUUID();
  await tx.insert(receipts).values({
    id,
    ownerId: input.ownerId,
    operation: input.operation,
    targetRef: {
      session_id: input.sessionId,
      turn_id: null,
      request_id: input.result.push_request_id,
    },
    status: "failed",
    result: input.result,
    error: PUSH_REFUSAL_ERRORS[input.refusal],
    actor: input.actor,
  });
  return id;
}

// The receipts here carry their own actor; the scope only finds the key.
function createScope(
  ownerId: string,
  sessionId: string,
  key: string,
): IdempotencyScope {
  return {
    principal: ownerId,
    operation: "request_push",
    resource: sessionId.toLowerCase(),
    key,
    actor: null,
    requestId: null,
  };
}

async function replayCreate(
  tx: Database,
  scope: ReturnType<typeof createScope>,
  payloadHash: string,
): Promise<PushWriteResult | null> {
  const existing = await findIdempotent(tx, scope);
  if (!existing) return null;
  if (existing.payloadHash !== payloadHash) return { outcome: "conflict" };
  const [row] = await tx
    .select()
    .from(pushRequests)
    .where(eq(pushRequests.requestReceiptId, existing.receiptId))
    .limit(1);
  return row ? { outcome: "replayed", request: publicPushRequest(row) } : null;
}

export function createPostgresPushRequests(
  db: Database,
): PushRequestStore & PushRequestDisplayReader {
  return {
    async findSession(ownerId, sessionId) {
      const [row] = await db
        .select({
          repositoryId: sessions.repositoryId,
          profileId: sessions.profileId,
          attached: sessions.attachedRepositoryIds,
          releaseId: agentReleases.id,
          // Only an explicit false: a release without GitHub settings, or
          // with a shape this image does not know, keeps a person deciding.
          approvalOff: sql<boolean>`coalesce(${agentReleases.policyPins} -> 'github' -> 'push_approval' = 'false'::jsonb, false)`,
          github: sql<unknown>`${agentReleases.policyPins} -> 'github'`,
          githubEnabled: agents.githubEnabled,
        })
        .from(sessions)
        .leftJoin(agentReleases, eq(agentReleases.id, sessions.agentReleaseId))
        .leftJoin(agents, eq(agents.id, agentReleases.agentId))
        .where(
          and(
            eq(sessions.id, sessionId.toLowerCase()),
            eq(sessions.ownerId, ownerId),
          ),
        )
        .limit(1);
      if (row === undefined) return null;
      const github =
        row.github === null || row.github === undefined
          ? null
          : agentGitHubSchema.safeParse(row.github);
      return {
        repositoryId: row.repositoryId,
        profileId: row.profileId,
        attached: row.attached,
        github:
          github === null ? null : github.success ? github.data : "invalid",
        githubEnabled: row.githubEnabled ?? false,
        approvalOffRelease:
          row.approvalOff && row.releaseId !== null ? row.releaseId : null,
      };
    },

    recordRefusal(input) {
      return insertRefusal(db, input);
    },

    replayCreate(input) {
      return replayCreate(
        db,
        createScope(input.ownerId, input.sessionId, input.idempotencyKey),
        input.payloadHash,
      );
    },

    create(input): Promise<PushWriteResult> {
      const sessionId = input.sessionId.toLowerCase();
      const targetBranch = input.targetBranch ?? pushBranchFor(sessionId);
      const scope = createScope(input.ownerId, sessionId, input.idempotencyKey);
      const refuse = async (
        tx: Database,
        refusal: "not_found" | "request_open" | "checkpoint_moved",
        row: Row | null,
      ): Promise<PushWriteResult> => ({
        outcome: "refused",
        refusal,
        receiptId: await insertRefusal(tx, {
          ownerId: input.ownerId,
          sessionId,
          actor: input.actor,
          operation: "request_push",
          refusal,
          result: resultOf(row, {
            action: null,
            verdict: "refuse",
            refusal,
          }),
        }),
      });
      return db.transaction(async (tx) => {
        await lockIdempotencyScope(tx, scope);
        const replay = await replayCreate(tx, scope, input.payloadHash);
        if (replay) return replay;
        const [session] = await tx
          .select({ checkpointRevision: sessions.checkpointRevision })
          .from(sessions)
          .where(
            and(
              eq(sessions.id, sessionId),
              eq(sessions.ownerId, input.ownerId),
            ),
          )
          .limit(1)
          .for("update");
        if (!session) return refuse(tx, "not_found", null);
        const [open] = await tx
          .select()
          .from(pushRequests)
          .where(
            and(
              eq(pushRequests.sessionId, sessionId),
              eq(pushRequests.repositoryId, input.repositoryId),
              eq(pushRequests.targetBranch, targetBranch),
              inArray(pushRequests.state, [...OPEN_PUSH_REQUEST_STATES]),
            ),
          )
          .limit(1);
        if (open) return refuse(tx, "request_open", open);
        if (session.checkpointRevision !== input.checkpointRevision) {
          return refuse(tx, "checkpoint_moved", null);
        }
        const id = randomUUID();
        const receiptId = randomUUID();
        await tx.insert(receipts).values({
          id: receiptId,
          ownerId: input.ownerId,
          operation: "request_push",
          targetRef: { session_id: sessionId, turn_id: null, request_id: id },
          status: "succeeded",
          result: {
            push_request_id: id,
            action: null,
            verdict: "allow",
            refusal: null,
            repository_id: input.repositoryId,
            checkpoint_revision: input.checkpointRevision,
            git_commit: input.gitCommit,
            target_branch: targetBranch,
          } satisfies PushReceiptResult,
          actor: input.actor,
        });
        await tx.insert(idempotencyKeys).values({
          ...scope,
          payloadHash: input.payloadHash,
          receiptId,
        });
        // A release that pushes without a person's approval decides here,
        // in the request's own transaction (design github-agent.md
        // decision 6); the executor sees an approved row as for any other.
        const policy =
          input.approvedByRelease === null
            ? null
            : {
                decider: {
                  kind: "policy",
                  agent_release_id: input.approvedByRelease,
                } satisfies PushDecider,
                receiptId: randomUUID(),
              };
        if (policy !== null) {
          await tx.insert(receipts).values({
            id: policy.receiptId,
            ownerId: input.ownerId,
            operation: "resolve_push",
            targetRef: { session_id: sessionId, turn_id: null, request_id: id },
            status: "succeeded",
            result: {
              push_request_id: id,
              action: "approve",
              verdict: "allow",
              refusal: null,
              repository_id: input.repositoryId,
              checkpoint_revision: input.checkpointRevision,
              git_commit: input.gitCommit,
              target_branch: targetBranch,
              approved_by: policy.decider,
            } satisfies PushReceiptResult,
            // No one decided: the release's policy did.
            actor: null,
          });
        }
        const [row] = await tx
          .insert(pushRequests)
          .values({
            id,
            ownerId: input.ownerId,
            sessionId,
            repositoryId: input.repositoryId,
            repositoryBinding: input.repositoryBinding,
            checkpointRevision: input.checkpointRevision,
            gitCommit: input.gitCommit,
            targetBranch,
            requestedBy: input.actor,
            requestReceiptId: receiptId,
            ...(policy === null
              ? {}
              : {
                  state: "approved",
                  decidedBy: policy.decider,
                  decidedAt: sql`now()`,
                  decisionReceiptId: policy.receiptId,
                }),
          })
          .returning();
        if (!row) throw new Error("push request insert returned no row");
        return { outcome: "written", request: publicPushRequest(row) };
      });
    },

    async list(ownerId, sessionId) {
      const session = await this.findSession(ownerId, sessionId);
      if (!session) return null;
      const rows = await db
        .select()
        .from(pushRequests)
        .where(
          and(
            eq(pushRequests.sessionId, sessionId.toLowerCase()),
            eq(pushRequests.ownerId, ownerId),
          ),
        )
        .orderBy(desc(pushRequests.createdAt), desc(pushRequests.id));
      return rows.map(publicPushRequest);
    },

    async get(ownerId, sessionId, pushRequestId) {
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
      return row ? publicPushRequest(row) : null;
    },

    async displayOf(ownerId, sessionId, pushRequestId) {
      if (!UUID.test(sessionId) || !UUID.test(pushRequestId)) return null;
      const [row] = await db
        .select({
          repositoryId: pushRequests.repositoryId,
          repositoryName: catalogName(sql`${pushRequests.repositoryId}`),
          targetBranch: pushRequests.targetBranch,
          gitCommit: pushRequests.gitCommit,
          state: pushRequests.state,
          decidedBy: pushRequests.decidedBy,
          createdAt: pushRequests.createdAt,
        })
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
      const decider = (row.decidedBy as { actor_user_id?: unknown } | null)
        ?.actor_user_id;
      return {
        repositoryId: row.repositoryId,
        repositoryName: row.repositoryName,
        targetBranch: row.targetBranch,
        gitCommit: row.gitCommit,
        state: row.state as PushRequestState,
        decidedByUserId: typeof decider === "string" ? decider : null,
        createdAt: row.createdAt.toISOString(),
      };
    },

    decide(input): Promise<PushWriteResult> {
      const sessionId = input.sessionId.toLowerCase();
      const pushRequestId = input.pushRequestId.toLowerCase();
      const scope: IdempotencyScope = {
        principal: input.ownerId,
        // The name before the receipt rename, so a retry across it replays.
        operation: "decide_push",
        resource: pushRequestId,
        key: input.idempotencyKey,
        actor: null,
        requestId: null,
      };
      return db.transaction(async (tx) => {
        const refuse = async (
          refusal:
            | "not_found"
            | "already_resolved"
            | "checkpoint_moved"
            | "commit_mismatch",
          row: Row | null,
        ): Promise<PushWriteResult> => ({
          outcome: "refused",
          refusal,
          receiptId: await insertRefusal(tx, {
            ownerId: input.ownerId,
            sessionId,
            actor: input.actor,
            operation: "resolve_push",
            refusal,
            result: resultOf(row, {
              action: input.decision,
              verdict: "refuse",
              refusal,
              decider_key: input.deciderKey ?? null,
            }),
          }),
        });
        await lockIdempotencyScope(tx, scope);
        const existing = await findIdempotent(tx, scope);
        if (existing) {
          if (existing.payloadHash !== input.payloadHash) {
            return { outcome: "conflict" };
          }
          const [row] = await tx
            .select()
            .from(pushRequests)
            .where(
              and(
                eq(pushRequests.decisionReceiptId, existing.receiptId),
                eq(pushRequests.sessionId, sessionId),
                eq(pushRequests.ownerId, input.ownerId),
              ),
            )
            .limit(1);
          if (row)
            return { outcome: "replayed", request: publicPushRequest(row) };
        }
        // FOR SHARE holds the checkpoint pointer still until the decision
        // commits, so an approval can never land on a moved pointer.
        const [session] = await tx
          .select({ checkpointRevision: sessions.checkpointRevision })
          .from(sessions)
          .where(
            and(
              eq(sessions.id, sessionId),
              eq(sessions.ownerId, input.ownerId),
            ),
          )
          .limit(1)
          .for("share");
        if (!session) return refuse("not_found", null);
        const [row] = await tx
          .select()
          .from(pushRequests)
          .where(
            and(
              eq(pushRequests.id, pushRequestId),
              eq(pushRequests.sessionId, sessionId),
            ),
          )
          .limit(1)
          .for("update");
        if (!row) return refuse("not_found", null);
        if (row.state !== "requested") return refuse("already_resolved", row);
        if (input.decision === "approve") {
          if (input.gitCommit !== row.gitCommit) {
            return refuse("commit_mismatch", row);
          }
          // A later checkpoint of the same commit still pushes what the
          // person approved: the push runs from the pinned revision.
          const sameCommit =
            input.latest?.revision === session.checkpointRevision &&
            input.latest.gitCommit === row.gitCommit;
          if (
            session.checkpointRevision !== row.checkpointRevision &&
            !sameCommit
          ) {
            return refuse("checkpoint_moved", row);
          }
        }
        const receiptId = randomUUID();
        await tx.insert(receipts).values({
          id: receiptId,
          ownerId: input.ownerId,
          operation: "resolve_push",
          targetRef: {
            session_id: sessionId,
            turn_id: null,
            request_id: row.id,
          },
          status: "succeeded",
          result: resultOf(row, {
            action: input.decision,
            verdict: "allow",
            refusal: null,
            decider_key: input.deciderKey ?? null,
          }),
          actor: input.actor,
        });
        await tx.insert(idempotencyKeys).values({
          ...scope,
          payloadHash: input.payloadHash,
          receiptId,
        });
        const [decided] = await tx
          .update(pushRequests)
          .set({
            state: input.decision === "approve" ? "approved" : "rejected",
            decidedBy: input.actor,
            decidedAt: sql`now()`,
            decisionReason: input.reason,
            decisionReceiptId: receiptId,
          })
          .where(eq(pushRequests.id, row.id))
          .returning();
        if (!decided) throw new Error("push request update returned no row");
        return { outcome: "written", request: publicPushRequest(decided) };
      });
    },

    async claimNextApproved(leaseMs): Promise<PushJob | null> {
      const [row] = await db
        .update(pushRequests)
        .set({
          state: "pushing",
          pushStartedAt: sql`now()`,
          pushAttempts: sql`${pushRequests.pushAttempts} + 1`,
          leaseExpiresAt: sql`now() + make_interval(secs => ${leaseMs / 1000})`,
        })
        .where(
          eq(
            pushRequests.id,
            sql`(SELECT ${pushRequests.id} FROM ${pushRequests} WHERE ${pushRequests.state} = 'approved' OR (${pushRequests.state} = 'pushing' AND (${pushRequests.leaseExpiresAt} IS NULL OR ${pushRequests.leaseExpiresAt} < now())) ORDER BY ${pushRequests.createdAt} LIMIT 1 FOR UPDATE SKIP LOCKED)`,
          ),
        )
        .returning();
      if (!row) return null;
      return {
        id: row.id,
        ownerId: row.ownerId,
        sessionId: row.sessionId,
        repositoryId: row.repositoryId,
        repositoryBinding: row.repositoryBinding,
        checkpointRevision: row.checkpointRevision,
        gitCommit: row.gitCommit,
        targetBranch: row.targetBranch,
        attempt: row.pushAttempts,
      };
    },

    finish(job, outcome) {
      return db.transaction(async (tx) => {
        const [row] = await tx
          .select()
          .from(pushRequests)
          .where(
            and(
              eq(pushRequests.id, job.id),
              eq(pushRequests.state, "pushing"),
              eq(pushRequests.pushAttempts, job.attempt),
            ),
          )
          .limit(1)
          .for("update");
        if (!row) return false;
        const pushed = outcome.state === "pushed";
        const error = pushed ? null : PUSH_REFUSAL_ERRORS[outcome.refusal];
        const receiptId = randomUUID();
        await tx.insert(receipts).values({
          id: receiptId,
          ownerId: row.ownerId,
          operation: "push",
          targetRef: {
            session_id: row.sessionId,
            turn_id: null,
            request_id: row.id,
          },
          status: pushed ? "succeeded" : "failed",
          result: {
            ...resultOf(row, {
              action: null,
              verdict: pushed ? "allow" : "refuse",
              refusal: pushed ? null : outcome.refusal,
            }),
            remote_url: outcome.remoteUrl ?? null,
            remote_ref: outcome.remoteRef ?? null,
            previous_commit: pushed ? outcome.previousCommit : null,
            approved_by: (row.decidedBy as PushDecider | null) ?? null,
            reason_code:
              outcome.state === "failed" ? (outcome.reasonCode ?? null) : null,
          } satisfies PushReceiptResult,
          error,
        });
        await tx
          .update(pushRequests)
          .set({
            state: outcome.state,
            finishedAt: sql`now()`,
            leaseExpiresAt: null,
            pushError: error,
            pushReceiptId: receiptId,
          })
          .where(eq(pushRequests.id, row.id));
        return true;
      });
    },
  };
}
