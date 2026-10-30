import type { SessionGitHubSettings } from "@werft-ai/platform";
import { eq, sql } from "drizzle-orm";
import type { Database } from "./queries.ts";
import { agentReleases, sessions } from "./schema.ts";

/**
 * Whether the session's release pins `policy_pins.github`. Read as a key,
 * not parsed, so a shape a later image writes still counts as pinned.
 */
export async function sessionPinsGitHub(
  db: Database,
  sessionId: string,
): Promise<boolean> {
  const [row] = await db
    .select({
      pinned: sql<boolean>`(${agentReleases.policyPins} -> 'github') IS NOT NULL`,
    })
    .from(sessions)
    .innerJoin(agentReleases, eq(agentReleases.id, sessions.agentReleaseId))
    .where(eq(sessions.id, sessionId.toLowerCase()))
    .limit(1);
  return row?.pinned === true;
}

export function createPostgresSessionGitHubSettings(
  db: Database,
): SessionGitHubSettings {
  return { pinned: (sessionId) => sessionPinsGitHub(db, sessionId) };
}
