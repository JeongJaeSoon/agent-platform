import { randomUUID } from "node:crypto";
import type { SlackInboundEventStore } from "@werft-ai/platform";
import { and, eq } from "drizzle-orm";
import type { Database } from "./queries.ts";
import { slackInboundEvents } from "./schema.ts";

export function createPostgresSlackInboundEventStore(
  db: Database,
): SlackInboundEventStore {
  return {
    async seen(teamId, eventId) {
      const [row] = await db
        .select({ id: slackInboundEvents.id })
        .from(slackInboundEvents)
        .where(
          and(
            eq(slackInboundEvents.teamId, teamId),
            eq(slackInboundEvents.eventId, eventId),
          ),
        )
        .limit(1);
      return row !== undefined;
    },

    async record(event) {
      const [row] = await db
        .insert(slackInboundEvents)
        .values({
          id: randomUUID(),
          workspaceId: event.workspaceId,
          agentId: event.agentId,
          slackAppId: event.slackAppId,
          teamId: event.teamId,
          appId: event.appId,
          eventId: event.eventId,
          eventType: event.eventType,
          eventSubtype: event.eventSubtype,
          eventTime: event.eventTime,
          status: event.status,
          dropReason: event.status === "dropped" ? event.dropReason : null,
          payload: event.status === "dropped" ? null : event.payload,
        })
        .onConflictDoNothing({
          target: [slackInboundEvents.teamId, slackInboundEvents.eventId],
        })
        .returning({ id: slackInboundEvents.id });
      return row ? "recorded" : "duplicate";
    },
  };
}
