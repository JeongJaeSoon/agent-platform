import type { ReceiptActor } from "@werft-ai/contracts";
import {
  type McpEgressStore,
  type McpRefusalRecord,
  type McpSessionState,
  pinnedMcpTools,
  type SessionMcp,
} from "@werft-ai/platform";
import { and, eq, isNull } from "drizzle-orm";
import type { Database } from "./queries.ts";
import {
  agentReleases,
  agentVersions,
  credentialBindings,
  receipts,
  sessions,
  turns,
  workspaces,
} from "./schema.ts";

type ReleaseMcp = {
  agentId: string;
  server: string | null;
  perTool: Record<string, string>;
};

// Read off the stored card and pins without the full schemas: a release is
// immutable and was parsed whole when it was made.
async function releaseMcpOf(
  executor: Database,
  releaseId: string,
): Promise<ReleaseMcp | null> {
  const [release] = await executor
    .select({
      agentId: agentReleases.agentId,
      card: agentVersions.card,
      policyPins: agentReleases.policyPins,
    })
    .from(agentReleases)
    .innerJoin(
      agentVersions,
      and(
        eq(agentVersions.id, agentReleases.versionId),
        eq(agentVersions.agentId, agentReleases.agentId),
      ),
    )
    .where(eq(agentReleases.id, releaseId))
    .limit(1);
  if (!release) return null;
  const card = release.card as {
    capabilities?: { mcp?: Array<{ server?: unknown }> | null };
  };
  const server = card.capabilities?.mcp?.[0]?.server;
  const pins = release.policyPins as {
    tools?: { per_tool?: Record<string, string> };
  };
  return {
    agentId: release.agentId,
    server: typeof server === "string" ? server : null,
    perTool: pins.tools?.per_tool ?? {},
  };
}

/** The MCP server a claimed session's release names, for its claim. */
export async function sessionMcpOf(
  executor: Database,
  session: { agentReleaseId: string | null },
): Promise<SessionMcp | null> {
  if (session.agentReleaseId === null) return null;
  const release = await releaseMcpOf(executor, session.agentReleaseId);
  if (release === null || release.server === null) return null;
  return {
    releaseId: session.agentReleaseId,
    server: release.server,
    tools: pinnedMcpTools(release.server, release.perTool),
  };
}

function creatorOf(
  session: { createdByUserId: string | null; createdByApiKeyId: string | null },
  agentId: string,
): ReceiptActor | null {
  if (session.createdByApiKeyId !== null) {
    return {
      principal: { kind: "api_key", id: session.createdByApiKeyId },
      actor_user_id: session.createdByUserId,
      agent_id: agentId,
    };
  }
  if (session.createdByUserId !== null) {
    return {
      principal: { kind: "user", id: session.createdByUserId },
      actor_user_id: session.createdByUserId,
      agent_id: agentId,
    };
  }
  return null;
}

export function createPostgresMcpEgressStore(db: Database): McpEgressStore {
  return {
    async sessionState(input): Promise<McpSessionState | null> {
      const [session] = await db
        .select({
          ownerId: sessions.ownerId,
          workspaceId: sessions.workspaceId,
          workspaceSlug: workspaces.slug,
          agentReleaseId: sessions.agentReleaseId,
          createdByUserId: sessions.createdByUserId,
          createdByApiKeyId: sessions.createdByApiKeyId,
        })
        .from(sessions)
        .leftJoin(workspaces, eq(workspaces.id, sessions.workspaceId))
        .where(eq(sessions.id, input.sessionId))
        .limit(1);
      if (!session || session.agentReleaseId === null) return null;
      const release = await releaseMcpOf(db, session.agentReleaseId);
      if (release === null) return null;
      const bound =
        session.workspaceId === null
          ? []
          : await db
              .select({ ref: credentialBindings.credentialRef })
              .from(credentialBindings)
              .where(
                and(
                  eq(credentialBindings.workspaceId, session.workspaceId),
                  eq(credentialBindings.target, "agent"),
                  eq(credentialBindings.targetId, release.agentId),
                  isNull(credentialBindings.revokedAt),
                ),
              );
      const [turn] = await db
        .select({ sequence: turns.sequence })
        .from(turns)
        .where(
          and(
            eq(turns.sessionId, input.sessionId),
            eq(turns.attemptId, input.attemptId),
            eq(turns.status, "running"),
          ),
        )
        .limit(1);
      return {
        ownerId: session.ownerId,
        workspaceSlug: session.workspaceSlug,
        agentId: release.agentId,
        releaseId: session.agentReleaseId,
        server: release.server,
        perTool: release.perTool,
        boundRefs: bound.map((row) => row.ref),
        turnId: turn === undefined ? null : String(turn.sequence),
        actor: creatorOf(session, release.agentId),
      };
    },

    async recordRefusal(record: McpRefusalRecord): Promise<void> {
      await db.transaction(async (tx) => {
        await tx
          .insert(receipts)
          .values({
            id: record.id,
            ownerId: record.ownerId,
            operation: "call_mcp",
            targetRef: {
              session_id: record.sessionId,
              turn_id: record.turnId,
              request_id: null,
            },
            status: record.status,
            result: record.result,
            error: { code: "CREDENTIAL_UNBOUND", message: record.message },
            actor: record.actor,
          })
          .onConflictDoNothing({ target: receipts.id });
      });
    },
  };
}
