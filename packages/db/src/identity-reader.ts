import { scopesForRole, type WorkspaceRole } from "@agent-platform/contracts";
import type { IdentityReader } from "@agent-platform/platform";
import { and, eq, isNull } from "drizzle-orm";
import {
  apiKeyRecordOf,
  type Database,
  liveApiKey,
  selectLiveApiKey,
} from "./queries.ts";
import { apiKeys, memberships, users } from "./schema.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The user's role in that workspace while account and membership are live. */
export async function findLiveRole(
  db: Database,
  userId: string,
  workspaceId: string,
): Promise<WorkspaceRole | null> {
  const [row] = await db
    .select({ role: memberships.role })
    .from(users)
    .innerJoin(
      memberships,
      and(
        eq(memberships.userId, users.id),
        eq(memberships.workspaceId, workspaceId),
        isNull(memberships.disabledAt),
      ),
    )
    .where(and(eq(users.id, userId), isNull(users.disabledAt)))
    .limit(1);
  // memberships_role_check holds the vocabulary.
  return (row?.role as WorkspaceRole | undefined) ?? null;
}

/**
 * Step 1 of every decision (design A.3): the user, their membership and the
 * key as stored now, read for each decision and never cached. A disabled
 * account or membership, a revoked or expired key, and a personal key whose
 * creator is no longer live all read as disabled.
 */
export function createDatabaseIdentityReader(db: Database): IdentityReader {
  return {
    async reread(subject) {
      const { principal } = subject;
      if (principal.kind === "installation") return { status: "unlinked" };
      if (principal.kind === "user") {
        const role = await findLiveRole(
          db,
          principal.id,
          principal.workspace_id,
        );
        if (role === null) return { status: "disabled" };
        const ceiling = new Set(scopesForRole(role));
        return {
          status: "ok",
          principal: {
            ...principal,
            role,
            scopes: principal.scopes.filter((scope) => ceiling.has(scope)),
          },
        };
      }
      // AUTH_MODE=none names its key after the owner; it is no row.
      if (!UUID.test(principal.id)) return { status: "disabled" };
      const [row] = await selectLiveApiKey(db)
        .where(and(eq(apiKeys.id, principal.id), liveApiKey()))
        .limit(1);
      if (!row) return { status: "disabled" };
      const key = apiKeyRecordOf(row);
      const stored = {
        kind: "api_key" as const,
        id: key.id,
        owner_id: key.ownerId,
        workspace_id: key.workspaceId,
        scopes: key.scopes === null ? [] : [...key.scopes],
      };
      if (key.kind === "service") return { status: "ok", principal: stored };
      // The personal_check constraint guarantees both.
      if (key.createdByUserId === null || key.workspaceId === null) {
        return { status: "disabled" };
      }
      const role = await findLiveRole(db, key.createdByUserId, key.workspaceId);
      if (role === null) return { status: "disabled" };
      return {
        status: "ok",
        principal: stored,
        keyCreator: { userId: key.createdByUserId, role },
      };
    },
  };
}
