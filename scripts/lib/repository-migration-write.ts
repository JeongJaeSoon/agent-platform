/**
 * The write side of the repository migration (R2): moves what the active
 * releases hold into each agent's GitHub settings row and widens each
 * workspace's repository ceiling to `installed`, and takes both back from a
 * before-image file.
 *
 * Every decision is made by the same functions the read-only report uses
 * (`repositoryContext`, `buildReport`), on the snapshot taken inside the
 * write transaction. Nothing here runs by itself: no migration, no startup
 * hook. An operator runs the command line once the stack is ready.
 *
 * Rules (design 3.2, 3.7):
 * - A written agent row has `updated_by = NULL`, so it narrows no session
 *   that started before it and is not a person's save.
 * - A row that exists is never touched. A URL repository (`none`, `basic`,
 *   `bearer`) is not copied and not deleted; it is reported.
 * - A workspace gets only values it can be attributed to; the rest is
 *   reported. Values already in a ceiling stay.
 *
 * The before-image is a file because the scope has no table. It is written
 * and made durable before COMMIT, so a run that committed always has one. A
 * run that did not commit may leave one; revert then finds nothing of it in
 * the database (every row carries the run's `updated_at`) and changes nothing.
 */

import { randomUUID } from "node:crypto";
import { open, readFile, rename } from "node:fs/promises";
import { dirname } from "node:path";
import {
  type AgentGitHub,
  agentGitHubSchema,
  GITHUB_POLICY_CLOSED,
} from "@werft-ai/contracts";
import * as schema from "@werft-ai/db";
import { type Database, ensureInstalledRepositoryCeiling } from "@werft-ai/db";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import {
  buildReport,
  type Report,
  readSnapshot,
  repositoryContext,
  type Snapshot,
  withReadOnlySnapshot,
} from "./repository-migration-report.ts";

type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];

/** Text of a timestamptz that two reads agree on to the microsecond. */
const stamp = (column: string) =>
  `to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US')`;

/** Key-sorted JSON, so two jsonb reads of one value compare equal. */
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

const same = (a: unknown, b: unknown) => stable(a) === stable(b);

// ---------------------------------------------------------------- before-image

const settingsValues = z.object({
  repositories: z.array(z.string()),
  push_approval: z.boolean(),
  features: z.record(z.string(), z.boolean()),
  actions_allow: z.array(z.unknown()),
  start_repository_id: z.string().nullable(),
  revision: z.number().int(),
  updated_at: z.string(),
});

export const beforeImageSchema = z.object({
  version: z.literal(1),
  migration_id: z.string(),
  created_at: z.string(),
  /** Rows the run inserted. Before the run there was no row. */
  agent_rows: z.array(
    z.object({
      agent_id: z.string(),
      workspace_id: z.string(),
      written: settingsValues,
    }),
  ),
  /** Ceilings the run changed. */
  workspace_ceilings: z.array(
    z.object({
      workspace_id: z.string(),
      row_existed: z.boolean(),
      before: z.object({
        repository_ceiling: z.unknown().nullable(),
        revision: z.number().int(),
      }),
      written: z.object({
        repository_ceiling: z.unknown(),
        revision: z.number().int(),
        updated_at: z.string(),
      }),
    }),
  ),
});
export type BeforeImage = z.infer<typeof beforeImageSchema>;

/** File and parent directory are durable before the caller commits. */
export async function writeBeforeImage(path: string, image: BeforeImage) {
  const temporary = `${path}.partial`;
  const body = `${JSON.stringify(image, null, 2)}\n`;
  const file = await open(temporary, "wx", 0o600);
  try {
    await file.writeFile(body);
    await file.sync();
  } finally {
    await file.close();
  }
  // A path that exists is never replaced: rename would.
  const target = await open(path, "wx", 0o600);
  await target.close();
  await rename(temporary, path);
  const directory = await open(dirname(path), "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

// ----------------------------------------------------------------------- plan

type ReleaseRow = {
  agent_id: string;
  workspace_id: string;
  repository_id: string | null;
  profile_id: string | null;
  pin: unknown;
  has_row: boolean;
};

export const RELEASES_SQL = `
SELECT a.id AS agent_id, a.workspace_id, r.repository_id,
       r.runtime_profile_id AS profile_id, r.policy_pins #> '{github}' AS pin,
       EXISTS (SELECT 1 FROM agent_github_settings g WHERE g.agent_id = a.id) AS has_row
FROM agents a JOIN agent_releases r ON r.id = a.active_release_id
ORDER BY a.id`;

type AgentRowPlan = {
  agent_id: string;
  workspace_id: string;
  repositories: string[];
  push_approval: boolean;
  features: AgentGitHub["features"];
  actions_allow: AgentGitHub["actions_allow"];
  start_repository_id: string | null;
  source: "pin" | "pinless";
  /** Legacy URL ids left out of the row. */
  url_not_moved: string[];
  release_repository_outside_list: boolean;
};

type Skipped = {
  agent_id: string;
  workspace_id: string;
  reason: "has_row" | "pin_unreadable";
};

export function planAgentRows(
  snapshot: Snapshot,
  releases: ReleaseRow[],
): { rows: AgentRowPlan[]; skipped: Skipped[] } {
  const context = repositoryContext(snapshot);
  const isUrl = (id: string) => context.kindOf.get(id) === "legacy";
  const rows: AgentRowPlan[] = [];
  const skipped: Skipped[] = [];
  for (const release of releases) {
    const key = {
      agent_id: release.agent_id,
      workspace_id: release.workspace_id,
    };
    if (release.has_row) {
      skipped.push({ ...key, reason: "has_row" });
      continue;
    }
    let source: AgentRowPlan["source"];
    let full: string[];
    let rest: Pick<AgentGitHub, "push_approval" | "features" | "actions_allow">;
    if (release.pin === null || release.pin === undefined) {
      // A release from before GitHub settings: whatever its session was
      // judged against, a person approves each push, nothing optional.
      source = "pinless";
      const judged =
        release.profile_id !== null &&
        context.profileScope(release.profile_id) === "profile"
          ? context.profileSet(release.profile_id)
          : context.ceilingBefore(release.workspace_id);
      full = [...judged].filter((id) => context.kindOf.has(id));
      rest = {
        push_approval: GITHUB_POLICY_CLOSED.push_approval,
        features: GITHUB_POLICY_CLOSED.features,
        actions_allow: GITHUB_POLICY_CLOSED.actions_allow,
      };
    } else {
      const pin = agentGitHubSchema.safeParse(release.pin);
      if (!pin.success) {
        skipped.push({ ...key, reason: "pin_unreadable" });
        continue;
      }
      source = "pin";
      full = pin.data.repositories;
      rest = pin.data;
    }
    const repositories = [...new Set(full.filter((id) => !isUrl(id)))].sort();
    const url = full.filter(isUrl);
    const start =
      release.repository_id !== null &&
      repositories.includes(release.repository_id)
        ? release.repository_id
        : null;
    rows.push({
      ...key,
      repositories,
      push_approval: rest.push_approval,
      features: rest.features,
      actions_allow: rest.actions_allow,
      start_repository_id: start,
      source,
      url_not_moved: [...new Set(url)].sort(),
      release_repository_outside_list:
        release.repository_id !== null && start === null,
    });
  }
  return { rows, skipped };
}

export type Plan = {
  report: Report;
  agent_rows: AgentRowPlan[];
  agent_rows_skipped: Skipped[];
  /** Ids each workspace's ceiling gets, besides what it holds and `installed`. */
  workspace_ceilings: Array<{ workspace_id: string; add_ids: string[] }>;
};

export function buildPlan(
  snapshot: Snapshot,
  releases: ReleaseRow[],
  now: Date,
): Plan {
  const report = buildReport(snapshot, null, now);
  const { rows, skipped } = planAgentRows(snapshot, releases);
  return {
    report,
    agent_rows: rows,
    agent_rows_skipped: skipped,
    workspace_ceilings: report.workspaces.map((workspace) => ({
      workspace_id: workspace.workspace_id,
      add_ids: workspace.attributed.map((entry) => entry.id),
    })),
  };
}

async function readPlan(client: PoolClient, now: Date): Promise<Plan> {
  const snapshot = await readSnapshot(client);
  const releases = (await client.query(RELEASES_SQL)).rows as ReleaseRow[];
  return buildPlan(snapshot, releases, now);
}

/** The plan alone, in a read-only snapshot. Writes nothing. */
export function planMigration(pool: Pool, now: Date = new Date()) {
  return withReadOnlySnapshot(pool, (client) => readPlan(client, now));
}

// ---------------------------------------------------------------------- apply

/** `Tx` as the report's reader expects a client. */
const asClient = (tx: Tx): PoolClient =>
  ({
    query: async (text: string) => ({
      rows: (
        (await tx.execute(sql.raw(text))) as unknown as { rows: unknown[] }
      ).rows,
    }),
  }) as unknown as PoolClient;

export type ApplyResult = {
  migration_id: string;
  changes: number;
  before_image: string | null;
  plan: Plan;
  agent_rows_written: string[];
  workspaces: Array<{
    workspace_id: string;
    changed: boolean;
    allowed_before: string[];
    allowed_after: string[];
  }>;
};

const allowedOf = (snapshot: Snapshot) => {
  const context = repositoryContext(snapshot);
  return new Map(
    snapshot.workspaces.map((workspace) => [
      workspace.id,
      [...context.ceilingBefore(workspace.id)].sort(),
    ]),
  );
};

export async function applyMigration(
  pool: Pool,
  beforeImagePath: string,
  now: Date = new Date(),
): Promise<ApplyResult> {
  const db = drizzle(pool, { schema });
  const migrationId = randomUUID();
  // One value only this run writes into `updated_at`; revert matches on it.
  const runStamp = now.toISOString();
  return db.transaction(
    async (tx) => {
      // Agents first, then their settings, then the workspace: the order a
      // session start takes. The first statement also fixes the snapshot.
      await tx.execute(
        sql`SELECT id FROM agents WHERE active_release_id IS NOT NULL ORDER BY id FOR UPDATE`,
      );
      const client = asClient(tx);
      const plan = await readPlan(client, now);
      const beforeSets = allowedOf(await readSnapshot(client));

      const agentRows: BeforeImage["agent_rows"] = [];
      for (const row of plan.agent_rows) {
        const inserted = await tx.execute(sql`
          INSERT INTO agent_github_settings (agent_id, workspace_id, repositories,
            push_approval, features, actions_allow, start_repository_id,
            revision, updated_by, updated_at)
          VALUES (${row.agent_id}, ${row.workspace_id},
            ${JSON.stringify(row.repositories)}::jsonb, ${row.push_approval},
            ${JSON.stringify(row.features)}::jsonb,
            ${JSON.stringify(row.actions_allow)}::jsonb,
            ${row.start_repository_id}, 1, NULL, ${runStamp}::timestamptz)
          ON CONFLICT (agent_id) DO NOTHING
          RETURNING ${sql.raw(stamp("updated_at"))} AS updated_at`);
        const written = inserted.rows[0] as { updated_at: string } | undefined;
        // The row appeared after the snapshot: stop, the plan is stale.
        if (written === undefined) {
          throw new Error(`agent ${row.agent_id} gained a settings row`);
        }
        agentRows.push({
          agent_id: row.agent_id,
          workspace_id: row.workspace_id,
          written: {
            repositories: row.repositories,
            push_approval: row.push_approval,
            features: row.features,
            actions_allow: row.actions_allow as unknown[],
            start_repository_id: row.start_repository_id,
            revision: 1,
            updated_at: written.updated_at,
          },
        });
      }

      const ceilings: BeforeImage["workspace_ceilings"] = [];
      const changed = new Map<string, boolean>();
      const ceilingQuery = (workspaceId: string) =>
        tx.execute(sql`
          SELECT repository_ceiling, revision, ${sql.raw(stamp("updated_at"))} AS updated_at
          FROM github_workspace_settings WHERE workspace_id = ${workspaceId} FOR UPDATE`);
      for (const entry of plan.workspace_ceilings) {
        const held = (await ceilingQuery(entry.workspace_id)).rows[0] as
          | { repository_ceiling: unknown; revision: number }
          | undefined;
        const result = await ensureInstalledRepositoryCeiling(
          tx as unknown as Database,
          entry.workspace_id,
          entry.add_ids,
        );
        changed.set(entry.workspace_id, result.changed);
        if (!result.changed) continue;
        const after = (await ceilingQuery(entry.workspace_id)).rows[0] as {
          repository_ceiling: unknown;
          revision: number;
          updated_at: string;
        };
        ceilings.push({
          workspace_id: entry.workspace_id,
          row_existed: held !== undefined,
          before: {
            repository_ceiling: held?.repository_ceiling ?? null,
            revision: held?.revision ?? 0,
          },
          written: {
            repository_ceiling: after.repository_ceiling,
            revision: after.revision,
            updated_at: after.updated_at,
          },
        });
      }

      // What the database now allows must be what the report promised.
      const afterSets = allowedOf(await readSnapshot(client));
      for (const workspace of plan.report.workspaces) {
        const promised = workspace.ceiling_after_ids.map((entry) => entry.id);
        const got = afterSets.get(workspace.workspace_id) ?? [];
        if (!same(promised, got)) {
          throw new Error(
            `workspace ${workspace.workspace_id}: allowed set differs from the report`,
          );
        }
      }

      const changes = agentRows.length + ceilings.length;
      if (changes > 0) {
        await writeBeforeImage(beforeImagePath, {
          version: 1,
          migration_id: migrationId,
          created_at: runStamp,
          agent_rows: agentRows,
          workspace_ceilings: ceilings,
        });
      }
      return {
        migration_id: migrationId,
        changes,
        before_image: changes > 0 ? beforeImagePath : null,
        plan,
        agent_rows_written: agentRows.map((row) => row.agent_id),
        workspaces: plan.report.workspaces.map((workspace) => ({
          workspace_id: workspace.workspace_id,
          changed: changed.get(workspace.workspace_id) ?? false,
          allowed_before: beforeSets.get(workspace.workspace_id) ?? [],
          allowed_after: afterSets.get(workspace.workspace_id) ?? [],
        })),
      };
    },
    { isolationLevel: "repeatable read" },
  );
}

// --------------------------------------------------------------------- revert

export type RevertResult = {
  migration_id: string;
  agent_rows: Array<{
    agent_id: string;
    outcome: "reverted" | "already_reverted" | "changed_since";
  }>;
  workspace_ceilings: Array<{
    workspace_id: string;
    outcome: "reverted" | "already_reverted" | "changed_since";
  }>;
};

export async function revertMigration(
  pool: Pool,
  beforeImagePath: string,
): Promise<RevertResult> {
  const image = beforeImageSchema.parse(
    JSON.parse(await readFile(beforeImagePath, "utf8")),
  );
  const db = drizzle(pool, { schema });
  return db.transaction(
    async (tx) => {
      const result: RevertResult = {
        migration_id: image.migration_id,
        agent_rows: [],
        workspace_ceilings: [],
      };
      const agentIds = image.agent_rows.map((row) => row.agent_id).sort();
      for (const id of agentIds) {
        await tx.execute(
          sql`SELECT id FROM agents WHERE id = ${id} FOR UPDATE`,
        );
      }
      for (const entry of image.agent_rows) {
        const found = (
          await tx.execute(sql`
            SELECT workspace_id, repositories, push_approval, features, actions_allow,
                   start_repository_id, revision, updated_by,
                   ${sql.raw(stamp("updated_at"))} AS updated_at
            FROM agent_github_settings WHERE agent_id = ${entry.agent_id} FOR UPDATE`)
        ).rows[0] as
          | {
              workspace_id: string;
              repositories: unknown;
              push_approval: boolean;
              features: unknown;
              actions_allow: unknown;
              start_repository_id: string | null;
              revision: number;
              updated_by: string | null;
              updated_at: string;
            }
          | undefined;
        if (found === undefined) {
          result.agent_rows.push({
            agent_id: entry.agent_id,
            outcome: "already_reverted",
          });
          continue;
        }
        const written = entry.written;
        const ours =
          found.updated_by === null &&
          found.workspace_id === entry.workspace_id &&
          found.revision === written.revision &&
          found.updated_at === written.updated_at &&
          found.push_approval === written.push_approval &&
          found.start_repository_id === written.start_repository_id &&
          same(found.repositories, written.repositories) &&
          same(found.features, written.features) &&
          same(found.actions_allow, written.actions_allow);
        if (!ours) {
          result.agent_rows.push({
            agent_id: entry.agent_id,
            outcome: "changed_since",
          });
          continue;
        }
        await tx.execute(
          sql`DELETE FROM agent_github_settings WHERE agent_id = ${entry.agent_id}`,
        );
        result.agent_rows.push({
          agent_id: entry.agent_id,
          outcome: "reverted",
        });
      }

      for (const entry of [...image.workspace_ceilings].sort((a, b) =>
        a.workspace_id < b.workspace_id ? -1 : 1,
      )) {
        const found = (
          await tx.execute(sql`
            SELECT repository_ceiling, revision, ${sql.raw(stamp("updated_at"))} AS updated_at
            FROM github_workspace_settings
            WHERE workspace_id = ${entry.workspace_id} FOR UPDATE`)
        ).rows[0] as
          | {
              repository_ceiling: unknown;
              revision: number;
              updated_at: string;
            }
          | undefined;
        const outcome = (
          value: RevertResult["workspace_ceilings"][number]["outcome"],
        ) =>
          result.workspace_ceilings.push({
            workspace_id: entry.workspace_id,
            outcome: value,
          });
        if (found === undefined) {
          outcome("already_reverted");
          continue;
        }
        const ours =
          found.revision === entry.written.revision &&
          found.updated_at === entry.written.updated_at &&
          same(found.repository_ceiling, entry.written.repository_ceiling);
        if (!ours) {
          const back = same(
            found.repository_ceiling ?? null,
            entry.before.repository_ceiling ?? null,
          );
          outcome(back ? "already_reverted" : "changed_since");
          continue;
        }
        await tx.execute(sql`
          UPDATE github_workspace_settings
          SET repository_ceiling = ${
            entry.before.repository_ceiling === null ||
            entry.before.repository_ceiling === undefined
              ? null
              : JSON.stringify(entry.before.repository_ceiling)
          }::jsonb,
              revision = revision + 1, updated_at = now()
          WHERE workspace_id = ${entry.workspace_id}`);
        outcome("reverted");
      }
      return result;
    },
    { isolationLevel: "repeatable read" },
  );
}

export function summarizeApply(result: ApplyResult): string[] {
  const widened = result.workspaces.filter((w) => w.changed).length;
  return [
    `migration ${result.migration_id}: ${result.changes} change(s)`,
    `agent rows written: ${result.agent_rows_written.length}, skipped: ${result.plan.agent_rows_skipped.length}`,
    `workspace ceilings written: ${widened} of ${result.workspaces.length}`,
    `unattributed values (reported, not written): ${result.plan.report.unattributed.length}`,
    `before-image: ${result.before_image ?? "none (nothing changed)"}`,
  ];
}
