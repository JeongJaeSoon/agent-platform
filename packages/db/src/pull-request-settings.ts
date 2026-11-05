import { createHash, randomUUID } from "node:crypto";
import {
  DEFAULT_PULL_REQUEST_SETTINGS,
  GITHUB_CEILING_NONE,
  type PullRequestSettings,
  pullRequestSettingsSchema,
} from "@werft-ai/contracts";
import type { PullRequestSettingsStore } from "@werft-ai/platform";
import { eq, sql } from "drizzle-orm";
import { lockedRole } from "./api-keys.ts";
import type { Database } from "./queries.ts";
import { githubWorkspaceSettings, receipts } from "./schema.ts";

/** None saved, or a value a later image wrote in another shape: the defaults. */
export function pullRequestSettingsOf(stored: unknown): PullRequestSettings {
  const parsed = pullRequestSettingsSchema.safeParse(stored);
  return parsed.success ? parsed.data : DEFAULT_PULL_REQUEST_SETTINGS;
}

/** What a receipt keeps of a template: that it is set, its size and a hash. */
function templateRecord(text: string | null) {
  return text === null
    ? null
    : {
        bytes: new TextEncoder().encode(text).length,
        sha256: createHash("sha256").update(text).digest("hex"),
      };
}

function receiptView(settings: PullRequestSettings | null) {
  return settings === null
    ? null
    : {
        formatting: settings.formatting,
        template_mode: settings.template_mode,
        session_link: settings.session_link,
        default_template: templateRecord(settings.default_template),
      };
}

export function createPostgresPullRequestSettingsStore(
  db: Database,
): PullRequestSettingsStore {
  return {
    async get(workspaceId) {
      const [row] = await db
        .select({
          pullRequest: githubWorkspaceSettings.pullRequest,
          revision: githubWorkspaceSettings.pullRequestRevision,
        })
        .from(githubWorkspaceSettings)
        .where(eq(githubWorkspaceSettings.workspaceId, workspaceId))
        .limit(1);
      return row === undefined
        ? { settings: DEFAULT_PULL_REQUEST_SETTINGS, revision: 0 }
        : {
            settings: pullRequestSettingsOf(row.pullRequest),
            revision: row.revision,
          };
    },

    put(input) {
      return db.transaction(async (tx) => {
        // A demotion or disable committed after the policy's check wins.
        const role = await lockedRole(tx, input.workspaceId, input.updatedBy);
        if (role !== "owner" && role !== "admin") {
          return { outcome: "actor_inactive" as const };
        }
        const [held] = await tx
          .select({
            pullRequest: githubWorkspaceSettings.pullRequest,
            revision: githubWorkspaceSettings.pullRequestRevision,
          })
          .from(githubWorkspaceSettings)
          .where(eq(githubWorkspaceSettings.workspaceId, input.workspaceId))
          .limit(1)
          .for("update");
        if ((held?.revision ?? 0) !== input.revision) {
          return { outcome: "revision_conflict" as const };
        }
        const before =
          held === undefined ? null : pullRequestSettingsOf(held.pullRequest);
        if (
          held !== undefined &&
          JSON.stringify(before) === JSON.stringify(input.settings)
        ) {
          return {
            outcome: "stored" as const,
            settings: input.settings,
            revision: held.revision,
            receiptId: null,
          };
        }
        const revision = input.revision + 1;
        if (held === undefined) {
          // The ceiling stays unsaved: its revision 0 is what a client that
          // never saved one still holds. Two first writes both read no row;
          // the second finds the key.
          const [inserted] = await tx
            .insert(githubWorkspaceSettings)
            .values({
              workspaceId: input.workspaceId,
              ceiling: GITHUB_CEILING_NONE,
              revision: 0,
              pullRequest: input.settings,
              pullRequestRevision: revision,
              updatedBy: input.updatedBy,
            })
            .onConflictDoNothing()
            .returning({
              revision: githubWorkspaceSettings.pullRequestRevision,
            });
          if (inserted === undefined) {
            return { outcome: "revision_conflict" as const };
          }
        } else {
          await tx
            .update(githubWorkspaceSettings)
            .set({
              pullRequest: input.settings,
              pullRequestRevision: revision,
              updatedBy: input.updatedBy,
              updatedAt: sql`now()`,
            })
            .where(eq(githubWorkspaceSettings.workspaceId, input.workspaceId));
        }
        const receiptId = randomUUID();
        await tx.insert(receipts).values({
          id: receiptId,
          ownerId: input.workspaceId,
          actor: input.actor,
          operation: "set_github_pull_request_settings",
          targetRef: {
            resource: { kind: "workspace", id: input.workspaceId },
            workspace_id: input.workspaceId,
          },
          status: "succeeded",
          result: {
            before: receiptView(before),
            after: receiptView(input.settings),
            revision,
          },
        });
        return {
          outcome: "stored" as const,
          settings: input.settings,
          revision,
          receiptId,
        };
      });
    },
  };
}
