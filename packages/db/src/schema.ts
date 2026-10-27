import {
  ADMISSION_STATE_VALUES,
  AGENT_IDENTITY_PROVIDER_VALUES,
  AGENT_IDENTITY_STATUS_VALUES,
  AGENT_STATUS_VALUES,
  BINDING_MODE_VALUES,
  MEMORY_WRITE_POLICY_VALUES,
  OPEN_PUSH_REQUEST_STATES,
  PERMISSION_MODE_VALUES,
  PUSH_REQUEST_STATE_VALUES,
  RECEIPT_STATUS_VALUES,
  SESSION_STATUS_VALUES,
  SLACK_APP_KIND_VALUES,
  SLACK_APP_STATE_VALUES,
  SLACK_INBOUND_DROP_REASON_VALUES,
  SLACK_INBOUND_EVENT_STATUS_VALUES,
  SLACK_SURFACE_ACTION_VALUES,
  type SlackAppKind,
  type SlackAppState,
  type SlackInboundDropReason,
  type SlackInboundEventStatus,
  SURFACE_BINDING_STATUS_VALUES,
  SURFACE_CHANNEL_KIND_VALUES,
  SURFACE_DISCLOSURE_VALUES,
  SURFACE_KIND_VALUES,
  SURFACE_MEMBERSHIP_STATE_VALUES,
  type SurfaceKind,
  type SurfaceMembershipState,
} from "@werft-ai/contracts";
import type {
  SecretOwnerRef,
  SlackOutboxBody,
  SlackOutboxKind,
  SlackOutboxStatus,
} from "@werft-ai/platform";
import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  bigint,
  bigserial,
  boolean,
  check,
  customType,
  date,
  foreignKey,
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

// Vocabularies the CHECK constraints below pin. They mirror
// SESSION_SCOPE_VALUES and AUTHORIZATION_ACTION_VALUES; schema.test.ts
// asserts the two lists are equal, the way
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
// Which resource kinds each action may be granted on: `session.read` on a
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
// does not depend on a package that is still landing.
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
    /** argon2id; null for an account that only signs in externally. */
    passwordHash: text("password_hash"),
    displayName: text("display_name").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    // Account suspension. Losing one workspace is memberships.disabled_at, a
    // different thing.
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
    check(
      "memberships_role_check",
      sql`${table.role} IN ('owner', 'admin', 'member')`,
    ),
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
    check(
      "invites_role_check",
      sql`${table.role} IN ('owner', 'admin', 'member')`,
    ),
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

export const loginMethods = pgTable(
  "login_methods",
  {
    id: uuid().primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    kind: text().$type<"password" | "google">().notNull(),
    issuer: text(),
    subject: text(),
    /** The address the provider vouched for when the account was linked. */
    emailAtLink: text("email_at_link"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("login_methods_external_uniq").on(
      table.kind,
      table.issuer,
      table.subject,
    ),
    uniqueIndex("login_methods_password_user_uniq")
      .on(table.userId)
      .where(sql`${table.kind} = 'password'`),
    check(
      "login_methods_kind_check",
      sql`${table.kind} IN ('password', 'google')`,
    ),
    check(
      "login_methods_external_check",
      sql`CASE WHEN ${table.kind} = 'password' THEN ${table.issuer} IS NULL AND ${table.subject} IS NULL ELSE ${table.issuer} IS NOT NULL AND ${table.subject} IS NOT NULL END`,
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

export const passwordResets = pgTable(
  "password_resets",
  {
    id: uuid().primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    /** sha256 of the one-time token; the token itself is never stored. */
    tokenHash: bytea("token_hash").notNull().unique(),
    issuedBy: uuid("issued_by")
      .notNull()
      .references(() => users.id),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    // Issuing a new link revokes the user's open one, so at most one link
    // per user can set a password.
    uniqueIndex("password_resets_live_user_uniq")
      .on(table.userId)
      .where(sql`${table.usedAt} IS NULL AND ${table.revokedAt} IS NULL`),
    check(
      "password_resets_single_outcome_check",
      sql`${table.usedAt} IS NULL OR ${table.revokedAt} IS NULL`,
    ),
  ],
);

// A BOOTSTRAP_TOKEN works once per installation, not once per process: a
// value left in the environment after an install must not reopen recovery
// the next time no live owner remains.
export const bootstrapTokenUses = pgTable("bootstrap_token_uses", {
  tokenHash: bytea("token_hash").primaryKey(),
  usedAt: timestamp("used_at", { withTimezone: true }).notNull().defaultNow(),
});

// The shared Slack app installed in one Slack team, owned by one workspace.
// A row is registered `pending` from config, turns `verified` once
// `auth.test` confirms the app, team and bot user, and is `revoked` rather
// than deleted so that rows pointing at it keep their target. No secret is
// stored here; credentials stay in the config's references.
export const slackInstallations = pgTable(
  "slack_installations",
  {
    id: uuid().primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    appId: text("app_id").notNull(),
    teamId: text("team_id").notNull(),
    /** Known only once `auth.test` has answered. */
    botUserId: text("bot_user_id"),
    status: text()
      .$type<"pending" | "verified" | "revoked">()
      .notNull()
      .default("pending"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (table) => [
    unique("slack_installations_app_team_uniq").on(table.appId, table.teamId),
    // What agent_identities references, so an identity cannot pin another
    // workspace's install.
    unique("slack_installations_workspace_id_key").on(
      table.workspaceId,
      table.id,
    ),
    check(
      "slack_installations_status_check",
      sql`${table.status} IN ('pending', 'verified', 'revoked')`,
    ),
    check(
      "slack_installations_verified_check",
      sql`${table.status} <> 'verified' OR (${table.botUserId} IS NOT NULL AND ${table.verifiedAt} IS NOT NULL)`,
    ),
    check(
      "slack_installations_revoked_check",
      sql`(${table.status} = 'revoked') = (${table.revokedAt} IS NOT NULL)`,
    ),
  ],
);

// Runtime secrets (Slack config token, app secrets), AES-256-GCM under the
// API's master key.
export const secretValues = pgTable(
  "secret_values",
  {
    id: uuid().primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    ownerRef: text("owner_ref").$type<SecretOwnerRef>().notNull(),
    purpose: text().notNull(),
    secretVersion: integer("secret_version").notNull(),
    keyVersion: integer("key_version").notNull(),
    nonce: bytea().notNull(),
    ciphertext: bytea().notNull(),
    last4: text().notNull(),
    /** No foreign key: the row outlives the account; null for a server write. */
    updatedBy: uuid("updated_by"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    unique("secret_values_slot_uniq").on(
      table.workspaceId,
      table.ownerRef,
      table.purpose,
    ),
    check(
      "secret_values_versions_check",
      sql`${table.secretVersion} > 0 AND ${table.keyVersion} > 0`,
    ),
    check("secret_values_last4_check", sql`length(${table.last4}) = 4`),
  ],
);

// What the console and the rotator know about a workspace's App
// Configuration Token without opening it; the token pair itself is the
// workspace's `slack_config_token` secret.
export const slackConfigTokens = pgTable(
  "slack_config_tokens",
  {
    workspaceId: uuid("workspace_id")
      .primaryKey()
      .references(() => workspaces.id),
    state: text().$type<"active" | "needs_reentry">().notNull(),
    accessExpiresAt: timestamp("access_expires_at", { withTimezone: true }),
    issuerUserId: text("issuer_user_id"),
    issuerTeamId: text("issuer_team_id"),
    previousIssuerUserId: text("previous_issuer_user_id"),
    issuerChangedAt: timestamp("issuer_changed_at", { withTimezone: true }),
    leaseId: uuid("lease_id"),
    leaseUntil: timestamp("lease_until", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check(
      "slack_config_tokens_state_check",
      sql`${table.state} IN ('active', 'needs_reentry')`,
    ),
    check(
      "slack_config_tokens_lease_check",
      sql`(${table.leaseId} IS NULL) = (${table.leaseUntil} IS NULL)`,
    ),
  ],
);

export const slackApps = pgTable(
  "slack_apps",
  {
    id: uuid().primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    kind: text().$type<SlackAppKind>().notNull(),
    agentId: uuid("agent_id"),
    state: text().$type<SlackAppState>().notNull(),
    appId: text("app_id"),
    clientId: text("client_id"),
    redirectUrl: text("redirect_url").notNull(),
    eventsState: text("events_state")
      .$type<"pending" | "verified" | "failed">()
      .notNull()
      .default("pending"),
    eventsCheckedAt: timestamp("events_checked_at", { withTimezone: true }),
    eventsError: text("events_error"),
    createdByTokenUser: text("created_by_token_user"),
    /** No foreign key: the row outlives the account; null for the CLI. */
    createdBy: uuid("created_by"),
    signingSecretRef: text("signing_secret_ref"),
    clientSecretRef: text("client_secret_ref"),
    botTokenRef: text("bot_token_ref"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    unique("slack_apps_app_id_key").on(table.appId),
    check(
      "slack_apps_events_state_check",
      sql`${table.eventsState} IN ('pending', 'verified', 'failed')`,
    ),
    uniqueIndex("slack_apps_live_agent_idx")
      .on(table.workspaceId, table.agentId)
      .where(
        sql`${table.kind} = 'agent' AND ${table.state} IN ('creating', 'created', 'deleting')`,
      ),
    uniqueIndex("slack_apps_live_link_idx")
      .on(table.workspaceId)
      .where(
        sql`${table.kind} = 'link' AND ${table.state} IN ('creating', 'created', 'deleting')`,
      ),
    foreignKey({
      name: "slack_apps_agent_fk",
      columns: [table.workspaceId, table.agentId],
      foreignColumns: [agents.workspaceId, agents.id],
    }),
    check(
      "slack_apps_kind_check",
      sql`${table.kind} IN (${sql.raw(sqlList(SLACK_APP_KIND_VALUES))})`,
    ),
    check(
      "slack_apps_state_check",
      sql`${table.state} IN (${sql.raw(sqlList(SLACK_APP_STATE_VALUES))})`,
    ),
    check(
      "slack_apps_agent_check",
      sql`(${table.kind} = 'agent') = (${table.agentId} IS NOT NULL)`,
    ),
    check(
      "slack_apps_created_check",
      sql`${table.state} NOT IN ('created', 'deleting', 'deleted') OR (${table.appId} IS NOT NULL AND ${table.clientId} IS NOT NULL)`,
    ),
  ],
);

/**
 * Install links in flight: the sha256 of each OAuth `state`, never the
 * value, with who may complete it for which agent's app. A row is deleted
 * when the link is completed, whatever the outcome, or once it expired.
 */
export const slackInstallStates = pgTable(
  "slack_install_states",
  {
    stateHash: bytea("state_hash").primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    agentId: uuid("agent_id").notNull(),
    slackAppId: uuid("slack_app_id")
      .notNull()
      .references(() => slackApps.id),
    actorUserId: uuid("actor_user_id").notNull(),
    teamId: text("team_id").notNull(),
    redirectUrl: text("redirect_url").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [index("slack_install_states_expires_idx").on(table.expiresAt)],
);

// One row per (team_id, event_id): Slack keeps `event_id` across its
// retries. 94S-790 adds the claim columns.
export const slackInboundEvents = pgTable(
  "slack_inbound_events",
  {
    id: uuid().primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    agentId: uuid("agent_id").notNull(),
    slackAppId: uuid("slack_app_id")
      .notNull()
      .references(() => slackApps.id),
    teamId: text("team_id").notNull(),
    appId: text("app_id").notNull(),
    eventId: text("event_id").notNull(),
    eventType: text("event_type").notNull(),
    eventSubtype: text("event_subtype"),
    eventTime: timestamp("event_time", { withTimezone: true }),
    status: text().$type<SlackInboundEventStatus>().notNull(),
    dropReason: text("drop_reason").$type<SlackInboundDropReason>(),
    payload: jsonb().$type<Record<string, unknown>>(),
    receivedAt: timestamp("received_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    /**
     * `<slack_app_id>:<channel>:<thread_ts ?? ts>`: the thread a message
     * belongs to, in which the `slack` role takes one event at a time.
     * Null on dropped rows and on events outside a channel message.
     */
    conversationKey: text("conversation_key"),
    claimToken: uuid("claim_token"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    /** Claims so far, lease expiries included. */
    attempts: integer().notNull().default(0),
    /** A failed attempt's backoff; unclaimable before it. */
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }),
  },
  (table) => [
    // Per app: the event_id two apps of one team receive for one message is
    // not documented to differ, and each app's copy is its own work.
    unique("slack_inbound_events_app_event_key").on(table.appId, table.eventId),
    foreignKey({
      name: "slack_inbound_events_agent_fk",
      columns: [table.workspaceId, table.agentId],
      foreignColumns: [agents.workspaceId, agents.id],
    }),
    check(
      "slack_inbound_events_status_check",
      sql`${table.status} IN (${sql.raw(sqlList(SLACK_INBOUND_EVENT_STATUS_VALUES))})`,
    ),
    check(
      "slack_inbound_events_drop_reason_check",
      sql`${table.dropReason} IS NULL OR ${table.dropReason} IN (${sql.raw(sqlList(SLACK_INBOUND_DROP_REASON_VALUES))})`,
    ),
    check(
      "slack_inbound_events_dropped_check",
      sql`(${table.status} = 'dropped') = (${table.dropReason} IS NOT NULL) AND (${table.status} = 'dropped') = (${table.payload} IS NULL)`,
    ),
    check(
      "slack_inbound_events_conversation_check",
      sql`${table.status} <> 'dropped' OR ${table.conversationKey} IS NULL`,
    ),
    check(
      "slack_inbound_events_claim_check",
      sql`(${table.claimToken} IS NULL) = (${table.leaseExpiresAt} IS NULL) AND (${table.status} = 'received' OR ${table.claimToken} IS NULL)`,
    ),
    index("slack_inbound_events_due_idx")
      .on(table.nextAttemptAt)
      .where(sql`${table.status} = 'received'`),
    index("slack_inbound_events_conversation_idx")
      .on(table.conversationKey, table.eventTime, table.receivedAt)
      .where(sql`${table.status} = 'received'`),
  ],
);

// A person's account on another service (design A.2): today a Slack user,
// linked through Sign in with Slack. Rows are revoked, never deleted, so the
// receipts that name one keep their target; every status change bumps
// `revision`, which a decision made on an older reading compares against.
export const linkedAccounts = pgTable(
  "linked_accounts",
  {
    id: uuid().primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    provider: text().$type<"slack">().notNull(),
    /** The Slack team id. */
    externalTenant: text("external_tenant").notNull(),
    externalUserId: text("external_user_id").notNull(),
    /** Names from the last verification, for display; null on older links. */
    externalTenantName: text("external_tenant_name"),
    externalUserName: text("external_user_name"),
    status: text()
      .$type<"active" | "stale" | "revoked">()
      .notNull()
      .default("active"),
    revokedReason: text("revoked_reason").$type<"unlinked" | "offboarded">(),
    verifiedVia: text("verified_via").$type<"slack_oidc">().notNull(),
    verifiedAt: timestamp("verified_at", { withTimezone: true }).notNull(),
    revision: integer().notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (table) => [
    // One person per external account, and one account per person in each
    // Slack team, among the rows that still resolve.
    uniqueIndex("linked_accounts_external_live_uniq")
      .on(table.provider, table.externalTenant, table.externalUserId)
      .where(sql`${table.status} <> 'revoked'`),
    uniqueIndex("linked_accounts_user_live_uniq")
      .on(table.userId, table.provider, table.externalTenant)
      .where(sql`${table.status} <> 'revoked'`),
    index("linked_accounts_workspace_user_idx").on(
      table.workspaceId,
      table.userId,
    ),
    check(
      "linked_accounts_provider_check",
      sql`${table.provider} IN ('slack')`,
    ),
    check(
      "linked_accounts_status_check",
      sql`${table.status} IN ('active', 'stale', 'revoked')`,
    ),
    check(
      "linked_accounts_revoked_check",
      sql`(${table.status} = 'revoked') = (${table.revokedAt} IS NOT NULL) AND (${table.status} = 'revoked') = (${table.revokedReason} IS NOT NULL)`,
    ),
    check(
      "linked_accounts_revoked_reason_check",
      sql`${table.revokedReason} IS NULL OR ${table.revokedReason} IN ('unlinked', 'offboarded')`,
    ),
  ],
);

// One Grant row per `grantSchema`; the refs are stored as
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
    /** Narrows the key scope; never widens it. */
    scopes: text().array().notNull().default([]),
    revision: integer().notNull().default(0),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    // Evaluation is one query by actor and resource; revoked rows
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
    // Same bounds as opaqueIdSchema (1..128) and resource/audience
    // refs (1..512), so an empty id cannot be stored and then never matched.
    check(
      "grants_id_length_check",
      sql`length(${table.actorId}) BETWEEN 1 AND 128 AND (${table.servicePrincipalId} IS NULL OR length(${table.servicePrincipalId}) BETWEEN 1 AND 128) AND length(${table.resourceId}) BETWEEN 1 AND 512 AND length(${table.audienceId}) BETWEEN 1 AND 512`,
    ),
    // A grant stored under workspace A must not name workspace B (
    // grantSchema): the evaluator compares the request's workspace with
    // workspace_id, so such a row would match across the boundary.
    check(
      "grants_workspace_ref_check",
      sql`(${table.resourceKind} <> 'workspace' OR ${table.resourceId} = ${table.workspaceId}::text) AND (${table.audienceKind} <> 'workspace' OR ${table.audienceId} = ${table.workspaceId}::text)`,
    ),
  ],
);

// Legacy owner_id strings are never backfilled into a workspace:
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
    // Given at create or rename, else derived from the first message.
    // Null on rows from before it (not backfilled) and when the first
    // message had no text to derive one from.
    title: text(),
    // `derived` (cut from the first message) is the only title a generated
    // one replaces; `user` is one given at create or by rename. The default
    // is `user`: rows from before it, and an API from before it still
    // writing during a rollout, cannot tell the two kinds apart.
    titleSource: text("title_source", {
      enum: ["derived", "user", "generated"],
    })
      .notNull()
      .default("user"),
    // 'none' marks a session accepted without a repository. A null
    // repository_id alone cannot say that: it already means a row from
    // before the catalog, which no pair matches.
    repositoryMode: text("repository_mode", { enum: ["repository", "none"] })
      .notNull()
      .default("repository"),
    // Null exactly when repository_mode is 'none'.
    repoUrl: text("repo_url"),
    branch: text(),
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
    // The profile's fingerprint (catalog.ts profileFingerprint) when the
    // session was accepted: settings and credential reference, never the
    // value. A claim binds only on a host whose profile under this id still
    // hashes to it. Null on rows from before it, pinned by their
    // next claim.
    profileFingerprint: text("profile_fingerprint"),
    // The model the session runs, one the profile offers. What a version 2
    // fingerprint pins it to alongside; a version 1 fingerprint names the
    // model itself, and the API backfills this from it at start. Null where
    // neither says.
    model: text(),
    // The profile declared `billing: none` when the session was accepted.
    // Fixed on the row, not read from each API's catalog: during a rollout
    // a replica that does not know the profile must not price its calls.
    unmetered: boolean().notNull().default(false),
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
    // pointer's own checkpoint was damaged. While set, the
    // session's state is that revision's, not the pointer's; the next
    // committed checkpoint, or another attempt restoring the pointer,
    // clears it. The attempt column names the attempt that was last handed
    // a restore plan on the current pointer, fallback or not: that attempt
    // is held to the base it was given.
    checkpointFallbackRevision: integer("checkpoint_fallback_revision"),
    checkpointRestoreAttemptId: text("checkpoint_restore_attempt_id"),
    // Set by a start_fresh recovery decision: the last turn that
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
    // A stopped session's workspace being reclaimed: set under the
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
    createdByApiKeyId: uuid("created_by_api_key_id").references(
      () => apiKeys.id,
    ),
    // The surface the creating request came from. Rows from before it got
    // it from their creator columns where those prove it (0158), else null.
    channel: text().$type<SurfaceKind>(),
    takeoverRequiredAt: timestamp("takeover_required_at", {
      withTimezone: true,
    }),
    agentReleaseId: text("agent_release_id").references(
      (): AnyPgColumn => agentReleases.id,
    ),
    // What this session's Messages calls cost, as the egress proxy metered
    // them: each is priced and added once (provider_usage), the
    // engine's calls and a tool's alike. An estimate. Sessions from before
    // it carry the engine's own turn totals up to that point.
    // Compared against SESSION_COST_LIMIT_USD at dispatch.
    costUsd: numeric("cost_usd", { precision: 14, scale: 6, mode: "number" })
      .notNull()
      .default(0),
    // Every token of those same calls (input, cache writes and reads,
    // output), whatever they cost. A provider_usage insert trigger
    // (migration 0127) adds them, so every API build counts them. Compared
    // against SESSION_TOKEN_LIMIT wherever cost_usd is compared against its
    // limit.
    providerTokens: bigint("provider_tokens", { mode: "number" })
      .notNull()
      .default(0),
    // Whether the last status event the stream carries about input said
    // needs_input. A record of what was published, not a state
    // it flips only in the transaction that writes that status event.
    inputAnnounced: boolean("input_announced").notNull().default(false),
    // An operator revoked this session's execution authority.
    // Independent of admission_state on purpose: every lifecycle path that
    // would dispatch again (resume, start_fresh, a claim) refuses while it
    // is set, and only the operator's restore command clears it.
    executionRevokedAt: timestamp("execution_revoked_at", {
      withTimezone: true,
    }),
    executionRevokedReason: text("execution_revoked_reason"),
    // Startups that failed before their worker was ready for input: a
    // restore not reported ready, or any claim that never asked
    // for input. The attempt is the one claimed and not yet ready
    // the count is consecutive, cleared by a ready worker, and at its limit
    // the session waits in recovery_required. Until then no launch is made
    // before retry_at. The reason is the last failed attempt's. Named for
    // the restores they first counted.
    restoreAttemptId: text("restore_attempt_id"),
    restoreFailureCount: integer("restore_failure_count").notNull().default(0),
    restoreRetryAt: timestamp("restore_retry_at", { withTimezone: true }),
    restoreFailureReason: text("restore_failure_reason"),
    // The worker pool that may run this session. Chosen when the
    // session is created and never changed after: every signal and launch
    // copies it, and a claim only binds a session whose partition is the
    // launch's, so a claim never moves a session to another pool.
    partition: text().notNull().default("default"),
    // Why the session is pausing or paused when the system, not a person,
    // asked: 'awaiting_input' is a park on unanswered requests. Null for a
    // person's pause. A trigger (migration await_park) clears it whenever
    // admission_state leaves pausing and paused, on every write path.
    pauseReason: text("pause_reason"),
    // The session's own park and expiry waits, as given at create. Resolved
    // against the profile and the installation cap whenever a request is
    // registered; null means none given.
    permissionWaitOverride: jsonb("permission_wait_override"),
  },
  (table) => [
    check("sessions_cost_usd_nonneg", sql`${table.costUsd} >= 0`),
    check(
      "sessions_pause_reason_check",
      sql`${table.pauseReason} IS NULL OR (${table.pauseReason} IN ('awaiting_input') AND ${table.admissionState} IN ('pausing', 'paused'))`,
    ),
    check(
      "sessions_channel_check",
      sql`${table.channel} IN (${sql.raw(sqlList(SURFACE_KIND_VALUES))})`,
    ),
    check(
      "sessions_title_source_check",
      sql`${table.titleSource} IN ('derived', 'user', 'generated')`,
    ),
    check(
      "sessions_restore_failure_count_check",
      sql`${table.restoreFailureCount} >= 0`,
    ),
    check(
      "sessions_execution_revoked_check",
      sql`(${table.executionRevokedAt} IS NULL) = (${table.executionRevokedReason} IS NULL)`,
    ),
    check(
      "sessions_repository_mode_check",
      sql`(${table.repositoryMode} = 'repository' AND ${table.repoUrl} IS NOT NULL AND ${table.branch} IS NOT NULL) OR (${table.repositoryMode} = 'none' AND ${table.repositoryId} IS NULL AND ${table.repoUrl} IS NULL AND ${table.branch} IS NULL)`,
    ),
    uniqueIndex("sessions_pod_uniq")
      .on(table.podId)
      .where(sql`${table.podId} IS NOT NULL`),
    index("sessions_workspace_idx")
      .on(table.workspaceId)
      .where(sql`${table.workspaceId} IS NOT NULL`),
    index("sessions_created_by_user_idx")
      .on(table.createdByUserId)
      .where(sql`${table.createdByUserId} IS NOT NULL`),
    index("sessions_takeover_idx")
      .on(table.workspaceId, table.takeoverRequiredAt)
      .where(sql`${table.takeoverRequiredAt} IS NOT NULL`),
    // Usage summaries and series pick an installation's sessions by period.
    index("sessions_created_at_idx").on(table.createdAt),
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

// The one request for a generated title a session gets, made after its first
// turn completed and charged to the attempt that ran it, which the proxy's
// usage report names. Its token is what the egress proxy presents; a row is
// kept once settled, so a session is never asked about twice.
export const sessionTitleRequests = pgTable(
  "session_title_requests",
  {
    sessionId: uuid("session_id")
      .primaryKey()
      .references(() => sessions.id),
    attemptId: text("attempt_id")
      .notNull()
      .references(() => attempts.id),
    tokenHash: bytea("token_hash").notNull(),
    // The session's auth_revision at issue: a revocation since refuses it.
    authRevision: integer("auth_revision").notNull(),
    // The title at issue. One that changed since was renamed, if by an API
    // from before title_source, so it is not replaced.
    issuedTitle: text("issued_title"),
    // The first authorization uses the token up: one request, one exchange.
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    settledAt: timestamp("settled_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("session_title_requests_token_uniq").on(table.tokenHash),
  ],
);

// Retained content the installation holds. A `turns` insert trigger
// (migration 0107) charges every input in the same transaction that writes
// it, and admitInput checks STORAGE_LIMIT_BYTES under this row's lock, so no
// concurrent writer can race past the limit. One row per scope: today only
// "installation".
// TODO(94S-187): Add per-workspace rows for memory revisions.
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

// Rows from 94S-630 on carry the push request they were opened from; the
// alpha columns stay as they were.
export const pullRequests = pgTable(
  "pull_requests",
  {
    sessionId: uuid("session_id").references(() => sessions.id),
    url: text().notNull(),
    pushRequestId: uuid("push_request_id").references(() => pushRequests.id),
    ownerId: text("owner_id"),
    repositoryId: text("repository_id"),
    number: integer(),
    head: text(),
    base: text(),
    receiptId: uuid("receipt_id").references(() => receipts.id),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.sessionId, table.url] }),
    uniqueIndex("pull_requests_push_request_idx").on(table.pushRequestId),
  ],
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

/**
 * One row per tool call, projected from the tool_use and tool_result events
 * by the reconciler (`projectToolCalls`), paired as the run tree pairs them
 * (94S-923). A read of the usage API never parses events.
 *
 * No foreign keys: a key on session_id would take KEY SHARE on the session
 * row, which a worker append holds FOR UPDATE, so each projection batch and
 * the appends of its sessions would wait on each other. Nothing deletes
 * sessions or events.
 */
export const toolCalls = pgTable(
  "tool_calls",
  {
    useEventId: bigint("use_event_id", { mode: "number" }).notNull(),
    // The tool_use block's place in its event's content.
    ord: integer().notNull(),
    sessionId: uuid("session_id").notNull(),
    // attempt_id, '' for none: a null attempt pairs with null.
    attemptKey: text("attempt_key").notNull(),
    // null when the block's id is no string: such a call pairs with nothing.
    toolUseId: text("tool_use_id"),
    name: text().notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    // used_at, else created_at: when the call shows as made.
    at: timestamp({ withTimezone: true }).notNull(),
    // The tool_use event's created_at, which the period cuts on.
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    resultEventId: bigint("result_event_id", { mode: "number" }),
    resultAt: timestamp("result_at", { withTimezone: true }),
    outcome: text().notNull().default("unknown"),
    // Both times known only; a result stamped before its call is 0.
    ms: bigint({ mode: "number" }),
  },
  (table) => [
    primaryKey({ columns: [table.useEventId, table.ord] }),
    check(
      "tool_calls_outcome_check",
      sql`${table.outcome} IN ('ok', 'failed', 'unknown')`,
    ),
    check("tool_calls_ms_check", sql`${table.ms} >= 0`),
    uniqueIndex("tool_calls_pair_uniq")
      .on(table.sessionId, table.attemptKey, table.toolUseId)
      .where(sql`${table.toolUseId} IS NOT NULL`),
    index("tool_calls_recent_idx").on(
      table.name,
      table.at.desc(),
      table.useEventId.desc(),
      table.ord.desc(),
    ),
    index("tool_calls_slowest_idx").on(
      table.name,
      table.ms.desc().nullsLast(),
      table.useEventId.desc(),
      table.ord.desc(),
    ),
    index("tool_calls_created_at_idx").on(table.createdAt),
    // A scope with few sessions reads its calls from them; the name-led
    // indexes above would walk every call of the tool in the period.
    index("tool_calls_session_name_idx").on(table.sessionId, table.name),
  ],
);

/**
 * A tool's description as a session's engine declared it at init, projected
 * with tool_calls (94S-936). Only MCP tools have one; the adapter has already
 * redacted it and cut it to one line. A usage read takes the newest one among
 * the sessions it may see, so a description never crosses into a scope whose
 * sessions did not declare it.
 */
export const toolDescriptions = pgTable(
  "tool_descriptions",
  {
    sessionId: uuid("session_id").notNull(),
    name: text().notNull(),
    description: text().notNull(),
    // The init event's id: of two inits in a session the later one wins.
    eventId: bigint("event_id", { mode: "number" }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.sessionId, table.name] }),
    check(
      "tool_descriptions_description_check",
      sql`char_length(${table.description}) BETWEEN 1 AND 200`,
    ),
    index("tool_descriptions_name_idx").on(table.name, table.eventId.desc()),
  ],
);

/**
 * How far `projectToolCalls` has read events: every event with an id at or
 * below `applied_through` is in tool_calls. One row.
 */
export const toolCallProgress = pgTable(
  "tool_call_progress",
  {
    id: integer().primaryKey(),
    appliedThrough: bigint("applied_through", { mode: "number" })
      .notNull()
      .default(0),
    // The batch size a statement timeout cut it down to, kept across passes;
    // null is the reconciler's configured size.
    batchSize: integer("batch_size"),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [check("tool_call_progress_one_row", sql`${table.id} = 1`)],
);

/**
 * tool_calls summed per UTC day of created_at and tool name, once for each
 * scope a usage read can ask for, so a read touches days × tools rows
 * whatever the volume. A session's calls count under scope_key '' (the
 * installation), `user:<user_id>:<owner_id>` and `api_key:<key_id>:<owner_id>`
 * for whoever started it, each once with agent_key '' and once more with its
 * agent's id. `hist` counts timed calls per duration bucket
 * (`tool_ms_bucket`), the only way to a median across rows.
 */
export const toolCallDays = pgTable(
  "tool_call_days",
  {
    scopeKey: text("scope_key").notNull(),
    agentKey: text("agent_key").notNull(),
    day: date({ mode: "string" }).notNull(),
    name: text().notNull(),
    calls: integer().notNull(),
    failed: integer().notNull(),
    timed: integer().notNull(),
    totalMs: bigint("total_ms", { mode: "number" }).notNull(),
    // Never lowered when an earlier result replaces a call's time.
    maxMs: bigint("max_ms", { mode: "number" }).notNull(),
    hist: integer().array().notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.scopeKey, table.agentKey, table.day, table.name],
    }),
    check(
      "tool_call_days_hist_check",
      sql`array_length(${table.hist}, 1) = 161`,
    ),
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
    /** `receiptActorSchema`: principal plus the human behind it. */
    actor: jsonb(),
    requestId: text("request_id"),
  },
  (table) => [
    index("receipts_owner_created_at_idx").on(table.ownerId, table.createdAt),
    index("receipts_request_idx").on(table.requestId),
    // The terminate deadline sweep runs every scheduler and reconciler pass
    // and must not read the whole receipt history to find the few open ones.
    // An execution revocation is swept the same way.
    index("receipts_open_terminate_idx")
      .on(table.createdAt)
      .where(
        sql`${table.operation} IN ('terminate', 'revoke_execution') AND ${table.status} = 'accepted'`,
      ),
  ],
);

// No foreign keys, so a row outlives the session, key or user it names for
// as long as the workspace keeps audit rows.
export const authzDecisions = pgTable(
  "authz_decisions",
  {
    id: uuid().primaryKey(),
    at: timestamp({ withTimezone: true }).notNull().defaultNow(),
    ownerId: text("owner_id").notNull(),
    workspaceId: uuid("workspace_id"),
    principalKind: text("principal_kind"),
    principalId: text("principal_id"),
    actorUserId: uuid("actor_user_id"),
    agentId: uuid("agent_id"),
    agentReleaseId: text("agent_release_id"),
    linkedAccountId: text("linked_account_id"),
    linkedAccountRevision: integer("linked_account_revision"),
    surface: jsonb().notNull(),
    action: text().notNull(),
    resourceKind: text("resource_kind").notNull(),
    resourceId: text("resource_id"),
    outcome: text().notNull(),
    reasonCode: text("reason_code").notNull(),
    justification: text(),
    policyVersion: text("policy_version").notNull(),
    requestId: text("request_id").notNull(),
  },
  (table) => [
    index("authz_decisions_request_idx").on(table.requestId),
    index("authz_decisions_at_idx").on(table.at),
    check(
      "authz_decisions_outcome_check",
      sql`${table.outcome} IN ('allow', 'deny', 'redact', 'require_approval')`,
    ),
    check(
      "authz_decisions_principal_check",
      sql`(${table.principalKind} IS NULL) = (${table.principalId} IS NULL)`,
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
    // Who answered, where, and the session.approve decision that let them:
    // the answer receipt's actor shape, so a key with no person is still
    // named. No FK on the decision: audit retention prunes authz_decisions
    // and the approval row outlives it. Null on rows answered before 0137.
    answeredBy: jsonb("answered_by"),
    answerSurface: text("answer_surface"),
    answerDecisionId: uuid("answer_decision_id"),
    settledAt: timestamp("settled_at", { withTimezone: true }),
    // answered | expired | cancelled from the worker; lost when the
    // execution went away before it said.
    settledOutcome: text("settled_outcome"),
    // Why the worker cancelled it (park | shutdown | interrupt | refused),
    // and what its run said of a delivered answer (applied | stale |
    // unknown). Null from a worker older than them and where it did not say.
    settledReason: text("settled_reason"),
    settledAnswerResult: text("settled_answer_result"),
    // Set when the worker handed the `question` event to the gateway
    // a replay must carry the same pair. Null for a worker that
    // publishes the event itself.
    toolUseId: text("tool_use_id"),
    tool: text(),
    // When the worker should park the turn on this request. Null on rows
    // from before it and for a wait that never parks.
    parkAt: timestamp("park_at", { withTimezone: true }),
    // Written by the transaction that finalizes the parked turn with its
    // checkpoint. From then the row stays answerable whatever happens to
    // the attempt that asked, until it is answered, expires or is closed.
    parkedAt: timestamp("parked_at", { withTimezone: true }),
    // When pendingControl first handed the answer to a worker. An answer
    // with none never reached an engine.
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
  },
  (table) => [
    index("pending_requests_unresolved_session_idx")
      .on(table.sessionId)
      .where(sql`${table.resolvedAt} IS NULL`),
    index("pending_requests_park_due")
      .on(table.parkAt)
      .where(
        sql`${table.parkedAt} IS NULL AND ${table.resolvedAt} IS NULL AND ${table.parkAt} IS NOT NULL`,
      ),
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
    check(
      "pending_requests_answer_surface_check",
      sql`${table.answerSurface} IN ('web', 'slack', 'api')`,
    ),
    check(
      "pending_requests_approval_check",
      sql`(${table.answerSurface} IS NULL) = (${table.answerDecisionId} IS NULL) AND (${table.answerSurface} IS NULL OR ${table.answeredAt} IS NOT NULL) AND (${table.answeredBy} IS NULL OR ${table.answerSurface} IS NOT NULL)`,
    ),
  ],
);

// An answer to a parked permission request, to be spent once by the turn
// that resumes it. The tool, input hash and who answered stay on the
// request row; copying them here would let the two disagree.
export const permissionGrants = pgTable("permission_grants", {
  requestId: text("request_id")
    .primaryKey()
    .references(() => pendingRequests.requestId, { onDelete: "cascade" }),
  sessionId: uuid("session_id")
    .notNull()
    .references(() => sessions.id, { onDelete: "cascade" }),
  turnId: bigint("turn_id", { mode: "number" })
    .notNull()
    .references(() => turns.id),
  consumedAt: timestamp("consumed_at", { withTimezone: true }),
});

// A session result the platform may push to `agent/<session-id>` once a human
// approves it. The commit is pinned when the request is made, so what is
// approved is what is pushed, however far the session moves on.
export const pushRequests = pgTable(
  "push_requests",
  {
    id: uuid().primaryKey(),
    ownerId: text("owner_id").notNull(),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => sessions.id),
    repositoryId: text("repository_id").notNull(),
    checkpointRevision: integer("checkpoint_revision").notNull(),
    gitCommit: text("git_commit").notNull(),
    targetBranch: text("target_branch").notNull(),
    state: text().notNull().default("requested"),
    requestedBy: jsonb("requested_by").notNull(),
    requestReceiptId: uuid("request_receipt_id")
      .notNull()
      .references(() => receipts.id),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    decidedBy: jsonb("decided_by"),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    decisionReason: text("decision_reason"),
    decisionReceiptId: uuid("decision_receipt_id").references(
      () => receipts.id,
    ),
    pushStartedAt: timestamp("push_started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    pushError: jsonb("push_error"),
    pushReceiptId: uuid("push_receipt_id").references(() => receipts.id),
    repositoryBinding: text("repository_binding"),
    pushAttempts: integer("push_attempts").notNull().default(0),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
  },
  (table) => [
    check(
      "push_requests_state_check",
      sql`${table.state} IN (${sql.raw(sqlList(PUSH_REQUEST_STATE_VALUES))})`,
    ),
    check(
      "push_requests_git_commit_check",
      sql`${table.gitCommit} ~ '^[0-9a-f]{40}$'`,
    ),
    check(
      "push_requests_checkpoint_revision_check",
      sql`${table.checkpointRevision} >= 0`,
    ),
    check(
      "push_requests_target_branch_check",
      sql`${table.targetBranch} = 'agent/' || ${table.sessionId}::text`,
    ),
    check(
      "push_requests_decision_check",
      sql`(${table.state} = 'requested') = (${table.decidedAt} IS NULL) AND (${table.decidedAt} IS NULL) = (${table.decidedBy} IS NULL) AND (${table.decidedAt} IS NULL) = (${table.decisionReceiptId} IS NULL)`,
    ),
    uniqueIndex("push_requests_open_session_idx")
      .on(table.sessionId)
      .where(
        sql`${table.state} IN (${sql.raw(sqlList(OPEN_PUSH_REQUEST_STATES))})`,
      ),
    index("push_requests_session_created_idx").on(
      table.sessionId,
      table.createdAt,
    ),
    index("push_requests_approved_idx")
      .on(table.createdAt)
      .where(sql`${table.state} = 'approved'`),
    index("push_requests_pushing_lease_idx")
      .on(table.leaseExpiresAt)
      .where(sql`${table.state} = 'pushing'`),
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
    // The transcript total the verified manifest pins, which the session
    // detail judges TRANSCRIPT_LIMIT on. Null for rows committed before it
    // was recorded.
    transcriptBytes: bigint("transcript_bytes", { mode: "number" }),
    turnId: bigint("turn_id", { mode: "number" }).references(() => turns.id),
    committedAt: timestamp("committed_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    // Set by checkpoint garbage collection before it deletes the
    // revision's objects: no restore reaches this revision any more, and a
    // backup leaves it out rather than fail on what is gone.
    collectedAt: timestamp("collected_at", { withTimezone: true }),
    // Set once a collection pass after collected_at deleted every object it
    // found; output usage counts the revision's outputs until then.
    objectsPurgedAt: timestamp("objects_purged_at", { withTimezone: true }),
    // The profile of the attempt that committed it: its runtime fingerprint
    // was computed from that profile, so a restore after a profile change
    // is checked against it. Null on rows from before the column.
    profileId: text("profile_id"),
    profileFingerprint: text("profile_fingerprint"),
    // The attempt's model; null where the fingerprint names it (version 1).
    model: text(),
    // Whether checkpoint_outputs holds what this revision's manifest names
    // under outputs. False on rows committed before it was recorded, whose
    // outputs no figure counts.
    outputsRecorded: boolean("outputs_recorded").notNull().default(false),
  },
  (table) => [primaryKey({ columns: [table.sessionId, table.revision] })],
);

// Every output object a committed revision's manifest names, the ones it
// inherited included, so the bytes still kept are the distinct keys of the
// revisions garbage collection has not released.
export const checkpointOutputs = pgTable(
  "checkpoint_outputs",
  {
    sessionId: uuid("session_id").notNull(),
    revision: integer().notNull(),
    objectKey: text("object_key").notNull(),
    bytes: bigint({ mode: "number" }).notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.sessionId, table.revision, table.objectKey],
    }),
    foreignKey({
      name: "checkpoint_outputs_checkpoint_fk",
      columns: [table.sessionId, table.revision],
      foreignColumns: [checkpoints.sessionId, checkpoints.revision],
    }),
    check("checkpoint_outputs_bytes_nonneg", sql`${table.bytes} >= 0`),
  ],
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
    // The session's profile when this attempt claimed it. The attempt runs
    // it to the end, so a profile change on the session takes effect at the
    // next claim; null on rows from before the column.
    profileId: text("profile_id"),
    profileFingerprint: text("profile_fingerprint"),
    // The session's model when this attempt claimed it; null where the
    // fingerprint names it (version 1).
    model: text(),
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

// One Messages call the egress proxy metered, priced when it was
// recorded. Its cost is added to the session's in the same transaction, and
// the proxy's own id for the exchange keys it, so a report sent again after
// a lost answer is not counted twice. The attempt is the one the proxy's
// grant named, which may have ended since: the call was still made.
export const providerUsage = pgTable(
  "provider_usage",
  {
    exchangeId: text("exchange_id").primaryKey(),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => sessions.id),
    attemptId: text("attempt_id")
      .notNull()
      .references(() => attempts.id),
    model: text().notNull(),
    inputTokens: bigint("input_tokens", { mode: "number" }).notNull(),
    outputTokens: bigint("output_tokens", { mode: "number" }).notNull(),
    cacheCreationInputTokens: bigint("cache_creation_input_tokens", {
      mode: "number",
    }).notNull(),
    cacheCreation1hInputTokens: bigint("cache_creation_1h_input_tokens", {
      mode: "number",
    }).notNull(),
    cacheReadInputTokens: bigint("cache_read_input_tokens", {
      mode: "number",
    }).notNull(),
    // What else the price rests on. Rows from before it say
    // `unknown`, as a report from a proxy that predates it does; they were
    // priced as standard with no tool fee.
    speed: text().notNull().default("unknown"),
    webSearchRequests: bigint("web_search_requests", { mode: "number" })
      .notNull()
      .default(0),
    webFetchRequests: bigint("web_fetch_requests", { mode: "number" })
      .notNull()
      .default(0),
    codeExecutionRequests: bigint("code_execution_requests", {
      mode: "number",
    })
      .notNull()
      .default(0),
    // Rows from before say `unknown`, as a report from a proxy that
    // predates it does; they were priced with no geo multiplier.
    inferenceGeo: text("inference_geo").notNull().default("unknown"),
    // The proxy estimated the call high because its answer did not say what
    // it used: a stream cut short, or a body it could not read.
    estimated: boolean().notNull(),
    // What was charged: the priced amount rounded up to the micro-dollar,
    // clamped to what the column holds. Exactly what the session got.
    costUsd: numeric("cost_usd", {
      precision: 14,
      scale: 6,
      mode: "number",
    }).notNull(),
    // `fallback`: the model was not in the price table and every part was
    // charged at the highest known rate. `unmetered`: the session's profile
    // declared `billing: none`, so the call cost nothing.
    pricedBy: text("priced_by")
      .$type<"table" | "fallback" | "unmetered">()
      .notNull(),
    recordedAt: timestamp("recorded_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("provider_usage_session_idx").on(table.sessionId),
    check(
      "provider_usage_priced_by_check",
      sql`${table.pricedBy} IN ('table', 'fallback', 'unmetered')`,
    ),
    check("provider_usage_cost_usd_nonneg", sql`${table.costUsd} >= 0`),
  ],
);

// provider_usage summed per session and model by the provider_usage insert
// trigger (migration usage_breakdown_rollup), so the usage breakdown reads a row per pair
// instead of every call. The session's created_at and agent are copied for
// the period filter and the grouping; neither changes after the session is
// created. No foreign keys: rows only come from provider_usage, which holds
// the session's, and adding one would block session writes for the whole
// migration.
export const sessionModelUsage = pgTable(
  "session_model_usage",
  {
    sessionId: uuid("session_id").notNull(),
    model: text().notNull(),
    sessionCreatedAt: timestamp("session_created_at", {
      withTimezone: true,
    }).notNull(),
    agentId: uuid("agent_id"),
    inputTokens: bigint("input_tokens", { mode: "number" }).notNull(),
    outputTokens: bigint("output_tokens", { mode: "number" }).notNull(),
    cacheReadInputTokens: bigint("cache_read_input_tokens", {
      mode: "number",
    }).notNull(),
    cacheCreationInputTokens: bigint("cache_creation_input_tokens", {
      mode: "number",
    }).notNull(),
    costUsd: numeric("cost_usd", {
      precision: 14,
      scale: 6,
      mode: "number",
    }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.sessionId, table.model] }),
    index("session_model_usage_created_at_idx").on(table.sessionCreatedAt),
  ],
);

// The part of a session's cost_usd no metered call explains: the engine's
// turn totals from before provider_usage. Written once by migration usage_breakdown_rollup;
// a call adds to cost_usd and to its own sum alike, so the difference stays
// put and new sessions never get a row. No foreign key, as above.
export const sessionPreMeteringCost = pgTable(
  "session_pre_metering_cost",
  {
    sessionId: uuid("session_id").primaryKey(),
    sessionCreatedAt: timestamp("session_created_at", {
      withTimezone: true,
    }).notNull(),
    costUsd: numeric("cost_usd", {
      precision: 14,
      scale: 6,
      mode: "number",
    }).notNull(),
  },
  (table) => [
    index("session_pre_metering_cost_created_at_idx").on(
      table.sessionCreatedAt,
    ),
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
    // its slot back instead of holding it forever.
    launchFailureCount: integer("launch_failure_count").notNull().default(0),
    // Attempts whose outcome was recorded, success or failure. A failure is
    // fenced on it, so one reported by a pass that lost its lock mid-ensure
    // cannot revoke what a later pass has since launched.
    launchAttempts: integer("launch_attempts").notNull().default(0),
    // No attempt before this, on the database clock; null when none failed
    // or the launch was given up on.
    launchRetryAt: timestamp("launch_retry_at", { withTimezone: true }),
    lastLaunchError: text("last_launch_error"),
    // When the scheduler first asked the worker this launch bound to drain,
    // because its resource no longer meets the isolation contract.
    // From then on the worker is handed no new turn; the replacement waits
    // for the one it runs, up to a deadline counted from here.
    drainRequestedAt: timestamp("drain_requested_at", { withTimezone: true }),
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
// credential routes, `object_store` its object store route, and `mcp` the
// remote MCP route of a session whose agent release names a server (only
// then is one issued). All of them are issued, extended and revoked
// together, and a token only ever works for its own purpose.
export const workerCredentials = pgTable(
  "worker_credentials",
  {
    tokenHash: bytea("token_hash").primaryKey(),
    attemptId: text("attempt_id")
      .notNull()
      .references(() => attempts.id),
    purpose: text("purpose").notNull().default("gateway"),
    // What an egress token was issued against: the profile fingerprint, the
    // repository binding or the session's object prefix at claim time. A catalog entry that moved since
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
      sql`${table.purpose} IN ('gateway', 'provider', 'repository', 'object_store', 'mcp')`,
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
  // process cannot be judged by another's.
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
    /** Null on a key from before scopes: it holds none. */
    scopes: text().array(),
    // personal: a member's own; agent: one agent's; operator: issued by the
    // key CLI to an owner partition outside any workspace.
    kind: text().notNull(),
    name: text(),
    createdByUserId: uuid("created_by_user_id").references(() => users.id),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    /** An agent key's agent, whose sessions it reaches and nothing else. */
    agentId: uuid("agent_id"),
    // Unindexed so the throttled touch stays a HOT update (touchApiKey).
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  },
  (table) => [
    foreignKey({
      name: "api_keys_agent_fk",
      columns: [table.workspaceId, table.agentId],
      foreignColumns: [agents.workspaceId, agents.id],
    }),
    index("api_keys_agent_idx")
      .on(table.agentId)
      .where(sql`${table.agentId} IS NOT NULL`),
    // A person's key carries their authority, never an agent's.
    check(
      "api_keys_agent_check",
      sql`(${table.kind} = 'agent') = (${table.agentId} IS NOT NULL) AND (${table.kind} <> 'agent' OR ${table.workspaceId} IS NOT NULL)`,
    ),
    // No key reaches a whole workspace as itself.
    check(
      "api_keys_operator_check",
      sql`${table.kind} <> 'operator' OR ${table.workspaceId} IS NULL`,
    ),
    check(
      "api_keys_name_check",
      sql`${table.name} IS NULL OR (char_length(${table.name}) BETWEEN 1 AND 64 AND ${table.name} = btrim(${table.name}))`,
    ),
    index("api_keys_workspace_idx")
      .on(table.workspaceId)
      .where(sql`${table.workspaceId} IS NOT NULL`),
    index("api_keys_personal_creator_idx")
      .on(table.createdByUserId)
      .where(sql`${table.kind} = 'personal'`),
    check(
      "api_keys_kind_check",
      sql`${table.kind} IN ('personal', 'agent', 'operator')`,
    ),
    check(
      "api_keys_personal_check",
      sql`${table.kind} <> 'personal' OR (${table.createdByUserId} IS NOT NULL AND ${table.workspaceId} IS NOT NULL)`,
    ),
    // Same vocabulary as grants.scopes, which may only narrow a key's.
    check(
      "api_keys_scopes_check",
      sql`${table.scopes} IS NULL OR (${oneDimensional(table.scopes)} AND ${table.scopes} <@ ${SESSION_SCOPES_SQL})`,
    ),
  ],
);

// The catalog revision an operator activated: only a gateway
// whose own `catalogRevision` equals it may fail a session for a pair its
// catalog lacks. One row at most; none means a single replica, where every
// gateway is the authority. The API never writes it — the operator's
// compare-and-swap does, as a rollout's first step (docs/operator/api-server.md).
export const catalogAuthority = pgTable(
  "catalog_authority",
  {
    id: integer().primaryKey(),
    revision: text().notNull(),
    activatedAt: timestamp("activated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [check("catalog_authority_singleton_check", sql`${table.id} = 1`)],
);

export const AGENT_ACTIVATION_EVENT_KINDS = [
  "release_created",
  "activated",
] as const;

// Mirror contracts' CREDENTIAL_BINDING_TARGET_VALUES and CREDENTIAL_REF
// pattern; schema.test.ts asserts they agree.
export const CREDENTIAL_BINDING_TARGETS = ["agent", "agent_identity"] as const;
export const CREDENTIAL_REF_PATTERN = "^[a-z0-9][a-z0-9._:/-]{0,127}$";

// Versions, releases and activation events are insert-only (migration 0139
// triggers); a release's approval is set once, by its first activation.
export const agents = pgTable(
  "agents",
  {
    id: uuid().primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    slug: text().notNull(),
    name: text().notNull(),
    status: text().notNull().default("active"),
    activeReleaseId: text("active_release_id"),
    activationRevision: integer("activation_revision").notNull().default(-1),
    slackDefaultMode: text("slack_default_mode")
      .$type<"off" | "mention">()
      .notNull()
      .default("off"),
    createdBy: uuid("created_by").references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("agents_workspace_slug_idx").on(table.workspaceId, table.slug),
    check(
      "agents_slack_default_mode_check",
      sql`${table.slackDefaultMode} IN ('off', 'mention')`,
    ),
    // What agent_admins and api_keys reference, so neither can name another
    // workspace's agent.
    unique("agents_workspace_id_key").on(table.workspaceId, table.id),
    foreignKey({
      name: "agents_active_release_fk",
      columns: [table.id, table.activeReleaseId],
      foreignColumns: [agentReleases.agentId, agentReleases.id],
    }),
    check(
      "agents_status_check",
      sql`${table.status} IN (${sql.raw(sqlList(AGENT_STATUS_VALUES))})`,
    ),
    check(
      "agents_slug_check",
      sql`length(${table.slug}) BETWEEN 1 AND 64 AND ${table.slug} ~ '^[a-z0-9][a-z0-9-]*$'`,
    ),
    check(
      "agents_activation_check",
      sql`${table.activationRevision} >= -1 AND (${table.activeReleaseId} IS NULL) = (${table.activationRevision} = -1)`,
    ),
  ],
);

// An agent's admins (design 4.1): a member gains that agent's management
// actions. Whoever creates an agent is its first (D3). A team as admin is M13.
export const agentAdmins = pgTable(
  "agent_admins",
  {
    workspaceId: uuid("workspace_id").notNull(),
    agentId: uuid("agent_id").notNull(),
    userId: uuid("user_id").notNull(),
    createdBy: uuid("created_by").references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.agentId, table.userId] }),
    foreignKey({
      name: "agent_admins_agent_fk",
      columns: [table.workspaceId, table.agentId],
      foreignColumns: [agents.workspaceId, agents.id],
    }),
    // An admin is a member of the agent's workspace, never someone else's.
    foreignKey({
      name: "agent_admins_member_fk",
      columns: [table.workspaceId, table.userId],
      foreignColumns: [memberships.workspaceId, memberships.userId],
    }),
    index("agent_admins_user_idx").on(table.workspaceId, table.userId),
  ],
);

// A group of people in a workspace (design 4.7). Named apart from the
// session teams Lotse will add.
export const memberTeams = pgTable(
  "member_teams",
  {
    id: uuid().primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    name: text().notNull(),
    createdBy: uuid("created_by").references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    revision: integer().notNull().default(1),
  },
  (table) => [
    unique("member_teams_workspace_id_key").on(table.workspaceId, table.id),
    uniqueIndex("member_teams_live_name_uniq")
      .on(table.workspaceId, table.name)
      .where(sql`${table.archivedAt} IS NULL`),
    check(
      "member_teams_name_check",
      sql`length(${table.name}) BETWEEN 1 AND 100`,
    ),
  ],
);

// Read at every decision: a removed row stops granting from the next request.
export const memberTeamMembers = pgTable(
  "member_team_members",
  {
    id: uuid().primaryKey(),
    workspaceId: uuid("workspace_id").notNull(),
    teamId: uuid("team_id").notNull(),
    userId: uuid("user_id").notNull(),
    addedBy: uuid("added_by").references(() => users.id),
    addedAt: timestamp("added_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    removedAt: timestamp("removed_at", { withTimezone: true }),
  },
  (table) => [
    foreignKey({
      name: "member_team_members_team_fk",
      columns: [table.workspaceId, table.teamId],
      foreignColumns: [memberTeams.workspaceId, memberTeams.id],
    }),
    // Only a member of the team's own workspace can join it.
    foreignKey({
      name: "member_team_members_member_fk",
      columns: [table.workspaceId, table.userId],
      foreignColumns: [memberships.workspaceId, memberships.userId],
    }),
    uniqueIndex("member_team_members_live_uniq")
      .on(table.teamId, table.userId)
      .where(sql`${table.removedAt} IS NULL`),
    index("member_team_members_user_idx")
      .on(table.workspaceId, table.userId)
      .where(sql`${table.removedAt} IS NULL`),
  ],
);

// A team as an agent's admin: every live member of it administers the agent.
export const agentAdminTeams = pgTable(
  "agent_admin_teams",
  {
    workspaceId: uuid("workspace_id").notNull(),
    agentId: uuid("agent_id").notNull(),
    teamId: uuid("team_id").notNull(),
    createdBy: uuid("created_by").references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.agentId, table.teamId] }),
    foreignKey({
      name: "agent_admin_teams_agent_fk",
      columns: [table.workspaceId, table.agentId],
      foreignColumns: [agents.workspaceId, agents.id],
    }),
    foreignKey({
      name: "agent_admin_teams_team_fk",
      columns: [table.workspaceId, table.teamId],
      foreignColumns: [memberTeams.workspaceId, memberTeams.id],
    }),
    index("agent_admin_teams_team_idx").on(table.teamId),
  ],
);

// Who sees a session (design 4.6). No row reads as `workspace`, which is
// what every session made before this table, and every web, API and channel
// session since, starts as.
export const sessionShares = pgTable(
  "session_shares",
  {
    sessionId: uuid("session_id").primaryKey(),
    ownerId: text("owner_id").notNull(),
    workspaceId: uuid("workspace_id").notNull(),
    scope: text().notNull(),
    updatedBy: uuid("updated_by").references(() => users.id),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    revision: integer().notNull().default(1),
  },
  (table) => [
    // NOT NULL workspace_id makes this pin the row to its session's
    // workspace; a legacy session has none and cannot be shared.
    foreignKey({
      name: "session_shares_session_fk",
      columns: [table.sessionId, table.ownerId, table.workspaceId],
      foreignColumns: [sessions.id, sessions.ownerId, sessions.workspaceId],
    }),
    unique("session_shares_workspace_session_key").on(
      table.workspaceId,
      table.sessionId,
    ),
    check(
      "session_shares_scope_check",
      sql`${table.scope} IN ('private', 'people', 'team', 'workspace')`,
    ),
  ],
);

// The people or teams a `people` or `team` share names; a team is read for
// its live members at every decision.
export const sessionShareTargets = pgTable(
  "session_share_targets",
  {
    id: uuid().primaryKey(),
    workspaceId: uuid("workspace_id").notNull(),
    sessionId: uuid("session_id").notNull(),
    userId: uuid("user_id"),
    teamId: uuid("team_id"),
    addedBy: uuid("added_by").references(() => users.id),
    addedAt: timestamp("added_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    foreignKey({
      name: "session_share_targets_share_fk",
      columns: [table.workspaceId, table.sessionId],
      foreignColumns: [sessionShares.workspaceId, sessionShares.sessionId],
    }).onDelete("cascade"),
    foreignKey({
      name: "session_share_targets_member_fk",
      columns: [table.workspaceId, table.userId],
      foreignColumns: [memberships.workspaceId, memberships.userId],
    }),
    foreignKey({
      name: "session_share_targets_team_fk",
      columns: [table.workspaceId, table.teamId],
      foreignColumns: [memberTeams.workspaceId, memberTeams.id],
    }),
    check(
      "session_share_targets_one_check",
      sql`(${table.userId} IS NULL) <> (${table.teamId} IS NULL)`,
    ),
    uniqueIndex("session_share_targets_user_uniq")
      .on(table.sessionId, table.userId)
      .where(sql`${table.userId} IS NOT NULL`),
    uniqueIndex("session_share_targets_team_uniq")
      .on(table.sessionId, table.teamId)
      .where(sql`${table.teamId} IS NOT NULL`),
  ],
);

// "This Slack app and bot is this agent" (design A.2, M8). App and team are
// the install's; the bot user is pinned here, so a reinstall that answers as
// another bot resolves to no one until linked again.
export const agentIdentities = pgTable(
  "agent_identities",
  {
    id: uuid().primaryKey(),
    workspaceId: uuid("workspace_id").notNull(),
    agentId: uuid("agent_id").notNull(),
    provider: text().$type<"slack_bot">().notNull(),
    installationId: uuid("installation_id").notNull(),
    /** The bot user id `auth.test` reported when the identity was linked. */
    externalPrincipalId: text("external_principal_id").notNull(),
    /** The bot token's name in the secret store; the value is never here. */
    credentialRef: text("credential_ref").notNull(),
    status: text().$type<"active" | "revoked">().notNull().default("active"),
    revision: integer().notNull().default(1),
    createdBy: uuid("created_by").references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    revokedBy: uuid("revoked_by").references(() => users.id),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (table) => [
    foreignKey({
      name: "agent_identities_agent_fk",
      columns: [table.workspaceId, table.agentId],
      foreignColumns: [agents.workspaceId, agents.id],
    }),
    foreignKey({
      name: "agent_identities_installation_fk",
      columns: [table.workspaceId, table.installationId],
      foreignColumns: [slackInstallations.workspaceId, slackInstallations.id],
    }),
    // An event's app and team name one agent at most.
    uniqueIndex("agent_identities_installation_live_uniq")
      .on(table.installationId)
      .where(sql`${table.status} = 'active'`),
    index("agent_identities_agent_idx").on(table.agentId),
    check(
      "agent_identities_provider_check",
      sql`${table.provider} IN (${sql.raw(sqlList(AGENT_IDENTITY_PROVIDER_VALUES))})`,
    ),
    check(
      "agent_identities_status_check",
      sql`${table.status} IN (${sql.raw(sqlList(AGENT_IDENTITY_STATUS_VALUES))})`,
    ),
    check(
      "agent_identities_revoked_check",
      sql`(${table.status} = 'revoked') = (${table.revokedAt} IS NOT NULL)`,
    ),
    check(
      "agent_identities_credential_ref_check",
      sql`${table.credentialRef} ~ '^[a-z0-9][a-z0-9._:/-]{0,127}$'`,
    ),
  ],
);

// How an agent answers in one place of a chat surface (03 §5, 94S-177): a
// Slack channel of its app's install, or that install's DMs, which share one
// row with no channel id. Rows are revoked, never deleted; a write replaces
// the row and bumps `revision`. The install is the agent's own: the store
// takes it from the agent's live identity.
export const surfaceBindings = pgTable(
  "surface_bindings",
  {
    id: uuid().primaryKey(),
    workspaceId: uuid("workspace_id").notNull(),
    agentId: uuid("agent_id").notNull(),
    surface: text().$type<"web" | "slack" | "api">().notNull().default("slack"),
    installationId: uuid("installation_id"),
    externalSurfaceId: text("external_surface_id"),
    surfaceKind: text("surface_kind").$type<
      "public_channel" | "private_channel" | "dm"
    >(),
    mode: text().$type<"off" | "mention" | "ambient">().notNull(),
    /** The channel's ceiling; `surfaceCeilingSchema` split in two columns. */
    ceilingActions: text("ceiling_actions").array().notNull(),
    ceilingDisclosure: text("ceiling_disclosure")
      .$type<"full" | "summary">()
      .notNull(),
    home: boolean().notNull().default(false),
    memoryWritePolicy: text("memory_write_policy")
      .$type<"deny" | "allow_explicit">()
      .notNull()
      .default("deny"),
    status: text()
      .$type<"ready" | "partial" | "failed" | "revoked">()
      .notNull()
      .default("ready"),
    muted: boolean().notNull().default(false),
    /** `surfaceMembershipSchema`; null until Slack was asked. */
    membership: text().$type<SurfaceMembershipState>(),
    membershipError: text("membership_error"),
    revision: integer().notNull().default(1),
    createdBy: uuid("created_by").references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (table) => [
    foreignKey({
      name: "surface_bindings_agent_fk",
      columns: [table.workspaceId, table.agentId],
      foreignColumns: [agents.workspaceId, agents.id],
    }),
    foreignKey({
      name: "surface_bindings_installation_fk",
      columns: [table.workspaceId, table.installationId],
      foreignColumns: [slackInstallations.workspaceId, slackInstallations.id],
    }),
    // One live binding per channel of an install, and one DM row.
    uniqueIndex("surface_bindings_channel_live_uniq")
      .on(table.installationId, table.externalSurfaceId)
      .where(sql`${table.revokedAt} IS NULL`),
    uniqueIndex("surface_bindings_dm_live_uniq")
      .on(table.installationId)
      .where(sql`${table.surfaceKind} = 'dm' AND ${table.revokedAt} IS NULL`),
    uniqueIndex("surface_bindings_home_live_uniq")
      .on(table.agentId)
      .where(sql`${table.home} AND ${table.revokedAt} IS NULL`),
    index("surface_bindings_agent_idx").on(table.agentId),
    check(
      "surface_bindings_surface_check",
      sql`${table.surface} IN (${sql.raw(sqlList(SURFACE_KIND_VALUES))})`,
    ),
    check(
      "surface_bindings_surface_kind_check",
      sql`${table.surfaceKind} IN (${sql.raw(sqlList(SURFACE_CHANNEL_KIND_VALUES))})`,
    ),
    check(
      "surface_bindings_mode_check",
      sql`${table.mode} IN (${sql.raw(sqlList(BINDING_MODE_VALUES))})`,
    ),
    check(
      "surface_bindings_ceiling_check",
      sql`${table.ceilingActions} <@ ${textArrayLiteral(SLACK_SURFACE_ACTION_VALUES)} AND ${table.ceilingDisclosure} IN (${sql.raw(sqlList(SURFACE_DISCLOSURE_VALUES))})`,
    ),
    check(
      "surface_bindings_memory_write_policy_check",
      sql`${table.memoryWritePolicy} IN (${sql.raw(sqlList(MEMORY_WRITE_POLICY_VALUES))})`,
    ),
    check(
      "surface_bindings_status_check",
      sql`${table.status} IN (${sql.raw(sqlList(SURFACE_BINDING_STATUS_VALUES))})`,
    ),
    check(
      "surface_bindings_membership_check",
      sql`(${table.membership} IS NULL OR ${table.membership} IN (${sql.raw(sqlList(SURFACE_MEMBERSHIP_STATE_VALUES))})) AND (${table.membershipError} IS NULL OR ${table.membership} IS NOT NULL)`,
    ),
    check(
      "surface_bindings_revoked_check",
      sql`(${table.status} = 'revoked') = (${table.revokedAt} IS NOT NULL)`,
    ),
    // The DM row covers every DM, so it names no channel; a DM is never home.
    check(
      "surface_bindings_dm_check",
      sql`${table.surfaceKind} IS DISTINCT FROM 'dm' OR (${table.externalSurfaceId} IS NULL AND NOT ${table.home})`,
    ),
    // `ready` claims routing works: a slack row then has what routing reads.
    check(
      "surface_bindings_ready_check",
      sql`${table.surface} <> 'slack' OR ${table.status} <> 'ready' OR (${table.installationId} IS NOT NULL AND ${table.surfaceKind} IS NOT NULL AND (${table.externalSurfaceId} IS NOT NULL OR ${table.surfaceKind} = 'dm'))`,
    ),
    check("surface_bindings_revision_check", sql`${table.revision} >= 1`),
  ],
);

export const agentVersions = pgTable(
  "agent_versions",
  {
    id: uuid().primaryKey(),
    agentId: uuid("agent_id")
      .notNull()
      .references((): AnyPgColumn => agents.id),
    versionNo: integer("version_no").notNull(),
    card: jsonb().notNull(),
    contentSha256: text("content_sha256").notNull(),
    createdBy: uuid("created_by").references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("agent_versions_number_idx").on(table.agentId, table.versionNo),
    uniqueIndex("agent_versions_content_idx").on(
      table.agentId,
      table.contentSha256,
    ),
    unique("agent_versions_agent_id_key").on(table.agentId, table.id),
    check("agent_versions_number_check", sql`${table.versionNo} > 0`),
    check(
      "agent_versions_content_check",
      sql`${table.contentSha256} ~ '^[0-9a-f]{64}$'`,
    ),
  ],
);

export const agentReleases = pgTable(
  "agent_releases",
  {
    // deriveReleaseId: a hash of every column below up to policy_pins.
    id: text().primaryKey(),
    agentId: uuid("agent_id")
      .notNull()
      .references((): AnyPgColumn => agents.id),
    versionId: uuid("version_id").notNull(),
    cardSha256: text("card_sha256").notNull(),
    runtimeProfileId: text("runtime_profile_id").notNull(),
    repositoryId: text("repository_id"),
    profileDigest: text("profile_digest").notNull(),
    runtimeConfigSnapshot: jsonb("runtime_config_snapshot").notNull(),
    effectiveTools: jsonb("effective_tools").notNull(),
    policyPins: jsonb("policy_pins").notNull().default({}),
    createdBy: uuid("created_by").references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    approvedBy: uuid("approved_by").references(() => users.id),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    // Outside the id's hash: a re-release of the same content keeps the
    // first note, null included.
    note: text(),
  },
  (table) => [
    foreignKey({
      name: "agent_releases_version_fk",
      columns: [table.agentId, table.versionId],
      foreignColumns: [agentVersions.agentId, agentVersions.id],
    }),
    unique("agent_releases_agent_id_key").on(table.agentId, table.id),
    check(
      "agent_releases_approval_check",
      sql`(${table.approvedBy} IS NULL) = (${table.approvedAt} IS NULL)`,
    ),
    check(
      "agent_releases_note_check",
      sql`${table.note} IS NULL OR char_length(${table.note}) BETWEEN 1 AND 200`,
    ),
  ],
);

export const sessionLinks = pgTable(
  "session_links",
  {
    id: uuid().primaryKey(),
    workspaceId: uuid("workspace_id").notNull(),
    ownerId: text("owner_id").notNull(),
    sessionId: uuid("session_id").references(() => sessions.id),
    surface: text().$type<"slack">().notNull().default("slack"),
    installationId: uuid("installation_id").notNull(),
    surfaceBindingId: uuid("surface_binding_id")
      .notNull()
      .references(() => surfaceBindings.id),
    surfaceRef: text("surface_ref").notNull(),
    channelId: text("channel_id").notNull(),
    threadId: text("thread_id").notNull(),
    /**
     * The message whose turn opens the session: its other event (Slack sends
     * a mention as `app_mention` and as `message`) replays that turn.
     */
    openedByTs: text("opened_by_ts").notNull(),
    agentId: uuid("agent_id").notNull(),
    releaseId: text("release_id").notNull(),
    profileId: text("profile_id").notNull(),
    role: text().$type<"primary" | "mirror">().notNull().default("primary"),
    visibility: text().$type<"full" | "summary">().notNull().default("full"),
    muted: boolean().notNull().default(false),
    revision: integer().notNull().default(1),
    /**
     * The Slack outbox's mark: every turn up to this sequence needs nothing
     * more from it, so its pass reads only the turns after.
     */
    answeredThrough: integer("answered_through").notNull().default(0),
    createdBy: uuid("created_by").references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (table) => [
    foreignKey({
      name: "session_links_agent_fk",
      columns: [table.workspaceId, table.agentId],
      foreignColumns: [agents.workspaceId, agents.id],
    }),
    foreignKey({
      name: "session_links_release_fk",
      columns: [table.agentId, table.releaseId],
      foreignColumns: [agentReleases.agentId, agentReleases.id],
    }),
    foreignKey({
      name: "session_links_installation_fk",
      columns: [table.workspaceId, table.installationId],
      foreignColumns: [slackInstallations.workspaceId, slackInstallations.id],
    }),
    unique("session_links_surface_ref_key").on(
      table.installationId,
      table.surfaceRef,
    ),
    uniqueIndex("session_links_session_uniq")
      .on(table.sessionId)
      .where(sql`${table.sessionId} IS NOT NULL`),
    check("session_links_surface_check", sql`${table.surface} = 'slack'`),
    check(
      "session_links_role_check",
      sql`${table.role} IN ('primary', 'mirror')`,
    ),
    check(
      "session_links_visibility_check",
      sql`${table.visibility} IN ('full', 'summary')`,
    ),
    check("session_links_revision_check", sql`${table.revision} >= 1`),
  ],
);

// What the `slack` role sends: a linked turn's answer, its failure or input
// notice, and refusals. A row whose send was under way when its lease ran
// out becomes `uncertain` and is never sent again (design 94S-792).
export const slackOutbox = pgTable(
  "slack_outbox",
  {
    id: uuid().primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    agentId: uuid("agent_id").notNull(),
    slackAppId: uuid("slack_app_id")
      .notNull()
      .references(() => slackApps.id),
    installationId: uuid("installation_id").notNull(),
    kind: text().$type<SlackOutboxKind>().notNull(),
    channelId: text("channel_id").notNull(),
    threadTs: text("thread_ts").notNull(),
    slackUserId: text("slack_user_id"),
    sessionId: uuid("session_id").references(() => sessions.id),
    /** The text before Slack controls are escaped, and the link it carries. */
    body: jsonb().$type<SlackOutboxBody>().notNull(),
    dedupeKey: text("dedupe_key").notNull(),
    status: text().$type<SlackOutboxStatus>().notNull().default("pending"),
    claimToken: uuid("claim_token"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    /** Claims so far. */
    attempts: integer().notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }),
    slackTs: text("slack_ts"),
    errorCode: text("error_code"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    // Send order: rows enqueued within one clock tick still go in order.
    seq: bigserial({ mode: "number" }).notNull(),
  },
  (table) => [
    unique("slack_outbox_dedupe_key").on(table.dedupeKey),
    foreignKey({
      name: "slack_outbox_agent_fk",
      columns: [table.workspaceId, table.agentId],
      foreignColumns: [agents.workspaceId, agents.id],
    }),
    check(
      "slack_outbox_kind_check",
      sql`${table.kind} IN ('reply', 'notice', 'failure_notice', 'input_notice', 'welcome')`,
    ),
    check(
      "slack_outbox_status_check",
      sql`${table.status} IN ('pending', 'sending', 'sent', 'failed', 'uncertain')`,
    ),
    check(
      "slack_outbox_user_check",
      sql`(${table.kind} = 'notice') = (${table.slackUserId} IS NOT NULL)`,
    ),
    check(
      "slack_outbox_claim_check",
      // A claimed row stays `pending` until its send begins.
      sql`(${table.claimToken} IS NULL) = (${table.leaseExpiresAt} IS NULL) AND (${table.status} IN ('pending', 'sending') OR ${table.claimToken} IS NULL) AND (${table.status} <> 'sending' OR ${table.claimToken} IS NOT NULL)`,
    ),
    index("slack_outbox_due_idx")
      .on(table.nextAttemptAt)
      .where(sql`${table.status} = 'pending'`),
    index("slack_outbox_sending_idx")
      .on(table.leaseExpiresAt)
      .where(sql`${table.status} = 'sending'`),
    index("slack_outbox_session_idx").on(table.sessionId),
    index("slack_outbox_uncertain_idx")
      .on(table.seq)
      .where(sql`${table.status} = 'uncertain' AND ${table.kind} = 'reply'`),
  ],
);

// The name of a credential an agent may use, never its value (design 4.4,
// D11). A row is revoked, not deleted, so a later session start sees the
// binding is gone while the receipt keeps who bound it.
export const credentialBindings = pgTable(
  "credential_bindings",
  {
    id: uuid().primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    credentialRef: text("credential_ref").notNull(),
    target: text().notNull(),
    // An agent or an agent identity; the identity table comes later (M8),
    // so the target has no foreign key and the store checks it exists.
    targetId: uuid("target_id").notNull(),
    boundBy: uuid("bound_by")
      .notNull()
      .references(() => users.id),
    boundAt: timestamp("bound_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("credential_bindings_live_idx")
      .on(table.target, table.targetId, table.credentialRef)
      .where(sql`${table.revokedAt} IS NULL`),
    index("credential_bindings_ref_idx")
      .on(table.workspaceId, table.credentialRef)
      .where(sql`${table.revokedAt} IS NULL`),
    check(
      "credential_bindings_target_check",
      sql`${table.target} IN (${sql.raw(sqlList(CREDENTIAL_BINDING_TARGETS))})`,
    ),
    check(
      "credential_bindings_ref_check",
      sql`${table.credentialRef} ~ ${sql.raw(`'${CREDENTIAL_REF_PATTERN}'`)}`,
    ),
  ],
);

export const agentActivationEvents = pgTable(
  "agent_activation_events",
  {
    id: uuid().primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    agentId: uuid("agent_id")
      .notNull()
      .references((): AnyPgColumn => agents.id),
    kind: text().notNull(),
    releaseId: text("release_id")
      .notNull()
      .references(() => agentReleases.id),
    previousReleaseId: text("previous_release_id").references(
      () => agentReleases.id,
    ),
    activationRevision: integer("activation_revision"),
    actorUserId: uuid("actor_user_id")
      .notNull()
      .references(() => users.id),
    actor: jsonb(),
    receiptId: uuid("receipt_id")
      .notNull()
      .references(() => receipts.id),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("agent_activation_events_agent_idx").on(
      table.agentId,
      table.createdAt,
    ),
    check(
      "agent_activation_events_kind_check",
      sql`${table.kind} IN (${sql.raw(sqlList(AGENT_ACTIVATION_EVENT_KINDS))})`,
    ),
    check(
      "agent_activation_events_revision_check",
      sql`(${table.kind} = 'activated') = (${table.activationRevision} IS NOT NULL)`,
    ),
  ],
);

// A version of a workspace profile (94S-1001): an operator profile narrowed
// in the console. A row never changes but for its retirement; a change is
// the next version, under a new id.
export const workspaceProfiles = pgTable(
  "workspace_profiles",
  {
    id: text().primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    name: text().notNull(),
    version: integer().notNull(),
    baseProfileId: text("base_profile_id").notNull(),
    baseFingerprint: text("base_fingerprint").notNull(),
    baseRuntimeVersion: text("base_runtime_version").notNull(),
    baseBilling: text("base_billing").notNull(),
    baseRepositoryMode: text("base_repository_mode").notNull(),
    model: text().notNull(),
    models: jsonb().$type<string[]>().notNull(),
    tools: jsonb().$type<string[]>().notNull(),
    permissionMode: text("permission_mode").notNull(),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    retiredAt: timestamp("retired_at", { withTimezone: true }),
    retiredBy: uuid("retired_by").references(() => users.id),
  },
  (table) => [
    unique("workspace_profiles_version_key").on(
      table.workspaceId,
      table.name,
      table.version,
    ),
    check("workspace_profiles_id_check", sql`${table.id} LIKE 'ws\\_%'`),
    check("workspace_profiles_version_check", sql`${table.version} >= 1`),
    check(
      "workspace_profiles_permission_mode_check",
      sql`${table.permissionMode} IN (${sql.raw(sqlList(PERMISSION_MODE_VALUES))})`,
    ),
    check(
      "workspace_profiles_base_billing_check",
      sql`${table.baseBilling} IN ('metered', 'none')`,
    ),
    check(
      "workspace_profiles_base_repository_mode_check",
      sql`${table.baseRepositoryMode} IN ('required', 'optional', 'none')`,
    ),
    check(
      "workspace_profiles_retired_check",
      sql`(${table.retiredAt} IS NULL) = (${table.retiredBy} IS NULL)`,
    ),
  ],
);
