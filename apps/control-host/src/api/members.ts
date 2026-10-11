import { randomUUID } from "node:crypto";
import { parseArgs } from "node:util";
import { scopesForRole } from "@agent-platform/contracts";
import * as schema from "@agent-platform/db";
import {
  createDatabaseIdentityReader,
  createPostgresMemberStore,
  findLiveMembership,
} from "@agent-platform/db";
import { createEnforcedPool, JOB_POOL_TIMEOUTS } from "@agent-platform/db/pool";
import { createLogger } from "@agent-platform/observability";
import {
  callerFor,
  createAuthorizationPolicy,
  createMemberService,
  SessionServiceError,
} from "@agent-platform/platform";
import { drizzle } from "drizzle-orm/node-postgres";

// Offboarding until the member API (94S-464) exists. The command acts as the
// owner named by --by and goes through the same member.manage decision a
// route would; the operator's shell is not an authority of its own.

const USAGE =
  "Usage: bun run apps/control-host/src/api/members.ts offboard <user_id> --by <owner_user_id>";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type MembersCommand = {
  command: "offboard";
  userId: string;
  byUserId: string;
};

function parseStrict(argv: string[]) {
  try {
    return parseArgs({
      args: argv,
      options: { by: { type: "string" } },
      allowPositionals: true,
      strict: true,
    });
  } catch (error) {
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}\n${USAGE}`,
    );
  }
}

export function parseMembersCommand(argv: string[]): MembersCommand {
  const parsed = parseStrict(argv);
  const [command, userId, ...extra] = parsed.positionals;
  const by = parsed.values.by;
  if (command !== "offboard" || !userId || extra.length > 0 || !by) {
    throw new Error(USAGE);
  }
  if (!UUID.test(userId) || !UUID.test(by)) {
    throw new Error(`user ids must be UUIDs\n${USAGE}`);
  }
  return {
    command,
    userId: userId.toLowerCase(),
    byUserId: by.toLowerCase(),
  };
}

async function main(): Promise<void> {
  const command = parseMembersCommand(Bun.argv.slice(2));
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required");
  }
  const pool = createEnforcedPool(
    databaseUrl,
    createLogger(),
    "members",
    JOB_POOL_TIMEOUTS,
  );
  try {
    const db = drizzle(pool, { schema });
    const membership = await findLiveMembership(db, command.byUserId);
    if (!membership) {
      console.error(`User ${command.byUserId} has no live membership`);
      process.exitCode = 1;
      return;
    }
    const service = createMemberService({
      authorization: createAuthorizationPolicy({
        identity: createDatabaseIdentityReader(db),
      }),
      store: createPostgresMemberStore(db),
    });
    const caller = callerFor(
      {
        kind: "user",
        id: command.byUserId,
        workspace_id: membership.workspaceId,
        role: membership.role,
        scopes: [...scopesForRole(membership.role)],
      },
      { kind: "api" },
      randomUUID(),
    );
    try {
      const result = await service.offboardMember(caller, command.userId);
      console.log(
        `offboarded ${command.userId} workspace=${membership.workspaceId} web_sessions_revoked=${result.revokedWebSessions} personal_keys_revoked=${result.revokedPersonalKeys} sessions_awaiting_takeover=${result.sessionsAwaitingTakeover}`,
      );
    } catch (error) {
      if (!(error instanceof SessionServiceError)) throw error;
      console.error(`${error.code}: ${error.message}`);
      process.exitCode = 1;
    }
  } finally {
    await pool.end();
  }
}

if (import.meta.main) {
  await main();
}
