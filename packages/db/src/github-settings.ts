import { randomUUID } from "node:crypto";
import {
  agentGitHubSchema,
  GITHUB_CEILING_NONE,
  type GitHubCeiling,
  type GitHubFeatures,
  githubCeilingSchema,
} from "@werft-ai/contracts";
import type {
  GitHubGateStore,
  GitHubSettingsStore,
  GitHubWorkStore,
} from "@werft-ai/platform";
import { and, eq, sql } from "drizzle-orm";
import type { Database } from "./queries.ts";
import {
  agentReleases,
  agents,
  githubApps,
  githubWorkflowDispatches,
  githubWorkspaceSettings,
  receipts,
  sessions,
  turns,
} from "./schema.ts";

/** No row reads all false; a row a later image wrote in another shape, too. */
function ceilingOf(stored: unknown): GitHubCeiling {
  const parsed = githubCeilingSchema.safeParse(stored);
  return parsed.success ? parsed.data : GITHUB_CEILING_NONE;
}

async function readSettings(db: Database, workspaceId: string) {
  const [row] = await db
    .select({
      ceiling: githubWorkspaceSettings.ceiling,
      revision: githubWorkspaceSettings.revision,
    })
    .from(githubWorkspaceSettings)
    .where(eq(githubWorkspaceSettings.workspaceId, workspaceId))
    .limit(1);
  return row === undefined
    ? { ceiling: GITHUB_CEILING_NONE, revision: 0 }
    : { ceiling: ceilingOf(row.ceiling), revision: row.revision };
}

const sessionTarget = (sessionId: string) => ({
  session_id: sessionId,
  turn_id: null,
  request_id: null,
});

/** What the GitHub gate and the work service read and write. */
export function createPostgresGitHubGateStore(
  db: Database,
): GitHubGateStore & GitHubWorkStore {
  return {
    async context(rawSessionId) {
      const sessionId = rawSessionId.toLowerCase();
      const [row] = await db
        .select({
          ownerId: sessions.ownerId,
          repositoryId: sessions.repositoryId,
          repoUrl: sessions.repoUrl,
          branch: sessions.branch,
          // Turn 1's actor, else the creator: the session-shares rule.
          startedBy: sql<
            string | null
          >`coalesce((SELECT t.actor_id FROM ${turns} t WHERE t.session_id = ${sessions.id} AND t.sequence = 1), ${sessions.createdByUserId})`,
          agentId: agents.id,
          workspaceId: agents.workspaceId,
          githubEnabled: agents.githubEnabled,
          releaseId: agentReleases.id,
          github: sql<unknown>`${agentReleases.policyPins} -> 'github'`,
        })
        .from(sessions)
        .leftJoin(agentReleases, eq(agentReleases.id, sessions.agentReleaseId))
        .leftJoin(agents, eq(agents.id, agentReleases.agentId))
        .where(eq(sessions.id, sessionId))
        .limit(1);
      if (row === undefined) return null;
      const github =
        row.github === null || row.github === undefined
          ? null
          : agentGitHubSchema.safeParse(row.github);
      const ceiling =
        row.workspaceId === null
          ? GITHUB_CEILING_NONE
          : (await readSettings(db, row.workspaceId)).ceiling;
      return {
        ownerId: row.ownerId,
        sessionId,
        repositoryId: row.repositoryId,
        repository:
          row.repoUrl === null || row.branch === null
            ? null
            : { url: row.repoUrl, branch: row.branch },
        startedBy: row.startedBy,
        agent:
          row.agentId === null ||
          row.workspaceId === null ||
          row.githubEnabled === null
            ? null
            : {
                id: row.agentId,
                workspaceId: row.workspaceId,
                githubEnabled: row.githubEnabled,
              },
        release:
          row.releaseId === null
            ? null
            : {
                id: row.releaseId,
                github:
                  github === null
                    ? null
                    : github.success
                      ? github.data
                      : "invalid",
              },
        ceiling,
      };
    },

    async findDispatch(repositoryId, runId) {
      const [row] = await db
        .select({
          runId: githubWorkflowDispatches.runId,
          repositoryId: githubWorkflowDispatches.repositoryId,
          workflow: githubWorkflowDispatches.workflow,
          ref: githubWorkflowDispatches.ref,
        })
        .from(githubWorkflowDispatches)
        .where(
          and(
            eq(githubWorkflowDispatches.repositoryId, repositoryId),
            eq(githubWorkflowDispatches.runId, runId),
          ),
        )
        .limit(1);
      return row ?? null;
    },

    async recordReceipt(input) {
      const id = randomUUID();
      await db.insert(receipts).values({
        id,
        ownerId: input.ownerId,
        operation: input.operation,
        targetRef: sessionTarget(input.sessionId),
        status: input.status,
        result: input.result,
        error: input.error,
        actor: input.actor,
      });
      return id;
    },

    recordDispatch(input) {
      return db.transaction(async (tx) => {
        const id = randomUUID();
        await tx.insert(receipts).values({
          id,
          ownerId: input.context.ownerId,
          operation: "dispatch_workflow",
          targetRef: sessionTarget(input.context.sessionId),
          status: "succeeded",
          result: input.result,
          error: null,
          actor: input.actor,
        });
        if (input.run !== null) {
          await tx.insert(githubWorkflowDispatches).values({
            runId: input.run.id,
            repositoryId: input.context.repositoryId,
            sessionId: input.context.sessionId,
            agentReleaseId: input.context.agentReleaseId,
            workflow: input.run.workflow,
            ref: input.run.ref,
            receiptId: id,
          });
        }
        return id;
      });
    },
  };
}

const FEATURES: readonly (keyof GitHubFeatures)[] = [
  "workflows",
  "actions",
  "checks",
  "issues",
  "review",
];

export function createPostgresGitHubSettingsStore(
  db: Database,
): GitHubSettingsStore {
  return {
    get: (workspaceId) => readSettings(db, workspaceId),

    async agentsUsing(workspaceId) {
      const feature = (name: keyof GitHubFeatures) =>
        sql<number>`count(*) FILTER (WHERE ${agentReleases.policyPins} -> 'github' -> 'features' -> ${name} = 'true'::jsonb)::int`;
      const [row] = await db
        .select({
          workflows: feature("workflows"),
          actions: feature("actions"),
          checks: feature("checks"),
          issues: feature("issues"),
          review: feature("review"),
        })
        .from(agents)
        .innerJoin(agentReleases, eq(agentReleases.id, agents.activeReleaseId))
        .where(
          and(
            eq(agents.workspaceId, workspaceId),
            eq(agents.githubEnabled, true),
          ),
        );
      return Object.fromEntries(
        FEATURES.map((name) => [name, row?.[name] ?? 0]),
      ) as Record<keyof GitHubFeatures, number>;
    },

    async appPermissions(workspaceId) {
      const rows = await db
        .select({ role: githubApps.role, permissions: githubApps.permissions })
        .from(githubApps)
        .where(eq(githubApps.workspaceId, workspaceId));
      const of = (role: "author" | "reviewer") => {
        const found = rows.find((row) => row.role === role);
        return found === undefined
          ? null
          : {
              permissions:
                (found.permissions as Record<
                  string,
                  "read" | "write" | "admin"
                > | null) ?? null,
            };
      };
      return { author: of("author"), reviewer: of("reviewer") };
    },

    putCeiling(input) {
      return db.transaction(async (tx) => {
        const [held] = await tx
          .select({
            ceiling: githubWorkspaceSettings.ceiling,
            revision: githubWorkspaceSettings.revision,
          })
          .from(githubWorkspaceSettings)
          .where(eq(githubWorkspaceSettings.workspaceId, input.workspaceId))
          .limit(1)
          .for("update");
        if ((held?.revision ?? 0) !== input.revision) {
          return { outcome: "revision_conflict" as const };
        }
        const revision = input.revision + 1;
        if (held === undefined) {
          // Two first writes both read no row; the second finds the key.
          const [inserted] = await tx
            .insert(githubWorkspaceSettings)
            .values({
              workspaceId: input.workspaceId,
              ceiling: input.ceiling,
              revision,
              updatedBy: input.updatedBy,
            })
            .onConflictDoNothing()
            .returning({ revision: githubWorkspaceSettings.revision });
          if (inserted === undefined) {
            return { outcome: "revision_conflict" as const };
          }
        } else {
          await tx
            .update(githubWorkspaceSettings)
            .set({
              ceiling: input.ceiling,
              revision,
              updatedBy: input.updatedBy,
              updatedAt: sql`now()`,
            })
            .where(eq(githubWorkspaceSettings.workspaceId, input.workspaceId));
        }
        await tx.insert(receipts).values({
          id: randomUUID(),
          ownerId: input.workspaceId,
          actor: input.actor,
          operation: "set_github_ceiling",
          targetRef: {
            resource: { kind: "workspace", id: input.workspaceId },
            workspace_id: input.workspaceId,
          },
          status: "succeeded",
          result: {
            before: held === undefined ? null : ceilingOf(held.ceiling),
            after: input.ceiling,
            revision,
          },
        });
        return {
          outcome: "stored" as const,
          settings: { ceiling: input.ceiling, revision },
        };
      });
    },
  };
}
