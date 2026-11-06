import { randomUUID } from "node:crypto";
import {
  type BackfillReport,
  type ClaimedRolloutItem,
  type ProfileRolloutStore,
  type RolloutProfile,
  sameExecutionForm,
} from "@werft-ai/platform";
import { type SQL, sql } from "drizzle-orm";
import { rowsOf } from "./control-unit-of-work.ts";
import { lockWrites } from "./installation-profiles.ts";
import type { Database } from "./queries.ts";

/** An item leased this many times without a result is a crash loop. */
export const ROLLOUT_MAX_CLAIMS = 5;

// Versions of one profile share this key; a catalog row (no name) has none.
const LINEAGE = (alias: string) =>
  sql.raw(
    `CASE WHEN ${alias}.display_name IS NOT NULL THEN ${alias}.workspace_id::text || ':' || ${alias}.display_name WHEN ${alias}.name IS NOT NULL THEN 'name:' || ${alias}.name END`,
  );

type ProfileRow = {
  id: string;
  version: number;
  definition: Record<string, unknown>;
  lineage: string | null;
  created_by: string | null;
};

type Follower = ProfileRow & { agent_id: string; revision: number };

const profileOf = (row: ProfileRow): RolloutProfile => ({
  id: row.id,
  version: row.version,
  definition: row.definition,
});

const rows = async <T>(db: Database, query: SQL): Promise<T[]> =>
  rowsOf<T>(await db.execute(query));

/** Whether no later version of the profile's lineage exists. */
export async function isNewestProfile(
  tx: Database,
  profileId: string,
): Promise<boolean> {
  const later = await rows(
    tx,
    sql`SELECT 1 FROM installation_profiles p
      JOIN installation_profiles n
        ON n.origin = 'console' AND ${LINEAGE("n")} = ${LINEAGE("p")}
        AND n.version > p.version
      WHERE p.id = ${profileId} LIMIT 1`,
  );
  return later.length === 0;
}

/** Each lineage's newest version, whatever its state (design 2.3). */
async function latestPerLineage(tx: Database) {
  const found = await rows<ProfileRow>(
    tx,
    sql`SELECT DISTINCT ON (lineage) id, version, definition, lineage, created_by
      FROM (
        SELECT p.id, p.version, p.definition, p.created_by, ${LINEAGE("p")} AS lineage
        FROM installation_profiles p WHERE p.origin = 'console'
      ) l WHERE lineage IS NOT NULL
      ORDER BY lineage, version DESC`,
  );
  return new Map(found.map((row) => [row.lineage as string, row]));
}

/** Following agents with the console profile they run. */
async function followers(tx: Database): Promise<Follower[]> {
  const found = await rows<Follower>(
    tx,
    sql`SELECT a.id AS agent_id, a.activation_revision AS revision,
        p.id, p.version, p.definition, p.created_by, ${LINEAGE("p")} AS lineage
      FROM agents a
      JOIN agent_releases r ON r.id = a.active_release_id
      JOIN installation_profiles p ON p.id = r.runtime_profile_id
      WHERE a.profile_tracking = 'follow' AND p.origin = 'console'`,
  );
  return found.filter((row) => row.lineage !== null);
}

/** Followers running a form that is not their lineage's newest. */
async function behindLatest(tx: Database) {
  const latest = await latestPerLineage(tx);
  const behind = (await followers(tx)).filter((agent) => {
    const newest = latest.get(agent.lineage as string);
    return (
      newest !== undefined &&
      newest.id !== agent.id &&
      !sameExecutionForm(agent.definition, newest.definition)
    );
  });
  return { latest, behind };
}

export function createPostgresProfileRolloutStore(
  db: Database,
): ProfileRolloutStore {
  return {
    async claim({ leaseMs, limit }) {
      const token = randomUUID();
      await db.execute(sql`
        UPDATE profile_rollout_items
        SET status = 'failed', reason_code = 'retries_exhausted',
            locked_by = NULL, locked_until = NULL, updated_at = now()
        WHERE status = 'pending' AND attempts >= ${ROLLOUT_MAX_CLAIMS}
          AND (locked_until IS NULL OR locked_until < now())`);
      const claimed = await rows(
        db,
        sql`WITH picked AS (
            SELECT rollout_id, agent_id, generation FROM profile_rollout_items
            WHERE status = 'pending'
              AND (locked_until IS NULL OR locked_until < now())
            ORDER BY created_at, rollout_id, agent_id
            LIMIT ${limit}
            FOR UPDATE SKIP LOCKED)
          UPDATE profile_rollout_items i
          SET locked_by = ${token},
              locked_until = now() + ${leaseMs} * interval '1 millisecond',
              attempts = i.attempts + 1, updated_at = now()
          FROM picked
          WHERE i.rollout_id = picked.rollout_id
            AND i.agent_id = picked.agent_id
            AND i.generation = picked.generation
          RETURNING i.agent_id`,
      );
      if (claimed.length === 0) return [];
      const held = await rows<{
        rollout_id: string;
        agent_id: string;
        generation: number;
        workspace_id: string;
        target_profile_id: string;
        created_by: string | null;
      }>(
        db,
        sql`SELECT i.rollout_id, i.agent_id, i.generation, a.workspace_id,
            r.target_profile_id, r.created_by
          FROM profile_rollout_items i
          JOIN profile_rollouts r ON r.id = i.rollout_id
          JOIN agents a ON a.id = i.agent_id
          WHERE i.locked_by = ${token}
          ORDER BY i.created_at, i.rollout_id, i.agent_id`,
      );
      return held.map(
        (row): ClaimedRolloutItem => ({
          rolloutId: row.rollout_id,
          agentId: row.agent_id,
          generation: row.generation,
          claim: token,
          workspaceId: row.workspace_id,
          targetProfileId: row.target_profile_id,
          actorUserId: row.created_by,
        }),
      );
    },

    async settle(item, result) {
      const written = await rows(
        db,
        sql`UPDATE profile_rollout_items
          SET status = ${result.status},
              reason_code = ${result.status === "failed" ? result.reasonCode : null},
              locked_by = NULL, locked_until = NULL, updated_at = now()
          WHERE rollout_id = ${item.rolloutId} AND agent_id = ${item.agentId}
            AND generation = ${item.generation} AND status = 'pending'
            AND locked_by = ${item.claim} AND locked_until > now()
          RETURNING 1 AS ok`,
      );
      return written.length > 0;
    },

    async abandon(claims) {
      if (claims.length === 0) return 0;
      const freed = await rows(
        db,
        sql`UPDATE profile_rollout_items
          SET locked_by = NULL, locked_until = NULL,
              attempts = GREATEST(attempts - 1, 0), updated_at = now()
          WHERE status = 'pending'
            AND locked_by IN (${sql.join(
              claims.map((claim) => sql`${claim}`),
              sql`, `,
            )})
          RETURNING 1 AS ok`,
      );
      return freed.length;
    },

    async retry(item) {
      const reopened = await rows(
        db,
        sql`UPDATE profile_rollout_items
          SET status = 'pending', reason_code = NULL, attempts = 0,
              locked_by = NULL, locked_until = NULL, updated_at = now()
          WHERE rollout_id = ${item.rolloutId} AND agent_id = ${item.agentId}
            AND generation = ${item.generation} AND status = 'failed'
          RETURNING 1 AS ok`,
      );
      return reopened.length > 0;
    },

    async sweep() {
      return db.transaction(async (tx) => {
        // Profile writes take this lock, so no version lands mid-sweep.
        await lockWrites(tx);
        const { latest, behind } = await behindLatest(tx);
        let rollouts = 0;
        let items = 0;
        const headOf = new Map<string, string>();
        for (const lineage of new Set(
          behind.map((agent) => agent.lineage as string),
        )) {
          const newest = latest.get(lineage) as ProfileRow;
          // The head is the lineage's last behavior-changing rollout. When
          // the newest version's form differs from the head target's (an
          // image without the writer made it), it gets its own rollout.
          const [current] = await rows<{
            id: string;
            definition: ProfileRow["definition"];
          }>(
            tx,
            sql`SELECT r.id, p.definition FROM profile_rollouts r
              JOIN installation_profiles p ON p.id = r.target_profile_id
              WHERE r.kind = 'profile_update' AND ${LINEAGE("p")} = ${lineage}
              ORDER BY p.version DESC LIMIT 1`,
          );
          if (
            current !== undefined &&
            sameExecutionForm(current.definition, newest.definition)
          ) {
            headOf.set(lineage, current.id);
            continue;
          }
          const made = await rows<{ id: string }>(
            tx,
            sql`INSERT INTO profile_rollouts (id, kind, target_profile_id, created_by)
              VALUES (${randomUUID()}, 'profile_update', ${newest.id}, ${newest.created_by})
              ON CONFLICT (target_profile_id, kind) DO NOTHING RETURNING id`,
          );
          rollouts += made.length;
          const [row] =
            made.length > 0
              ? made
              : await rows<{ id: string }>(
                  tx,
                  sql`SELECT id FROM profile_rollouts
                    WHERE kind = 'profile_update' AND target_profile_id = ${newest.id}`,
                );
          if (row !== undefined) headOf.set(lineage, row.id);
        }
        for (const agent of behind) {
          const lineage = agent.lineage as string;
          const head = headOf.get(lineage);
          if (head === undefined) continue;
          // Only this agent's pending item in this lineage holds it back.
          const pending = await rows(
            tx,
            sql`SELECT 1 FROM profile_rollout_items i
              JOIN profile_rollouts r ON r.id = i.rollout_id AND r.kind = 'profile_update'
              JOIN installation_profiles p ON p.id = r.target_profile_id
              WHERE i.agent_id = ${agent.agent_id} AND i.status = 'pending'
                AND ${LINEAGE("p")} = ${lineage} LIMIT 1`,
          );
          if (pending.length > 0) continue;
          const put = await rows(
            tx,
            sql`INSERT INTO profile_rollout_items (rollout_id, agent_id, generation)
              VALUES (${head}, ${agent.agent_id}, ${agent.revision})
              ON CONFLICT DO NOTHING RETURNING 1 AS ok`,
          );
          items += put.length;
        }
        return { rollouts, items };
      });
    },

    async inspect({ agentId, targetProfileId, activeProfileId }) {
      const [agent] = await rows<{ tracking: "follow" | "pinned" }>(
        db,
        sql`SELECT profile_tracking AS tracking FROM agents WHERE id = ${agentId}`,
      );
      const found = await rows<ProfileRow>(
        db,
        sql`SELECT p.id, p.version, p.definition, p.created_by, ${LINEAGE("p")} AS lineage
          FROM installation_profiles p WHERE p.id IN (${targetProfileId}, ${activeProfileId})`,
      );
      const target = found.find((row) => row.id === targetProfileId);
      const active = found.find((row) => row.id === activeProfileId);
      const lineage = target?.lineage ?? null;
      const [newest] =
        lineage === null
          ? []
          : await rows<ProfileRow>(
              db,
              sql`SELECT p.id, p.version, p.definition, p.created_by, ${LINEAGE("p")} AS lineage
                FROM installation_profiles p
                WHERE p.origin = 'console' AND ${LINEAGE("p")} = ${lineage}
                ORDER BY p.version DESC LIMIT 1`,
            );
      return {
        tracking: agent?.tracking ?? null,
        sameLineage:
          lineage !== null &&
          active !== undefined &&
          active.lineage === lineage,
        latest: newest === undefined ? null : profileOf(newest),
        active: active === undefined ? null : profileOf(active),
      };
    },

    async backfill({
      dryRun,
    }): Promise<BackfillReport | { refused: "rollouts_exist" }> {
      return db.transaction(async (tx) => {
        await lockWrites(tx);
        if (!dryRun) {
          const any = await rows(
            tx,
            sql`SELECT 1 FROM profile_rollouts LIMIT 1`,
          );
          if (any.length > 0) return { refused: "rollouts_exist" as const };
        }
        const { behind } = await behindLatest(tx);
        const pinned = behind.map((agent) => agent.agent_id).sort();
        const same = await rows<{ id: string }>(
          tx,
          sql`SELECT a.id FROM agents a
            JOIN agent_releases r ON r.id = a.active_release_id
            JOIN installation_profiles p ON p.id = r.runtime_profile_id
            WHERE a.model_source = 'fixed'
              AND r.runtime_config_snapshot ->> 'model' = p.definition ->> 'model'
            ORDER BY a.id`,
        );
        const modelFollowsProfile = same.map((row) => row.id);
        if (!dryRun) {
          for (const id of pinned) {
            await tx.execute(
              sql`UPDATE agents SET profile_tracking = 'pinned' WHERE id = ${id}`,
            );
          }
          for (const id of modelFollowsProfile) {
            await tx.execute(
              sql`UPDATE agents SET model_source = 'profile' WHERE id = ${id}`,
            );
          }
        }
        return { dryRun, pinned, modelFollowsProfile };
      });
    },
  };
}
