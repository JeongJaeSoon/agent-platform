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
  listSessionsQuerySchema,
  listSessionsResponseSchema,
  listTakeoversResponseSchema,
  listTeamsResponseSchema,
  listTurnsQuerySchema,
  listTurnsResponseSchema,
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
  StartGoogleLoginResponse: startGoogleLoginResponseSchema,
  IssuePasswordResetRequest: issuePasswordResetRequestSchema,
  IssuePasswordResetResponse: issuePasswordResetResponseSchema,
  AuditRetentionResponse: auditRetentionResponseSchema,
  PasswordResetResponse: passwordResetResponseSchema,
  AuthMeResponse: authMeResponseSchema,
  InstallationLimitsResponse: installationLimitsResponseSchema,
  SessionUsageResponse: sessionUsageResponseSchema,
  ListAgentsResponse: listAgentsResponseSchema,
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

type RouteDeclaration = {
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
  success:
    | { status: 200 | 201 | 202; schema: ComponentName; sse?: boolean }
    | { status: 204 };
  errors: number[];
  errorCodes?: Partial<Record<number, readonly ApiErrorCode[]>>;
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

const API_ROUTE_DECLARATIONS = [
  {
    method: "get",
    path: "/healthz",
    operationId: "getHealth",
    tag: "Health",
    summary: "Process liveness",
    success: { status: 200, schema: "HealthResponse" },
    errors: [],
  },
  {
    method: "get",
    path: "/readyz",
    operationId: "getReady",
    tag: "Health",
    summary: "DB, schema and config readiness",
    success: { status: 200, schema: "ReadyResponse" },
    errors: [503],
    errorCodes: { 503: ["NOT_READY"] },
  },
  {
    method: "get",
    path: "/v1/openapi.json",
    operationId: "getOpenApiDocument",
    tag: "Health",
    summary: "Generated OpenAPI document",
    auth: "public",
    success: { status: 200, schema: "OpenApiDocument" },
    errors: [],
  },
  {
    method: "get",
    path: "/v1",
    operationId: "getApiRoot",
    tag: "Auth",
    summary: "Authenticated principal",
    scope: "read",
    success: { status: 200, schema: "ApiRootResponse" },
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
    success: { status: 201, schema: "BootstrapResponse" },
    errors: [400, 401, 409, 413, 503],
    errorCodes: { 409: ["BOOTSTRAP_DONE"] },
    idempotent: false,
  },
  {
    method: "post",
    path: "/v1/auth/login",
    operationId: "login",
    tag: "Auth",
    summary: "Email/password login; sets the session cookie",
    auth: "public",
    csrf: "always",
    body: "LoginRequest",
    success: { status: 200, schema: "LoginResponse" },
    errors: [400, 401, 403, 413, 429, 503],
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
    path: "/v1/auth/logout",
    operationId: "logout",
    tag: "Auth",
    summary: "Revoke the session cookie",
    auth: "session",
    success: { status: 204 },
    errors: [401, 403, 503],
    idempotent: false,
  },
  {
    method: "get",
    path: "/v1/auth/me",
    operationId: "getAuthMe",
    tag: "Auth",
    summary: "The authenticated principal, user and workspace",
    scope: "read",
    success: { status: 200, schema: "AuthMeResponse" },
    errors: [401, 503],
  },
  {
    method: "post",
    path: "/v1/sessions",
    operationId: "createSession",
    tag: "Sessions",
    summary: "Durably accept a session and its first input",
    scope: "write",
    description:
      "`agent_release_id` pins the session to that release of an agent, so a key bound to the agent may create it; `profile_id` must be the release's runtime profile (409 RELEASE_PROFILE_MISMATCH). The run itself follows `profile_id`. Every credential the release names must still be bound to its agent; otherwise 409 CREDENTIAL_UNBOUND, whose `details` carry the guidance to show the requester and the agent's admins to ask (`SessionCredentialUnboundDetails`), never the missing names.",
    body: "CreateSessionRequest",
    success: { status: 201, schema: "CreateSessionResponse" },
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
  },
  {
    method: "get",
    path: "/v1/sessions",
    operationId: "listSessions",
    tag: "Sessions",
    summary: "List sessions visible to the principal",
    scope: "read",
    query: "ListSessionsQuery",
    success: { status: 200, schema: "ListSessionsResponse" },
    errors: [400, 401, 503],
  },
  {
    method: "get",
    path: "/v1/sessions/{id}",
    operationId: "getSession",
    tag: "Sessions",
    summary: "Session detail with projection, execution and durability",
    scope: "read",
    success: { status: 200, schema: "SessionDetail" },
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
    method: "get",
    path: "/v1/sessions/{id}/usage",
    operationId: "getSessionUsage",
    tag: "Sessions",
    summary: "Estimated cost of a session and whether every turn reported it",
    scope: "read",
    success: { status: 200, schema: "SessionUsageResponse" },
    errors: [401, 404, 503],
  },
  {
    method: "post",
    path: "/v1/sessions/{id}/messages",
    operationId: "appendSessionMessage",
    tag: "Messages & turns",
    summary: "Enqueue the next input after the current turn",
    scope: "write",
    body: "PostSessionMessageRequest",
    success: { status: 202, schema: "PostSessionMessageResponse" },
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
  },
  {
    method: "get",
    path: "/v1/sessions/{id}/turns",
    operationId: "listSessionTurns",
    tag: "Messages & turns",
    summary: "Queued and finished turns",
    scope: "read",
    query: "ListTurnsQuery",
    success: { status: 200, schema: "ListTurnsResponse" },
    errors: [400, 401, 404, 503],
  },
  {
    method: "get",
    path: "/v1/sessions/{id}/turns/{turn_id}",
    operationId: "getSessionTurn",
    tag: "Messages & turns",
    summary: "Committed result of one turn",
    scope: "read",
    success: { status: 200, schema: "TurnDetail" },
    errors: [401, 404, 503],
  },
  {
    method: "get",
    path: "/v1/sessions/{id}/events",
    operationId: "streamSessionEvents",
    tag: "Events",
    summary: "Durable event replay and live stream (SSE)",
    description:
      "Reconnect after backoff with the last complete event id in `Last-Event-ID`; replay resumes strictly after that event. The stream sends a comment keepalive every 15 seconds and normally remains open. `410 CURSOR_EXPIRED` means the cursor fell outside retained history and the client must resynchronize from resource state; alpha does not trim events, so this response is reserved. A `result` event is engine output, not durable completion: confirm the turn with `GET /v1/sessions/{id}/turns/{turn_id}` and treat only `completed`, `failed`, `interrupted`, `cancelled`, or `outcome_unknown` as terminal.",
    scope: "read",
    lastEventId: true,
    success: { status: 200, schema: "SseEvent", sse: true },
    // 410 CURSOR_EXPIRED is declared for clients but never produced in alpha:
    // events are not trimmed (api.md § 이벤트).
    errors: [400, 401, 404, 410, 429, 503],
  },
  {
    method: "get",
    path: "/v1/sessions/{id}/pending-requests",
    operationId: "listPendingRequests",
    tag: "Pending requests",
    summary: "Open permission and question requests",
    scope: "read",
    success: { status: 200, schema: "ListPendingRequestsResponse" },
    errors: [401, 404, 503],
  },
  {
    method: "post",
    path: "/v1/sessions/{id}/answers",
    operationId: "answerPendingRequest",
    tag: "Pending requests",
    summary: "Answer a pending permission or question request",
    scope: "approve",
    body: "PostSessionAnswerRequest",
    success: { status: 202, schema: "PostSessionAnswerResponse" },
    errors: [...CONFLICTS, 413, 503],
    errorCodes: {
      409: ["IDEMPOTENCY_CONFLICT", "REQUEST_EXPIRED", "REQUEST_STALE"],
    },
  },
  {
    method: "post",
    path: "/v1/sessions/{id}/interrupt",
    operationId: "interruptSession",
    tag: "Session control",
    summary: "Interrupt the targeted turn only",
    description:
      "Accepted while the turn runs: the receipt settles when the turn ends, with a result of `{turn_id, terminal, no_op}`. A new request for a turn that has already ended answers `receipt_status: succeeded` at once, and its receipt says `no_op: true` with the terminal the turn reached on its own: the interrupt did nothing. An interrupt accepted while the turn ran is `no_op: true` too when the turn got to another terminal first; when the turn's outcome is unknown, so is the receipt (`status: unknown`, `no_op: false`). A replayed Idempotency-Key answers the receipt's current status instead.",
    scope: "control",
    body: "InterruptSessionRequest",
    success: { status: 202, schema: "ReceiptAcceptedResponse" },
    // 422: a turn running on the legacy pod binding, which no worker polls
    // control for.
    errors: [...CONFLICTS, 413, 422, 503],
    errorCodes: {
      409: ["IDEMPOTENCY_CONFLICT", "TURN_NOT_STARTED"],
    },
  },
  {
    method: "post",
    path: "/v1/sessions/{id}/pause",
    operationId: "pauseSession",
    tag: "Session control",
    summary: "Drain the current turn, checkpoint, stop the execution",
    scope: "control",
    body: "PauseSessionRequest",
    success: { status: 202, schema: "ReceiptAcceptedResponse" },
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
  },
  {
    method: "post",
    path: "/v1/sessions/{id}/terminate",
    operationId: "terminateSession",
    tag: "Session control",
    summary: "Block dispatch and force the execution down",
    scope: "control",
    body: "TerminateSessionRequest",
    success: { status: 202, schema: "TerminateSessionResponse" },
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
  },
  {
    method: "post",
    path: "/v1/sessions/{id}/resume",
    operationId: "resumeSession",
    tag: "Session control",
    summary: "Restore from the last committed checkpoint or cancel a pause",
    scope: "control",
    body: "ResumeSessionRequest",
    success: { status: 202, schema: "ReceiptAcceptedResponse" },
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
  },
  {
    method: "post",
    path: "/v1/sessions/{id}/recovery-decisions",
    operationId: "decideSessionRecovery",
    tag: "Recovery",
    summary:
      "Operator decision for an unknown outcome or a context no checkpoint covers",
    scope: "recover",
    body: "RecoveryDecisionRequest",
    success: { status: 202, schema: "ReceiptAcceptedResponse" },
    // 422: a legacy pod binding, as for terminate.
    errors: [...CONFLICTS, 413, 422, 503],
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
    path: "/v1/limits",
    operationId: "getInstallationLimits",
    tag: "Limits & receipts",
    summary: "Installation limits and installation-wide usage",
    scope: "read",
    success: { status: 200, schema: "InstallationLimitsResponse" },
    errors: [401, 503],
  },
  {
    method: "get",
    path: "/v1/receipts/{id}",
    operationId: "getReceipt",
    tag: "Limits & receipts",
    summary: "Current outcome of an accepted command",
    scope: "read",
    success: { status: 200, schema: "Receipt" },
    errors: [401, 404, 503],
  },
] as const satisfies readonly RouteDeclaration[];

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
  return route.scope
    ? [
        {
          method: route.method.toUpperCase() as Uppercase<
            RouteDeclaration["method"]
          >,
          path: route.path,
          scope: `sessions:${route.scope}` as SessionScope,
        },
      ]
    : [];
});

type JsonSchema = Record<string, unknown>;

function securityFor(route: RouteDeclaration): Array<Record<string, string[]>> {
  if (route.auth === "public") return [];
  if (route.auth === "session") return [{ cookieSession: [] }];
  return route.scope ? [{ bearerApiKey: [] }, { cookieSession: [] }] : [];
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

function jsonContent(name: ComponentName) {
  return { "application/json": { schema: ref(name) } };
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
  if (route.method !== "get" && route.idempotent !== false) {
    parameters.push({
      name: "Idempotency-Key",
      in: "header",
      required: true,
      schema: { type: "string", minLength: 1, maxLength: 255 },
    });
  }
  if (route.lastEventId) {
    parameters.push({
      name: "Last-Event-ID",
      in: "header",
      required: false,
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
  const responses: Record<string, unknown> = {
    [route.success.status]:
      route.success.status === 204
        ? { description: "No content" }
        : {
            description: route.success.sse ? "Event stream" : "Success",
            content: route.success.sse
              ? {
                  "text/event-stream": { schema: ref(route.success.schema) },
                }
              : jsonContent(route.success.schema),
          },
  };
  const errors = new Set<number>(route.errors);
  if (csrf || route.scope) errors.add(403);
  if (route.method !== "get") errors.add(408);
  for (const status of [...errors].sort((a, b) => a - b)) {
    const codes = errorCodesFor(route, status);
    responses[status] = {
      description: `Error: ${codes.join(", ")}`,
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
    ...(route.description ? { description: route.description } : {}),
    ...(route.scope ? { "x-scope": `sessions:${route.scope}` } : {}),
    security: securityFor(route),
    parameters,
    ...(route.body
      ? {
          request: {
            body: {
              required: true,
              content: jsonContent(route.body),
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
      description:
        "Private alpha session control plane. Generated from the Zod contracts in packages/contracts; do not edit by hand.",
    },
  });

  return {
    openapi: generated.openapi,
    info: generated.info,
    tags: OPENAPI_TAGS,
    components: {
      securitySchemes: {
        bearerApiKey: { type: "http", scheme: "bearer" },
        cookieSession: {
          type: "apiKey",
          in: "cookie",
          name: WEB_SESSION_COOKIE_NAME,
        },
      },
      schemas,
      responses: {
        InternalError: {
          description: "Unexpected server error (INTERNAL_ERROR)",
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
