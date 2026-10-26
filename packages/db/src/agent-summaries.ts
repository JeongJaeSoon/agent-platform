import {
  AGENT_SUMMARY_INSTRUCTIONS_MAX,
  type AgentSummary,
  agentCapabilitiesSchema,
} from "@werft-ai/contracts";
import type { SessionViewer } from "@werft-ai/platform";
import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { actionableOfSession, IN_FLIGHT_STATUSES } from "./pending-requests.ts";
import type { Database } from "./queries.ts";
import {
  agentAdmins,
  agentAdminTeams,
  agentReleases,
  agents,
  agentVersions,
  credentialBindings,
  memberTeams,
  sessions,
  users,
} from "./schema.ts";
import { sessionVisibleTo } from "./session-shares.ts";

// Postgres `left` counts code points; the contract counts UTF-16 units.
function clip(text: string) {
  if (text.length <= AGENT_SUMMARY_INSTRUCTIONS_MAX) return text;
  const end = AGENT_SUMMARY_INSTRUCTIONS_MAX;
  return text.slice(
    0,
    /[\uD800-\uDBFF]/.test(text[end - 1] ?? "") ? end - 1 : end,
  );
}

function push<T>(map: Map<string, T[]>, key: string, value: T) {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

/**
 * The summaries of a page of agents in seven statements whatever its size,
 * matching what the agent, admins, bindings and session list reads would
 * show one by one.
 */
export async function agentSummaries(
  db: Database,
  workspaceId: string,
  agentIds: readonly string[],
  viewer: SessionViewer,
): Promise<Map<string, AgentSummary>> {
  const ids = [...new Set(agentIds.map((id) => id.toLowerCase()))];
  if (ids.length === 0) return new Map();
  const heads = await db
    .select({
      id: agents.id,
      profile: agentReleases.runtimeProfileId,
      versionId: agentReleases.versionId,
    })
    .from(agents)
    .leftJoin(
      agentReleases,
      and(
        eq(agentReleases.id, agents.activeReleaseId),
        eq(agentReleases.agentId, agents.id),
      ),
    )
    .where(and(eq(agents.workspaceId, workspaceId), inArray(agents.id, ids)));
  if (heads.length === 0) return new Map();
  const found = heads.map((head) => head.id);

  // Only the fields shown, so a long card is not read whole for each agent.
  const fields = {
    agentId: agentVersions.agentId,
    versionNo: agentVersions.versionNo,
    role: sql<string>`${agentVersions.card}->>'role'`,
    instructions: sql<string>`left(${agentVersions.card}->>'instructions', ${AGENT_SUMMARY_INSTRUCTIONS_MAX})`,
    capabilities: sql<unknown>`${agentVersions.card}->'capabilities'`,
  };
  const released = heads.flatMap((head) =>
    head.versionId ? [head.versionId] : [],
  );
  const drafts = heads.filter((head) => !head.versionId).map((head) => head.id);
  const versions = [
    ...(released.length > 0
      ? await db
          .select(fields)
          .from(agentVersions)
          .where(inArray(agentVersions.id, released))
      : []),
    ...(drafts.length > 0
      ? await db
          .selectDistinctOn([agentVersions.agentId], fields)
          .from(agentVersions)
          .where(inArray(agentVersions.agentId, drafts))
          .orderBy(agentVersions.agentId, desc(agentVersions.versionNo))
      : []),
  ];

  const admins = new Map<string, string[]>();
  for (const row of await db
    .select({
      agentId: agentAdmins.agentId,
      email: users.email,
      displayName: users.displayName,
    })
    .from(agentAdmins)
    .innerJoin(users, eq(users.id, agentAdmins.userId))
    .where(
      and(
        eq(agentAdmins.workspaceId, workspaceId),
        inArray(agentAdmins.agentId, found),
      ),
    )
    .orderBy(asc(agentAdmins.createdAt), asc(agentAdmins.userId)))
    push(admins, row.agentId, row.displayName ?? row.email);
  for (const row of await db
    .select({ agentId: agentAdminTeams.agentId, name: memberTeams.name })
    .from(agentAdminTeams)
    .innerJoin(memberTeams, eq(memberTeams.id, agentAdminTeams.teamId))
    .where(
      and(
        eq(agentAdminTeams.workspaceId, workspaceId),
        inArray(agentAdminTeams.agentId, found),
      ),
    )
    .orderBy(asc(agentAdminTeams.createdAt), asc(agentAdminTeams.teamId)))
    push(admins, row.agentId, row.name);

  const bound = new Map<string, string[]>();
  for (const row of await db
    .select({
      agentId: credentialBindings.targetId,
      ref: credentialBindings.credentialRef,
    })
    .from(credentialBindings)
    .where(
      and(
        eq(credentialBindings.workspaceId, workspaceId),
        eq(credentialBindings.target, "agent"),
        inArray(credentialBindings.targetId, found),
        isNull(credentialBindings.revokedAt),
      ),
    )
    .orderBy(asc(credentialBindings.credentialRef)))
    push(bound, row.agentId, row.ref);

  // GET /v1/sessions' filter and public status, so a card's counts are that
  // list's `?agent_id=&status=` read to the end.
  const awaiting = sql`exists (${actionableOfSession(db)})`;
  const live = new Map(
    (
      await db
        .select({
          agentId: agentReleases.agentId,
          needsInput: sql<number>`(count(*) filter (where ${awaiting}))::int`,
          running: sql<number>`(count(*) filter (where not ${awaiting}))::int`,
        })
        .from(sessions)
        .innerJoin(agentReleases, eq(agentReleases.id, sessions.agentReleaseId))
        .where(
          and(
            eq(sessions.ownerId, workspaceId),
            inArray(agentReleases.agentId, found),
            inArray(sessions.status, IN_FLIGHT_STATUSES),
            sessionVisibleTo(viewer),
          ),
        )
        .groupBy(agentReleases.agentId)
    ).map((row) => [row.agentId, row]),
  );

  const profiles = new Map(heads.map((head) => [head.id, head.profile]));
  const summaries = new Map<string, AgentSummary>();
  for (const version of versions) {
    const capabilities = agentCapabilitiesSchema.parse(version.capabilities);
    summaries.set(version.agentId, {
      version: {
        version_no: version.versionNo,
        role: version.role,
        instructions: clip(version.instructions),
        mcp_servers: (capabilities.mcp ?? []).map((mcp) => mcp.server),
        credential_refs: capabilities.credential_refs ?? [],
      },
      runtime_profile_id: profiles.get(version.agentId) ?? null,
      bound_credential_refs: bound.get(version.agentId) ?? [],
      admins: admins.get(version.agentId) ?? [],
      needs_input_count: live.get(version.agentId)?.needsInput ?? 0,
      running_count: live.get(version.agentId)?.running ?? 0,
    });
  }
  return summaries;
}
