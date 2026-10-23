import type {
  SlackInboundDropReason,
  SlackInboundEventStatus,
} from "@werft-ai/contracts";

/**
 * One event as the events route stored it. A `dropped` row has a reason and
 * no payload; the others keep the envelope as Slack sent it.
 */
export type SlackInboundEventInput = {
  workspaceId: string;
  /** The agent the request URL named. */
  agentId: string;
  slackAppId: string;
  teamId: string;
  appId: string;
  eventId: string;
  eventType: string;
  eventSubtype: string | null;
  eventTime: Date | null;
} & (
  | { status: "dropped"; dropReason: SlackInboundDropReason }
  | {
      status: Exclude<SlackInboundEventStatus, "dropped">;
      payload: Record<string, unknown>;
    }
);

/**
 * The Slack inbox. `(team_id, event_id)` is unique: Slack keeps `event_id`
 * across its retries, so a retry finds the row already there.
 */
export interface SlackInboundEventStore {
  seen(teamId: string, eventId: string): Promise<boolean>;
  record(event: SlackInboundEventInput): Promise<"recorded" | "duplicate">;
}
