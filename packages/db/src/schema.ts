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
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

const bytea = customType<{ data: Uint8Array }>({
  dataType() {
    return "bytea";
  },
});

/** The largest `sessions.cost_usd` numeric(14, 6) holds; sums saturate here. */
export const MAX_SESSION_COST_USD = 99_999_999.999999;

export const sessionStatus = pgEnum("session_status", SESSION_STATUS_VALUES);
export const admissionState = pgEnum("admission_state", ADMISSION_STATE_VALUES);
export const receiptStatus = pgEnum("receipt_status", RECEIPT_STATUS_VALUES);

// Vocabularies the CHECK constraints below pin. They mirror 94S-148's
// SESSION_SCOPE_VALUES and AUTHORIZATION_ACTION_VALUES; once that package
// is on main, schema.test.ts should assert the two lists are equal, the way
// it already does for sessionStatus.
export const SESSION_SCOPE_VALUES = [
  "sessions:read",
  "sessions:write",
  "sessions:approve",
  "sessions:control",
  "sessions:recover",
] as const;
export const AUTHORIZATION_ACTION_VALUES = [
  "workspace.read",
  "workspace.manage",
  "agent.manage",
  "binding.manage",
  "routine.manage",
  "session.read",
  "session.submit",
  "session.approve",
  "session.control",
  "session.recover",
  "memory.read",
  "memory.write",
  "artifact.read",
  "delivery.send",
] as const;
export const RESOURCE_KIND_VALUES = [
  "workspace",
  "session",
  "invite",
  "agent",
  "agent_release",
  "surface_binding",
  "session_link",
  "dispatch",
  "memory",
  "routine",
  "artifact",
] as const;
export const AUDIENCE_KIND_VALUES = [
  "workspace",
  "surface_binding",
  "session_link",
  "session",
] as const;
// Which resource kinds each action may be granted on (94S-148
// ACTION_RESOURCE_KINDS, ported from Kollegium): `session.read` on a
// workspace would be a workspace-wide read smuggled in through the resource.
const ACTION_RESOURCE_KINDS: Record<
  (typeof AUTHORIZATION_ACTION_VALUES)[number],
  readonly (typeof RESOURCE_KIND_VALUES)[number][]
> = {
  "workspace.read": ["workspace"],
  "workspace.manage": ["workspace"],
  "agent.manage": ["workspace", "agent"],
  "binding.manage": ["workspace", "agent", "surface_binding"],
  "routine.manage": ["workspace", "agent", "routine"],
  "session.read": ["session", "session_link"],
  "session.submit": ["session", "session_link", "surface_binding"],
  "session.approve": ["session", "session_link"],
  "session.control": ["session", "session_link"],
  "session.recover": ["session"],
  "memory.read": ["workspace", "agent", "memory"],
  "memory.write": ["workspace", "agent", "memory"],
  "artifact.read": ["artifact", "session"],
  "delivery.send": ["session", "session_link", "surface_binding"],
};
const sqlList = (values: readonly string[]) =>
  values.map((value) => `'${value}'`).join(",");
const textArrayLiteral = (values: readonly string[]) =>
  sql.raw(`ARRAY[${sqlList(values)}]::text[]`);
const SESSION_SCOPES_SQL = textArrayLiteral(SESSION_SCOPE_VALUES);
const AUTHORIZATION_ACTIONS_SQL = textArrayLiteral(AUTHORIZATION_ACTION_VALUES);
const RESOURCE_KINDS_SQL = sql.raw(sqlList(RESOURCE_KIND_VALUES));
const AUDIENCE_KINDS_SQL = sql.raw(sqlList(AUDIENCE_KIND_VALUES));
// `actions` must be a subset of what the row's resource kind admits.
const ACTIONS_FOR_RESOURCE_SQL = sql.raw(
  `CASE "resource_kind" ${RESOURCE_KIND_VALUES.map((kind) => {
    const allowed = AUTHORIZATION_ACTION_VALUES.filter((action) =>
      ACTION_RESOURCE_KINDS[action].includes(kind),
    );
    return `WHEN '${kind}' THEN ARRAY[${sqlList(allowed)}]::text[]`;
  }).join(" ")} ELSE ARRAY[]::text[] END`,
);
// `<@` ignores dimensions, so a nested array would pass containment and come
// back where TypeScript expects string[]. Empty arrays have no dimensions.
const oneDimensional = (column: unknown) =>
  sql`coalesce(array_ndims(${column}), 1) = 1`;

// Identity (I0-2, 03 §3.1). One workspace per installation for now; every
// row added by the interface track carries a workspace_id. Vocabularies are
// CHECK constraints rather than pg enums so that widening one is a plain
// additive migration, and rather than contracts imports so that the schema
// does not depend on a package that is still landing (94S-148).
export const workspaces = pgTable("workspaces", {
  id: uuid().primaryKey(),
  slug: text().notNull().unique(),
  name: text().notNull(),
  settings: jsonb().notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const users = pgTable(
  "users",
  {
    id: uuid().primaryKey(),
    email: text().notNull().unique(),
    /** argon2id. */
    passwordHash: text("password_hash").notNull(),
    displayName: text("display_name").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    // Account suspension. Losing one workspace is memberships.disabled_at, a
    // different thing (Codex A03).
    disabledAt: timestamp("disabled_at", { withTimezone: true }),
  },
  (table) => [
    // The unique above is case-sensitive, so lower-casing has to be a fact of
    // the row rather than a promise of the caller (contracts normalizeEmail).
    check(
      "users_email_lower_check",
      sql`${table.email} = lower(${table.email})`,
    ),
  ],
);

export const memberships = pgTable(
  "memberships",
  {
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    role: text().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    disabledAt: timestamp("disabled_at", { withTimezone: true }),
  },
  (table) => [
    primaryKey({ columns: [table.workspaceId, table.userId] }),
    // Login resolves a user's workspaces; the PK leads with workspace_id.
    index("memberships_user_idx").on(table.userId),
    check("memberships_role_check", sql`${table.role} IN ('owner', 'member')`),
  ],
);

export const invites = pgTable(
  "invites",
  {
    id: uuid().primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    email: text().notNull(),
    role: text().notNull(),
    /** sha256 of the one-time token; the token itself is never stored. */
    tokenHash: bytea("token_hash").notNull().unique(),
    invitedBy: uuid("invited_by")
      .notNull()
      .references(() => users.id),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    // One redeemable invite per address and workspace: re-inviting revokes
    // the old row first, and two owners cannot each hand out a live token.
    // An expired-but-unrevoked row still counts here, on purpose.
    uniqueIndex("invites_live_email_uniq")
      .on(table.workspaceId, table.email)
      .where(sql`${table.acceptedAt} IS NULL AND ${table.revokedAt} IS NULL`),
    check("invites_role_check", sql`${table.role} IN ('owner', 'member')`),
    // Same rule as users.email, or the live-invite unique above would let
    // two spellings of one address stay redeemable at once.
    check(
      "invites_email_lower_check",
      sql`${table.email} = lower(${table.email})`,
    ),
    // An invite is consumed once: accepted or revoked, never both.
    check(
      "invites_single_outcome_check",
      sql`${table.acceptedAt} IS NULL OR ${table.revokedAt} IS NULL`,
    ),
  ],
);

export const webSessions = pgTable(
  "web_sessions",
  {
    id: uuid().primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    /** sha256 of the cookie value. */
    tokenHash: bytea("token_hash").notNull().unique(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
    userAgent: text("user_agent"),
  },
  (table) => [
    // Logout-everywhere and the login lockout both walk a user's live sessions.
    index("web_sessions_user_live_idx")
      .on(table.userId)
      .where(sql`${table.revokedAt} IS NULL`),
  ],
);

// One Grant row per 94S-148 `grantSchema`; the refs are stored as
// (kind, id) column pairs so the evaluator (I0-5a) matches them exactly in
// SQL without unpacking JSON. `service_principal_id` is always a service
// actor, so it carries no kind column.
export const grants = pgTable(
  "grants",
  {
    id: uuid().primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    actorKind: text("actor_kind").notNull(),
    actorId: text("actor_id").notNull(),
    servicePrincipalId: text("service_principal_id"),
    actions: text().array().notNull(),
    resourceKind: text("resource_kind").notNull(),
    resourceId: text("resource_id").notNull(),
    audienceKind: text("audience_kind").notNull(),
    audienceId: text("audience_id").notNull(),
    /** Narrows the 94S-132 key scope; never widens it. */
    scopes: text().array().notNull().default([]),
    revision: integer().notNull().default(0),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    // Evaluation is one query by actor and resource (94S-152); revoked rows
    // are kept as history and never match.
    index("grants_lookup_idx")
      .on(
        table.workspaceId,
        table.actorKind,
        table.actorId,
        table.resourceKind,
        table.resourceId,
      )
      .where(sql`${table.revokedAt} IS NULL`),
    check(
      "grants_actor_kind_check",
      sql`${table.actorKind} IN ('user', 'service')`,
    ),
    check(
      "grants_resource_kind_check",
      sql`${table.resourceKind} IN (${RESOURCE_KINDS_SQL})`,
    ),
    check(
      "grants_audience_kind_check",
      sql`${table.audienceKind} IN (${AUDIENCE_KINDS_SQL})`,
    ),
    check(
      "grants_actions_check",
      sql`cardinality(${table.actions}) > 0 AND ${oneDimensional(table.actions)} AND ${table.actions} <@ ${AUTHORIZATION_ACTIONS_SQL}`,
    ),
    check(
      "grants_actions_resource_check",
      sql`${table.actions} <@ ${ACTIONS_FOR_RESOURCE_SQL}`,
    ),
    check(
      "grants_scopes_check",
      sql`${oneDimensional(table.scopes)} AND ${table.scopes} <@ ${SESSION_SCOPES_SQL}`,
    ),
    check("grants_revision_check", sql`${table.revision} >= 0`),
    // Same bounds as 94S-148 opaqueIdSchema (1..128) and resource/audience
    // refs (1..512), so an empty id cannot be stored and then never matched.
    check(
      "grants_id_length_check",
      sql`length(${table.actorId}) BETWEEN 1 AND 128 AND (${table.servicePrincipalId} IS NULL OR length(${table.servicePrincipalId}) BETWEEN 1 AND 128) AND length(${table.resourceId}) BETWEEN 1 AND 512 AND length(${table.audienceId}) BETWEEN 1 AND 512`,
    ),
    // A grant stored under workspace A must not name workspace B (94S-148
    // grantSchema): the evaluator compares the request's workspace with
    // workspace_id, so such a row would match across the boundary.
    check(
      "grants_workspace_ref_check",
      sql`(${table.resourceKind} <> 'workspace' OR ${table.resourceId} = ${table.workspaceId}::text) AND (${table.audienceKind} <> 'workspace' OR ${table.audienceId} = ${table.workspaceId}::text)`,
    ),
  ],
);

// Legacy owner_id strings are never backfilled into a workspace (Codex B18):
// a row here is an operator's explicit statement that this owner's sessions
// and keys belong to that workspace. An unmapped owner stays visible only on
// the api-key path.
export const ownerWorkspaceMap = pgTable("owner_workspace_map", {
  ownerId: text("owner_id").primaryKey(),
  workspaceId: uuid("workspace_id")
    .notNull()
    .references(() => workspaces.id),
  mappedBy: uuid("mapped_by")
    .notNull()
    .references(() => users.id),
  mappedAt: timestamp("mapped_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

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
    // A CheckpointBlockReason that outlives the turn that produced it
    // (durability.ts CHECKPOINT_REASONS); null once a checkpoint commits.
    checkpointPendingReason: text("checkpoint_pending_reason"),
    // The attempt that reported the reason. A checkpoint clears a blocking
    // reason only when another attempt commits one: the runtime holds a
    // mirror failure for the whole run, so a checkpoint from the same attempt
    // was captured before the failure at best and proves nothing about what
    // came after. Any commit clears an advisory one.
    checkpointPendingAttemptId: text("checkpoint_pending_attempt_id"),
    // The earlier revision the session was last restored from because the
    // pointer's own checkpoint was damaged (94S-204). While set, the
    // session's state is that revision's, not the pointer's; the next
    // committed checkpoint, or another attempt restoring the pointer,
    // clears it. The attempt column names the attempt that was last handed
    // a restore plan on the current pointer, fallback or not: that attempt
    // is held to the base it was given.
    checkpointFallbackRevision: integer("checkpoint_fallback_revision"),
    checkpointRestoreAttemptId: text("checkpoint_restore_attempt_id"),
    // Set by a start_fresh recovery decision (94S-288): the last turn that
    // ran before the operator accepted losing its context, and the pointer
    // the session had then. Turns up to the first are no longer a context
    // gap; checkpoints up to the second are retired and never restored,
    // since a new engine session started on top of neither.
    contextResetTurnSequence: integer("context_reset_turn_sequence"),
    contextResetCheckpointRevision: integer(
      "context_reset_checkpoint_revision",
    ),
    // The worker's last successful transcript mirror write, as it reported
    // it; only ever moves forward.
    lastTranscriptPersistedAt: timestamp("last_transcript_persisted_at", {
      withTimezone: true,
    }),
    // A stopped session's workspace being reclaimed (94S-225): set under the
    // session lock before the volume is removed, cleared by the claim id that
    // set it once the removal settles. Resume refuses while it is set, so a
    // resumed session never has its workspace removed underneath it.
    workspaceReclaimId: text("workspace_reclaim_id"),
    workspaceReclaimWorkspaceId: text("workspace_reclaim_workspace_id"),
    workspaceReclaimClaimedAt: timestamp("workspace_reclaim_claimed_at", {
      withTimezone: true,
    }),
    // The stopped session's workspace is gone; a resume comes back on a new
    // one restored from the checkpoint. Cleared by that resume.
    workspaceReclaimedAt: timestamp("workspace_reclaimed_at", {
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
    // Interface track (I0-2). Null on every row from before it: legacy
    // sessions are not backfilled, see owner_workspace_map.
    workspaceId: uuid("workspace_id").references(() => workspaces.id),
    createdByUserId: uuid("created_by_user_id").references(() => users.id),
    // agent_releases lands with I0-5b (94S-154); the FK is added there. Not
    // a uuid: release ids are derived hashes (94S-148 agentReleaseIdSchema).
    agentReleaseId: text("agent_release_id"),
    // What the engine reported this session's turns cost, summed at each
    // finalize (94S-131). An estimate: turns whose cost was never reported
    // add nothing. Compared against SESSION_COST_LIMIT_USD at dispatch.
    costUsd: numeric("cost_usd", { precision: 14, scale: 6, mode: "number" })
      .notNull()
      .default(0),
    // Whether the last status event the stream carries about input said
    // needs_input (94S-278). A record of what was published, not a state:
    // it flips only in the transaction that writes that status event.
    inputAnnounced: boolean("input_announced").notNull().default(false),
    // An operator revoked this session's execution authority (94S-321).
    // Independent of admission_state on purpose: every lifecycle path that
    // would dispatch again (resume, start_fresh, a claim) refuses while it
    // is set, and only the operator's restore command clears it.
    executionRevokedAt: timestamp("execution_revoked_at", {
      withTimezone: true,
    }),
    executionRevokedReason: text("execution_revoked_reason"),
    // Restores that failed before their worker reported ready (94S-345).
    // The attempt is the one claimed with a restore and not yet ready; the
    // count is consecutive, cleared by a ready restore, and at its limit the
    // session waits in recovery_required. Until then no launch is made
    // before retry_at. The reason is the last failed attempt's.
    restoreAttemptId: text("restore_attempt_id"),
    restoreFailureCount: integer("restore_failure_count").notNull().default(0),
    restoreRetryAt: timestamp("restore_retry_at", { withTimezone: true }),
    restoreFailureReason: text("restore_failure_reason"),
  },
  (table) => [
    check("sessions_cost_usd_nonneg", sql`${table.costUsd} >= 0`),
    check(
      "sessions_restore_failure_count_check",
      sql`${table.restoreFailureCount} >= 0`,
    ),
    check(
      "sessions_execution_revoked_check",
      sql`(${table.executionRevokedAt} IS NULL) = (${table.executionRevokedReason} IS NULL)`,
    ),
    uniqueIndex("sessions_pod_uniq")
      .on(table.podId)
      .where(sql`${table.podId} IS NOT NULL`),
    index("sessions_workspace_idx")
      .on(table.workspaceId)
      .where(sql`${table.workspaceId} IS NOT NULL`),
    // The reconciler's sweep for waits that ended with no write.
    index("sessions_input_announced_idx")
      .on(table.id)
      .where(sql`${table.inputAnnounced}`),
    // Lets a later table reference (session_id, owner_id, workspace_id) as
    // one FK. That only pins the row to its session's workspace when the
    // referencing side declares workspace_id NOT NULL (or MATCH FULL): with
    // MATCH SIMPLE a NULL there skips the check. Legacy sessions, whose
    // workspace_id is NULL, are unreachable through such an FK by design.
    unique("sessions_id_owner_workspace_uniq").on(
      table.id,
      table.ownerId,
      table.workspaceId,
    ),
  ],
);

// Retained content the installation holds (94S-131). A `turns` insert trigger
// (migration 0107) charges every input in the same transaction that writes
// it, and admitInput checks STORAGE_LIMIT_BYTES under this row's lock, so no
// concurrent writer can race past the limit. One row per scope: today only
// "installation"; 94S-187 adds per-workspace rows for memory revisions.
export const storageUsage = pgTable(
  "storage_usage",
  {
    scope: text().primaryKey(),
    bytes: bigint({ mode: "number" }).notNull().default(0),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [check("storage_usage_bytes_nonneg", sql`${table.bytes} >= 0`)],
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
    /** The human whose input started the turn; null on the api-key path. */
    actorId: uuid("actor_id").references(() => users.id),
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
    /** 94S-148 `receiptActorSchema`: principal plus the human behind it. */
    actor: jsonb(),
  },
  (table) => [
    index("receipts_owner_created_at_idx").on(table.ownerId, table.createdAt),
    // The terminate deadline sweep runs every scheduler and reconciler pass
    // and must not read the whole receipt history to find the few open ones.
    // An execution revocation (94S-321) is swept the same way.
    index("receipts_open_terminate_idx")
      .on(table.createdAt)
      .where(
        sql`${table.operation} IN ('terminate', 'revoke_execution') AND ${table.status} = 'accepted'`,
      ),
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
    // Closed to clients: answered, given up on by the worker, or invalidated
    // with its attempt. The worker's own acknowledgement is `settled_at`.
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    answer: jsonb(),
    answeredAt: timestamp("answered_at", { withTimezone: true }),
    // Per session, allocated under the session row lock, so commit order is
    // sequence order and the worker's answers_after cursor never skips one.
    answerSequence: integer("answer_sequence"),
    answerReceiptId: uuid("answer_receipt_id").references(() => receipts.id),
    settledAt: timestamp("settled_at", { withTimezone: true }),
    // answered | expired | cancelled from the worker; lost when the
    // execution went away before it said.
    settledOutcome: text("settled_outcome"),
    // Set when the worker handed the `question` event to the gateway
    // (94S-278); a replay must carry the same pair. Null for a worker that
    // publishes the event itself.
    toolUseId: text("tool_use_id"),
    tool: text(),
  },
  (table) => [
    index("pending_requests_unresolved_session_idx")
      .on(table.sessionId)
      .where(sql`${table.resolvedAt} IS NULL`),
    uniqueIndex("pending_requests_session_answer_sequence_idx").on(
      table.sessionId,
      table.answerSequence,
    ),
    // What pendingControl hands out: answered, not yet acknowledged.
    index("pending_requests_undelivered_attempt_idx")
      .on(table.attemptId, table.answerSequence)
      .where(
        sql`${table.answeredAt} IS NOT NULL AND ${table.settledAt} IS NULL`,
      ),
  ],
);

// api.md § 승인·중단·강제 종료: a control request the worker has to act on,
// kept apart from the input FIFO. An interrupt names its turn and the attempt
// that turn is bound to — a running turn never moves to another attempt — and
// stays unsettled until that turn reaches a terminal, which settles the
// receipt in the same transaction.
export const controlIntents = pgTable(
  "control_intents",
  {
    id: uuid().primaryKey(),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => sessions.id),
    kind: text().notNull(),
    targetTurnId: bigint("target_turn_id", { mode: "number" }).references(
      () => turns.id,
    ),
    attemptId: text("attempt_id"),
    receiptId: uuid("receipt_id")
      .notNull()
      .references(() => receipts.id),
    issuedAt: timestamp("issued_at", { withTimezone: true }).notNull(),
    settledAt: timestamp("settled_at", { withTimezone: true }),
  },
  (table) => [
    // Only interrupt rows are ever written. A pause travels as the session's
    // `pausing` admission state and a terminate as executions.desired_state;
    // the two stay allowed only because narrowing the CHECK would cost a
    // migration for no row that exists.
    check(
      "control_intents_kind_check",
      sql`${table.kind} IN ('interrupt', 'pause', 'terminate')`,
    ),
    check(
      "control_intents_interrupt_target_check",
      sql`${table.kind} <> 'interrupt' OR (${table.targetTurnId} IS NOT NULL AND ${table.attemptId} IS NOT NULL)`,
    ),
    uniqueIndex("control_intents_receipt_uniq").on(table.receiptId),
    // What pendingControl hands the attempt, and what a turn's terminal settles.
    index("control_intents_open_attempt_idx")
      .on(table.attemptId, table.issuedAt)
      .where(sql`${table.settledAt} IS NULL`),
    index("control_intents_open_turn_idx")
      .on(table.targetTurnId)
      .where(sql`${table.settledAt} IS NULL`),
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
    // The object store version finalize verified the manifest at; restore
    // reads exactly that one. Null when the deployment stores no versions.
    manifestVersion: text("manifest_version"),
    // Set only by a locked finalize (CheckpointPointer.versionsHeld).
    versionsHeld: boolean("versions_held").notNull().default(false),
    // CheckpointPointer.parentRevision: what a restore falls back along.
    parentRevision: integer("parent_revision"),
    turnId: bigint("turn_id", { mode: "number" }).references(() => turns.id),
    committedAt: timestamp("committed_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    // Set by checkpoint garbage collection (94S-281) before it deletes the
    // revision's objects: no restore reaches this revision any more, and a
    // backup leaves it out rather than fail on what is gone.
    collectedAt: timestamp("collected_at", { withTimezone: true }),
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
    // The lease-expiry sweep only ever looks at attempts still open, in
    // expiry order; ended ones accumulate and stay out of the index.
    index("attempts_open_lease_idx")
      .on(table.leaseExpiresAt, table.id)
      .where(sql`${table.state} NOT IN ('exited', 'lost')`),
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
    // What the launch runs for as long as it lives: the image pinned when it
    // was reserved and the limits it was reserved with. Null on a launch
    // reserved before they were stored, which runs on current settings.
    image: text(),
    resources: jsonb(),
    // Launch attempts that failed before any worker bound: a create or start
    // the provider refused, or a resource that exited unclaimed. Never reset,
    // so a launch that keeps failing reaches the scheduler's limit and gives
    // its slot back instead of holding it forever (94S-207).
    launchFailureCount: integer("launch_failure_count").notNull().default(0),
    // Attempts whose outcome was recorded, success or failure. A failure is
    // fenced on it, so one reported by a pass that lost its lock mid-ensure
    // cannot revoke what a later pass has since launched.
    launchAttempts: integer("launch_attempts").notNull().default(0),
    // No attempt before this, on the database clock; null when none failed
    // or the launch was given up on.
    launchRetryAt: timestamp("launch_retry_at", { withTimezone: true }),
    lastLaunchError: text("last_launch_error"),
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
      sql`${table.replacementReason} IS NULL OR ${table.replacementReason} IN ('credential_mismatch', 'nonce_expired', 'spec_mismatch', 'stale_isolation')`,
    ),
    check(
      "worker_launches_replacement_count_check",
      sql`${table.replacementCount} >= 0`,
    ),
    check(
      "worker_launches_launch_spec_check",
      sql`(${table.image} IS NULL) = (${table.resources} IS NULL)`,
    ),
    check(
      "worker_launches_launch_failure_count_check",
      sql`${table.launchFailureCount} >= 0`,
    ),
    check(
      "worker_launches_launch_attempts_check",
      sql`${table.launchAttempts} >= 0`,
    ),
  ],
);

// Tokens handed out by bootstrapClaim; only their hashes are stored. Each
// attempt holds one live token per purpose: `gateway` authenticates the
// worker's own calls, `provider` and `repository` the egress proxy's
// credential routes (94S-252). All three are issued, extended and revoked
// together, and a token only ever works for its own purpose.
export const workerCredentials = pgTable(
  "worker_credentials",
  {
    tokenHash: bytea("token_hash").primaryKey(),
    attemptId: text("attempt_id")
      .notNull()
      .references(() => attempts.id),
    purpose: text("purpose").notNull().default("gateway"),
    // What an egress token was issued against: the profile fingerprint or
    // the repository binding at claim time. A catalog entry that moved since
    // (a restart with an edited config) no longer matches, and the proxy is
    // refused rather than sent somewhere the attempt never agreed to.
    binding: text("binding"),
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
    uniqueIndex("worker_credentials_live_purpose_idx")
      .on(table.attemptId, table.purpose)
      .where(sql`${table.revokedAt} IS NULL`),
    check(
      "worker_credentials_purpose_check",
      sql`${table.purpose} IN ('gateway', 'provider', 'repository')`,
    ),
    check(
      "worker_credentials_binding_check",
      sql`(${table.purpose} = 'gateway') = (${table.binding} IS NULL)`,
    ),
  ],
);

export const workers = pgTable("workers", {
  podId: text("pod_id").primaryKey(),
  lastSeen: timestamp("last_seen", { withTimezone: true })
    .notNull()
    .defaultNow(),
  // Stamped by whoever heartbeats, from its own TTL; the orphan reconciler
  // compares against this and holds no TTL of its own, so a TTL set on one
  // process cannot be judged by another's (94S-132).
  leaseExpiresAt: timestamp("lease_expires_at", {
    withTimezone: true,
  }).notNull(),
});

export const apiKeys = pgTable(
  "api_keys",
  {
    id: uuid().primaryKey(),
    keyHash: bytea("key_hash").notNull().unique(),
    ownerId: text("owner_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    /** Null on legacy keys until an owner_workspace_map row exists. */
    workspaceId: uuid("workspace_id").references(() => workspaces.id),
    /** Null means the pre-94S-132 "everything" key. */
    scopes: text().array(),
  },
  (table) => [
    index("api_keys_workspace_idx")
      .on(table.workspaceId)
      .where(sql`${table.workspaceId} IS NOT NULL`),
    // Same vocabulary as grants.scopes, which may only narrow a key's.
    check(
      "api_keys_scopes_check",
      sql`${table.scopes} IS NULL OR (${oneDimensional(table.scopes)} AND ${table.scopes} <@ ${SESSION_SCOPES_SQL})`,
    ),
  ],
);
