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
  return (row?.role as WorkspaceRole | undefined) ?? null;
}

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
      if (key.createdByUserId === null || key.creatorRole === null) {
        return { status: "disabled" };
      }
      return {
        status: "ok",
        principal: stored,
        keyCreator: { userId: key.createdByUserId, role: key.creatorRole },
      };
    },
  };
}
