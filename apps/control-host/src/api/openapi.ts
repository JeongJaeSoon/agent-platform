import {
  type ApiErrorCode,
  acceptInviteRequestSchema,
  acceptInviteResponseSchema,
  activateAgentRequestSchema,
  activateAgentResponseSchema,
  activationCredentialUnboundDetailsSchema,
  addAgentAdminRequestSchema,
  addTeamMemberRequestSchema,
  adminTerminateSessionRequestSchema,
  agentAdminChangeResponseSchema,
  agentAdminParamsSchema,
  agentAdminsViewSchema,
  agentDetailSchema,
  agentIdentityParamsSchema,
  agentIdParamsSchema,
  apiErrorResponseSchema,
  apiKeyIdParamsSchema,
  apiRootResponseSchema,
  auditReadRequestSchema,
  auditReadResponseSchema,
  auditRetentionRequestSchema,
  auditRetentionResponseSchema,
  authMeResponseSchema,
  bootstrapRequestSchema,
  bootstrapResponseSchema,
  createAgentReleaseRequestSchema,
  createAgentReleaseResponseSchema,
  createAgentRequestSchema,
  createApiKeyRequestSchema,
  createApiKeyResponseSchema,
  createCredentialBindingRequestSchema,
  createCredentialBindingResponseSchema,
  createInviteRequestSchema,
  createInviteResponseSchema,
  createSessionRequestSchema,
  createSessionResponseSchema,
  createTeamRequestSchema,
  credentialBindingParamsSchema,
  deleteTeamResponseSchema,
  getReceiptResponseSchema,
  getSessionResponseSchema,
  getTurnResponseSchema,
  googleLoginCallbackRequestSchema,
  healthResponseSchema,
  installationLimitsResponseSchema,
  interruptSessionRequestSchema,
  inviteIdParamsSchema,
  issuePasswordResetRequestSchema,
  issuePasswordResetResponseSchema,
  linkAgentIdentityRequestSchema,
  linkAgentIdentityResponseSchema,
  linkedAccountParamsSchema,
  listAdministeredAgentsResponseSchema,
  listAdminSessionsResponseSchema,
  listAgentIdentitiesResponseSchema,
  listAgentsResponseSchema,
  listApiKeysResponseSchema,
  listCredentialBindingsResponseSchema,
  listInvitesResponseSchema,
  listLinkedAccountsResponseSchema,
  listMembersResponseSchema,
  listPendingRequestsResponseSchema,
  listProfilesResponseSchema,
  listSessionsQuerySchema,
  listSessionsResponseSchema,
  listTakeoversResponseSchema,
  listTeamsResponseSchema,
  listTurnsQuerySchema,
  listTurnsResponseSchema,
  loginMethodsResponseSchema,
  loginRequestSchema,
  loginResponseSchema,
  memberParamsSchema,
  memberUserParamsSchema,
  memberViewSchema,
  passwordResetRequestSchema,
  passwordResetResponseSchema,
  pauseSessionRequestSchema,
  postSessionAnswerRequestSchema,
  postSessionAnswerResponseSchema,
  postSessionMessageRequestSchema,
  postSessionMessageResponseSchema,
  readyResponseSchema,
  receiptAcceptedResponseSchema,
  receiptIdParamsSchema,
  recoveryDecisionRequestSchema,
  resumeSessionRequestSchema,
  revokeAgentIdentityResponseSchema,
  revokeApiKeyResponseSchema,
  revokeCredentialBindingResponseSchema,
  type SessionScope,
  sessionCredentialUnboundDetailsSchema,
  sessionDurabilitySchema,
  sessionIdParamsSchema,
  sessionShareSchema,
  sessionSummarySchema,
  sessionUsageResponseSchema,
  setAccessRequestSchema,
  setAccessResponseSchema,
  setSessionShareRequestSchema,
  setSessionShareResponseSchema,
  slackGuestRequestSchema,
  slackGuestResponseSchema,
  slackLinkCallbackRequestSchema,
  slackLinkCallbackResponseSchema,
  sseEventSchema,
  startGoogleLoginResponseSchema,
  startSlackLinkResponseSchema,
  takeOverSessionRequestSchema,
  teamChangeResponseSchema,
  teamDetailSchema,
  teamIdParamsSchema,
  teamMemberParamsSchema,
  terminateSessionRequestSchema,
  terminateSessionResponseSchema,
  turnIdParamsSchema,
  turnSummarySchema,
  updateAgentRequestSchema,
  updateMemberRequestSchema,
  updateTeamRequestSchema,
  WEB_SESSION_COOKIE_NAME,
  workspaceParamsSchema,
} from "@agent-platform/contracts";
import { createRoute, OpenAPIHono, type RouteConfig } from "@hono/zod-openapi";
import { z } from "zod";
import {
  API_INFO_DESCRIPTION,
  accessNote,
  type ErrorContext,
  errorResponseDescription,
  IDEMPOTENCY_KEY_DESCRIPTION,
  LAST_EVENT_ID_DESCRIPTION,
  RESPONSE_HEADERS,
  SECURITY_SCHEME_DESCRIPTIONS,
} from "./openapi-docs.ts";

const OPENAPI_VERSION = "0.1.0-alpha";

const openApiDocumentResponseSchema = z.looseObject({
  openapi: z.literal("3.1.0"),
});

// Request schemas are rendered as input (defaults optional); responses as output.
const requestComponents = {
  CreateSessionRequest: createSessionRequestSchema,
  ListSessionsQuery: listSessionsQuerySchema,
  PostSessionMessageRequest: postSessionMessageRequestSchema,
  ListTurnsQuery: listTurnsQuerySchema,
  PostSessionAnswerRequest: postSessionAnswerRequestSchema,
  PostSessionAnswerResponse: postSessionAnswerResponseSchema,
  InterruptSessionRequest: interruptSessionRequestSchema,
  PauseSessionRequest: pauseSessionRequestSchema,
  TerminateSessionRequest: terminateSessionRequestSchema,
  ResumeSessionRequest: resumeSessionRequestSchema,
  RecoveryDecisionRequest: recoveryDecisionRequestSchema,
  BootstrapRequest: bootstrapRequestSchema,
  LoginRequest: loginRequestSchema,
  PasswordResetRequest: passwordResetRequestSchema,
  SlackLinkCallbackRequest: slackLinkCallbackRequestSchema,
  CreateInviteRequest: createInviteRequestSchema,
  AcceptInviteRequest: acceptInviteRequestSchema,
  UpdateMemberRequest: updateMemberRequestSchema,
  SetAccessRequest: setAccessRequestSchema,
  GoogleLoginCallbackRequest: googleLoginCallbackRequestSchema,
  AuditRetentionRequest: auditRetentionRequestSchema,
  SlackGuestRequest: slackGuestRequestSchema,
  CreateAgentRequest: createAgentRequestSchema,
  UpdateAgentRequest: updateAgentRequestSchema,
  CreateAgentReleaseRequest: createAgentReleaseRequestSchema,
  ActivateAgentRequest: activateAgentRequestSchema,
  CreateApiKeyRequest: createApiKeyRequestSchema,
  CreateTeamRequest: createTeamRequestSchema,
  SetSessionShareRequest: setSessionShareRequestSchema,
  AuditReadRequest: auditReadRequestSchema,
  AdminTerminateSessionRequest: adminTerminateSessionRequestSchema,
  TakeOverSessionRequest: takeOverSessionRequestSchema,
  UpdateTeamRequest: updateTeamRequestSchema,
  AddTeamMemberRequest: addTeamMemberRequestSchema,
  AddAgentAdminRequest: addAgentAdminRequestSchema,
  LinkAgentIdentityRequest: linkAgentIdentityRequestSchema,
} satisfies Record<string, z.ZodType>;
const responseComponents = {
  ApiErrorResponse: apiErrorResponseSchema,
  ApiRootResponse: apiRootResponseSchema,
  HealthResponse: healthResponseSchema,
  ReadyResponse: readyResponseSchema,
  CreateSessionResponse: createSessionResponseSchema,
  ListSessionsResponse: listSessionsResponseSchema,
  SessionSummary: sessionSummarySchema,
  SessionDetail: getSessionResponseSchema,
  SessionDurability: sessionDurabilitySchema,
  PostSessionMessageResponse: postSessionMessageResponseSchema,
  ListTurnsResponse: listTurnsResponseSchema,
  TurnSummary: turnSummarySchema,
  TurnDetail: getTurnResponseSchema,
  SseEvent: sseEventSchema,
  ListPendingRequestsResponse: listPendingRequestsResponseSchema,
  ListTakeoversResponse: listTakeoversResponseSchema,
  SessionShare: sessionShareSchema,
  SetSessionShareResponse: setSessionShareResponseSchema,
  AuditReadResponse: auditReadResponseSchema,
  ListAdminSessionsResponse: listAdminSessionsResponseSchema,
  StartSlackLinkResponse: startSlackLinkResponseSchema,
  SlackLinkCallbackResponse: slackLinkCallbackResponseSchema,
  ListLinkedAccountsResponse: listLinkedAccountsResponseSchema,
  CreateInviteResponse: createInviteResponseSchema,
  ListInvitesResponse: listInvitesResponseSchema,
  AcceptInviteResponse: acceptInviteResponseSchema,
  ListMembersResponse: listMembersResponseSchema,
  MemberView: memberViewSchema,
  SetAccessResponse: setAccessResponseSchema,
  ReceiptAcceptedResponse: receiptAcceptedResponseSchema,
  TerminateSessionResponse: terminateSessionResponseSchema,
  Receipt: getReceiptResponseSchema,
  BootstrapResponse: bootstrapResponseSchema,
  LoginResponse: loginResponseSchema,
  LoginMethodsResponse: loginMethodsResponseSchema,
  StartGoogleLoginResponse: startGoogleLoginResponseSchema,
  IssuePasswordResetRequest: issuePasswordResetRequestSchema,
  IssuePasswordResetResponse: issuePasswordResetResponseSchema,
  AuditRetentionResponse: auditRetentionResponseSchema,
  SlackGuestResponse: slackGuestResponseSchema,
  PasswordResetResponse: passwordResetResponseSchema,
  AuthMeResponse: authMeResponseSchema,
  InstallationLimitsResponse: installationLimitsResponseSchema,
  SessionUsageResponse: sessionUsageResponseSchema,
  ListAgentsResponse: listAgentsResponseSchema,
  ListProfilesResponse: listProfilesResponseSchema,
  AgentDetail: agentDetailSchema,
  CreateAgentReleaseResponse: createAgentReleaseResponseSchema,
  ActivateAgentResponse: activateAgentResponseSchema,
  SessionCredentialUnboundDetails: sessionCredentialUnboundDetailsSchema,
  ActivationCredentialUnboundDetails: activationCredentialUnboundDetailsSchema,
  CreateApiKeyResponse: createApiKeyResponseSchema,
  ListApiKeysResponse: listApiKeysResponseSchema,
  RevokeApiKeyResponse: revokeApiKeyResponseSchema,
  ListTeamsResponse: listTeamsResponseSchema,
  TeamDetail: teamDetailSchema,
  TeamChangeResponse: teamChangeResponseSchema,
  DeleteTeamResponse: deleteTeamResponseSchema,
  AgentAdmins: agentAdminsViewSchema,
  AgentAdminChangeResponse: agentAdminChangeResponseSchema,
  ListAdministeredAgentsResponse: listAdministeredAgentsResponseSchema,
  CreateCredentialBindingRequest: createCredentialBindingRequestSchema,
  CreateCredentialBindingResponse: createCredentialBindingResponseSchema,
  ListCredentialBindingsResponse: listCredentialBindingsResponseSchema,
  RevokeCredentialBindingResponse: revokeCredentialBindingResponseSchema,
  LinkAgentIdentityResponse: linkAgentIdentityResponseSchema,
  ListAgentIdentitiesResponse: listAgentIdentitiesResponseSchema,
  RevokeAgentIdentityResponse: revokeAgentIdentityResponseSchema,
  OpenApiDocument: openApiDocumentResponseSchema,
} satisfies Record<string, z.ZodType>;

export const OPENAPI_TAGS = [
  {
    name: "Health",
    description: "Check process health, readiness and API metadata.",
  },
  {
    name: "Auth",
    description: "Discover the API and manage authenticated browser sessions.",
  },
  {
    name: "Sessions",
    description: "Create sessions and inspect their state and usage.",
  },
  {
    name: "Messages & turns",
    description: "Send session input and inspect turn history and results.",
  },
  {
    name: "Events",
    description: "Stream durable session events.",
  },
  {
    name: "Pending requests",
    description: "List and answer pending permission and question requests.",
  },
  {
    name: "Session control",
    description: "Stop, pause, resume or interrupt a session's execution.",
  },
  {
    name: "Recovery",
    description: "Resolve sessions that require an operator recovery decision.",
  },
  {
    name: "Members",
    description:
      "Invite people, change member roles and take over the sessions of members who were offboarded. Owners and admins, from a browser session; only an owner grants or changes the owner role.",
  },
  {
    name: "Teams",
    description:
      "Group people into teams; a team named an agent's admin makes every member of it one. Owners and admins change teams, from a browser session. A person added joins at once, without accepting.",
  },
  {
    name: "Workspace settings",
    description: "Change workspace-wide settings. Owners only.",
  },
  {
    name: "Agents",
    description:
      "Write agent cards, release a version against a runtime profile, activate a release and bind the credential names it runs with. Owners, admins, and each agent's own admins.",
  },
  {
    name: "Linked accounts",
    description:
      "Link and unlink the caller's own Slack account through Sign in with Slack.",
  },
  {
    name: "API keys",
    description:
      "Issue and revoke keys, never above what the issuer holds. Signed-in people only.",
  },
  {
    name: "Limits & receipts",
    description:
      "Inspect installation limits and asynchronous command receipts.",
  },
] as const;

type ComponentName =
  | keyof typeof requestComponents
  | keyof typeof responseComponents;

type ApiTagName = (typeof OPENAPI_TAGS)[number]["name"];

export type RouteDeclaration = {
  method: "get" | "post" | "patch" | "delete";
  path: string;
  operationId: string;
  tag: ApiTagName;
  summary: string;
  description?: string;
  scope?: "read" | "write" | "approve" | "control" | "recover";
  // Who may call: `scope` routes take an API key or a cookie session,
  // `auth: "session"` routes only a cookie session, `auth: "public"` routes
  // sit outside the auth middleware (03 §3.2 allowlist). Default: scope
  // present → both credentials; absent → public probe.
  auth?: "public" | "session";
  // A public route that sets the session cookie needs the CSRF header from
  // every caller (login CSRF), not only from cookie principals.
  csrf?: "always";
  query?: ComponentName;
  body?: ComponentName;
  // Parsed with the body schema by openapi.test.ts.
  requestExample?: unknown;
  success:
    | {
        status: 200 | 201 | 202;
        schema: ComponentName;
        sse?: boolean;
        description?: string;
        // Parsed with `schema` by openapi.test.ts.
        example?: unknown;
      }
    | { status: 204; description?: string };
  errors: number[];
  errorCodes?: Partial<Record<number, readonly ApiErrorCode[]>>;
  // Appended to ERROR_CODE_WHEN's sentence where a code is narrower here.
  errorNotes?: Partial<Record<ApiErrorCode, string>>;
  lastEventId?: boolean;
  // Most POSTs are commands and take Idempotency-Key; auth endpoints do not.
  idempotent?: false;
};

const CONFLICTS = [400, 401, 404, 409];

const COMMON_ERROR_CODES: Partial<Record<number, readonly ApiErrorCode[]>> = {
  400: ["BAD_REQUEST"],
  401: ["UNAUTHORIZED"],
  403: ["FORBIDDEN"],
  404: ["NOT_FOUND"],
  408: ["REQUEST_TIMEOUT"],
  410: ["CURSOR_EXPIRED"],
  413: ["PAYLOAD_TOO_LARGE"],
  422: ["UNSUPPORTED_CAPABILITY"],
  429: ["RATE_LIMITED"],
  500: ["INTERNAL_ERROR"],
  503: ["BACKEND_UNAVAILABLE"],
};

// Example values shared across declarations, so the examples read as one
// session's story.
const EXAMPLE_SESSION_ID = "0f8b6a52-3d1e-4c7a-9b2f-5e6d7c8a9b01";
const EXAMPLE_RECEIPT_ID = "c4a1e9d2-7b3f-4e8a-a6c5-1d2e3f4a5b6c";
const EXAMPLE_USER_ID = "3e7f1a90-5c2d-4b8e-8f61-2a9d0c4b7e35";
const EXAMPLE_WORKSPACE = {
  id: "9d2c4e61-8a3b-4f70-b1e5-6c0a7d3f2b98",
  slug: "acme",
  name: "Acme",
  settings: {
    dispatch_model: null,
    kill_switch: false,
    daily_cost_limit_usd: null,
    idle_pause_minutes: 30,
    audit_retention_days: 90,
    slack_guest_enabled: false,
  },
  created_at: "2026-10-01T09:00:00Z",
};
const ALL_SCOPES = [
  "sessions:read",
  "sessions:write",
  "sessions:approve",
  "sessions:control",
  "sessions:recover",
];
const EXAMPLE_SESSION_SUMMARY = {
  id: EXAMPLE_SESSION_ID,
  revision: 7,
  admission_state: "active",
  status: "running",
  runtime: {
    kind: "claude_agent_sdk",
    version: "0.2.1",
    profile_id: "claude-coding-real",
  },
  repository_id: "sample-app",
  current_turn_id: "3",
  queued_turn_count: 1,
  last_event_at: "2026-10-11T08:15:42Z",
  created_at: "2026-10-11T08:00:00Z",
  updated_at: "2026-10-11T08:15:40Z",
};
const EXAMPLE_TURN_SUMMARY = {
  turn_id: "1",
  session_id: EXAMPLE_SESSION_ID,
  status: "completed",
  message: "Add a health check endpoint and a test for it.",
  terminal_reason: null,
  checkpoint_revision: 2,
  created_at: "2026-10-11T08:00:00Z",
  started_at: "2026-10-11T08:00:05Z",
  ended_at: "2026-10-11T08:03:12Z",
};
const ACCEPTED_RECEIPT = {
  receipt_id: EXAMPLE_RECEIPT_ID,
  receipt_status: "accepted",
};
const RESERVED_HERE =
  "Reserved: this operation does not currently return it, because it accepts a session in that state.";

export const API_ROUTE_DECLARATIONS = [
  {
    method: "get",
    path: "/healthz",
    operationId: "getHealth",
    tag: "Health",
    summary: "Process liveness",
    description:
      "Answers 200 while the process serves HTTP; it checks nothing else, not even the database. Use it as a liveness probe, and `/readyz` to decide whether to send traffic.",
    success: {
      status: 200,
      schema: "HealthResponse",
      description: "The process is up.",
      example: { status: "ok" },
    },
    errors: [],
  },
  {
    method: "get",
    path: "/readyz",
    operationId: "getReady",
    tag: "Health",
    summary: "DB, schema and config readiness",
    description:
      "Runs the readiness checks in order and stops at the first failure: `database` (the database answers), `schema` (the applied migrations include every migration of this build) and `config` (required settings and limits are valid). Use it as a readiness probe: a 503 means do not route traffic here. The execution backend is not checked. From the moment the process starts shutting down it answers 503 too.",
    success: {
      status: 200,
      schema: "ReadyResponse",
      description: "Every check passed.",
      example: {
        status: "ready",
        checks: { database: "ok", schema: "ok", config: "ok" },
      },
    },
    errors: [503],
    errorCodes: { 503: ["NOT_READY"] },
  },
  {
    method: "get",
    path: "/v1/openapi.json",
    operationId: "getOpenApiDocument",
    tag: "Health",
    summary: "Generated OpenAPI document",
    description:
      "This document as JSON, the same content as `docs/openapi.json` in the repository.",
    auth: "public",
    success: {
      status: 200,
      schema: "OpenApiDocument",
      description: "The OpenAPI 3.1 document.",
      example: {
        openapi: "3.1.0",
        info: { title: "Agent Platform API", version: OPENAPI_VERSION },
      },
    },
    errors: [],
  },
  {
    method: "get",
    path: "/v1",
    operationId: "getApiRoot",
    tag: "Auth",
    summary: "Check a credential and return its owner",
    description:
      "Checks a credential: answers 200 with the owner it authenticates as, or 401. It changes nothing; use it to test an API key before other calls.",
    scope: "read",
    success: {
      status: 200,
      schema: "ApiRootResponse",
      description: "The credential is valid.",
      example: {
        status: "ok",
        owner_id: "7b0e5c1e-2f4a-4d7e-9a51-3c6f0b8d2e14",
      },
    },
    errors: [401, 503],
  },
  {
    method: "post",
    path: "/v1/auth/bootstrap",
    operationId: "bootstrap",
    tag: "Auth",
    summary:
      "Create the first owner and default workspace, or recover an owner",
    description:
      "Allowed only while no live owner exists (an owner whose account or membership is disabled is not live). On an installation that already has users it adds or restores the owner in the existing workspace, ignores workspace_name and workspace_slug, revokes every web session in the workspace and writes a `recover_owner` receipt. Each BOOTSTRAP_TOKEN works once per installation; a token presented while a live owner exists is spent. A wrong or spent token answers 401 before the owner state is looked at.",
    auth: "public",
    body: "BootstrapRequest",
    requestExample: {
      bootstrap_token: "bt_4f9c2a7e1d8b6c3a5e0f9d2b7c4a1e8f6d3b0c9a",
      email: "owner@example.com",
      password: "correct horse battery staple",
      display_name: "Ada Owner",
      workspace_name: "Acme",
      workspace_slug: "acme",
    },
    success: {
      status: 201,
      schema: "BootstrapResponse",
      description:
        "The owner, the workspace and the membership are created, or the owner is restored in the existing workspace.",
      example: {
        user_id: EXAMPLE_USER_ID,
        workspace: EXAMPLE_WORKSPACE,
        role: "owner",
      },
    },
    errors: [400, 401, 409, 413, 503],
    errorCodes: { 409: ["BOOTSTRAP_DONE"] },
    errorNotes: {
      UNAUTHORIZED:
        "`bootstrap_token` is missing, does not match the installation's token, or was already used; checked first, before the owner state and the rest of the body.",
      BOOTSTRAP_DONE:
        "A live owner exists, checked only after the token matched (the token is then spent); also the answer to the loser of two concurrent bootstraps.",
    },
    idempotent: false,
  },
  {
    method: "get",
    path: "/v1/auth/login-methods",
    operationId: "listLoginMethods",
    tag: "Auth",
    summary: "How a person can sign in on this installation",
    description:
      "`password` always; `google` when Google sign-in is configured. The login page offers these.",
    auth: "public",
    success: { status: 200, schema: "LoginMethodsResponse" },
    errors: [],
  },
  {
    method: "post",
    path: "/v1/auth/login",
    operationId: "login",
    tag: "Auth",
    summary: "Email/password login; sets the session cookie",
    description:
      "Checks an email and password and starts a browser session: the response sets the `__Host-ap_session` cookie (HttpOnly, Secure, SameSite=Lax) for 14 days, and the expiry slides forward while the session is used. A user keeps at most 10 live sessions; a new login drops the oldest. This is for the web app; scripts and servers use an API key.",
    auth: "public",
    csrf: "always",
    body: "LoginRequest",
    requestExample: {
      email: "owner@example.com",
      password: "correct horse battery staple",
    },
    success: {
      status: 200,
      schema: "LoginResponse",
      description:
        "Signed in; the response sets the session cookie. `scopes` are the ones the workspace role holds.",
      example: {
        user_id: EXAMPLE_USER_ID,
        workspace_id: EXAMPLE_WORKSPACE.id,
        role: "owner",
        scopes: ALL_SCOPES,
        expires_at: "2026-10-25T09:00:00Z",
      },
    },
    errors: [400, 401, 403, 413, 429, 503],
    errorNotes: {
      UNAUTHORIZED:
        "Unknown email, wrong password, or a user with no live workspace membership.",
      RATE_LIMITED:
        "Five failed logins for this email within 15 minutes lock it until the window ends (`Retry-After` is the time left), or too many logins are being checked at once (`Retry-After: 1`).",
    },
    idempotent: false,
  },
  {
    method: "post",
    path: "/v1/auth/google/start",
    operationId: "startGoogleLogin",
    tag: "Auth",
    summary: "Begin Google sign-in; answers the Google URL to open",
    description:
      "Sets a short-lived cookie that binds the flow (state, nonce, PKCE verifier) to this browser. 404 when Google sign-in is not configured.",
    auth: "public",
    csrf: "always",
    success: { status: 200, schema: "StartGoogleLoginResponse" },
    errors: [403, 404, 503],
    idempotent: false,
  },
  {
    method: "post",
    path: "/v1/auth/google/callback",
    operationId: "googleLoginCallback",
    tag: "Auth",
    summary: "Finish Google sign-in; sets the session cookie",
    description:
      "Posts the `code` and `state` Google returned to the redirect URI. The first matching rule decides: an already linked Google account signs in as its user; an address that already has an account answers 409 LOGIN_LINK_REQUIRED and is never joined by email; otherwise a live invite for the address, or JIT for an allowed domain, creates the account. Anything else answers 401 without saying whether an account exists. A Google account outside the allowed domains answers 403.",
    auth: "public",
    csrf: "always",
    body: "GoogleLoginCallbackRequest",
    success: { status: 200, schema: "LoginResponse" },
    errors: [400, 401, 403, 404, 409, 413, 503],
    errorCodes: { 409: ["LOGIN_LINK_REQUIRED"] },
    idempotent: false,
  },
  {
    method: "post",
    path: "/v1/auth/password-reset",
    operationId: "resetPassword",
    tag: "Auth",
    summary: "Set a new password with a one-time reset link",
    description:
      "Spends the token, sets the password, revokes every live web session of the user and writes a `reset_password` receipt. There is no failure window: the token cannot be guessed, and a shared one would let anyone lock recovery out. Password hashing shares login's concurrency limit, past which it answers 429.",
    auth: "public",
    body: "PasswordResetRequest",
    success: { status: 200, schema: "PasswordResetResponse" },
    errors: [400, 401, 413, 429, 503],
    idempotent: false,
  },
  {
    method: "post",
    path: "/v1/workspaces/{id}/members/{userId}/password-reset",
    operationId: "issuePasswordReset",
    tag: "Auth",
    summary: "Issue a one-time password reset link for a member (owner only)",
    description:
      "Requires the issuer's current password, counted against the issuer's login failure window. An owner cannot issue a link for themselves, nor for a member who owns another workspace. The token is returned once and expires in one hour; issuing another revokes the member's open link. Writes an `issue_password_reset` receipt whose result names the target's role.",
    auth: "session",
    body: "IssuePasswordResetRequest",
    success: { status: 201, schema: "IssuePasswordResetResponse" },
    errors: [400, 401, 403, 404, 413, 429, 503],
    idempotent: false,
  },
  {
    method: "post",
    path: "/v1/workspaces/{id}/audit-retention",
    operationId: "setAuditRetention",
    tag: "Workspace settings",
    summary: "Set how many days authorization decisions are kept (owner only)",
    description:
      "At least 30 days; the default is 90. Rows older than this are deleted by the reconciler. The current value is `workspace.settings.audit_retention_days` in GET /v1/auth/me.",
    auth: "session",
    body: "AuditRetentionRequest",
    success: { status: 200, schema: "AuditRetentionResponse" },
    errors: [400, 401, 403, 404, 413, 503],
    idempotent: false,
  },
  {
    method: "post",
    path: "/v1/workspaces/{id}/slack-guest",
    operationId: "setSlackGuest",
    tag: "Workspace settings",
    summary: "Let Slack guests call agents, or stop them (owner or admin)",
    description:
      "Off by default. While off, a Slack guest (`is_restricted`) who calls an agent is refused with `guest_disabled`; while on, a guest still has to link their Slack account. Slack Connect users from other organizations are refused either way. An app with Slack's agent features on is closed to guests by Slack itself. The current value is `workspace.settings.slack_guest_enabled` in GET /v1/auth/me.",
    auth: "session",
    body: "SlackGuestRequest",
    success: { status: 200, schema: "SlackGuestResponse" },
    errors: [400, 401, 403, 404, 413, 503],
    idempotent: false,
  },
  {
    method: "post",
    path: "/v1/auth/logout",
    operationId: "logout",
    tag: "Auth",
    summary: "Revoke the session cookie",
    description:
      "Revokes the cookie session that sent the request and clears the cookie. The user's other sessions stay signed in.",
    auth: "session",
    success: {
      status: 204,
      description: "The session is revoked and the cookie cleared.",
    },
    errors: [401, 403, 503],
    errorNotes: {
      FORBIDDEN: "Also when the caller is not a cookie session (an API key).",
    },
    idempotent: false,
  },
  {
    method: "get",
    path: "/v1/auth/me",
    operationId: "getAuthMe",
    tag: "Auth",
    summary: "The authenticated principal, user and workspace",
    description:
      "Says who the credential authenticates as and what it may do: the principal with its scopes, the workspace, and for a cookie session the user and the management actions its role holds (`permissions`). An API key has no user, so `user` is null and `permissions` is empty; `workspace` is the key's workspace, or null for a legacy key that predates workspaces. The web app boots from this. It changes nothing.",
    scope: "read",
    success: {
      status: 200,
      schema: "AuthMeResponse",
      description: "The authenticated principal; `scopes` is what it may do.",
      example: {
        principal: {
          kind: "user",
          id: EXAMPLE_USER_ID,
          workspace_id: EXAMPLE_WORKSPACE.id,
          role: "owner",
          scopes: ALL_SCOPES,
        },
        user: {
          id: EXAMPLE_USER_ID,
          email: "owner@example.com",
          display_name: "Ada Owner",
        },
        workspace: EXAMPLE_WORKSPACE,
        scopes: ALL_SCOPES,
        permissions: [
          "workspace.manage",
          "audit_retention.manage",
          "member.manage",
          "team.manage",
          "api_key.manage",
          "api_key.manage_own",
          "account.link",
          "agent.create",
          "agent.manage",
          "agent.restore",
          "agent.admin.manage",
          "credential.bind",
          "binding.manage",
          "session.audit_read",
          "session.admin_list",
        ],
      },
    },
    errors: [401, 503],
    errorNotes: {
      UNAUTHORIZED: "Also when the session's workspace no longer exists.",
    },
  },
  {
    method: "post",
    path: "/v1/sessions",
    operationId: "createSession",
    tag: "Sessions",
    summary: "Durably accept a session and its first input",
    description:
      "Creates a session for a catalog profile and repository and queues `message` as turn `1`. The 201 means the input is stored, not that it ran: follow the turn with `GET /v1/sessions/{id}/turns/{turn_id}` or the event stream. A session waits in `queued` while no execution slot is free; it is never refused for that. `agent_release_id` pins the session to that release of an agent, so a key bound to the agent may create it; `profile_id` must be the release's runtime profile (409 RELEASE_PROFILE_MISMATCH). The run itself follows `profile_id`. Every credential the release names must still be bound to its agent; otherwise 409 CREDENTIAL_UNBOUND, whose `details` carry the guidance to show the requester and the agent's admins to ask (`SessionCredentialUnboundDetails`), never the missing names. The receipt settles with turn `1`: `succeeded` when it completes, `failed` when it fails or is interrupted or cancelled, `unknown` when its outcome is unknown.",
    scope: "write",
    body: "CreateSessionRequest",
    requestExample: {
      profile_id: "claude-coding-real",
      repository_id: "sample-app",
      message: "Add a health check endpoint and a test for it.",
    },
    success: {
      status: 201,
      schema: "CreateSessionResponse",
      description:
        "The session and its first turn are stored; `receipt_id` tracks the acceptance.",
      example: {
        session_id: EXAMPLE_SESSION_ID,
        turn_id: "1",
        receipt_id: EXAMPLE_RECEIPT_ID,
        receipt_status: "accepted",
        status: "queued",
      },
    },
    errors: [400, 401, 404, 409, 413, 422, 429, 503],
    errorCodes: {
      409: [
        "IDEMPOTENCY_CONFLICT",
        "RELEASE_PROFILE_MISMATCH",
        "PROFILE_DIGEST_MISMATCH",
        "CREDENTIAL_UNBOUND",
      ],
      413: ["PAYLOAD_TOO_LARGE", "STORAGE_LIMIT_EXCEEDED"],
    },
    errorNotes: {
      UNSUPPORTED_CAPABILITY:
        "`profile_id` or `repository_id` is not in the catalog, or the catalog does not allow the pair.",
      RATE_LIMITED:
        "Reserved here: the per-session input queue limit applies to later messages, not to the first, so this operation does not currently return it.",
    },
  },
  {
    method: "get",
    path: "/v1/sessions",
    operationId: "listSessions",
    tag: "Sessions",
    summary: "List the owner's sessions, newest first",
    description:
      "Lists the sessions of the credential's owner, newest `created_at` first, closed ones included, `limit` per page (default 50, at most 100). Pass `next_cursor` back as `cursor` for the next page; it is null on the last one. `status` keeps only sessions reporting that status, `needs_input` included. It changes nothing.",
    scope: "read",
    query: "ListSessionsQuery",
    success: {
      status: 200,
      schema: "ListSessionsResponse",
      description: "One page of session summaries.",
      example: {
        items: [EXAMPLE_SESSION_SUMMARY],
        next_cursor: null,
      },
    },
    errors: [400, 401, 503],
  },
  {
    method: "get",
    path: "/v1/sessions/{id}",
    operationId: "getSession",
    tag: "Sessions",
    summary: "Session detail with projection, execution and durability",
    description:
      "Reads one session: its `admission_state` (whether it takes input and controls: `active`, `pausing`, `paused`, `resuming`, `stopping`, `stopped`, `recovery_required`, `closed`), its `status`, the current `revision`, the execution as last observed, the number of pending requests, `attention` (why the session is held or slowed, if it is) and checkpoint `durability`. Read `revision` here and send it as `expected_revision` to pause, resume, terminate or decide recovery. `status: needs_input` and `attention` are computed on each read; reading changes nothing.",
    scope: "read",
    success: {
      status: 200,
      schema: "SessionDetail",
      description: "The session as it stands now.",
      example: {
        ...EXAMPLE_SESSION_SUMMARY,
        execution: {
          backend: "local_docker",
          state: "running",
          observed_at: "2026-10-11T08:15:38Z",
        },
        checkpoint_revision: 2,
        pending_request_count: 0,
        attention: null,
        durability: {
          last_transcript_persisted_at: "2026-10-11T08:15:41Z",
          checkpoint_committed_at: "2026-10-11T08:10:02Z",
          checkpoint_revision: 2,
          last_completed_turn_id: "2",
          last_checkpointed_turn_id: "2",
          checkpoint_pending_reason: null,
          checkpoint_fallback_revision: null,
          context_reset_turn_id: null,
        },
      },
    },
    errors: [401, 404, 503],
  },
  {
    method: "get",
    path: "/v1/sessions/{id}/share",
    operationId: "getSessionShare",
    tag: "Sessions",
    summary: "Who sees the session",
    description:
      "Readable by whoever sees the session. A session never re-shared reads `workspace` at revision 0.",
    scope: "read",
    success: { status: 200, schema: "SessionShare" },
    errors: [401, 404, 503],
  },
  {
    method: "post",
    path: "/v1/sessions/{id}/share",
    operationId: "setSessionShare",
    tag: "Sessions",
    summary: "Change who sees the session",
    description:
      "`private` is the creator alone; `people` and `team` add the people or the current members of the teams named; `workspace` is every member. A person's session is changed only by its creator; a session an API key made, by owners, admins and the admins of its agent. Anyone else the session is visible to gets 403; anyone it is not visible to, 404. Open event streams that may no longer see the session end. Writes a `share_session` receipt unless the share was already as asked (`receipt_id` null).",
    auth: "session",
    body: "SetSessionShareRequest",
    success: { status: 200, schema: "SetSessionShareResponse" },
    errors: [400, 401, 403, 404, 409, 413, 503],
    errorCodes: { 409: ["REVISION_CONFLICT"] },
    idempotent: false,
  },
  {
    method: "post",
    path: "/v1/sessions/{id}/audit-read",
    operationId: "auditReadSession",
    tag: "Sessions",
    summary: "Read a session outside its share, with a reason",
    description:
      "Owners and admins. The session detail and a page of its turns, whatever the share; nothing on the session changes and no other action is opened by it. Every read is recorded with its `justification`.",
    auth: "session",
    body: "AuditReadRequest",
    success: { status: 200, schema: "AuditReadResponse" },
    errors: [400, 401, 403, 404, 413, 503],
    idempotent: false,
  },
  {
    method: "get",
    path: "/v1/admin/sessions",
    operationId: "listAdminSessions",
    tag: "Sessions",
    summary: "Every session of the workspace, metadata only",
    description:
      "Owners and admins. Who made each session, its agent release, state and share scope, newest first; no content, title or summary.",
    auth: "session",
    success: { status: 200, schema: "ListAdminSessionsResponse" },
    errors: [401, 403, 503],
  },
  {
    method: "post",
    path: "/v1/admin/sessions/{id}/terminate",
    operationId: "adminTerminateSession",
    tag: "Session control",
    summary: "Stop any session of the workspace, with a reason",
    description:
      "Owners and admins, whatever the session's share. The `justification` is recorded with the decision and becomes the stop reason. Otherwise as `POST /v1/sessions/{id}/terminate`.",
    auth: "session",
    body: "AdminTerminateSessionRequest",
    success: { status: 202, schema: "TerminateSessionResponse" },
    errors: [...CONFLICTS, 403, 413, 422, 503],
    errorCodes: {
      409: [
        "IDEMPOTENCY_CONFLICT",
        "REVISION_CONFLICT",
        "SESSION_PAUSED",
        "SESSION_RESUMING",
        "SESSION_STOPPED",
        "RECOVERY_REQUIRED",
        "SESSION_CLOSED",
      ],
    },
  },
  {
    method: "post",
    path: "/v1/admin/sessions/{id}/recovery-decisions",
    operationId: "adminDecideSessionRecovery",
    tag: "Recovery",
    summary: "Decide recovery for any session of the workspace",
    description:
      "Owners only, whatever the session's share. The decision's `reason` is the justification, recorded with the decision. Otherwise as `POST /v1/sessions/{id}/recovery-decisions`.",
    auth: "session",
    body: "RecoveryDecisionRequest",
    success: { status: 202, schema: "ReceiptAcceptedResponse" },
    errors: [...CONFLICTS, 403, 413, 422, 503],
    errorCodes: {
      409: [
        "IDEMPOTENCY_CONFLICT",
        "REVISION_CONFLICT",
        "REQUEST_STALE",
        "SESSION_PAUSED",
        "SESSION_RESUMING",
        "SESSION_STOPPED",
        "RECOVERY_REQUIRED",
        "SESSION_CLOSED",
        "CHECKPOINT_UNAVAILABLE",
      ],
    },
  },
  {
    method: "get",
    path: "/v1/sessions/{id}/usage",
    operationId: "getSessionUsage",
    tag: "Sessions",
    summary: "Estimated cost of a session and whether every turn reported it",
    description:
      "Reads the session's estimated provider cost and token count over its lifetime, its cost and token limits, and its queued input against the per-session limit. The cost is the platform's estimate from the model calls it saw, not a bill. `cost.complete: false` means a turn is still open or ended without reporting, so the true total is unknown; do not read it as zero. `budget_exceeded: true` means either limit is reached: no new turn is dispatched, but input is still accepted and queued. It changes nothing.",
    scope: "read",
    success: {
      status: 200,
      schema: "SessionUsageResponse",
      description: "The session's usage as of `refreshed_at`.",
      example: {
        session_id: EXAMPLE_SESSION_ID,
        period: "session_lifetime",
        refreshed_at: "2026-10-11T08:15:43Z",
        cost: {
          amount_usd: "0.4231",
          kind: "estimated",
          source: "provider_usage",
          completeness_scope: "turn_reports",
          complete: false,
          reported_turn_count: 2,
          unreported_turn_count: 0,
          open_turn_count: 1,
        },
        cost_limit_usd: "20",
        token_count: 182450,
        token_limit: null,
        budget_exceeded: false,
        queued_input_count: 1,
        queued_input_limit: 20,
      },
    },
    errors: [401, 404, 503],
  },
  {
    method: "post",
    path: "/v1/sessions/{id}/messages",
    operationId: "appendSessionMessage",
    tag: "Messages & turns",
    summary: "Enqueue the next input after the current turn",
    description:
      "Queues `message` as the session's next turn in the same engine conversation, after every turn already queued. Only an `active` session takes input; the other admission states answer the 409 codes below. The 202 means the input is stored under a new sequential `turn_id`, not that it ran: follow the turn with `GET /v1/sessions/{id}/turns/{turn_id}` or on the event stream. A session over its budget still queues input but runs no new turn (`attention.code: BUDGET_EXCEEDED`). The receipt settles with the turn: `succeeded` when it completes, `failed` when it fails or is interrupted or cancelled, `unknown` when its outcome is unknown.",
    scope: "write",
    body: "PostSessionMessageRequest",
    requestExample: { message: "Now add the endpoint to the README." },
    success: {
      status: 202,
      schema: "PostSessionMessageResponse",
      description: "The input is stored as a queued turn.",
      example: {
        turn_id: "4",
        receipt_id: EXAMPLE_RECEIPT_ID,
        receipt_status: "accepted",
      },
    },
    errors: [400, 401, 404, 409, 413, 429, 503],
    errorCodes: {
      409: [
        "IDEMPOTENCY_CONFLICT",
        "SESSION_PAUSED",
        "SESSION_RESUMING",
        "SESSION_STOPPED",
        "RECOVERY_REQUIRED",
        "SESSION_CLOSED",
        "CHECKPOINT_UNAVAILABLE",
        "TAKEOVER_REQUIRED",
      ],
      413: ["PAYLOAD_TOO_LARGE", "STORAGE_LIMIT_EXCEEDED"],
    },
    errorNotes: {
      RATE_LIMITED:
        "The session already holds the installation's maximum of queued inputs; `Retry-After` is 5.",
      CHECKPOINT_UNAVAILABLE:
        "A pending checkpoint problem holds new work, so a new turn could not be checkpointed; `message` names it.",
    },
  },
  {
    method: "get",
    path: "/v1/sessions/{id}/turns",
    operationId: "listSessionTurns",
    tag: "Messages & turns",
    summary: "Queued and finished turns",
    description:
      "Lists the session's turns oldest first, in `turn_id` order: queued, running and finished, `limit` per page (default 50, at most 100). Pass `next_cursor` back as `cursor` for the next page; it is null on the last one. Items are summaries; read one turn for its result, usage and attempts. It changes nothing.",
    scope: "read",
    query: "ListTurnsQuery",
    success: {
      status: 200,
      schema: "ListTurnsResponse",
      description: "One page of turn summaries.",
      example: {
        items: [
          EXAMPLE_TURN_SUMMARY,
          {
            ...EXAMPLE_TURN_SUMMARY,
            turn_id: "2",
            status: "running",
            message: "Now add the endpoint to the README.",
            checkpoint_revision: null,
            created_at: "2026-10-11T08:14:00Z",
            started_at: "2026-10-11T08:14:02Z",
            ended_at: null,
          },
        ],
        next_cursor: null,
      },
    },
    errors: [400, 401, 404, 503],
  },
  {
    method: "get",
    path: "/v1/sessions/{id}/turns/{turn_id}",
    operationId: "getSessionTurn",
    tag: "Messages & turns",
    summary: "Committed result of one turn",
    description:
      "Reads one turn: its status, terminal reason, the engine's committed `result` and `usage`, and the worker attempts that ran it. This is the durable answer to whether a turn finished: `completed`, `failed`, `interrupted`, `cancelled` and `outcome_unknown` are terminal. `completed` means the engine ended the turn normally, not that the requested work is done. `result` and `usage` are null until the turn ends, and their shape is the runtime's. It changes nothing.",
    scope: "read",
    success: {
      status: 200,
      schema: "TurnDetail",
      description: "The turn as it stands now.",
      example: {
        ...EXAMPLE_TURN_SUMMARY,
        result: {
          type: "result",
          subtype: "success",
          result: "Added GET /health and a test for it.",
        },
        usage: { input_tokens: 48210, output_tokens: 3120 },
        attempts: [
          {
            attempt_id: "att_01",
            state: "exited",
            lease_epoch: 1,
            execution_generation: 1,
            started_at: "2026-10-11T08:00:05Z",
            ended_at: "2026-10-11T08:03:12Z",
          },
        ],
      },
    },
    errors: [401, 404, 503],
    errorNotes: {
      NOT_FOUND: "Also when `turn_id` names no turn of the session.",
    },
  },
  {
    method: "get",
    path: "/v1/sessions/{id}/events",
    operationId: "streamSessionEvents",
    tag: "Events",
    summary: "Durable event replay and live stream (SSE)",
    description:
      "Streams the session's events as Server-Sent Events: first the stored events after `Last-Event-ID` (all of them without it), then new ones as they are written. Each frame's `id` is its cursor, `event` its kind (`system`, `assistant`, `tool_use`, `tool_result`, `question`, `result`, `status`, `error`), and `data` a versioned envelope naming the session, turn and attempt. `question` events announce pending requests; `status` events report the session's status and, after a pause, resume, terminate or recovery decision, its `admission_state`. The stream does not end with a turn or the session: it stays open until the client disconnects, the credential is revoked, or the session's share stops covering the caller (the reconnect then answers 404). Reading changes nothing.\n\nReconnect after backoff with the last complete event id in `Last-Event-ID`; replay resumes strictly after that event. The stream sends a comment keepalive every 15 seconds. `410 CURSOR_EXPIRED` means the cursor fell outside retained history and the client must resynchronize from resource state; alpha does not trim events, so this response is reserved. A `result` event is engine output, not durable completion: confirm the turn with `GET /v1/sessions/{id}/turns/{turn_id}` and treat only `completed`, `failed`, `interrupted`, `cancelled`, or `outcome_unknown` as terminal.",
    scope: "read",
    lastEventId: true,
    success: {
      status: 200,
      schema: "SseEvent",
      sse: true,
      description:
        "`text/event-stream`: one frame per event, each an `id:`, an `event:` and a `data:` line, with the envelope as JSON on the `data:` line.",
      example: {
        id: "ev_2s",
        event: "status",
        data: {
          schema_version: 1,
          session_id: EXAMPLE_SESSION_ID,
          turn_id: "2",
          attempt_id: "att_01",
          occurred_at: "2026-10-11T08:14:02Z",
          data: { phase: "running" },
        },
      },
    },
    // 410 CURSOR_EXPIRED is declared for clients but never produced in alpha:
    // events are not trimmed (api.md § 이벤트).
    errors: [400, 401, 404, 410, 429, 503],
    errorNotes: {
      RATE_LIMITED:
        "This owner already has 8 open streams, or the process 256; `Retry-After` is 15.",
    },
  },
  {
    method: "get",
    path: "/v1/sessions/{id}/pending-requests",
    operationId: "listPendingRequests",
    tag: "Pending requests",
    summary: "Open permission and question requests",
    description:
      "Lists the permission and question requests the session's running turn waits on that a client can still answer: open, unexpired, and raised by the worker attempt that holds the turn, oldest first. A `permission` item names the `tool` and its `input`; a `question` item carries the questions and their option ids. Answer before `expires_at` with `POST /v1/sessions/{id}/answers`. New requests also arrive as `question` events on the event stream. It changes nothing.",
    scope: "read",
    success: {
      status: 200,
      schema: "ListPendingRequestsResponse",
      description: "Every request that can be answered now; empty when none.",
      example: {
        items: [
          {
            request_id: "req_7f3a",
            turn_id: "2",
            attempt_id: "att_01",
            created_at: "2026-10-11T08:14:30Z",
            expires_at: "2026-10-11T08:44:30Z",
            kind: "permission",
            tool: "Bash",
            input: { command: "npm test", description: "Run the tests" },
          },
        ],
      },
    },
    errors: [401, 404, 503],
  },
  {
    method: "post",
    path: "/v1/sessions/{id}/answers",
    operationId: "answerPendingRequest",
    tag: "Pending requests",
    summary: "Answer a pending permission or question request",
    description:
      "Answers one pending request by `request_id`: a permission with `allow` or `deny` (a denial needs a `reason` the model can act on), a question with one answer per question, by option ids or free text where the question allows it. The answer is stored and the request closes at once: the pending list drops it and a `status` event ends the wait. The worker then hands the answer to the engine, and the receipt settles when it reports: `succeeded` once delivered, `failed` if the request expired (`REQUEST_EXPIRED`) or was cancelled (`REQUEST_STALE`) first, `unknown` if the execution ended before it reported.",
    scope: "approve",
    body: "PostSessionAnswerRequest",
    requestExample: {
      request_id: "req_7f3a",
      kind: "permission",
      decision: "allow",
    },
    success: {
      status: 202,
      schema: "PostSessionAnswerResponse",
      description:
        "The answer is stored; the receipt tracks its delivery, and `approval` records who answered and the decision that let them.",
      example: {
        ...ACCEPTED_RECEIPT,
        approval: {
          answered_by: {
            principal: { kind: "user", id: EXAMPLE_USER_ID },
            actor_user_id: EXAMPLE_USER_ID,
            agent_id: null,
          },
          surface: "web",
          decision_id: "5b9e2d7a-1c4f-4a83-b6e0-8d3f7a2c1e94",
        },
      },
    },
    errors: [...CONFLICTS, 413, 503],
    errorCodes: {
      409: ["IDEMPOTENCY_CONFLICT", "REQUEST_EXPIRED", "REQUEST_STALE"],
    },
    errorNotes: {
      BAD_REQUEST:
        "Also when the answer does not fit the pending request (its kind, question or option ids); `message` says how.",
      NOT_FOUND: "Also when `request_id` names no request of the session.",
      REQUEST_STALE:
        "The attempt that asked is no longer the session's live attempt: it ended, lost its lease, or the turn moved on.",
    },
  },
  {
    method: "post",
    path: "/v1/sessions/{id}/interrupt",
    operationId: "interruptSession",
    tag: "Session control",
    summary: "Interrupt the targeted turn only",
    description:
      "Asks the worker to stop turn `target_turn_id` while it runs; the session's admission state and its other turns are left alone. The event stream shows a `status` event with phase `interrupting` when the worker takes the request and `engine_stopped` when the engine has stopped the turn; the turn reads `interrupted` once its checkpoint commits. If the turn has not ended 60 seconds after acceptance, its execution is killed.\n\nAccepted while the turn runs: the receipt settles when the turn ends, with a result of `{turn_id, terminal, no_op}`. A new request for a turn that has already ended answers `receipt_status: succeeded` at once, and its receipt says `no_op: true` with the terminal the turn reached on its own: the interrupt did nothing. An interrupt accepted while the turn ran is `no_op: true` too when the turn got to another terminal first; when the turn's outcome is unknown, so is the receipt (`status: unknown`, `no_op: false`). A replayed Idempotency-Key answers the receipt's current status instead.",
    scope: "control",
    body: "InterruptSessionRequest",
    requestExample: { target_turn_id: "2" },
    success: {
      status: 202,
      schema: "ReceiptAcceptedResponse",
      description:
        "The interrupt is stored (`accepted`), or the turn had already ended (`succeeded`, `no_op: true` on the receipt).",
      example: ACCEPTED_RECEIPT,
    },
    // 422: a turn running on the legacy pod binding, which no worker polls
    // control for.
    errors: [...CONFLICTS, 413, 422, 503],
    errorCodes: {
      409: ["IDEMPOTENCY_CONFLICT", "TURN_NOT_STARTED"],
    },
    errorNotes: {
      NOT_FOUND: "Also when `target_turn_id` names no turn of the session.",
      UNSUPPORTED_CAPABILITY:
        "The turn runs on a legacy pod binding, which no worker polls for control.",
    },
  },
  {
    method: "post",
    path: "/v1/sessions/{id}/pause",
    operationId: "pauseSession",
    tag: "Session control",
    summary: "Drain the current turn, checkpoint, stop the execution",
    description:
      "Pauses an `active` session so it holds no worker: the running turn, if any, is drained, its checkpoint commits and the execution stops. Queued input is kept and runs after a resume. The session goes `pausing` and the receipt stays `accepted` until the execution is observed gone; then the session is `paused` and the receipt `succeeded` with result `{resulting_admission_state, checkpoint_revision, queued_turn_count}`. A session with no execution goes `paused` at once. A drain that takes over 60 seconds shows `attention.code: PAUSE_BLOCKED` with the reason; nothing is killed for it, and terminating is the caller's choice. The receipt fails if the pause cannot commit, a resume cancels it, or a terminate overtakes it. Each step is a `status` event with `admission_state` on the stream.",
    scope: "control",
    body: "PauseSessionRequest",
    requestExample: { expected_revision: 7, reason: "Done for the day" },
    success: {
      status: 202,
      schema: "ReceiptAcceptedResponse",
      description:
        "The pause is stored (`accepted`), or the session had no execution and is `paused` already (`succeeded`).",
      example: ACCEPTED_RECEIPT,
    },
    // 422: a legacy pod binding, as for terminate.
    errors: [...CONFLICTS, 413, 422, 503],
    errorCodes: {
      409: [
        "IDEMPOTENCY_CONFLICT",
        "REVISION_CONFLICT",
        "SESSION_PAUSED",
        "SESSION_RESUMING",
        "SESSION_STOPPED",
        "RECOVERY_REQUIRED",
        "SESSION_CLOSED",
        "CHECKPOINT_UNAVAILABLE",
      ],
    },
    errorNotes: {
      REVISION_CONFLICT:
        "Checked before the admission state, so a stale revision answers this even on a session that is already paused.",
      UNSUPPORTED_CAPABILITY: "The session runs on a legacy pod binding.",
      CHECKPOINT_UNAVAILABLE:
        "No live worker can drain the turn and no committed checkpoint covers the last turn; terminate instead.",
    },
  },
  {
    method: "post",
    path: "/v1/sessions/{id}/terminate",
    operationId: "terminateSession",
    tag: "Session control",
    summary: "Block dispatch and force the execution down",
    description:
      "Stops the session by force, in any admission state but `closed`: dispatch is blocked, queued input is cancelled (each input's receipt fails with `SESSION_STOPPED`), open requests close and the execution is killed. The session goes `stopping` until the kill is observed, then `stopped`; with nothing to kill it is `stopped` at once and the receipt is `succeeded` in the response. A `recovery_required` session keeps that state. A turn the kill cut short may end `outcome_unknown`, which holds the session in `recovery_required` until `POST /v1/sessions/{id}/recovery-decisions`. The kill reverts nothing the execution already did outside (commits, pushes, API calls): the response and the receipt say `external_effects_reverted: false`. The receipt result is `{execution_gone, checkpoint_revision, unconfirmed_turn_id, external_effects_reverted}`. Resume a `stopped` session from its last checkpoint with `POST /v1/sessions/{id}/resume`.",
    scope: "control",
    body: "TerminateSessionRequest",
    requestExample: { expected_revision: 7, reason: "Runaway tool loop" },
    success: {
      status: 202,
      schema: "TerminateSessionResponse",
      description:
        "The terminate is stored (`accepted`), or there was nothing to kill and the session is `stopped` (`succeeded`).",
      example: { ...ACCEPTED_RECEIPT, external_effects_reverted: false },
    },
    // Served: an oversized body, a legacy binding with no kill path, and a
    // database outage are real answers.
    errors: [...CONFLICTS, 413, 422, 503],
    errorCodes: {
      409: [
        "IDEMPOTENCY_CONFLICT",
        "REVISION_CONFLICT",
        "SESSION_PAUSED",
        "SESSION_RESUMING",
        "SESSION_STOPPED",
        "RECOVERY_REQUIRED",
        "SESSION_CLOSED",
      ],
    },
    errorNotes: {
      SESSION_PAUSED: RESERVED_HERE,
      SESSION_RESUMING: RESERVED_HERE,
      SESSION_STOPPED: RESERVED_HERE,
      RECOVERY_REQUIRED: RESERVED_HERE,
      UNSUPPORTED_CAPABILITY:
        "The session runs on a legacy pod binding with no kill path.",
    },
  },
  {
    method: "post",
    path: "/v1/sessions/{id}/resume",
    operationId: "resumeSession",
    tag: "Session control",
    summary: "Restore from the last committed checkpoint or cancel a pause",
    description:
      "Brings a `stopped` or `paused` session back to `active`, or cancels a pause that is still draining. The receipt result is `{resulting_admission_state, checkpoint_revision, queued_turn_count}`.\n\n- **From `stopped`:** the session is `active` at once, the next worker restores the last committed checkpoint, queued input is dispatched, and the receipt is `succeeded` in the response.\n- **From `paused`:** the session goes `resuming` and a new worker restores the pause's checkpoint. The receipt stays `accepted` until that worker reports ready; then the session is `active` and the receipt `succeeded`. If the restore keeps failing, the receipt fails and the session goes `recovery_required`.\n- **From `pausing`, before the stop is committed:** the pause is cancelled (its receipt fails), the session is `active` again, and this receipt is `succeeded`. Once the stop is committed the answer is `409 PAUSE_COMMITTING`.\n\nEach change is a `status` event with `admission_state` on the stream.",
    scope: "control",
    body: "ResumeSessionRequest",
    requestExample: { expected_revision: 8 },
    success: {
      status: 202,
      schema: "ReceiptAcceptedResponse",
      description:
        "The resume is stored: `accepted` while a worker restores a paused session, `succeeded` when it took effect in the request.",
      example: ACCEPTED_RECEIPT,
    },
    // 409 PAUSE_COMMITTING once a pause can no longer be cancelled, 409
    // SESSION_RESUMING while a resume is restoring; 422: a legacy pod
    // binding; 413/503 as for every mutation.
    errors: [...CONFLICTS, 413, 422, 503],
    errorCodes: {
      409: [
        "IDEMPOTENCY_CONFLICT",
        "REVISION_CONFLICT",
        "REQUEST_STALE",
        "SESSION_RESUMING",
        "SESSION_CLOSED",
        "RECOVERY_REQUIRED",
        "CHECKPOINT_UNAVAILABLE",
        "PAUSE_COMMITTING",
      ],
    },
    errorNotes: {
      FORBIDDEN:
        "Also when an operator revoked the session's execution authority.",
      RECOVERY_REQUIRED:
        "The session is stopping or needs recovery, or a turn's outcome is unknown.",
      REQUEST_STALE: "The session is already active.",
      CHECKPOINT_UNAVAILABLE:
        "The stopped or paused session has no restore point it can resume from.",
      UNSUPPORTED_CAPABILITY: "The session runs on a legacy pod binding.",
      BACKEND_UNAVAILABLE:
        "Also while the stopped session's workspace is being reclaimed; `Retry-After` is 10.",
    },
  },
  {
    method: "post",
    path: "/v1/sessions/{id}/recovery-decisions",
    operationId: "decideSessionRecovery",
    tag: "Recovery",
    summary:
      "Operator decision for an unknown outcome or a context no checkpoint covers",
    description:
      "Records an operator's decision where the platform will not guess: a turn whose outcome is unknown, or context no checkpoint covers. Nothing the execution did outside is reverted.\n\n- `abandon`: the `outcome_unknown` turn `target_turn_id` becomes `cancelled` and its input receipt fails; the session is `stopped`.\n- `confirm_completed`: with `evidence_ref`, the turn becomes `completed` and its input receipt succeeds; it needs a committed checkpoint that reaches the turn. The session is `stopped`.\n- `close`: ends the session for good.\n- `start_fresh`: continues on a new engine session that does not remember the turns before; the checkpoints so far are retired and queued input runs.\n- `retry_restore`: restores the same checkpoint again after what made the restores fail is fixed; queued input runs.\n\nThe decision takes effect in the request: the receipt is `succeeded` in the response, with result `{resulting_admission_state, checkpoint_revision, resumable}`. After `abandon` or `confirm_completed`, resume the session; `resumable: false` means a resume would answer `CHECKPOINT_UNAVAILABLE`. The decision is also recorded as a `system` event on the stream.",
    scope: "recover",
    body: "RecoveryDecisionRequest",
    requestExample: {
      decision: "abandon",
      expected_revision: 9,
      target_turn_id: "3",
      reason: "The call had no external effect.",
    },
    success: {
      status: 202,
      schema: "ReceiptAcceptedResponse",
      description: "The decision is applied; the receipt is `succeeded`.",
      example: { receipt_id: EXAMPLE_RECEIPT_ID, receipt_status: "succeeded" },
    },
    // 422: a legacy pod binding, as for terminate.
    errors: [...CONFLICTS, 413, 422, 503],
    errorNotes: {
      FORBIDDEN:
        "Also when an operator revoked the session's execution authority.",
      NOT_FOUND: "Also when `target_turn_id` names no turn of the session.",
      REQUEST_STALE:
        "The decision does not apply to the session now: `close` or `start_fresh` on a session not awaiting recovery, `confirm_completed` or `abandon` on a turn whose outcome is not unknown, or `retry_restore` on a session a failed restore did not stop.",
      RECOVERY_REQUIRED:
        "The execution is not yet confirmed gone, or `start_fresh` while a turn's outcome is still unknown.",
      CHECKPOINT_UNAVAILABLE:
        "`confirm_completed` with no committed checkpoint that reaches the target turn.",
      SESSION_PAUSED: `${RESERVED_HERE} A decision that does not apply to the session answers \`REQUEST_STALE\`.`,
      SESSION_RESUMING: `${RESERVED_HERE} A decision that does not apply to the session answers \`REQUEST_STALE\`.`,
      SESSION_STOPPED: `${RESERVED_HERE} A decision that does not apply to the session answers \`REQUEST_STALE\`.`,
      UNSUPPORTED_CAPABILITY: "The session runs on a legacy pod binding.",
      BACKEND_UNAVAILABLE:
        "Also while the stopped session's workspace is being reclaimed; `Retry-After` is 10.",
    },
    errorCodes: {
      409: [
        "IDEMPOTENCY_CONFLICT",
        "REVISION_CONFLICT",
        "REQUEST_STALE",
        "SESSION_PAUSED",
        "SESSION_RESUMING",
        "SESSION_STOPPED",
        "RECOVERY_REQUIRED",
        "SESSION_CLOSED",
        "CHECKPOINT_UNAVAILABLE",
      ],
    },
  },
  {
    method: "post",
    path: "/v1/invites",
    operationId: "createInvite",
    tag: "Members",
    summary: "Invite a person to the workspace",
    description:
      "The token is returned once and expires in seven days; only its sha256 is stored. Inviting an address that already has a live invite revokes that invite. An address that is already a live member answers 400. Every invite writes an `invite_member` receipt.",
    auth: "session",
    body: "CreateInviteRequest",
    success: { status: 201, schema: "CreateInviteResponse" },
    errors: [400, 401, 403, 413, 503],
    errorCodes: { 403: ["FORBIDDEN", "OWNER_PROTECTED"] },
    idempotent: false,
  },
  {
    method: "get",
    path: "/v1/invites",
    operationId: "listInvites",
    tag: "Members",
    summary: "Invites of the workspace, newest first",
    description:
      "Each invite's status is pending, accepted, revoked or expired. Tokens are never returned.",
    auth: "session",
    success: { status: 200, schema: "ListInvitesResponse" },
    errors: [401, 403, 503],
  },
  {
    method: "delete",
    path: "/v1/invites/{id}",
    operationId: "revokeInvite",
    tag: "Members",
    summary: "Revoke an invite",
    description:
      "Writes a `revoke_invite` receipt. Revoking an invite that was already revoked does nothing; an accepted one answers 409.",
    auth: "session",
    success: { status: 204 },
    errors: [401, 403, 404, 409, 503],
    errorCodes: { 409: ["INVITE_USED"] },
    idempotent: false,
  },
  {
    method: "post",
    path: "/v1/invites/accept",
    operationId: "acceptInvite",
    tag: "Members",
    summary: "Redeem an invite; sets the session cookie",
    description:
      "An address with no account gets one with this password. An existing account joins with its current password, which is never changed. The token is spent once; a revoked, replaced or expired token answers 410, an accepted one 409. Writes an `accept_invite` receipt.",
    auth: "public",
    csrf: "always",
    body: "AcceptInviteRequest",
    success: { status: 200, schema: "AcceptInviteResponse" },
    errors: [400, 401, 403, 409, 410, 413, 429, 503],
    errorCodes: { 409: ["INVITE_USED"], 410: ["INVITE_EXPIRED"] },
    idempotent: false,
  },
  {
    method: "get",
    path: "/v1/members",
    operationId: "listMembers",
    tag: "Members",
    summary: "Members of the workspace, oldest first",
    auth: "session",
    success: { status: 200, schema: "ListMembersResponse" },
    errors: [401, 403, 503],
  },
  {
    method: "patch",
    path: "/v1/members/{user_id}",
    operationId: "updateMember",
    tag: "Members",
    summary: "Change a member's role",
    description:
      "Demoting the workspace's last live owner answers 409 LAST_OWNER. Writes a `change_member_role` receipt when the role changes.",
    auth: "session",
    body: "UpdateMemberRequest",
    success: { status: 200, schema: "MemberView" },
    errors: [400, 401, 403, 404, 409, 413, 503],
    errorCodes: { 403: ["FORBIDDEN", "OWNER_PROTECTED"], 409: ["LAST_OWNER"] },
    idempotent: false,
  },
  {
    method: "post",
    path: "/v1/members/{user_id}/disable",
    operationId: "disableMember",
    tag: "Members",
    summary: "Disable a member of the workspace",
    description:
      "In the same transaction: the membership is disabled, every web session of the person is revoked (open event streams end), their personal keys in the workspace are revoked, and the sessions they asked for wait for an owner's takeover. Service keys are untouched. Disabling yourself, or the last live owner, answers 409 LAST_OWNER. Writes a `disable_member` receipt unless the membership was already disabled (`receipt_id` null).",
    auth: "session",
    body: "SetAccessRequest",
    success: { status: 200, schema: "SetAccessResponse" },
    errors: [400, 401, 403, 404, 409, 413, 503],
    errorCodes: { 409: ["LAST_OWNER"] },
    idempotent: false,
  },
  {
    method: "post",
    path: "/v1/members/{user_id}/enable",
    operationId: "enableMember",
    tag: "Members",
    summary: "Enable a disabled member again",
    description:
      "Revoked web sessions and personal keys stay revoked: the person signs in again. Sessions no owner took over go back to them. Writes an `enable_member` receipt unless the membership was already live (`receipt_id` null).",
    auth: "session",
    body: "SetAccessRequest",
    success: { status: 200, schema: "SetAccessResponse" },
    errors: [400, 401, 403, 404, 413, 503],
    idempotent: false,
  },
  {
    method: "post",
    path: "/v1/users/{user_id}/disable",
    operationId: "disableUser",
    tag: "Members",
    summary: "Suspend an account",
    description:
      "Allowed only when every live membership of the account is in a workspace the caller owns; otherwise 403. The account cannot sign in anywhere, and the same cut-off as disabling a member applies in each of its workspaces. Suspending yourself answers 409 LAST_OWNER. Writes a `disable_user` receipt unless the account was already suspended (`receipt_id` null).",
    auth: "session",
    body: "SetAccessRequest",
    success: { status: 200, schema: "SetAccessResponse" },
    errors: [400, 401, 403, 404, 409, 413, 503],
    errorCodes: { 409: ["LAST_OWNER"] },
    idempotent: false,
  },
  {
    method: "post",
    path: "/v1/users/{user_id}/enable",
    operationId: "enableUser",
    tag: "Members",
    summary: "Lift an account suspension",
    description:
      "The same ownership rule as suspending. Revoked web sessions and personal keys stay revoked. Writes an `enable_user` receipt unless the account was not suspended (`receipt_id` null).",
    auth: "session",
    body: "SetAccessRequest",
    success: { status: 200, schema: "SetAccessResponse" },
    errors: [400, 401, 403, 404, 413, 503],
    idempotent: false,
  },
  {
    method: "get",
    path: "/v1/takeovers",
    operationId: "listTakeovers",
    tag: "Members",
    summary: "Sessions waiting for an owner to take them over",
    description:
      "Sessions whose requester was offboarded. Each takes no further input until an owner takes it over. API keys are refused.",
    auth: "session",
    success: { status: 200, schema: "ListTakeoversResponse" },
    errors: [401, 403, 503],
  },
  {
    method: "post",
    path: "/v1/sessions/{id}/takeover",
    operationId: "takeOverSession",
    tag: "Members",
    summary: "Become the requester of an offboarded member's session",
    description:
      "The caller becomes the session's requester and its queued input runs again. A session shared with less than the whole workspace and not with the caller needs a `justification`, kept on the decision and the receipt; without one it answers 403 with `reason_code` `justification_required`. The body may be empty. API keys are refused.",
    auth: "session",
    body: "TakeOverSessionRequest",
    success: { status: 200, schema: "ReceiptAcceptedResponse" },
    errors: [400, 401, 403, 404, 409, 413, 503],
    errorCodes: { 409: ["REQUEST_STALE"] },
    idempotent: false,
  },
  {
    method: "post",
    path: "/v1/linked-accounts/slack/start",
    operationId: "startSlackLink",
    tag: "Linked accounts",
    summary: "Start linking the caller's Slack account",
    description:
      "Returns Slack's consent URL and sets a one-time state cookie for the callback, valid ten minutes. Scopes are `openid profile`; no email is requested. Refused with 409 when the workspace has no verified Slack install. API keys are refused.",
    auth: "session",
    success: { status: 200, schema: "StartSlackLinkResponse" },
    errors: [401, 403, 409, 503],
    errorCodes: { 409: ["SLACK_NOT_INSTALLED"] },
    idempotent: false,
  },
  {
    method: "post",
    path: "/v1/linked-accounts/slack/callback",
    operationId: "slackLinkCallback",
    tag: "Linked accounts",
    summary: "Finish linking with the code Slack returned",
    description:
      "Spends the state cookie, exchanges the code and verifies the id_token, then links the Slack account to the caller and writes a `link_account` receipt. Refused when the account's Slack team is not installed for the workspace, when the account is linked to someone else (never overwritten), or when the caller already linked another account in that team. API keys are refused.",
    auth: "session",
    body: "SlackLinkCallbackRequest",
    success: { status: 201, schema: "SlackLinkCallbackResponse" },
    errors: [400, 401, 403, 409, 413, 503],
    errorCodes: {
      409: [
        "SLACK_NOT_INSTALLED",
        "LINK_TEAM_MISMATCH",
        "LINK_TAKEN",
        "LINK_EXISTS",
      ],
    },
    idempotent: false,
  },
  {
    method: "get",
    path: "/v1/linked-accounts",
    operationId: "listLinkedAccounts",
    tag: "Linked accounts",
    summary: "The caller's linked accounts that are active or stale",
    description: "API keys are refused.",
    auth: "session",
    success: { status: 200, schema: "ListLinkedAccountsResponse" },
    errors: [401, 403, 503],
  },
  {
    method: "delete",
    path: "/v1/linked-accounts/{id}",
    operationId: "unlinkAccount",
    tag: "Linked accounts",
    summary: "Unlink one of the caller's accounts",
    description:
      "Revokes the link and writes an `unlink_account` receipt. Input from that Slack account is refused from then on, including input that was already waiting to be processed. API keys are refused.",
    auth: "session",
    success: { status: 200, schema: "ReceiptAcceptedResponse" },
    errors: [401, 403, 404, 503],
    idempotent: false,
  },
  {
    method: "get",
    path: "/v1/agents",
    operationId: "listAgents",
    tag: "Agents",
    summary: "The workspace's agents",
    description: "Up to 500, oldest first. API keys are refused.",
    auth: "session",
    success: { status: 200, schema: "ListAgentsResponse" },
    errors: [401, 403, 503],
  },
  {
    method: "post",
    path: "/v1/agents",
    operationId: "createAgent",
    tag: "Agents",
    summary: "Create an agent and its first card version",
    description:
      "Nothing is released or activated. A slug already used in the workspace answers 409 ALREADY_EXISTS. API keys are refused.",
    auth: "session",
    body: "CreateAgentRequest",
    success: { status: 201, schema: "AgentDetail" },
    errors: [400, 401, 403, 409, 413, 503],
    errorCodes: { 409: ["ALREADY_EXISTS"] },
    idempotent: false,
  },
  {
    method: "get",
    path: "/v1/agents/{id}",
    operationId: "getAgent",
    tag: "Agents",
    summary: "An agent with its versions, releases and active release",
    auth: "session",
    success: { status: 200, schema: "AgentDetail" },
    errors: [401, 403, 404, 503],
  },
  {
    method: "patch",
    path: "/v1/agents/{id}",
    operationId: "updateAgent",
    tag: "Agents",
    summary: "Rename an agent or add a card version",
    description:
      "A `card` becomes a new version; existing versions never change. A card equal to one the agent already has adds nothing.",
    auth: "session",
    body: "UpdateAgentRequest",
    success: { status: 200, schema: "AgentDetail" },
    errors: [400, 401, 403, 404, 413, 503],
    idempotent: false,
  },
  {
    method: "post",
    path: "/v1/agents/{id}/releases",
    operationId: "createAgentRelease",
    tag: "Agents",
    summary: "Release a version against a runtime profile",
    description:
      "The release id is a hash of the card, the profile's digest and the resolved runtime settings; releasing the same content again returns the stored release with `created: false`. A card tool outside the profile, a different model or an unknown profile answers 422. Releasing approves and activates nothing.",
    auth: "session",
    body: "CreateAgentReleaseRequest",
    success: { status: 200, schema: "CreateAgentReleaseResponse" },
    errors: [400, 401, 403, 404, 413, 422, 503],
    idempotent: false,
  },
  {
    method: "post",
    path: "/v1/agents/{id}/activate",
    operationId: "activateAgent",
    tag: "Agents",
    summary: "Point the agent at a release (compare-and-swap)",
    description:
      "`expected_revision` is the agent's current `activation_revision` (-1 before the first activation); a stale one answers 409 REVISION_CONFLICT. Sending the same activation again is a no-op with a null `receipt_id`. A release whose runtime profile changed since answers 409 PROFILE_DIGEST_MISMATCH and has to be released again. A release whose card names a credential not bound to the agent answers 409 CREDENTIAL_UNBOUND with the missing names in `details.missing` (`ActivationCredentialUnboundDetails`). Sessions already pinned keep their release.",
    auth: "session",
    body: "ActivateAgentRequest",
    success: { status: 200, schema: "ActivateAgentResponse" },
    errors: [400, 401, 403, 404, 409, 413, 503],
    errorCodes: {
      409: [
        "REVISION_CONFLICT",
        "PROFILE_DIGEST_MISMATCH",
        "CREDENTIAL_UNBOUND",
      ],
    },
    idempotent: false,
  },
  {
    method: "get",
    path: "/v1/agents/{id}/credential-bindings",
    operationId: "listCredentialBindings",
    tag: "Agents",
    summary: "The credential names bound to an agent",
    description:
      "Owners, admins and the agent's admins. Each binding carries `running_sessions`, the sessions of this agent that name it and have not closed, with the `revoke_notice` the unbind screen shows: unbinding stops the next session, not a running one (D11). Names only; no value is ever stored.",
    auth: "session",
    success: { status: 200, schema: "ListCredentialBindingsResponse" },
    errors: [401, 403, 404, 503],
  },
  {
    method: "post",
    path: "/v1/agents/{id}/credential-bindings",
    operationId: "createCredentialBinding",
    tag: "Agents",
    summary: "Bind a credential name to an agent",
    description:
      "Owners, admins and the agent's admins; never an API key. `credential_ref` names a credential held outside Werft (a secret store entry, a remote MCP server connection). Binding a name already bound answers `created: false` and a null `receipt_id`; otherwise writes a `bind_credential` receipt. A name an agent identity holds answers 409 CREDENTIAL_REF_IN_USE.",
    auth: "session",
    body: "CreateCredentialBindingRequest",
    success: { status: 200, schema: "CreateCredentialBindingResponse" },
    errors: [400, 401, 403, 404, 409, 413, 503],
    errorCodes: { 409: ["CREDENTIAL_REF_IN_USE"] },
    idempotent: false,
  },
  {
    method: "delete",
    path: "/v1/agents/{id}/credential-bindings/{binding_id}",
    operationId: "revokeCredentialBinding",
    tag: "Agents",
    summary: "Unbind a credential name from an agent",
    description:
      "Takes what binding takes. The next session of a release naming it is refused 409 CREDENTIAL_UNBOUND; sessions already running keep it until they end, which the answer's `binding.running_sessions` and `revoke_notice` say. Writes an `unbind_credential` receipt; a binding already revoked is not found.",
    auth: "session",
    success: { status: 200, schema: "RevokeCredentialBindingResponse" },
    errors: [401, 403, 404, 503],
    idempotent: false,
  },
  {
    method: "post",
    path: "/v1/agents/{id}/identities",
    operationId: "linkAgentIdentity",
    tag: "Agents",
    summary: "Pin the agent to its Slack app's install in one team",
    description:
      "Slack events from that app and team then resolve to this agent and no other; events from another app, or after the identity or the install is revoked, are dropped. The install must be verified for the workspace (409 SLACK_NOT_INSTALLED); one already pinned to another agent answers 409 AGENT_IDENTITY_TAKEN, and to this agent 409 ALREADY_EXISTS. `credential_ref` names the bot token in the secret store, never its value, and is this identity's alone: a name bound to an agent or another identity answers 409 CREDENTIAL_REF_IN_USE, and the name is freed when the identity is revoked. Owners, admins and the agent's admins; API keys are refused. Writes a `link_agent_identity` receipt.",
    auth: "session",
    body: "LinkAgentIdentityRequest",
    success: { status: 201, schema: "LinkAgentIdentityResponse" },
    errors: [400, 401, 403, 404, 409, 413, 503],
    errorCodes: {
      409: [
        "SLACK_NOT_INSTALLED",
        "AGENT_IDENTITY_TAKEN",
        "ALREADY_EXISTS",
        "CREDENTIAL_REF_IN_USE",
      ],
    },
    idempotent: false,
  },
  {
    method: "get",
    path: "/v1/agents/{id}/identities",
    operationId: "listAgentIdentities",
    tag: "Agents",
    summary: "The agent's Slack app identities",
    description:
      "Active first, then revoked, newest first within each; up to 50. Owners, admins and the agent's admins.",
    auth: "session",
    success: { status: 200, schema: "ListAgentIdentitiesResponse" },
    errors: [401, 403, 404, 503],
  },
  {
    method: "delete",
    path: "/v1/agents/{id}/identities/{identity_id}",
    operationId: "revokeAgentIdentity",
    tag: "Agents",
    summary: "Revoke an agent identity",
    description:
      "Events from that app and team are dropped from then on, including events already waiting to be processed. Revoking one already revoked changes nothing and answers a null `receipt_id`; otherwise writes a `revoke_agent_identity` receipt. Linking again makes a new identity.",
    auth: "session",
    success: { status: 200, schema: "RevokeAgentIdentityResponse" },
    errors: [401, 403, 404, 503],
    idempotent: false,
  },
  {
    method: "post",
    path: "/v1/api-keys",
    operationId: "createApiKey",
    tag: "API keys",
    summary: "Issue a personal key, a service key, or one bound to an agent",
    description:
      "A personal key is the caller's own; a service key takes an owner or an admin, and one with `agent_id` also that agent's admin. `scopes` may not exceed what the caller holds now, and a key with `agent_id` never holds `sessions:approve` (403 SCOPE_NOT_GRANTABLE). An API key never issues one. The secret is returned once; only its sha256 is stored. Writes a `create_api_key` receipt.",
    auth: "session",
    body: "CreateApiKeyRequest",
    success: { status: 201, schema: "CreateApiKeyResponse" },
    errors: [400, 401, 403, 404, 413, 503],
    errorCodes: { 403: ["FORBIDDEN", "SCOPE_NOT_GRANTABLE"] },
    idempotent: false,
  },
  {
    method: "get",
    path: "/v1/api-keys",
    operationId: "listApiKeys",
    tag: "API keys",
    summary: "The caller's personal keys and the service keys they manage",
    description:
      "Owners and admins see every service key; an agent's admin sees that agent's keys. Secrets are never returned.",
    auth: "session",
    success: { status: 200, schema: "ListApiKeysResponse" },
    errors: [401, 403, 503],
  },
  {
    method: "delete",
    path: "/v1/api-keys/{id}",
    operationId: "revokeApiKey",
    tag: "API keys",
    summary: "Revoke a key",
    description:
      "Takes the right issuing that kind of key takes. Revoking a key already revoked changes nothing and answers a null `receipt_id`; otherwise writes a `revoke_api_key` receipt.",
    auth: "session",
    success: { status: 200, schema: "RevokeApiKeyResponse" },
    errors: [401, 403, 404, 503],
    idempotent: false,
  },
  {
    method: "post",
    path: "/v1/teams",
    operationId: "createTeam",
    tag: "Teams",
    summary: "Create a team",
    description:
      "Owners and admins (`team.manage`). A live team's name is unique in its workspace (409 ALREADY_EXISTS). Writes a `create_team` receipt.",
    auth: "session",
    body: "CreateTeamRequest",
    success: { status: 201, schema: "TeamChangeResponse" },
    errors: [400, 401, 403, 409, 413, 503],
    errorCodes: { 409: ["ALREADY_EXISTS"] },
    idempotent: false,
  },
  {
    method: "get",
    path: "/v1/teams",
    operationId: "listTeams",
    tag: "Teams",
    summary: "The workspace's teams, by name",
    auth: "session",
    success: { status: 200, schema: "ListTeamsResponse" },
    errors: [401, 403, 503],
  },
  {
    method: "get",
    path: "/v1/teams/{team_id}",
    operationId: "getTeam",
    tag: "Teams",
    summary: "A team and its members",
    auth: "session",
    success: { status: 200, schema: "TeamDetail" },
    errors: [401, 403, 404, 503],
  },
  {
    method: "patch",
    path: "/v1/teams/{team_id}",
    operationId: "updateTeam",
    tag: "Teams",
    summary: "Rename a team",
    description:
      "Writes a `rename_team` receipt unless the name is unchanged (`receipt_id` null).",
    auth: "session",
    body: "UpdateTeamRequest",
    success: { status: 200, schema: "TeamChangeResponse" },
    errors: [400, 401, 403, 404, 409, 413, 503],
    errorCodes: { 409: ["ALREADY_EXISTS"] },
    idempotent: false,
  },
  {
    method: "delete",
    path: "/v1/teams/{team_id}",
    operationId: "deleteTeam",
    tag: "Teams",
    summary: "Delete a team",
    description:
      "Every agent the team administered loses it from the next request on; its members keep whatever they hold on their own. Writes a `delete_team` receipt.",
    auth: "session",
    success: { status: 200, schema: "DeleteTeamResponse" },
    errors: [401, 403, 404, 503],
    idempotent: false,
  },
  {
    method: "post",
    path: "/v1/teams/{team_id}/members",
    operationId: "addTeamMember",
    tag: "Teams",
    summary: "Add a member of the workspace to a team",
    description:
      "No invite and no acceptance: the person is a member of the team at once. A disabled member is not found. Writes an `add_team_member` receipt naming the person, unless they already were in (`receipt_id` null).",
    auth: "session",
    body: "AddTeamMemberRequest",
    success: { status: 200, schema: "TeamChangeResponse" },
    errors: [400, 401, 403, 404, 413, 503],
    idempotent: false,
  },
  {
    method: "delete",
    path: "/v1/teams/{team_id}/members/{user_id}",
    operationId: "removeTeamMember",
    tag: "Teams",
    summary: "Take a member out of a team",
    description:
      "What the person held through the team ends from their next request. Writes a `remove_team_member` receipt naming the person, unless they were not in (`receipt_id` null).",
    auth: "session",
    success: { status: 200, schema: "TeamChangeResponse" },
    errors: [401, 403, 404, 503],
    idempotent: false,
  },
  {
    method: "get",
    path: "/v1/agents/{id}/admins",
    operationId: "listAgentAdmins",
    tag: "Agents",
    summary: "The people and teams who administer an agent",
    description:
      "Owners, admins and the agent's own admins (`agent.admin.manage`).",
    auth: "session",
    success: { status: 200, schema: "AgentAdmins" },
    errors: [401, 403, 404, 503],
  },
  {
    method: "post",
    path: "/v1/agents/{id}/admins",
    operationId: "addAgentAdmin",
    tag: "Agents",
    summary: "Name a person or a team an agent's admin",
    description:
      "Owners, admins and the agent's own admins. A team's members administer the agent while they are in it. Writes an `add_agent_admin` receipt unless they already were one (`receipt_id` null).",
    auth: "session",
    body: "AddAgentAdminRequest",
    success: { status: 200, schema: "AgentAdminChangeResponse" },
    errors: [400, 401, 403, 404, 413, 503],
    idempotent: false,
  },
  {
    method: "delete",
    path: "/v1/agents/{id}/admins/{kind}/{subject_id}",
    operationId: "removeAgentAdmin",
    tag: "Agents",
    summary: "Stop a person or a team administering an agent",
    description:
      "`kind` is `users` or `teams`. Writes a `remove_agent_admin` receipt unless they were not one (`receipt_id` null).",
    auth: "session",
    success: { status: 200, schema: "AgentAdminChangeResponse" },
    errors: [401, 403, 404, 503],
    idempotent: false,
  },
  {
    method: "get",
    path: "/v1/administered-agents",
    operationId: "listAdministeredAgents",
    tag: "Agents",
    summary: "The agents the caller administers",
    description:
      "Directly or through a team, as of this request: what an agent's admin needs to issue that agent's own key.",
    auth: "session",
    success: { status: 200, schema: "ListAdministeredAgentsResponse" },
    errors: [401, 403, 503],
  },
  {
    method: "get",
    path: "/v1/profiles",
    operationId: "listProfiles",
    tag: "Limits & receipts",
    summary: "The runtime profiles this installation can run",
    description:
      "Lists the catalog profiles a session's `profile_id` or a release's `runtime_profile_id` may name, by `id`, with the model each one runs. The catalog is the operator's config, read once at startup; this reads it and changes nothing. A profile's provider endpoint and credential are not included.",
    scope: "read",
    success: {
      status: 200,
      schema: "ListProfilesResponse",
      description: "Every profile in the catalog, ordered by `id`.",
      example: {
        items: [
          {
            id: "claude-coding-real",
            model: "claude-sonnet-5",
            tools: ["Read", "Edit", "Write", "Glob", "Grep", "Bash"],
            runtime_kind: "claude_agent_sdk",
            runtime_version: "0.3.270",
            billing: "metered",
          },
        ],
      },
    },
    errors: [401, 503],
  },
  {
    method: "get",
    path: "/v1/limits",
    operationId: "getInstallationLimits",
    tag: "Limits & receipts",
    summary: "Installation limits and installation-wide usage",
    description:
      "Reads the limits this installation runs under (execution slots, queued input per session, storage, turn length, per-session cost and token limits, provider retries) and the usage against the installation-wide ones, summed over every owner. Use it to explain `STORAGE_LIMIT_EXCEEDED`, a full input queue, or sessions waiting in `queued` for a slot. It changes nothing.",
    scope: "read",
    success: {
      status: 200,
      schema: "InstallationLimitsResponse",
      description: "The limits and usage as of `refreshed_at`.",
      example: {
        scope: "installation",
        refreshed_at: "2026-10-11T08:15:43Z",
        limits: {
          execution_slot_limit: 4,
          queued_input_limit_per_session: 20,
          storage_limit_bytes: 1073741824,
          max_turn_seconds: 3600,
          session_cost_limit_usd: "20",
          session_token_limit: null,
          provider_max_retries: 2,
        },
        usage: {
          execution_slots_used: 1,
          queued_input_count: 3,
          storage: {
            used_bytes: 524288,
            accounted_content: ["input_messages"],
            updated_at: "2026-10-11T08:14:00Z",
          },
        },
      },
    },
    errors: [401, 503],
  },
  {
    method: "get",
    path: "/v1/receipts/{id}",
    operationId: "getReceipt",
    tag: "Limits & receipts",
    summary: "Current outcome of an accepted command",
    description:
      "Reads the current outcome of a command by the `receipt_id` its response returned: `accepted` while it is in progress, then `succeeded`, `failed` (with `error`) or `unknown` (nobody can say; `error` explains). Poll until it leaves `accepted`. `result` depends on `operation`:\n\n- `create_session`, `append_message`: the acceptance response exactly as first returned, never rewritten. The turn's outcome is read from `GET /v1/sessions/{session_id}/turns/{turn_id}` using `target_ref`.\n- `interrupt`: `{turn_id, terminal, no_op}` once settled.\n- `pause`, `resume`: `{resulting_admission_state, checkpoint_revision, queued_turn_count}`.\n- `terminate`: `{execution_gone, checkpoint_revision, unconfirmed_turn_id, external_effects_reverted}`.\n- `recovery_decision`: `{resulting_admission_state, checkpoint_revision, resumable}`.\n- `answer`: null; only `status` and `error` change.\n\nAny credential of the same owner can read a receipt. It changes nothing.",
    scope: "read",
    success: {
      status: 200,
      schema: "Receipt",
      description: "The receipt as it stands now.",
      example: {
        id: EXAMPLE_RECEIPT_ID,
        operation: "pause",
        target_ref: {
          session_id: EXAMPLE_SESSION_ID,
          turn_id: null,
          request_id: null,
        },
        status: "succeeded",
        result: {
          resulting_admission_state: "paused",
          checkpoint_revision: 3,
          queued_turn_count: 1,
        },
        error: null,
        created_at: "2026-10-11T08:20:00Z",
        updated_at: "2026-10-11T08:20:09Z",
      },
    },
    errors: [401, 404, 503],
  },
] as const satisfies readonly RouteDeclaration[];

export const OPENAPI_COMPONENT_SCHEMAS: Record<ComponentName, z.ZodType> = {
  ...requestComponents,
  ...responseComponents,
};

export type ApiOperationId =
  (typeof API_ROUTE_DECLARATIONS)[number]["operationId"];

/**
 * The session scope each operation demands, as the API enforces it before
 * reading a body or a resource. Routes without a scope are the
 * probes, the public auth routes and cookie-only logout.
 */
export const API_ROUTE_SCOPES: ReadonlyArray<{
  method: Uppercase<RouteDeclaration["method"]>;
  path: string;
  scope: SessionScope;
}> = API_ROUTE_DECLARATIONS.flatMap((declaration) => {
  const route: RouteDeclaration = declaration;
  const scope = scopeOf(route);
  return scope
    ? [
        {
          method: route.method.toUpperCase() as Uppercase<
            RouteDeclaration["method"]
          >,
          path: route.path,
          scope,
        },
      ]
    : [];
});

type JsonSchema = Record<string, unknown>;

function scopeOf(route: RouteDeclaration): SessionScope | undefined {
  return route.scope ? `sessions:${route.scope}` : undefined;
}

function securityFor(route: RouteDeclaration): Array<Record<string, string[]>> {
  if (route.auth === "public") return [];
  if (route.auth === "session") return [{ cookieSession: [] }];
  const scope = scopeOf(route);
  return scope ? [{ bearerApiKey: [scope] }, { cookieSession: [scope] }] : [];
}

function takesIdempotencyKey(route: RouteDeclaration): boolean {
  return route.method !== "get" && route.idempotent !== false;
}

function errorContext(route: RouteDeclaration): ErrorContext {
  return {
    scope: scopeOf(route),
    auth: route.auth ?? "any",
    csrf:
      route.csrf === "always"
        ? "always"
        : takesCookieMutation(route)
          ? "cookie"
          : "none",
    idempotencyKey: takesIdempotencyKey(route),
    lastEventId: route.lastEventId === true,
    body: route.body !== undefined,
    query: route.query !== undefined,
  };
}

// The /v1 middleware refuses a cookie-authenticated mutation without the
// CSRF header (403), so every such operation documents both; bearer calls
// never send it, hence `required: false`.
function takesCookieMutation(route: RouteDeclaration): boolean {
  return (
    route.method !== "get" &&
    securityFor(route).some((scheme) => "cookieSession" in scheme)
  );
}

function ref(name: ComponentName) {
  return { $ref: `#/components/schemas/${name}` };
}

function jsonContent(name: ComponentName, example?: unknown) {
  return {
    "application/json": {
      schema: ref(name),
      ...(example === undefined ? {} : { example }),
    },
  };
}

function errorCodesFor(
  route: RouteDeclaration,
  status: number,
): readonly ApiErrorCode[] {
  const codes = route.errorCodes?.[status] ?? COMMON_ERROR_CODES[status];
  if (!codes || codes.length === 0) {
    throw new Error(
      `No ApiErrorResponse.code values registered for ${route.method.toUpperCase()} ${route.path} ${status}`,
    );
  }
  return codes;
}

// Retry-After rides on every 429 and on a storage 503 (app.ts), not on the
// readiness probe's NOT_READY.
function responseHeaders(retryAfter = false) {
  return {
    "X-Request-Id": { $ref: "#/components/headers/RequestId" },
    ...(retryAfter
      ? { "Retry-After": { $ref: "#/components/headers/RetryAfter" } }
      : {}),
  };
}

function errorContent(codes: readonly ApiErrorCode[]) {
  return {
    "application/json": {
      schema: {
        allOf: [
          ref("ApiErrorResponse"),
          {
            type: "object",
            properties: {
              error: {
                type: "object",
                properties: {
                  code: { type: "string", enum: codes },
                },
              },
            },
          },
        ],
      },
    },
  };
}

function queryParameters(schema: JsonSchema) {
  const properties = (schema.properties ?? {}) as Record<string, JsonSchema>;
  const required = new Set((schema.required ?? []) as string[]);
  return Object.entries(properties).map(([name, property]) => ({
    name,
    in: "query",
    required: required.has(name),
    schema: property,
  }));
}

function paramsSchemaFor(path: string): z.ZodObject {
  if (path === "/v1/receipts/{id}") return receiptIdParamsSchema;
  if (path.startsWith("/v1/agents/{id}/admins/")) return agentAdminParamsSchema;
  if (path.includes("{binding_id}")) return credentialBindingParamsSchema;
  if (path === "/v1/agents/{id}/identities/{identity_id}")
    return agentIdentityParamsSchema;
  if (path.startsWith("/v1/agents/{id}")) return agentIdParamsSchema;
  if (path.startsWith("/v1/teams/{team_id}/members/"))
    return teamMemberParamsSchema;
  if (path.startsWith("/v1/teams/{team_id}")) return teamIdParamsSchema;
  if (path.startsWith("/v1/workspaces/{id}/members/{userId}"))
    return memberParamsSchema;
  if (path === "/v1/invites/{id}") return inviteIdParamsSchema;
  if (path === "/v1/api-keys/{id}") return apiKeyIdParamsSchema;
  if (path.startsWith("/v1/members/{user_id}")) return memberUserParamsSchema;
  if (path.startsWith("/v1/users/{user_id}")) return memberUserParamsSchema;
  if (path.startsWith("/v1/workspaces/{id}")) return workspaceParamsSchema;
  if (path.includes("{turn_id}")) return turnIdParamsSchema;
  if (
    path.startsWith("/v1/sessions/{id}") ||
    path.startsWith("/v1/admin/sessions/{id}")
  ) {
    return sessionIdParamsSchema;
  }
  if (path.startsWith("/v1/linked-accounts/{id}"))
    return linkedAccountParamsSchema;
  throw new Error(`No params schema registered for ${path}`);
}

function pathParameters(path: string) {
  const names = [...path.matchAll(/\{(\w+)\}/g)].map(([, name]) => name);
  if (names.length === 0) return [];
  const schema = paramsSchemaFor(path);
  const properties = (
    z.toJSONSchema(schema as z.ZodType, { io: "input" }) as JsonSchema
  ).properties as Record<string, JsonSchema>;
  return names.map((name) => {
    const property = properties[name as string];
    if (!property) throw new Error(`No params schema for ${name} in ${path}`);
    return { name, in: "path", required: true, schema: property };
  });
}

function buildSchemas(): Record<string, JsonSchema> {
  const schemas: Record<string, JsonSchema> = {};
  for (const [io, components] of [
    ["input", requestComponents],
    ["output", responseComponents],
  ] as const) {
    const registry = z.registry<{ id: string }>();
    for (const [id, schema] of Object.entries(components)) {
      registry.add(schema, { id });
    }
    const generated = z.toJSONSchema(registry, {
      io,
      uri: (id) => `#/components/schemas/${id}`,
      unrepresentable: "throw",
    }).schemas as Record<string, JsonSchema>;
    for (const [id, generatedSchema] of Object.entries(generated)) {
      const { $schema: _schema, $id: _id, ...schema } = generatedSchema;
      schemas[id] = schema;
    }
  }
  return schemas;
}

const schemas = buildSchemas();

export type ApiRouteConfig = RouteConfig & {
  path: string;
  getRoutingPath(): string;
};

function createApiRouteConfig(route: RouteDeclaration): ApiRouteConfig {
  const parameters: unknown[] = pathParameters(route.path);
  if (route.query) {
    const querySchema = schemas[route.query];
    if (!querySchema) throw new Error(`Missing query schema ${route.query}`);
    parameters.push(...queryParameters(querySchema));
  }
  if (takesIdempotencyKey(route)) {
    parameters.push({
      name: "Idempotency-Key",
      in: "header",
      required: true,
      description: IDEMPOTENCY_KEY_DESCRIPTION,
      schema: { type: "string", minLength: 1, maxLength: 255 },
    });
  }
  if (route.lastEventId) {
    parameters.push({
      name: "Last-Event-ID",
      in: "header",
      required: false,
      description: LAST_EVENT_ID_DESCRIPTION,
      schema: { type: "string", minLength: 1 },
    });
  }
  const csrf = route.csrf === "always" || takesCookieMutation(route);
  if (csrf) {
    parameters.push({
      name: "X-Requested-With",
      in: "header",
      required: route.csrf === "always",
      description:
        route.csrf === "always"
          ? "Always required: the literal `agent-platform-web`."
          : "Required with a cookie session: the literal `agent-platform-web`.",
      schema: { type: "string", enum: ["agent-platform-web"] },
    });
  }
  const success = route.success;
  const responses: Record<string, unknown> = {
    [success.status]:
      success.status === 204
        ? {
            description: success.description ?? "No content",
            headers: responseHeaders(),
          }
        : {
            description:
              success.description ?? (success.sse ? "Event stream" : "Success"),
            headers: responseHeaders(),
            content: success.sse
              ? {
                  "text/event-stream": {
                    schema: ref(success.schema),
                    ...(success.example === undefined
                      ? {}
                      : { example: success.example }),
                  },
                }
              : jsonContent(success.schema, success.example),
          },
  };
  const errors = new Set<number>(route.errors);
  if (csrf || route.scope) errors.add(403);
  if (route.method !== "get") errors.add(408);
  const context = errorContext(route);
  for (const status of [...errors].sort((a, b) => a - b)) {
    const codes = errorCodesFor(route, status);
    responses[status] = {
      description: errorResponseDescription(codes, context, route.errorNotes),
      headers: responseHeaders(
        status === 429 ||
          (status === 503 && codes.includes("BACKEND_UNAVAILABLE")),
      ),
      content: errorContent(codes),
    };
  }
  responses[500] = { $ref: "#/components/responses/InternalError" };

  return createRoute({
    method: route.method,
    path: route.path,
    operationId: route.operationId,
    tags: [route.tag],
    summary: route.summary,
    description: [
      route.description,
      accessNote(errorContext(route), route.method),
    ]
      .filter(Boolean)
      .join("\n\n"),
    ...(route.scope ? { "x-scope": scopeOf(route) } : {}),
    security: securityFor(route),
    parameters,
    ...(route.body
      ? {
          request: {
            body: {
              required: true,
              content: jsonContent(route.body, route.requestExample),
            },
          },
        }
      : {}),
    responses,
  } as RouteConfig & { path: string }) as ApiRouteConfig;
}

const routeConfigs = new Map<ApiOperationId, ApiRouteConfig>(
  API_ROUTE_DECLARATIONS.map((route) => [
    route.operationId,
    createApiRouteConfig(route),
  ]),
);

export function apiRouteConfig(
  operationId: ApiOperationId,
  basePath = "",
): ApiRouteConfig {
  const route = routeConfigs.get(operationId);
  if (!route) throw new Error(`Unknown API operation ${operationId}`);
  if (!basePath) return route;
  if (route.path !== basePath && !route.path.startsWith(`${basePath}/`)) {
    throw new Error(`${route.path} is not under ${basePath}`);
  }
  const path = route.path.slice(basePath.length) || "/";
  return createRoute({ ...route, path }) as ApiRouteConfig;
}

export function buildOpenApiDocument() {
  const registry = new OpenAPIHono();
  for (const route of API_ROUTE_DECLARATIONS) {
    registry.openapi(
      apiRouteConfig(route.operationId) as never,
      (() => new Response()) as never,
    );
  }
  const generated = registry.getOpenAPI31Document({
    openapi: "3.1.0",
    info: {
      title: "Agent Platform API",
      version: OPENAPI_VERSION,
      description: API_INFO_DESCRIPTION,
    },
  });

  return {
    openapi: generated.openapi,
    info: generated.info,
    tags: OPENAPI_TAGS,
    components: {
      securitySchemes: {
        bearerApiKey: {
          type: "http",
          scheme: "bearer",
          description: SECURITY_SCHEME_DESCRIPTIONS.bearerApiKey,
        },
        cookieSession: {
          type: "apiKey",
          in: "cookie",
          name: WEB_SESSION_COOKIE_NAME,
          description: SECURITY_SCHEME_DESCRIPTIONS.cookieSession,
        },
      },
      headers: RESPONSE_HEADERS,
      schemas,
      responses: {
        InternalError: {
          description:
            "- `INTERNAL_ERROR`: An unexpected server failure. Report it with the `X-Request-Id`.",
          headers: responseHeaders(),
          content: errorContent(["INTERNAL_ERROR"]),
        },
      },
    },
    paths: generated.paths ?? {},
  };
}

export function renderOpenApiDocument(): string {
  return `${JSON.stringify(buildOpenApiDocument(), null, 2)}\n`;
}
