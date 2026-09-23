import {
  and,
  asc,
  desc,
  eq,
  gt,
  isNotNull,
  isNull,
  lt,
  lte,
  ne,
  notInArray,
  or,
  sql,
} from "drizzle-orm";
import { DB_NOW, fromDbNow } from "./db-clock.ts";
import type { Database } from "./queries.ts";
import { memberships, users, webSessions, workspaces } from "./schema.ts";

// Identity queries for the cookie-session path (94S-151). API keys keep
// their own helpers in queries.ts so that path is untouched.

export type WorkspaceRow = typeof workspaces.$inferSelect;
export type UserRow = typeof users.$inferSelect;
export type MembershipRole = "owner" | "member";

export async function countUsers(db: Database): Promise<number> {
  const [row] = await db
    .select({ count: sql<string>`count(*)::text` })
    .from(users);
  return Number(row?.count ?? 0);
}

export class BootstrapDoneError extends Error {
  constructor() {
    super("Bootstrap has already been completed");
    this.name = "BootstrapDoneError";
  }
}

export type BootstrapInput = {
  userId: string;
  email: string;
  passwordHash: string;
  displayName: string;
  workspaceId: string;
  workspaceSlug: string;
  workspaceName: string;
};

/**
 * First owner + default workspace, only while `users` is empty. The advisory
 * lock serialises two installers racing for the same empty table; the count
 * is re-read under it so the loser sees the winner's row and gets
 * BootstrapDoneError instead of a unique violation.
 */
export async function bootstrapFirstOwner(
  db: Database,
  input: BootstrapInput,
): Promise<{ user: UserRow; workspace: WorkspaceRow }> {
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext('auth.bootstrap'))`,
    );
    if ((await countUsers(tx)) > 0) {
      throw new BootstrapDoneError();
    }
    const [user] = await tx
      .insert(users)
      .values({
        id: input.userId,
        email: input.email,
        passwordHash: input.passwordHash,
        displayName: input.displayName,
      })
      .returning();
    const [workspace] = await tx
      .insert(workspaces)
      .values({
        id: input.workspaceId,
        slug: input.workspaceSlug,
        name: input.workspaceName,
      })
      .returning();
    if (!user || !workspace) {
      throw new Error("bootstrap insert returned no row");
    }
    await tx.insert(memberships).values({
      workspaceId: workspace.id,
      userId: user.id,
      role: "owner",
    });
    return { user, workspace };
  });
}

/** Login lookup; a disabled account is indistinguishable from a missing one. */
export async function findUserForLogin(
  db: Database,
  email: string,
): Promise<UserRow | null> {
  const [row] = await db
    .select()
    .from(users)
    .where(and(eq(users.email, email), isNull(users.disabledAt)))
    .limit(1);
  return row ?? null;
}

export type LiveMembership = {
  workspaceId: string;
  role: MembershipRole;
};

// One workspace per installation for now (03 §3.1); with several the oldest
// membership wins so the choice is stable across logins.
export async function findLiveMembership(
  db: Database,
  userId: string,
): Promise<LiveMembership | null> {
  const [row] = await db
    .select({ workspaceId: memberships.workspaceId, role: memberships.role })
    .from(memberships)
    .where(and(eq(memberships.userId, userId), isNull(memberships.disabledAt)))
    .orderBy(asc(memberships.createdAt), asc(memberships.workspaceId))
    .limit(1);
  return row ? { ...row, role: row.role as MembershipRole } : null;
}

export async function findWorkspace(
  db: Database,
  workspaceId: string,
): Promise<WorkspaceRow | null> {
  const [row] = await db
    .select()
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId))
    .limit(1);
  return row ?? null;
}

/**
 * Inserts the session and keeps the user's rows bounded in the same
 * transaction: expired and revoked rows are deleted, and only the newest
 * `maxLive` live sessions survive, so the table holds at most users x
 * maxLive rows however often anyone logs in. The user row is locked first
 * so two concurrent logins cannot both leave maxLive + 1.
 */
export async function createWebSession(
  db: Database,
  input: {
    id: string;
    userId: string;
    tokenHash: Uint8Array;
    ttlMs: number;
    userAgent: string | null;
    maxLive: number;
  },
): Promise<{ expiresAt: Date }> {
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT 1 FROM ${users} WHERE ${users.id} = ${input.userId} FOR UPDATE`,
    );
    await tx
      .delete(webSessions)
      .where(
        and(
          eq(webSessions.userId, input.userId),
          or(
            lte(webSessions.expiresAt, DB_NOW),
            isNotNull(webSessions.revokedAt),
          ),
        ),
      );
    const [row] = await tx
      .insert(webSessions)
      .values({
        id: input.id,
        userId: input.userId,
        tokenHash: input.tokenHash,
        // Not the column default now(): that is the transaction start, and
        // a login that waited longest for the user lock would sort oldest.
        createdAt: DB_NOW,
        expiresAt: fromDbNow(input.ttlMs),
        lastSeenAt: DB_NOW,
        userAgent: input.userAgent,
      })
      .returning({ expiresAt: webSessions.expiresAt });
    if (!row) {
      throw new Error("web session insert returned no row");
    }
    // The new session always stays; the others compete for the rest.
    const keep = tx
      .select({ id: webSessions.id })
      .from(webSessions)
      .where(
        and(eq(webSessions.userId, input.userId), ne(webSessions.id, input.id)),
      )
      .orderBy(desc(webSessions.createdAt), desc(webSessions.id))
      .limit(Math.max(0, input.maxLive - 1));
    await tx
      .delete(webSessions)
      .where(
        and(
          eq(webSessions.userId, input.userId),
          ne(webSessions.id, input.id),
          notInArray(webSessions.id, keep),
        ),
      );
    return row;
  });
}

export type ResolvedWebSession = {
  sessionId: string;
  userId: string;
  email: string;
  displayName: string;
  workspaceId: string;
  role: MembershipRole;
  expiresAt: Date;
};

/**
 * The cookie's session, its user and the user's live membership in one
 * query, all judged on the database clock: an expired or revoked session, a
 * disabled account and a disabled membership all come back null.
 */
export async function resolveWebSession(
  db: Database,
  tokenHash: Uint8Array,
): Promise<ResolvedWebSession | null> {
  const [row] = await db
    .select({
      sessionId: webSessions.id,
      userId: users.id,
      email: users.email,
      displayName: users.displayName,
      workspaceId: memberships.workspaceId,
      role: memberships.role,
      expiresAt: webSessions.expiresAt,
    })
    .from(webSessions)
    .innerJoin(users, eq(users.id, webSessions.userId))
    .innerJoin(
      memberships,
      and(eq(memberships.userId, users.id), isNull(memberships.disabledAt)),
    )
    .where(
      and(
        eq(webSessions.tokenHash, tokenHash),
        isNull(webSessions.revokedAt),
        gt(webSessions.expiresAt, DB_NOW),
        isNull(users.disabledAt),
      ),
    )
    .orderBy(asc(memberships.createdAt), asc(memberships.workspaceId))
    .limit(1);
  return row ? { ...row, role: row.role as MembershipRole } : null;
}

/**
 * Sliding expiry. Only rows whose last touch is older than `renewAfterMs`
 * are written, so a busy tab does not turn every request into an UPDATE.
 * Returns the new expiry when the row was written, so the caller can move
 * the cookie's own Expires with it; null when nothing changed.
 */
export async function renewWebSession(
  db: Database,
  sessionId: string,
  ttlMs: number,
  renewAfterMs: number,
): Promise<Date | null> {
  const [row] = await db
    .update(webSessions)
    .set({ expiresAt: fromDbNow(ttlMs), lastSeenAt: DB_NOW })
    .where(
      and(
        eq(webSessions.id, sessionId),
        isNull(webSessions.revokedAt),
        or(
          isNull(webSessions.lastSeenAt),
          lt(
            webSessions.lastSeenAt,
            sql`clock_timestamp() - ${renewAfterMs}::double precision * interval '1 millisecond'`,
          ),
        ),
      ),
    )
    .returning({ expiresAt: webSessions.expiresAt });
  return row?.expiresAt ?? null;
}

export async function revokeWebSession(
  db: Database,
  tokenHash: Uint8Array,
): Promise<void> {
  await db
    .update(webSessions)
    .set({ revokedAt: DB_NOW })
    .where(
      and(eq(webSessions.tokenHash, tokenHash), isNull(webSessions.revokedAt)),
    );
}
