import {
  AUDIT_RETENTION_DEFAULT_DAYS,
  AUDIT_RETENTION_MIN_DAYS,
} from "@agent-platform/contracts";
import type {
  AuditRetentionStore,
  DecisionLog,
} from "@agent-platform/platform";
import { eq, sql } from "drizzle-orm";
import { rowsOf } from "./control-unit-of-work.ts";
import type { Database } from "./queries.ts";
import { authzDecisions, workspaces } from "./schema.ts";

export function createPostgresDecisionLog(db: Database): DecisionLog {
  return {
    async record({ request, decision }) {
      const { subject, resource } = request;
      await db.insert(authzDecisions).values({
        id: decision.decision_id,
        ownerId: resource.owner_scope,
        workspaceId: subject.principal?.workspace_id ?? null,
        principalKind: subject.principal?.kind ?? null,
        principalId: subject.principal?.id ?? null,
        actorUserId: subject.actor_user_id ?? null,
        agentId: subject.agent?.agent_id ?? null,
        agentReleaseId: subject.agent?.release_id ?? null,
        linkedAccountId: subject.linked_account?.id ?? null,
        linkedAccountRevision: subject.linked_account?.revision ?? null,
        surface: subject.surface,
        action: request.action,
        resourceKind: resource.kind,
        resourceId: resource.id,
        outcome: decision.outcome,
        reasonCode: decision.reason_code,
        justification: subject.justification ?? null,
        policyVersion: decision.policy_version,
        requestId: request.request_id,
      });
    },
  };
}

export function createPostgresAuditRetention(
  db: Database,
): AuditRetentionStore {
  return {
    async setAuditRetentionDays(workspaceId, days) {
      const rows = await db
        .update(workspaces)
        .set({
          settings: sql`jsonb_set(${workspaces.settings}, '{audit_retention_days}', to_jsonb(${days}::int))`,
        })
        .where(eq(workspaces.id, workspaceId))
        .returning({ id: workspaces.id });
      return rows.length > 0;
    },
  };
}

/**
 * Deletes up to `limit` rows older than their workspace keeps them, oldest
 * first, on the database clock. A row with no workspace keeps the default.
 * The floor is applied again here so a setting written around the API
 * cannot shorten it.
 */
export async function expireAuthzDecisions(
  db: Database,
  input: { limit: number; dryRun: boolean },
): Promise<number> {
  const expired = sql`
    SELECT d.id FROM ${authzDecisions} d
    LEFT JOIN ${workspaces} w ON w.id = d.workspace_id
    WHERE d.at < clock_timestamp() - make_interval(days => greatest(
      ${AUDIT_RETENTION_MIN_DAYS}::int,
      coalesce(
        CASE WHEN jsonb_typeof(w.settings -> 'audit_retention_days') = 'number'
          THEN floor((w.settings ->> 'audit_retention_days')::numeric)::int END,
        ${AUDIT_RETENTION_DEFAULT_DAYS}::int
      )
    ))
    ORDER BY d.at
    LIMIT ${input.limit}`;
  const result = await db.execute<{ id: string }>(
    input.dryRun
      ? expired
      : sql`DELETE FROM ${authzDecisions} WHERE id IN (${expired} FOR UPDATE OF d SKIP LOCKED) RETURNING id`,
  );
  return rowsOf<{ id: string }>(result).length;
}
