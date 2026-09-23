import { z } from "zod";

import {
  apiRootResponseSchema,
  createSessionRequestSchema,
  createSessionResponseSchema,
  getReceiptResponseSchema,
  getSessionResponseSchema,
  getTurnResponseSchema,
  healthResponseSchema,
  interruptSessionRequestSchema,
  listPendingRequestsResponseSchema,
  listSessionsQuerySchema,
  listSessionsResponseSchema,
  listTurnsQuerySchema,
  listTurnsResponseSchema,
  pauseSessionRequestSchema,
  postSessionAnswerRequestSchema,
  postSessionMessageRequestSchema,
  postSessionMessageResponseSchema,
  readyResponseSchema,
  receiptAcceptedResponseSchema,
  recoveryDecisionRequestSchema,
  resumeSessionRequestSchema,
  sessionDurabilitySchema,
  sessionSummarySchema,
  sseEventSchema,
  terminateSessionRequestSchema,
  terminateSessionResponseSchema,
  turnSummarySchema,
} from "./api/index.ts";
import {
  authMeResponseSchema,
  bootstrapRequestSchema,
  bootstrapResponseSchema,
  loginRequestSchema,
  loginResponseSchema,
  type SessionScope,
  WEB_SESSION_COOKIE_NAME,
} from "./domain/index.ts";
import {
  apiErrorResponseSchema,
  receiptIdParamsSchema,
  sessionIdParamsSchema,
  turnIdParamsSchema,
} from "./shared/index.ts";

export const OPENAPI_VERSION = "0.1.0-alpha";

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
} satisfies Record<string, z.ZodType>;

type ComponentName =
  | keyof typeof requestComponents
  | keyof typeof responseComponents;

type Route = {
  method: "get" | "post";
  path: string;
  operationId: string;
  summary: string;
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
  lastEventId?: boolean;
  // Most POSTs are commands and take Idempotency-Key; auth endpoints do not.
  idempotent?: false;
};

const CONFLICTS = [400, 401, 404, 409];

const routes: Route[] = [
  {
    method: "get",
    path: "/healthz",
    operationId: "getHealth",
    summary: "Process liveness",
    success: { status: 200, schema: "HealthResponse" },
    errors: [],
  },
  {
    method: "get",
    path: "/readyz",
    operationId: "getReady",
    summary: "DB, schema and config readiness",
    success: { status: 200, schema: "ReadyResponse" },
    errors: [503],
  },
  {
    method: "get",
    path: "/v1",
    operationId: "getApiRoot",
    summary: "Authenticated principal",
    scope: "read",
    success: { status: 200, schema: "ApiRootResponse" },
    errors: [401, 503],
  },
  {
    method: "post",
    path: "/v1/auth/bootstrap",
    operationId: "bootstrap",
    summary: "Create the first owner and default workspace (once)",
    auth: "public",
    body: "BootstrapRequest",
    success: { status: 201, schema: "BootstrapResponse" },
    errors: [400, 401, 409, 413, 503],
    idempotent: false,
  },
  {
    method: "post",
    path: "/v1/auth/login",
    operationId: "login",
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
    path: "/v1/auth/logout",
    operationId: "logout",
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
    summary: "The authenticated principal, user and workspace",
    scope: "read",
    success: { status: 200, schema: "AuthMeResponse" },
    errors: [401, 503],
  },
  {
    method: "post",
    path: "/v1/sessions",
    operationId: "createSession",
    summary: "Durably accept a session and its first input",
    scope: "write",
    body: "CreateSessionRequest",
    success: { status: 201, schema: "CreateSessionResponse" },
    errors: [400, 401, 409, 413, 422, 429, 503],
  },
  {
    method: "get",
    path: "/v1/sessions",
    operationId: "listSessions",
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
    summary: "Session detail with projection, execution and durability",
    scope: "read",
    success: { status: 200, schema: "SessionDetail" },
    errors: [401, 404, 503],
  },
  {
    method: "post",
    path: "/v1/sessions/{id}/messages",
    operationId: "appendSessionMessage",
    summary: "Enqueue the next input after the current turn",
    scope: "write",
    body: "PostSessionMessageRequest",
    success: { status: 202, schema: "PostSessionMessageResponse" },
    errors: [400, 401, 404, 409, 413, 429, 503],
  },
  {
    method: "get",
    path: "/v1/sessions/{id}/turns",
    operationId: "listSessionTurns",
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
    summary: "Committed result of one turn",
    scope: "read",
    success: { status: 200, schema: "TurnDetail" },
    errors: [401, 404, 503],
  },
  {
    method: "get",
    path: "/v1/sessions/{id}/events",
    operationId: "streamSessionEvents",
    summary: "Durable event replay and live stream (SSE)",
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
    summary: "Open permission and question requests",
    scope: "read",
    success: { status: 200, schema: "ListPendingRequestsResponse" },
    errors: [401, 404, 503],
  },
  {
    method: "post",
    path: "/v1/sessions/{id}/answers",
    operationId: "answerPendingRequest",
    summary: "Answer a pending permission or question request",
    scope: "approve",
    body: "PostSessionAnswerRequest",
    success: { status: 202, schema: "ReceiptAcceptedResponse" },
    errors: [...CONFLICTS, 413, 503],
  },
  {
    method: "post",
    path: "/v1/sessions/{id}/interrupt",
    operationId: "interruptSession",
    summary: "Interrupt the targeted turn only",
    scope: "control",
    body: "InterruptSessionRequest",
    success: { status: 202, schema: "ReceiptAcceptedResponse" },
    // 422: a turn running on the legacy pod binding, which no worker polls
    // control for.
    errors: [...CONFLICTS, 413, 422, 503],
  },
  {
    method: "post",
    path: "/v1/sessions/{id}/pause",
    operationId: "pauseSession",
    summary: "Drain the current turn, checkpoint, stop the execution",
    scope: "control",
    body: "PauseSessionRequest",
    success: { status: 202, schema: "ReceiptAcceptedResponse" },
    // 422: a legacy pod binding, as for terminate.
    errors: [...CONFLICTS, 413, 422, 503],
  },
  {
    method: "post",
    path: "/v1/sessions/{id}/terminate",
    operationId: "terminateSession",
    summary: "Block dispatch and force the execution down",
    scope: "control",
    body: "TerminateSessionRequest",
    success: { status: 202, schema: "TerminateSessionResponse" },
    // Served: an oversized body, a legacy binding with no kill path, and a
    // database outage are real answers.
    errors: [...CONFLICTS, 413, 422, 503],
  },
  {
    method: "post",
    path: "/v1/sessions/{id}/resume",
    operationId: "resumeSession",
    summary: "Restore from the last committed checkpoint or cancel a pause",
    scope: "control",
    body: "ResumeSessionRequest",
    success: { status: 202, schema: "ReceiptAcceptedResponse" },
    // 422: a paused session (94S-138) or a legacy pod binding; 413/503 as
    // for every mutation.
    errors: [...CONFLICTS, 413, 422, 503],
  },
  {
    method: "post",
    path: "/v1/sessions/{id}/recovery-decisions",
    operationId: "decideSessionRecovery",
    summary: "Operator decision for an unknown outcome",
    scope: "recover",
    body: "RecoveryDecisionRequest",
    success: { status: 202, schema: "ReceiptAcceptedResponse" },
    // 422: a legacy pod binding, as for terminate.
    errors: [...CONFLICTS, 413, 422, 503],
  },
  {
    method: "get",
    path: "/v1/receipts/{id}",
    operationId: "getReceipt",
    summary: "Current outcome of an accepted command",
    scope: "read",
    success: { status: 200, schema: "Receipt" },
    errors: [401, 404, 503],
  },
];

/**
 * The session scope each operation demands, as the API enforces it before
 * reading a body or a resource (94S-132). Routes without a scope are the
 * probes, the public auth routes and cookie-only logout.
 */
export const API_ROUTE_SCOPES: ReadonlyArray<{
  method: "GET" | "POST";
  path: string;
  scope: SessionScope;
}> = routes.flatMap((route) =>
  route.scope
    ? [
        {
          method: route.method === "get" ? "GET" : "POST",
          path: route.path,
          scope: `sessions:${route.scope}` as const,
        },
      ]
    : [],
);

type JsonSchema = Record<string, unknown>;

function securityFor(route: Route): Array<Record<string, string[]>> {
  if (route.auth === "public") return [];
  if (route.auth === "session") return [{ cookieSession: [] }];
  return route.scope ? [{ bearerApiKey: [] }, { cookieSession: [] }] : [];
}

// The /v1 middleware refuses a cookie-authenticated POST without the CSRF
// header (403), so every such operation documents both; bearer calls never
// send it, hence `required: false`.
function takesCookieMutation(route: Route): boolean {
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

export function buildOpenApiDocument() {
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

  const paths: Record<string, Record<string, unknown>> = {};
  for (const route of routes) {
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
    const errors = new Set(route.errors);
    // The CSRF refusal, and the scope refusal every scoped route can give.
    if (csrf || route.scope) errors.add(403);
    // The API reads every non-GET body under a deadline before the handler.
    if (route.method !== "get") errors.add(408);
    for (const status of [...errors].sort((a, b) => a - b)) {
      responses[status] = {
        description: "Error",
        content: jsonContent("ApiErrorResponse"),
      };
    }
    const operations = paths[route.path] ?? {};
    paths[route.path] = operations;
    operations[route.method] = {
      operationId: route.operationId,
      summary: route.summary,
      ...(route.scope ? { "x-scope": route.scope } : {}),
      security: securityFor(route),
      parameters,
      ...(route.body
        ? {
            requestBody: {
              required: true,
              content: jsonContent(route.body),
            },
          }
        : {}),
      responses,
    };
  }

  return {
    openapi: "3.1.0",
    info: {
      title: "Agent Platform API",
      version: OPENAPI_VERSION,
      description:
        "Private alpha session control plane. Generated from the Zod contracts in packages/contracts; do not edit by hand.",
    },
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
    },
    paths,
  };
}

export function renderOpenApiDocument(): string {
  return `${JSON.stringify(buildOpenApiDocument(), null, 2)}\n`;
}
