import { SESSION_STATUS_VALUES } from "@agent-platform/contracts";
import { sql } from "drizzle-orm";
import {
  bigint,
  bigserial,
  boolean,
  customType,
  index,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

const bytea = customType<{ data: Uint8Array }>({
  dataType() {
    return "bytea";
  },
});

export const sessionStatus = pgEnum("session_status", SESSION_STATUS_VALUES);

export const sessions = pgTable(
  "sessions",
  {
    id: uuid().primaryKey(),
    claudeSessionId: text("claude_session_id"),
    ownerId: text("owner_id").notNull(),
    repoUrl: text("repo_url").notNull(),
    branch: text().notNull(),
    status: sessionStatus().notNull().default("queued"),
    podId: text("pod_id"),
    pinned: boolean().notNull().default(false),
    lastTurnAt: timestamp("last_turn_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("sessions_pod_uniq")
      .on(table.podId)
      .where(sql`${table.podId} IS NOT NULL`),
  ],
);

export const turns = pgTable("turns", {
  id: bigserial({ mode: "number" }).primaryKey(),
  sessionId: uuid("session_id")
    .notNull()
    .references(() => sessions.id),
  message: text().notNull(),
  status: text().notNull(),
  startedAt: timestamp("started_at", { withTimezone: true }),
  endedAt: timestamp("ended_at", { withTimezone: true }),
  resultJson: jsonb("result_json"),
});

export const pullRequests = pgTable(
  "pull_requests",
  {
    sessionId: uuid("session_id").references(() => sessions.id),
    url: text().notNull(),
  },
  (table) => [primaryKey({ columns: [table.sessionId, table.url] })],
);

export const events = pgTable(
  "events",
  {
    id: bigserial({ mode: "number" }).primaryKey(),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => sessions.id),
    type: text().notNull(),
    payload: jsonb().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [index("events_session_id_idx").on(table.sessionId, table.id)],
);

export const queueMessages = pgTable(
  "queue_messages",
  {
    id: bigserial({ mode: "number" }).primaryKey(),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => sessions.id),
    turnId: bigint("turn_id", { mode: "number" }).references(() => turns.id),
    kind: text().notNull(),
    payload: jsonb().notNull(),
    visibleAt: timestamp("visible_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    claimedBy: text("claimed_by"),
    claimToken: uuid("claim_token"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("queue_messages_pick_idx")
      .on(table.sessionId, table.id)
      .where(sql`${table.claimedBy} IS NULL`),
  ],
);

export const unassignedSessions = pgTable("unassigned_sessions", {
  sessionId: uuid("session_id")
    .primaryKey()
    .references(() => sessions.id),
  signaledAt: timestamp("signaled_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const workers = pgTable("workers", {
  podId: text("pod_id").primaryKey(),
  lastSeen: timestamp("last_seen", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const apiKeys = pgTable("api_keys", {
  id: uuid().primaryKey(),
  keyHash: bytea("key_hash").notNull().unique(),
  ownerId: text("owner_id").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
});
