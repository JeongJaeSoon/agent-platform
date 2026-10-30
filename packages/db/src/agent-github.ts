import { randomUUID } from "node:crypto";
import type { AgentGitHubStore } from "@werft-ai/platform";
import { and, desc, eq, inArray, or, sql } from "drizzle-orm";
import { actorStillMember, receiptActorOf } from "./control-shared.ts";
import { receiptFromRow } from "./postgres-unit-of-work.ts";
import type { Database } from "./queries.ts";
import { agentReleases, agents, receipts, sessions } from "./schema.ts";
import { sessionVisibleTo } from "./session-shares.ts";

/** Receipts naming the agent; a release or activation only when it moved `github`. */
const AGENT_OPERATIONS = [
  "set_agent_github",
  "create_agent_release",
  "activate_agent",
] as const;
/** The gate's and the work service's receipts, which name a session. */
const SESSION_OPERATIONS = [
  "mint_github_token",
  "review_pull_request",
  "dispatch_workflow",
  "rerun_workflow",
] as const;

export function createPostgresAgentGitHubStore(db: Database): AgentGitHubStore {
  return {
    async enabled(workspaceId, agentId) {
      const [row] = await db
        .select({ enabled: agents.githubEnabled })
        .from(agents)
        .where(
          and(
            eq(agents.workspaceId, workspaceId),
            eq(agents.id, agentId.toLowerCase()),
          ),
        )
        .limit(1);
      return row?.enabled ?? null;
    },

    setEnabled(input) {
      return db.transaction(async (tx) => {
        if (!(await actorStillMember(tx, input.principal))) {
          return { outcome: "actor_inactive" as const };
        }
        const agentId = input.agentId.toLowerCase();
        const [held] = await tx
          .select({ enabled: agents.githubEnabled })
          .from(agents)
          .where(
            and(
              eq(agents.workspaceId, input.workspaceId),
              eq(agents.id, agentId),
            ),
          )
          .limit(1)
          .for("update");
        if (held === undefined) return { outcome: "not_found" as const };
        if (held.enabled === input.enabled) {
          return { outcome: "saved" as const, receiptId: null };
        }
        await tx
          .update(agents)
          .set({ githubEnabled: input.enabled })
          .where(eq(agents.id, agentId));
        const receiptId = randomUUID();
        await tx.insert(receipts).values({
          id: receiptId,
          ownerId: input.principal.ownerId,
          actor: receiptActorOf(input.principal),
          operation: "set_agent_github",
          targetRef: {
            resource: { kind: "agent", id: agentId },
            workspace_id: input.workspaceId,
          },
          status: "succeeded",
          result: { agent_id: agentId, enabled: input.enabled },
        });
        return { outcome: "saved" as const, receiptId };
      });
    },

    async activity(workspaceId, agentId, viewer, limit) {
      const id = agentId.toLowerCase();
      const agentTarget = and(
        inArray(receipts.operation, [...AGENT_OPERATIONS]),
        sql`${receipts.targetRef} -> 'resource' = ${JSON.stringify({ kind: "agent", id })}::jsonb`,
        or(
          eq(receipts.operation, "set_agent_github"),
          sql`${receipts.result} -> 'github_changed' = 'true'::jsonb`,
        ),
      );
      // Filtered before the limit, so sessions the caller cannot see never
      // take a place among the latest.
      const visibleSession = and(
        inArray(receipts.operation, [...SESSION_OPERATIONS]),
        sql`EXISTS (SELECT 1 FROM ${sessions} JOIN ${agentReleases} ON ${agentReleases.id} = ${sessions.agentReleaseId} WHERE ${sessions.id}::text = ${receipts.targetRef} ->> 'session_id' AND ${agentReleases.agentId} = ${id} AND ${sessionVisibleTo(viewer)})`,
      );
      const rows = await db
        .select()
        .from(receipts)
        .where(
          and(
            eq(receipts.ownerId, workspaceId),
            or(agentTarget, visibleSession),
          ),
        )
        .orderBy(desc(receipts.createdAt), desc(receipts.id))
        .limit(limit);
      return rows.map(receiptFromRow);
    },
  };
}
