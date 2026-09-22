import {
  ADMISSION_STATE_VALUES,
  RECEIPT_STATUS_VALUES,
  SESSION_STATUS_VALUES,
} from "@agent-platform/contracts";
import { sql } from "drizzle-orm";
import {
  bigint,
  bigserial,
  boolean,
  check,
  customType,
  index,
  integer,
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
export const admissionState = pgEnum("admission_state", ADMISSION_STATE_VALUES);
export const receiptStatus = pgEnum("receipt_status", RECEIPT_STATUS_VALUES);

export const sessions = pgTable(
  "sessions",
  {
    id: uuid().primaryKey(),
    claudeSessionId: text("claude_session_id"),
    ownerId: text("owner_id").notNull(),
    repoUrl: text("repo_url").notNull(),
    branch: text().notNull(),
    status: sessionStatus().notNull().default("queued"),
    admissionState: admissionState("admission_state")
      .notNull()
      .default("active"),
    revision: integer().notNull().default(0),
    leaseEpoch: integer("lease_epoch").notNull().default(0),
    executionGeneration: integer("execution_generation").notNull().default(0),
    authRevision: integer("auth_revision").notNull().default(0),
    executionId: text("execution_id"),
    profileId: text("profile_id"),
    repositoryId: text("repository_id"),
    checkpointRevision: integer("checkpoint_revision"),
    checkpointCommittedAt: timestamp("checkpoint_committed_at", {
      withTimezone: true,
    }),
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

export const turns = pgTable(
  "turns",
  {
    id: bigserial({ mode: "number" }).primaryKey(),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => sessions.id),
    // Public turn_id: 1-based position within the session, not the global id.
    sequence: integer().notNull(),
    message: text().notNull(),
    status: text().notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    resultJson: jsonb("result_json"),
    attemptId: text("attempt_id"),
    deliveryStartedAt: timestamp("delivery_started_at", { withTimezone: true }),
    terminalReason: text("terminal_reason"),
    outcomeUnknown: boolean("outcome_unknown").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("turns_session_sequence_uniq").on(
      table.sessionId,
      table.sequence,
    ),
  ],
);

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
    turnId: bigint("turn_id", { mode: "number" }).references(() => turns.id),
    attemptId: text("attempt_id"),
    sourceSequence: integer("source_sequence"),
    occurredAt: timestamp("occurred_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("events_session_id_idx").on(table.sessionId, table.id),
    uniqueIndex("events_attempt_sequence_uniq")
      .on(table.sessionId, table.attemptId, table.sourceSequence)
      .where(sql`${table.attemptId} IS NOT NULL`),
  ],
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
    // nextInput polls for a session's head every few hundred milliseconds
    // and looks at claimed rows too, which the partial index above cannot
    // serve.
    index("queue_messages_head_idx").on(table.sessionId, table.kind, table.id),
  ],
);

export const unassignedSessions = pgTable("unassigned_sessions", {
  sessionId: uuid("session_id")
    .primaryKey()
    .references(() => sessions.id),
  signaledAt: timestamp("signaled_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  partition: text().notNull().default("default"),
});

export const receipts = pgTable(
  "receipts",
  {
    id: uuid().primaryKey(),
    ownerId: text("owner_id").notNull(),
    operation: text().notNull(),
    targetRef: jsonb("target_ref").notNull(),
    status: receiptStatus().notNull().default("accepted"),
    result: jsonb(),
    error: jsonb(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("receipts_owner_created_at_idx").on(table.ownerId, table.createdAt),
  ],
);

export const idempotencyKeys = pgTable(
  "idempotency_keys",
  {
    principal: text().notNull(),
    operation: text().notNull(),
    resource: text().notNull(),
    key: text().notNull(),
    payloadHash: text("payload_hash").notNull(),
    receiptId: uuid("receipt_id")
      .notNull()
      .references(() => receipts.id),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({
      columns: [table.principal, table.operation, table.resource, table.key],
    }),
  ],
);

export const pendingRequests = pgTable(
  "pending_requests",
  {
    requestId: text("request_id").primaryKey(),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => sessions.id),
    turnId: bigint("turn_id", { mode: "number" })
      .notNull()
      .references(() => turns.id),
    attemptId: text("attempt_id").notNull(),
    kind: text().notNull(),
    payload: jsonb().notNull(),
    inputHash: text("input_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("pending_requests_unresolved_session_idx")
      .on(table.sessionId)
      .where(sql`${table.resolvedAt} IS NULL`),
  ],
);

export const checkpoints = pgTable(
  "checkpoints",
  {
    sessionId: uuid("session_id")
      .notNull()
      .references(() => sessions.id),
    revision: integer().notNull(),
    manifestRef: text("manifest_ref").notNull(),
    manifestSha256: text("manifest_sha256").notNull(),
    turnId: bigint("turn_id", { mode: "number" }).references(() => turns.id),
    committedAt: timestamp("committed_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.sessionId, table.revision] })],
);

export const executions = pgTable(
  "executions",
  {
    id: text().primaryKey(),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => sessions.id),
    backend: text().notNull(),
    providerRef: text("provider_ref"),
    launchOperationId: text("launch_operation_id"),
    generation: integer().notNull(),
    desiredState: text("desired_state").notNull(),
    observedState: text("observed_state").notNull(),
    observedAt: timestamp("observed_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("executions_launch_operation_id_uniq")
      .on(table.launchOperationId)
      .where(sql`${table.launchOperationId} IS NOT NULL`),
    index("executions_session_generation_idx").on(
      table.sessionId,
      table.generation,
    ),
  ],
);

// One worker binding to a session: the fenced identity every post-claim
// write carries (lease_epoch, execution_generation, auth_revision).
export const attempts = pgTable(
  "attempts",
  {
    id: text().primaryKey(),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => sessions.id),
    executionId: text("execution_id").notNull(),
    leaseEpoch: integer("lease_epoch").notNull(),
    executionGeneration: integer("execution_generation").notNull(),
    authRevision: integer("auth_revision").notNull(),
    state: text().notNull(),
    leaseExpiresAt: timestamp("lease_expires_at", {
      withTimezone: true,
    }).notNull(),
    lastHeartbeatAt: timestamp("last_heartbeat_at", { withTimezone: true }),
    startedAt: timestamp("started_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    endReason: text("end_reason"),
  },
  (table) => [
    index("attempts_session_started_idx").on(table.sessionId, table.startedAt),
  ],
);

// The one launch registry: a row is the reserved slot, and it carries the
// hash of the one-time nonce the worker trades for its binding. The row is
// written when the slot is taken; the nonce columns stay null until a
// container is actually created for it, so a reservation nobody launched
// hands out no credential at all.
export const workerLaunches = pgTable(
  "worker_launches",
  {
    executionId: text("execution_id").primaryKey(),
    generation: integer().notNull(),
    partition: text().notNull().default("default"),
    // Set when the launch was started for one particular session, which is
    // what a backend that mounts a session's workspace into the container
    // does. The claim is then pinned to it instead of taking the partition's
    // head, so an execution built for B can never run A.
    sessionId: uuid("session_id").references(() => sessions.id),
    backend: text().notNull(),
    // Null until the credential is issued. A null never matches a lookup by
    // hash, which is what makes an unlaunched reservation unclaimable.
    nonceHash: bytea("nonce_hash").unique(),
    nonceExpiresAt: timestamp("nonce_expires_at", { withTimezone: true }),
    claimedAttemptId: text("claimed_attempt_id").references(() => attempts.id),
    // Set before the scheduler tears the resource down to rebuild it from
    // the same intent; cleared once the rebuilt one is observed up. A
    // teardown that half happens, or a host that dies mid-way, leaves it
    // set, and that is what keeps the next pass from reading the stopped
    // resource as an ordinary exit.
    replacementReason: text("replacement_reason"),
    // Replacements ever requested for this launch; never reset, so the
    // scheduler's limit holds across settle-and-request-again cycles.
    replacementCount: integer("replacement_count").notNull().default(0),
    slotReservedAt: timestamp("slot_reserved_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    slotReleasedAt: timestamp("slot_released_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("worker_launches_open_slot_idx")
      .on(table.partition)
      .where(sql`${table.slotReleasedAt} IS NULL`),
    // Every reservation asks whether this session already holds a launch.
    index("worker_launches_open_session_idx")
      .on(table.sessionId)
      .where(
        sql`${table.slotReleasedAt} IS NULL AND ${table.sessionId} IS NOT NULL`,
      ),
    check(
      "worker_launches_replacement_reason_check",
      sql`${table.replacementReason} IS NULL OR ${table.replacementReason} IN ('nonce_expired', 'stale_isolation')`,
    ),
    check(
      "worker_launches_replacement_count_check",
      sql`${table.replacementCount} >= 0`,
    ),
  ],
);

// Session credential handed out by bootstrapClaim; only its hash is stored.
export const workerCredentials = pgTable(
  "worker_credentials",
  {
    tokenHash: bytea("token_hash").primaryKey(),
    attemptId: text("attempt_id")
      .notNull()
      .references(() => attempts.id),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    // Every heartbeat extends the attempt's live credential, and revoked
    // rows are kept as history, so that lookup needs its own index.
    index("worker_credentials_live_idx")
      .on(table.attemptId)
      .where(sql`${table.revokedAt} IS NULL`),
  ],
);

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
