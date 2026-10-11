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
  healthResponseSchema,
  installationLimitsResponseSchema,
  interruptSessionRequestSchema,
  listPendingRequestsResponseSchema,
  listSessionsQuerySchema,
  listSessionsResponseSchema,
  listTurnsQuerySchema,
  listTurnsResponseSchema,
  loginRequestSchema,
  loginResponseSchema,
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
  terminateSessionRequestSchema,
  terminateSessionResponseSchema,
  turnIdParamsSchema,
  turnSummarySchema,
  WEB_SESSION_COOKIE_NAME,
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
  InterruptSessionRequest: interruptSessionRequestSchema,
  PauseSessionRequest: pauseSessionRequestSchema,
  TerminateSessionRequest: terminateSessionRequestSchema,
  ResumeSessionRequest: resumeSessionRequestSchema,
  RecoveryDecisionRequest: recoveryDecisionRequestSchema,
  BootstrapRequest: bootstrapRequestSchema,
  LoginRequest: loginRequestSchema,
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
  ReceiptAcceptedResponse: receiptAcceptedResponseSchema,
  TerminateSessionResponse: terminateSessionResponseSchema,
  Receipt: getReceiptResponseSchema,
  BootstrapResponse: bootstrapResponseSchema,
  LoginResponse: loginResponseSchema,
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

export const API_ROUTE_DECLARATIONS = [
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
    summary: "Authenticated principal",
    description:
      "Checks a credential: answers 200 with the owner it authenticates as, or 401.",
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
    summary: "Create the first owner and default workspace (once)",
    auth: "public",
    body: "BootstrapRequest",
    success: { status: 201, schema: "BootstrapResponse" },
    errors: [400, 401, 409, 413, 503],
    errorCodes: { 409: ["BOOTSTRAP_DONE"] },
    errorNotes: {
      UNAUTHORIZED:
        "`bootstrap_token` is missing or does not match the installation's token; checked before the rest of the body.",
      BOOTSTRAP_DONE:
        "Checked before the token, and also the answer to the loser of two concurrent bootstraps.",
    },
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
    path: "/v1/auth/logout",
    operationId: "logout",
    tag: "Auth",
    summary: "Revoke the session cookie",
    auth: "session",
    success: { status: 204 },
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
    scope: "read",
    success: { status: 200, schema: "AuthMeResponse" },
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
      "Creates a session for a catalog profile and repository and queues `message` as turn `1`. The 201 means the input is stored, not that it ran: follow the turn with `GET /v1/sessions/{id}/turns/{turn_id}` or the event stream. A session waits in `queued` while no execution slot is free; it is never refused for that.",
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
        session_id: "0f8b6a52-3d1e-4c7a-9b2f-5e6d7c8a9b01",
        turn_id: "1",
        receipt_id: "c4a1e9d2-7b3f-4e8a-a6c5-1d2e3f4a5b6c",
        receipt_status: "accepted",
        status: "queued",
      },
    },
    errors: [400, 401, 409, 413, 422, 429, 503],
    errorCodes: {
      409: ["IDEMPOTENCY_CONFLICT"],
      413: ["PAYLOAD_TOO_LARGE", "STORAGE_LIMIT_EXCEEDED"],
    },
    errorNotes: {
      UNSUPPORTED_CAPABILITY:
        "`profile_id` or `repository_id` is not in the catalog, or the catalog does not allow the pair.",
      RATE_LIMITED:
        "Reserved here: the per-session input queue limit applies to later messages, not to the first.",
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
    errorNotes: {
      BAD_REQUEST:
        "Also when the answer does not fit the pending request (its kind, question or option ids); `message` says how.",
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
    errorNotes: {
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
    errorNotes: {
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
    errorNotes: {
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
    scope: "recover",
    body: "RecoveryDecisionRequest",
    success: { status: 202, schema: "ReceiptAcceptedResponse" },
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
  method: "GET" | "POST";
  path: string;
  scope: SessionScope;
}> = API_ROUTE_DECLARATIONS.flatMap((declaration) => {
  const route: RouteDeclaration = declaration;
  const scope = scopeOf(route);
  return scope
    ? [
        {
          method: route.method === "get" ? "GET" : "POST",
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
  return route.method === "post" && route.idempotent !== false;
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
