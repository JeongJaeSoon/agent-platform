import {
  type ApiErrorCode,
  apiErrorResponseSchema,
  apiRootResponseSchema,
  authMeResponseSchema,
  bootstrapRequestSchema,
  bootstrapResponseSchema,
  createPushRequestRequestSchema,
  createSessionRequestSchema,
  createSessionResponseSchema,
  decidePushRequestRequestSchema,
  getReceiptResponseSchema,
  getSessionResponseSchema,
  getTurnResponseSchema,
  healthResponseSchema,
  installationLimitsResponseSchema,
  interruptSessionRequestSchema,
  listPendingRequestsResponseSchema,
  listPushRequestsResponseSchema,
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
  pushRequestParamsSchema,
  pushRequestSchema,
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
  CreatePushRequestRequest: createPushRequestRequestSchema,
  DecidePushRequestRequest: decidePushRequestRequestSchema,
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
  PushRequest: pushRequestSchema,
  ListPushRequestsResponse: listPushRequestsResponseSchema,
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
    name: "Push requests",
    description:
      "Ask for a session's result to be pushed to its `agent/<session-id>` branch, and approve or reject that push.",
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
  // The service checks `scope` itself, so it can record the refusal; the
  // /v1 scope table leaves the route alone. The document still shows it.
  scopeCheckedBy?: "service";
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
    model: "claude-sonnet-5",
    permission_mode: "default",
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
const EXAMPLE_PUSH_REQUEST_ID = "5b9e2c17-4f3a-4d6e-8a1b-7c0d9e2f3a41";
const EXAMPLE_GIT_COMMIT = "4f2a9c1e7b3d5a8f0c6e2b9d1a4f7c3e5b8d0a2c";
const EXAMPLE_ACTOR = {
  principal: { kind: "user", id: EXAMPLE_USER_ID },
  actor_user_id: EXAMPLE_USER_ID,
  agent_id: null,
};
const EXAMPLE_PUSH_REQUEST = {
  id: EXAMPLE_PUSH_REQUEST_ID,
  session_id: EXAMPLE_SESSION_ID,
  repository_id: "sample-app",
  checkpoint_revision: 3,
  git_commit: EXAMPLE_GIT_COMMIT,
  target_branch: `agent/${EXAMPLE_SESSION_ID}`,
  state: "requested",
  requested_by: EXAMPLE_ACTOR,
  requested_at: "2026-10-11T08:30:00Z",
  decided_by: null,
  decided_at: null,
  decision_reason: null,
  request_receipt_id: EXAMPLE_RECEIPT_ID,
  decision_receipt_id: null,
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
    summary: "Create the first owner and default workspace (once)",
    description:
      "Creates the installation's first user, a workspace and the user's `owner` membership, authorized by the one-time `bootstrap_token` printed at install. It runs once: as soon as any user exists it answers `409 BOOTSTRAP_DONE`. It sets no cookie; sign in with `POST /v1/auth/login` afterwards.",
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
      description: "The owner, the workspace and the membership are created.",
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
      "Says who the credential authenticates as and what it may do: the principal with its scopes, and for a cookie session the user and the workspace. An API key has no user, so `user` is null, and `workspace` is null as well. The web app boots from this. It changes nothing.",
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
      "Creates a session for a catalog profile and repository and queues `message` as turn `1`. The 201 means the input is stored, not that it ran: follow the turn with `GET /v1/sessions/{id}/turns/{turn_id}` or the event stream. `model` picks one of the models the profile offers (its `model` or `models` in the catalog) and is fixed for the session's life; omitted, the profile's default runs. A session waits in `queued` while no execution slot is free; it is never refused for that. The receipt settles with turn `1`: `succeeded` when it completes, `failed` when it fails or is interrupted or cancelled, `unknown` when its outcome is unknown.",
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
    errors: [400, 401, 409, 413, 422, 429, 503],
    errorCodes: {
      409: ["IDEMPOTENCY_CONFLICT"],
      413: ["PAYLOAD_TOO_LARGE", "STORAGE_LIMIT_EXCEEDED"],
    },
    errorNotes: {
      UNSUPPORTED_CAPABILITY:
        "`profile_id` or `repository_id` is not in the catalog, the catalog does not allow the pair, or the profile does not offer `model`.",
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
      "Streams the session's events as Server-Sent Events: first the stored events after `Last-Event-ID` (all of them without it), then new ones as they are written. Each frame's `id` is its cursor, `event` its kind (`system`, `assistant`, `tool_use`, `tool_result`, `question`, `result`, `status`, `error`), and `data` a versioned envelope naming the session, turn and attempt. `question` events announce pending requests; `status` events report the session's status and, after a pause, resume, terminate or recovery decision, its `admission_state`. The stream does not end with a turn or the session: it stays open until the client disconnects or the credential is revoked. Reading changes nothing.\n\nReconnect after backoff with the last complete event id in `Last-Event-ID`; replay resumes strictly after that event. The stream sends a comment keepalive every 15 seconds. `410 CURSOR_EXPIRED` means the cursor fell outside retained history and the client must resynchronize from resource state; alpha does not trim events, so this response is reserved. A `result` event is engine output, not durable completion: confirm the turn with `GET /v1/sessions/{id}/turns/{turn_id}` and treat only `completed`, `failed`, `interrupted`, `cancelled`, or `outcome_unknown` as terminal.",
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
      schema: "ReceiptAcceptedResponse",
      description: "The answer is stored; the receipt tracks its delivery.",
      example: ACCEPTED_RECEIPT,
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
    path: "/v1/sessions/{id}/push-requests",
    operationId: "createPushRequest",
    tag: "Push requests",
    summary: "Ask for the session's latest checkpoint to be pushed",
    description:
      "Pins the session's latest committed checkpoint: its `checkpoint_revision`, the `git_commit` its verified manifest names, the session's `repository_id`, and the target branch `agent/<session-id>`. None of these can be chosen: the body is `{}`. The request starts `requested` and nothing is pushed until a holder of `sessions:approve` approves it (`POST .../push-requests/{push_request_id}/decision`); the push itself is the platform's, never the worker's.\n\nA session has at most one open request (`requested`, `approved` or `pushing`). Every attempt, refused ones included, leaves a `request_push` receipt; a refusal's `error.details.receipt_id` names it. A replayed Idempotency-Key answers the request it created.",
    scope: "write",
    body: "CreatePushRequestRequest",
    requestExample: {},
    success: {
      status: 201,
      schema: "PushRequest",
      description: "The request, pinned and waiting for a decision.",
      example: EXAMPLE_PUSH_REQUEST,
    },
    errors: [...CONFLICTS, 413, 503],
    errorCodes: {
      403: ["FORBIDDEN"],
      409: [
        "IDEMPOTENCY_CONFLICT",
        "PUSH_SOURCE_MISSING",
        "PUSH_REQUEST_OPEN",
        "CHECKPOINT_UNAVAILABLE",
        "CHECKPOINT_MOVED",
      ],
    },
    errorNotes: {
      FORBIDDEN:
        "Also when the deployment does not authenticate callers (`AUTH_MODE=none`): push requests need a verified credential.",
      CHECKPOINT_UNAVAILABLE:
        "Here: the latest checkpoint's manifest did not verify; a push never falls back to an older one.",
      CHECKPOINT_MOVED:
        "Here: the session checkpointed again while the request was being pinned; send it again.",
    },
  },
  {
    method: "get",
    path: "/v1/sessions/{id}/push-requests",
    operationId: "listPushRequests",
    tag: "Push requests",
    summary: "List the session's push requests",
    description:
      "Every push request of the session, newest first, with its state and who requested and decided it.",
    scope: "read",
    success: {
      status: 200,
      schema: "ListPushRequestsResponse",
      description: "The session's push requests.",
      example: { items: [EXAMPLE_PUSH_REQUEST] },
    },
    errors: [401, 404, 503],
  },
  {
    method: "get",
    path: "/v1/sessions/{id}/push-requests/{push_request_id}",
    operationId: "getPushRequest",
    tag: "Push requests",
    summary: "Read one push request",
    description:
      "One push request: what it pinned, its state (`requested`, `approved`, `rejected`, then `pushing`, `pushed` or `failed` once the platform pushes an approved one), and who decided it.",
    scope: "read",
    success: {
      status: 200,
      schema: "PushRequest",
      description: "The push request as it stands now.",
      example: EXAMPLE_PUSH_REQUEST,
    },
    errors: [401, 404, 503],
  },
  {
    method: "post",
    path: "/v1/sessions/{id}/push-requests/{push_request_id}/decision",
    operationId: "decidePushRequest",
    tag: "Push requests",
    summary: "Approve or reject a push request",
    description:
      "Decides a `requested` push request once: `approve` lets the platform push the pinned commit to the request's branch, `reject` closes it. `git_commit` must be the commit the decider reviewed; an approval naming any other is refused. An approval is also refused when the session has checkpointed since the request was made, so what is approved is what the session last committed; reject the request and ask again.\n\nOnly a verified credential that holds `sessions:approve` decides: an API key or a signed-in user. Worker credentials are not accepted on `/v1` at all (401). Every attempt, refused ones included, leaves a `decide_push` receipt carrying the actor, the verdict and the refusal reason; a refusal's `error.details.receipt_id` names it. A replayed Idempotency-Key answers the request as that decision left it.",
    scope: "approve",
    scopeCheckedBy: "service",
    body: "DecidePushRequestRequest",
    requestExample: {
      decision: "approve",
      git_commit: EXAMPLE_GIT_COMMIT,
    },
    success: {
      status: 200,
      schema: "PushRequest",
      description: "The decided request.",
      example: {
        ...EXAMPLE_PUSH_REQUEST,
        state: "approved",
        decided_by: EXAMPLE_ACTOR,
        decided_at: "2026-10-11T08:35:00Z",
        decision_receipt_id: "e1d2c3b4-a5f6-4789-9abc-def012345678",
      },
    },
    errors: [...CONFLICTS, 413, 503],
    errorCodes: {
      403: ["FORBIDDEN"],
      409: ["IDEMPOTENCY_CONFLICT", "PUSH_REQUEST_DECIDED", "CHECKPOINT_MOVED"],
    },
    errorNotes: {
      FORBIDDEN:
        "Also when the principal is not one that may decide, or the deployment does not authenticate callers (`AUTH_MODE=none`).",
      CHECKPOINT_MOVED:
        "Here: an approval whose `git_commit` is not the pinned one, or a session that checkpointed after the request; the request stays `requested`.",
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
      "Reads the current outcome of a command by the `receipt_id` its response returned: `accepted` while it is in progress, then `succeeded`, `failed` (with `error`) or `unknown` (nobody can say; `error` explains). Poll until it leaves `accepted`. `result` depends on `operation`:\n\n- `create_session`, `append_message`: the acceptance response exactly as first returned, never rewritten. The turn's outcome is read from `GET /v1/sessions/{session_id}/turns/{turn_id}` using `target_ref`.\n- `interrupt`: `{turn_id, terminal, no_op}` once settled.\n- `pause`, `resume`: `{resulting_admission_state, checkpoint_revision, queued_turn_count}`.\n- `terminate`: `{execution_gone, checkpoint_revision, unconfirmed_turn_id, external_effects_reverted}`.\n- `recovery_decision`: `{resulting_admission_state, checkpoint_revision, resumable}`.\n- `answer`: null; only `status` and `error` change.\n- `request_push`, `decide_push`, `push`: `{push_request_id, decision, verdict, refusal, repository_id, checkpoint_revision, git_commit, target_branch}`; `verdict` is `allow` or `refuse`, a refused attempt is `failed` with the reason in `refusal` and `error`, and fields the attempt never read are null. `actor` names who made it.\n\nAny credential of the same owner can read a receipt. It changes nothing.",
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
export const DOCUMENTED_ROUTE_SCOPES: ReadonlyArray<{
  method: "GET" | "POST";
  path: string;
  scope: SessionScope;
  checkedBy: "api" | "service";
}> = API_ROUTE_DECLARATIONS.flatMap((declaration) => {
  const route: RouteDeclaration = declaration;
  const scope = scopeOf(route);
  return scope
    ? [
        {
          method: route.method === "get" ? "GET" : "POST",
          path: route.path,
          scope,
          checkedBy: route.scopeCheckedBy ?? "api",
        },
      ]
    : [];
});

export const API_ROUTE_SCOPES = DOCUMENTED_ROUTE_SCOPES.filter(
  (route) => route.checkedBy === "api",
).map(({ method, path, scope }) => ({ method, path, scope }));

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
  if (path.includes("{push_request_id}")) return pushRequestParamsSchema;
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
