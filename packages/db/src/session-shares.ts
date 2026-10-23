import type { SessionRelation, SessionShareScope } from "@werft-ai/contracts";
import type {
  SessionShare,
  SessionShareStore,
  SessionViewer,
  SetSessionShareInput,
  SetSessionShareResult,
} from "@werft-ai/platform";
import {
  and,
  asc,
  desc,
  eq,
  inArray,
  isNull,
  type SQL,
  sql,
} from "drizzle-orm";
import { administers } from "./agent-admins.ts";
import { lockPeople, receiptActorOf } from "./control-shared.ts";
import type { Database } from "./queries.ts";
import {
  agentReleases,
  memberTeams,
  receipts,
  sessionShares,
  sessionShareTargets,
  sessions,
} from "./schema.ts";

// Session share scopes (94S-584, design 4.6). Lock order: the people
// involved (users, then memberships), the named teams, then the share row.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const uuidOrNull = (value: string | null) =>
  value !== null && UUID.test(value) ? value.toLowerCase() : null;

// The creator branches of sessionVisibleTo: the caller started the session.
function startedBy(viewer: SessionViewer): SQL[] {
  const userId = uuidOrNull(viewer.userId);
  const apiKeyId = uuidOrNull(viewer.apiKeyId);
  return [
    ...(userId === null ? [] : [sql`${sessions.createdByUserId} = ${userId}`]),
    // A key's session is its key's: the key stands where a creator would.
    ...(apiKeyId === null
      ? []
      : [
          sql`(${sessions.createdByUserId} IS NULL AND ${sessions.createdByApiKeyId} = ${apiKeyId})`,
        ]),
  ];
}

// The share branches of sessionVisibleTo: a people or team share names the
// caller.
function sharedWith(viewer: SessionViewer): SQL[] {
  const userId = uuidOrNull(viewer.userId);
  if (userId === null) return [];
  return [
    sql`EXISTS (SELECT 1 FROM session_shares sh JOIN session_share_targets st ON st.session_id = sh.session_id WHERE sh.session_id = ${sessions.id} AND sh.scope = 'people' AND st.user_id = ${userId})`,
    sql`EXISTS (SELECT 1 FROM session_shares sh JOIN session_share_targets st ON st.session_id = sh.session_id JOIN member_teams mt ON mt.id = st.team_id AND mt.archived_at IS NULL JOIN member_team_members mm ON mm.team_id = mt.id AND mm.removed_at IS NULL WHERE sh.session_id = ${sessions.id} AND sh.scope = 'team' AND mm.user_id = ${userId})`,
  ];
}

const anyOf = (branches: SQL[]): SQL =>
  branches.length === 0 ? sql`false` : sql`(${sql.join(branches, sql` OR `)})`;

/**
 * Whether `viewer` sees the session row the enclosing query reads from
 * `sessions`. One predicate for a decision on one session and for a list,
 * so what a list shows and what a detail answers never disagree.
 */
export function sessionVisibleTo(viewer: SessionViewer): SQL {
  return anyOf([
    sql`coalesce((SELECT ${sessionShares.scope} FROM ${sessionShares} WHERE ${sessionShares.sessionId} = ${sessions.id}), 'workspace') = 'workspace'`,
    ...startedBy(viewer),
    ...sharedWith(viewer),
  ]);
}

/**
 * How the session relates to `viewer`, to AND with sessionVisibleTo: on its
 * own it is no grant. `administered` follows the admin rows at this read,
 * as every decision does.
 */
export function sessionRelationIs(
  db: Database,
  viewer: SessionViewer,
  relation: Exclude<SessionRelation, "all">,
): SQL {
  switch (relation) {
    case "started":
      return anyOf(startedBy(viewer));
    case "shared":
      return sql`(${anyOf(sharedWith(viewer))} AND NOT ${anyOf(startedBy(viewer))})`;
    case "administered": {
      const userId = uuidOrNull(viewer.userId);
      if (userId === null) return sql`false`;
      // Qualified by hand: agent_releases has an id of its own.
      return sql`EXISTS (SELECT 1 FROM ${agentReleases} ar WHERE ar.id = ${sessions}.agent_release_id AND ${administers(db, sql`${sessions}.workspace_id`, userId, sql`ar.agent_id`)})`;
    }
  }
}

const sameSet = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((value) => b.includes(value));

async function readShare(
  db: Database,
  ownerId: string,
  sessionId: string,
): Promise<SessionShare | null> {
  const [row] = await db
    .select({
      sessionId: sessions.id,
      scope: sessionShares.scope,
      revision: sessionShares.revision,
      updatedBy: sessionShares.updatedBy,
      updatedAt: sessionShares.updatedAt,
    })
    .from(sessions)
    .leftJoin(sessionShares, eq(sessionShares.sessionId, sessions.id))
    .where(and(eq(sessions.id, sessionId), eq(sessions.ownerId, ownerId)))
    .limit(1);
  if (!row) return null;
  const targets = await db
    .select({
      userId: sessionShareTargets.userId,
      teamId: sessionShareTargets.teamId,
    })
    .from(sessionShareTargets)
    .where(eq(sessionShareTargets.sessionId, sessionId))
    .orderBy(asc(sessionShareTargets.addedAt), asc(sessionShareTargets.id));
  // A row at revision 0 is the placeholder a first change locks on.
  const changed = row.revision !== null && row.revision > 0;
  return {
    sessionId: row.sessionId,
    scope: (changed ? row.scope : "workspace") as SessionShareScope,
    userIds: targets.flatMap((t) => (t.userId === null ? [] : [t.userId])),
    teamIds: targets.flatMap((t) => (t.teamId === null ? [] : [t.teamId])),
    revision: changed ? (row.revision ?? 0) : 0,
    updatedBy: changed ? row.updatedBy : null,
    updatedAt: changed ? row.updatedAt : null,
  };
}

async function setShare(
  db: Database,
  input: SetSessionShareInput,
): Promise<SetSessionShareResult> {
  if (!UUID.test(input.sessionId)) return { outcome: "not_found" };
  const sessionId = input.sessionId.toLowerCase();
  const userIds =
    input.scope === "people"
      ? [...new Set(input.userIds.map((id) => id.toLowerCase()))].sort()
      : [];
  const teamIds =
    input.scope === "team"
      ? [...new Set(input.teamIds.map((id) => id.toLowerCase()))].sort()
      : [];
  if (![...userIds, ...teamIds].every((id) => UUID.test(id))) {
    return { outcome: "invalid_target" };
  }
  return db.transaction(async (tx) => {
    const people = await lockPeople(tx, input.workspaceId, [
      input.updatedBy,
      ...userIds,
    ]);
    const live = new Set(people.filter((p) => p.live).map((p) => p.userId));
    if (!live.has(input.updatedBy.toLowerCase())) {
      return { outcome: "actor_inactive" };
    }
    if (!userIds.every((id) => live.has(id))) {
      return { outcome: "invalid_target" };
    }
    if (teamIds.length > 0) {
      const teams = await tx
        .select({ id: memberTeams.id })
        .from(memberTeams)
        .where(
          and(
            eq(memberTeams.workspaceId, input.workspaceId),
            inArray(memberTeams.id, teamIds),
            isNull(memberTeams.archivedAt),
          ),
        )
        .for("share");
      if (teams.length !== teamIds.length) {
        return { outcome: "invalid_target" };
      }
    }
    const [session] = await tx
      .select({ id: sessions.id })
      .from(sessions)
      .where(
        and(
          eq(sessions.id, sessionId),
          eq(sessions.ownerId, input.ownerId),
          eq(sessions.workspaceId, input.workspaceId),
        ),
      )
      .limit(1);
    if (!session) return { outcome: "not_found" };
    // Two first changes would otherwise both find no row to lock.
    await tx
      .insert(sessionShares)
      .values({
        sessionId,
        ownerId: input.ownerId,
        workspaceId: input.workspaceId,
        scope: "workspace",
        revision: 0,
      })
      .onConflictDoNothing();
    const [locked] = await tx
      .select({ revision: sessionShares.revision })
      .from(sessionShares)
      .where(eq(sessionShares.sessionId, sessionId))
      .for("update");
    const current = await readShare(tx, input.ownerId, sessionId);
    if (!locked || !current) return { outcome: "not_found" };
    if (
      input.expectedRevision !== undefined &&
      input.expectedRevision !== current.revision
    ) {
      return {
        outcome: "revision_conflict",
        currentRevision: current.revision,
      };
    }
    if (
      current.scope === input.scope &&
      sameSet(current.userIds, userIds) &&
      sameSet(current.teamIds, teamIds)
    ) {
      return { outcome: "unchanged", share: current };
    }
    const now = new Date();
    await tx
      .update(sessionShares)
      .set({
        scope: input.scope,
        revision: current.revision + 1,
        updatedBy: input.updatedBy,
        updatedAt: now,
      })
      .where(eq(sessionShares.sessionId, sessionId));
    await tx
      .delete(sessionShareTargets)
      .where(eq(sessionShareTargets.sessionId, sessionId));
    const targets = [
      ...userIds.map((userId) => ({ userId, teamId: null })),
      ...teamIds.map((teamId) => ({ userId: null, teamId })),
    ];
    if (targets.length > 0) {
      await tx.insert(sessionShareTargets).values(
        targets.map((target) => ({
          id: crypto.randomUUID(),
          workspaceId: input.workspaceId,
          sessionId,
          ...target,
          addedBy: input.updatedBy,
          addedAt: now,
        })),
      );
    }
    await tx.insert(receipts).values({
      id: input.receiptId,
      ownerId: input.ownerId,
      actor: receiptActorOf(input.principal),
      requestId: input.principal.requestId ?? null,
      operation: "share_session",
      targetRef: { session_id: sessionId, turn_id: null, request_id: null },
      status: "succeeded",
      result: { scope: input.scope },
    });
    // Open streams re-read on this wakeup, and one that can no longer see
    // the session is refused there and ends.
    await tx.execute(sql`SELECT pg_notify('session_events', ${sessionId})`);
    const share = await readShare(tx, input.ownerId, sessionId);
    if (!share) throw new Error("session share vanished inside its write");
    return { outcome: "changed", share };
  });
}

export function createPostgresSessionShareStore(
  db: Database,
): SessionShareStore {
  return {
    async visibleTo(ownerId, sessionId, viewer) {
      if (!UUID.test(sessionId)) return false;
      const [row] = await db
        .select({ id: sessions.id })
        .from(sessions)
        .where(
          and(
            eq(sessions.id, sessionId.toLowerCase()),
            eq(sessions.ownerId, ownerId),
            sessionVisibleTo(viewer),
          ),
        )
        .limit(1);
      return row !== undefined;
    },

    async originOf(ownerId, sessionId) {
      if (!UUID.test(sessionId)) return null;
      const [row] = await db
        .select({
          creatorUserId: sessions.createdByUserId,
          creatorApiKeyId: sessions.createdByApiKeyId,
        })
        .from(sessions)
        .where(
          and(
            eq(sessions.id, sessionId.toLowerCase()),
            eq(sessions.ownerId, ownerId),
          ),
        )
        .limit(1);
      return row ?? null;
    },

    get(ownerId, sessionId) {
      if (!UUID.test(sessionId)) return Promise.resolve(null);
      // The row and its targets are two reads; one snapshot keeps a change
      // committed between them from mixing two shares.
      return db.transaction(
        (tx) => readShare(tx, ownerId, sessionId.toLowerCase()),
        { isolationLevel: "repeatable read", accessMode: "read only" },
      );
    },

    set: (input) => setShare(db, input),

    async listForAdmin(ownerId, limit) {
      const rows = await db
        .select({
          sessionId: sessions.id,
          createdByUserId: sessions.createdByUserId,
          createdByApiKeyId: sessions.createdByApiKeyId,
          agentReleaseId: sessions.agentReleaseId,
          status: sessions.status,
          admissionState: sessions.admissionState,
          scope: sessionShares.scope,
          revision: sessionShares.revision,
          createdAt: sessions.createdAt,
          takeoverRequiredAt: sessions.takeoverRequiredAt,
        })
        .from(sessions)
        .leftJoin(sessionShares, eq(sessionShares.sessionId, sessions.id))
        .where(eq(sessions.ownerId, ownerId))
        .orderBy(desc(sessions.createdAt), desc(sessions.id))
        .limit(limit);
      return rows.map(({ scope, revision, ...row }) => ({
        ...row,
        shareScope: (revision !== null && revision > 0
          ? scope
          : "workspace") as SessionShareScope,
      }));
    },
  };
}
