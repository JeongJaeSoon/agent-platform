import { randomBytes, randomUUID } from "node:crypto";
import { scopesForRole, type WorkspaceRole } from "@werft-ai/contracts";
import * as schema from "@werft-ai/db";
import {
  bootstrapOwner,
  countUsers,
  createPostgresInviteStore,
  type Database,
  memberships,
  users,
} from "@werft-ai/db";
import { createEnforcedPool, JOB_POOL_TIMEOUTS } from "@werft-ai/db/pool";
import { createLogger } from "@werft-ai/observability";
import { callerFor, INVITE_TTL_MS } from "@werft-ai/platform";
import { and, asc, eq, isNull } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import {
  generateWebSessionToken,
  hashPassword,
  hashWebSessionToken,
  WEB_SESSION_TTL_MS,
  WEB_SESSIONS_PER_USER,
} from "./auth.ts";
import { generateInviteToken } from "./routes/invites.ts";

// The web console's demo sign-ins for a local development stack, the same
// on every machine (docs/quickstart.md "웹 콘솔 데모 계정"). Public on
// purpose: never reuse them anywhere real.
export const DEMO_PASSWORD = "demo-local-only";
export const DEMO_ACCOUNTS = [
  {
    email: "demo-owner@example.test",
    displayName: "Demo Owner",
    role: "owner",
  },
  {
    email: "demo-member@example.test",
    displayName: "Demo Member",
    role: "member",
  },
] as const satisfies readonly {
  email: string;
  displayName: string;
  role: WorkspaceRole;
}[];

// The compose postgres service, or a database on this machine.
const LOCAL_DATABASE_HOSTS = new Set([
  "postgres",
  "localhost",
  "127.0.0.1",
  "[::1]",
]);

/**
 * Why this process must not create the demo accounts, or null. Only
 * scripts/local.sh sets DEMO_ACCOUNTS=local, and only on its own compose
 * stack; a Kubernetes pod or a database elsewhere is a real installation.
 */
export function demoAccountsRefusal(
  env: Record<string, string | undefined>,
): string | null {
  if (env.DEMO_ACCOUNTS !== "local") {
    return "DEMO_ACCOUNTS=local is not set; only scripts/local.sh creates demo accounts";
  }
  if (env.KUBERNETES_SERVICE_HOST) {
    return "this is a Kubernetes installation";
  }
  let host: string;
  try {
    host = new URL(env.DATABASE_URL ?? "").hostname;
  } catch {
    return "DATABASE_URL is missing or not a URL";
  }
  if (!LOCAL_DATABASE_HOSTS.has(host)) {
    return `DATABASE_URL points at ${host}, not the local compose postgres`;
  }
  return null;
}

export type DemoAccountOutcome = {
  email: string;
  outcome: "created" | "exists";
};

async function findUserId(db: Database, email: string) {
  const [row] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, email));
  return row?.id ?? null;
}

// The demo owner when it is live, else the longest-standing live owner.
async function liveOwner(db: Database, preferEmail: string) {
  const rows = await db
    .select({
      userId: memberships.userId,
      workspaceId: memberships.workspaceId,
      email: users.email,
    })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(
      and(
        eq(memberships.role, "owner"),
        isNull(memberships.disabledAt),
        isNull(users.disabledAt),
      ),
    )
    .orderBy(asc(memberships.createdAt), asc(memberships.userId));
  return rows.find((row) => row.email === preferEmail) ?? rows[0] ?? null;
}

/**
 * Adds whichever demo account is missing and leaves every existing row
 * alone, so running it again changes nothing. An empty installation gets
 * the owner the way a bootstrap would; anything else is invited and
 * accepted, as an owner inviting from the web console would.
 */
export async function seedDemoAccounts(
  db: Database,
): Promise<DemoAccountOutcome[]> {
  const passwordHash = await hashPassword(DEMO_PASSWORD);
  const outcomes: DemoAccountOutcome[] = [];
  for (const account of DEMO_ACCOUNTS) {
    if ((await findUserId(db, account.email)) !== null) {
      outcomes.push({ email: account.email, outcome: "exists" });
      continue;
    }
    if (account.role === "owner" && (await countUsers(db)) === 0) {
      await bootstrapOwner(db, {
        userId: randomUUID(),
        email: account.email,
        passwordHash,
        displayName: account.displayName,
        workspaceId: randomUUID(),
        workspaceSlug: "demo",
        workspaceName: "Demo",
        // No BOOTSTRAP_TOKEN was presented; a fresh value spends nothing.
        bootstrapTokenHash: hashWebSessionToken(
          randomBytes(32).toString("base64url"),
        ),
        receiptId: randomUUID(),
        loginMethodId: randomUUID(),
      });
      outcomes.push({ email: account.email, outcome: "created" });
      continue;
    }
    const owner = await liveOwner(db, DEMO_ACCOUNTS[0].email);
    if (!owner) {
      // Bootstrapping here would be recovery, which ends every session.
      throw new Error(
        "the installation has users but no live owner to invite the demo accounts",
      );
    }
    const store = createPostgresInviteStore(db);
    const inviteToken = generateInviteToken();
    const invited = await store.createInvite({
      id: randomUUID(),
      actor: {
        principal: callerFor(
          {
            kind: "user",
            id: owner.userId,
            workspace_id: owner.workspaceId,
            role: "owner",
            scopes: [...scopesForRole("owner")],
          },
          { kind: "web" },
          randomUUID(),
        ),
        workspaceId: owner.workspaceId,
        userId: owner.userId,
      },
      email: account.email,
      role: account.role,
      tokenHash: hashWebSessionToken(inviteToken),
      ttlMs: INVITE_TTL_MS,
      receiptId: randomUUID(),
    });
    if (invited.outcome !== "created") {
      throw new Error(`inviting ${account.email}: ${invited.outcome}`);
    }
    const accepted = await store.acceptInvite({
      tokenHash: hashWebSessionToken(inviteToken),
      account: {
        kind: "new",
        userId: randomUUID(),
        passwordHash,
        displayName: account.displayName,
        loginMethodId: randomUUID(),
      },
      session: {
        id: randomUUID(),
        tokenHash: hashWebSessionToken(generateWebSessionToken()),
        ttlMs: WEB_SESSION_TTL_MS,
        userAgent: "scripts/local.sh demo-accounts",
        maxLive: WEB_SESSIONS_PER_USER,
      },
      receiptId: randomUUID(),
    });
    if (accepted.outcome !== "accepted") {
      throw new Error(`accepting ${account.email}: ${accepted.outcome}`);
    }
    outcomes.push({ email: account.email, outcome: "created" });
  }
  return outcomes;
}

async function main(): Promise<void> {
  const refusal = demoAccountsRefusal(process.env);
  if (refusal) {
    console.error(`demo accounts refused: ${refusal}`);
    process.exitCode = 2;
    return;
  }
  const pool = createEnforcedPool(
    process.env.DATABASE_URL ?? "",
    createLogger(),
    "demo-accounts",
    JOB_POOL_TIMEOUTS,
  );
  try {
    for (const { email, outcome } of await seedDemoAccounts(
      drizzle(pool, { schema }),
    )) {
      console.log(`${outcome} ${email}`);
    }
  } finally {
    await pool.end();
  }
}

if (import.meta.main) {
  await main();
}
