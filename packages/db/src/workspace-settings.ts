import type {
  SlackGuestSetting,
  SlackGuestSettingStore,
} from "@agent-platform/platform";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { lockActorAccount } from "./control-shared.ts";
import type { Database } from "./queries.ts";
import { memberships, users, workspaces } from "./schema.ts";

export function createPostgresSlackGuestSetting(
  db: Database,
): SlackGuestSetting & SlackGuestSettingStore {
  return {
    // Anything but a stored `true` is the default: off.
    async enabled(workspaceId) {
      const [row] = await db
        .select({
          enabled: sql<boolean>`coalesce(${workspaces.settings} -> 'slack_guest_enabled' = 'true'::jsonb, false)`,
        })
        .from(workspaces)
        .where(eq(workspaces.id, workspaceId))
        .limit(1);
      return row?.enabled === true;
    },

    async setSlackGuestEnabled({ workspaceId, actorUserId, enabled }) {
      // Same lock as offboarding takes, so a manager disabled mid-request
      // cannot still write the setting.
      return db.transaction(async (tx) => {
        await lockActorAccount(tx, actorUserId);
        const manager = await tx
          .select({ userId: memberships.userId })
          .from(memberships)
          .innerJoin(users, eq(users.id, memberships.userId))
          .where(
            and(
              eq(memberships.workspaceId, workspaceId),
              eq(memberships.userId, actorUserId),
              inArray(memberships.role, ["owner", "admin"]),
              isNull(memberships.disabledAt),
              isNull(users.disabledAt),
            ),
          )
          .limit(1)
          .for("share", { of: memberships });
        if (manager.length === 0) return false;
        const rows = await tx
          .update(workspaces)
          .set({
            settings: sql`jsonb_set(${workspaces.settings}, '{slack_guest_enabled}', to_jsonb(${enabled}::boolean))`,
          })
          .where(eq(workspaces.id, workspaceId))
          .returning({ id: workspaces.id });
        return rows.length > 0;
      });
    },
  };
}
