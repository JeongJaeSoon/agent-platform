import {
  type ApiErrorCode,
  apiErrorResponseSchema,
  apiRootResponseSchema,
  authMeResponseSchema,
  bootstrapRequestSchema,
  bootstrapResponseSchema,
  createSessionRequestSchema,
  createSessionResponseSchema,
  getReceiptResponseSchema,
  getSessionResponseSchema,
  getTurnResponseSchema,
  googleLoginCallbackRequestSchema,
  healthResponseSchema,
  installationLimitsResponseSchema,
  interruptSessionRequestSchema,
  issuePasswordResetRequestSchema,
  issuePasswordResetResponseSchema,
  listPendingRequestsResponseSchema,
  listSessionsQuerySchema,
  listSessionsResponseSchema,
  listTakeoversResponseSchema,
  listTurnsQuerySchema,
  listTurnsResponseSchema,
  loginRequestSchema,
  loginResponseSchema,
  memberParamsSchema,
  passwordResetRequestSchema,
  passwordResetResponseSchema,
  pauseSessionRequestSchema,
  postSessionAnswerRequestSchema,
  postSessionMessageRequestSchema,
  postSessionMessageResponseSchema,
  readyResponseSchema,
  receiptAcceptedResponseSchema,
  receiptIdParamsSchema,
  recoveryDecisionRequestSchema,
  resumeSessionRequestSchema,
  type SessionScope,
  sessionDurabilitySchema,
  sessionIdParamsSchema,
  sessionSummarySchema,
  sessionUsageResponseSchema,
  sseEventSchema,
  startGoogleLoginResponseSchema,
  terminateSessionRequestSchema,
  terminateSessionResponseSchema,
  turnIdParamsSchema,
  turnSummarySchema,
  WEB_SESSION_COOKIE_NAME,
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
  InterruptSessionRequest: interruptSessionRequestSchema,
  PauseSessionRequest: pauseSessionRequestSchema,
  TerminateSessionRequest: terminateSessionRequestSchema,
  ResumeSessionRequest: resumeSessionRequestSchema,
  RecoveryDecisionRequest: recoveryDecisionRequestSchema,
  BootstrapRequest: bootstrapRequestSchema,
  LoginRequest: loginRequestSchema,
  PasswordResetRequest: passwordResetRequestSchema,
  GoogleLoginCallbackRequest: googleLoginCallbackRequestSchema,
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
  ReceiptAcceptedResponse: receiptAcceptedResponseSchema,
  TerminateSessionResponse: terminateSessionResponseSchema,
  Receipt: getReceiptResponseSchema,
  BootstrapResponse: bootstrapResponseSchema,
  LoginResponse: loginResponseSchema,
  StartGoogleLoginResponse: startGoogleLoginResponseSchema,
  IssuePasswordResetRequest: issuePasswordResetRequestSchema,
  IssuePasswordResetResponse: issuePasswordResetResponseSchema,
  PasswordResetResponse: passwordResetResponseSchema,
  AuthMeResponse: authMeResponseSchema,
  InstallationLimitsResponse: installationLimitsResponseSchema,
  SessionUsageResponse: sessionUsageResponseSchema,
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
      "Take over the sessions of members who were offboarded. Owners only.",
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
  method: "get" | "post";
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
    body: "CreateSessionRequest",
    success: { status: 201, schema: "CreateSessionResponse" },
    errors: [400, 401, 409, 413, 422, 429, 503],
    errorCodes: {
      409: ["IDEMPOTENCY_CONFLICT"],
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
    success: { status: 202, schema: "ReceiptAcceptedResponse" },
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
      "The caller becomes the session's requester and its queued input runs again. API keys are refused.",
    auth: "session",
    success: { status: 200, schema: "ReceiptAcceptedResponse" },
    errors: [401, 403, 404, 409, 503],
    errorCodes: { 409: ["REQUEST_STALE"] },
    idempotent: false,
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
  method: "GET" | "POST";
  path: string;
  scope: SessionScope;
}> = API_ROUTE_DECLARATIONS.flatMap((declaration) => {
  const route: RouteDeclaration = declaration;
  return route.scope
    ? [
        {
          method: route.method === "get" ? "GET" : "POST",
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

// The /v1 middleware refuses a cookie-authenticated POST without the CSRF
// header (403), so every such operation documents both; bearer calls never
// send it, hence `required: false`.
function takesCookieMutation(route: RouteDeclaration): boolean {
  return (
    route.method === "post" &&
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
  if (path.startsWith("/v1/workspaces/{id}/members/{userId}"))
    return memberParamsSchema;
  if (path.includes("{turn_id}")) return turnIdParamsSchema;
  if (path.startsWith("/v1/sessions/{id}")) return sessionIdParamsSchema;
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
  if (route.method === "post" && route.idempotent !== false) {
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
