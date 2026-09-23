import {
  type ApiErrorCode,
  apiErrorResponseSchema,
  apiRootResponseSchema,
  healthResponseSchema,
  PAYLOAD_TOO_LARGE_ISSUE,
  type Principal,
  REQUEST_BODY_MAX_BYTES,
  readyResponseSchema,
} from "@agent-platform/contracts";
import type { ResolvedWebSession } from "@agent-platform/db";
import { RequestDeadlineExceededError } from "@agent-platform/db/pool";
import {
  createLogger,
  type StructuredLogger,
} from "@agent-platform/observability";
import { type Context, Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { z } from "zod";
import {
  createAuthenticator,
  csrfViolation,
  type IdentityStore,
  ownerIdOf,
} from "./auth.ts";
import {
  BODY_DEADLINE_MS,
  readBodyWithin,
  requestDeadline,
} from "./deadline.ts";
import type { ApiKeyStore } from "./keys.ts";
import type { ReadinessProbe } from "./readiness.ts";

export interface ApiVariables {
  // The alpha partition key; every existing route authorizes on it alone.
  ownerId: string;
  principal: Principal;
  // Present on the cookie path only.
  webSession?: ResolvedWebSession;
  requestId: string;
  // Re-runs the credential check that admitted this request; false once the
  // key is revoked. Long-lived responses (SSE) call it on their clock so a
  // revocation ends the stream instead of outliving it.
  reauthenticate: () => Promise<boolean>;
  // The idle clock while the handler does database work: above the request
  // deadline under /v1, off (0) elsewhere.
  handlerIdleSeconds?: number;
}

export interface ApiBindings {
  // Sets the server's idle clock for this request, in seconds; 0 stops it.
  // The app lifts it above the request deadline (or stops it) for database
  // work so a response that waits on the pool's timeouts is not reset
  // mid-flight, and re-arms it while it ingests a body so a slow sender is
  // still cut off.
  setIdleTimeout?: (seconds: number) => void;
}

export type ApiEnvironment = {
  Bindings: ApiBindings;
  Variables: ApiVariables;
};

const BODYLESS_METHODS = new Set(["GET", "HEAD"]);
// What a connection gets while bytes are still expected; above
// BODY_DEADLINE_MS, so a sender that stops outright gets the 408 too rather
// than a reset.
export const BODY_IDLE_TIMEOUT_SECONDS = 20;

export type ApiRouter = Hono<ApiEnvironment>;

export interface CreateApiAppOptions {
  authMode?: string;
  keyStore?: ApiKeyStore;
  // Enables the cookie-session path of the /v1 middleware (94S-151).
  identity?: IdentityStore;
  logger?: StructuredLogger;
  registerRoutes?: (router: ApiRouter) => void;
  // Mounted under /v1 ahead of the auth middleware: the public allowlist
  // (bootstrap, login, invite accept). Anything not registered here still
  // falls through to the authenticated router and answers 401. Each route
  // attaches ingestThenStopClock itself.
  registerPublicRoutes?: (router: ApiRouter) => void;
  // Mounted under /internal, outside the /v1 API-key middleware; each
  // internal route family brings its own authentication.
  registerInternalRoutes?: (router: ApiRouter) => void;
  // Backs GET /readyz; without one the process reports 503 NOT_READY, so a
  // build that forgot to wire the probe is never routed traffic.
  readiness?: ReadinessProbe;
  // Overrides REQUEST_DEADLINE_MS, for tests.
  requestDeadlineMs?: number;
}

export class ApiHttpError extends Error {
  constructor(
    readonly status: ContentfulStatusCode,
    readonly code: ApiErrorCode,
    message: string,
    readonly retryable = false,
  ) {
    super(message);
  }
}

const SOCKET_ERROR_CODES = new Set([
  "ETIMEDOUT",
  "EPIPE",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EAI_AGAIN",
]);

// pg raises these without a code when a socket drops, a timeout fires, or a
// saturated pool cannot hand out a client (pg/lib/client.js, pg-pool/index.js).
const PG_CONNECTION_MESSAGES =
  /^(Connection terminated|timeout expired|Query read timeout|timeout exceeded when trying to connect|Client has encountered a connection error|Client was closed and is not queryable)/;

// Postgres connection (08xxx), insufficient-resources (53xxx: too many
// connections, disk full) and operator-intervention (57xxx: admin shutdown,
// and 57014 for a statement_timeout cancel) SQLSTATEs, node socket errors,
// and pg's code-less connection failures. Walks the cause chain because
// Drizzle and pg-pool both wrap the original error.
export function isStorageUnavailable(error: unknown): boolean {
  for (let depth = 0, current = error; depth < 5; depth += 1) {
    if (current instanceof RequestDeadlineExceededError) {
      return true;
    }
    const code = (current as { code?: unknown })?.code;
    if (
      typeof code === "string" &&
      (code.startsWith("08") ||
        code.startsWith("53") ||
        code.startsWith("57") ||
        code.startsWith("ECONN") ||
        SOCKET_ERROR_CODES.has(code))
    ) {
      return true;
    }
    if (
      current instanceof Error &&
      PG_CONNECTION_MESSAGES.test(current.message)
    ) {
      return true;
    }
    if (!(current instanceof Error) || !current.cause) {
      return false;
    }
    current = current.cause;
  }
  return false;
}

export function storageUnavailableError(): ApiHttpError {
  return new ApiHttpError(
    503,
    "BACKEND_UNAVAILABLE",
    "Storage is unavailable, retry later",
    true,
  );
}

// Errors the auth middleware can produce on every /v1 route; the OpenAPI
// parity test holds the root operation to this.
export const rootRouteErrors = [401, 503];
// What the same middleware adds on an unsafe method: the CSRF refusal of a
// cookie principal.
export const mutationRouteErrors = [403];
// What every /v1 route that reads a body can answer before its handler runs,
// public or not: the body deadline.
export const bodyRouteErrors = [408];
// Liveness never fails; readiness only ever answers 503 NOT_READY.
export const probeRouteErrors: Record<string, number[]> = {
  "GET /healthz": [],
  "GET /readyz": [503],
};

const missingKeyStore: ApiKeyStore = {
  async findOwner() {
    return null;
  },
};

function errorResponse(
  context: Context<ApiEnvironment>,
  status: ContentfulStatusCode,
  code: ApiErrorCode,
  message: string,
  retryable = false,
  details: unknown = null,
): Response {
  return context.json(
    apiErrorResponseSchema.parse({
      error: {
        code,
        message,
        retryable,
        request_id: context.get("requestId"),
        details,
      },
    }),
    status,
  );
}

export async function parseJsonBody<T extends z.ZodType>(
  context: Context<ApiEnvironment>,
  schema: T,
): Promise<z.infer<T>> {
  // Measure the bytes actually received; Content-Length can be absent or lie.
  const raw = await context.req.arrayBuffer();
  if (raw.byteLength > REQUEST_BODY_MAX_BYTES) {
    throw new ApiHttpError(413, "PAYLOAD_TOO_LARGE", "Request body too large");
  }
  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder().decode(raw));
  } catch {
    throw new ApiHttpError(400, "BAD_REQUEST", "Invalid JSON body");
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    const oversized = parsed.error.issues.some(
      (issue) =>
        issue.code === "custom" &&
        issue.params?.code === PAYLOAD_TOO_LARGE_ISSUE,
    );
    if (oversized) {
      throw new ApiHttpError(
        413,
        "PAYLOAD_TOO_LARGE",
        "Request field too large",
      );
    }
    throw new ApiHttpError(400, "BAD_REQUEST", "Request body is invalid");
  }
  return parsed.data;
}

export function jsonWithSchema<T extends z.ZodType>(
  context: Context<ApiEnvironment>,
  schema: T,
  value: z.input<T>,
  status: ContentfulStatusCode = 200,
): Response {
  return context.json(schema.parse(value), status);
}

function setHandlerClock(context: Context<ApiEnvironment>): void {
  (context.env?.setIdleTimeout ?? (() => {}))(
    context.get("handlerIdleSeconds") ?? 0,
  );
}

// Read and bound a body under the idle clock and BODY_DEADLINE_MS; the
// caller sets the handler's clock afterwards for its database work. The bytes
// go into Hono's body cache, so parseJsonBody reads the same bytes. Returns
// the 408 or 413 to send, or null.
async function ingestBody(
  context: Context<ApiEnvironment>,
): Promise<Response | null> {
  if (BODYLESS_METHODS.has(context.req.method)) {
    return null;
  }
  const setIdleTimeout = context.env?.setIdleTimeout ?? (() => {});
  setIdleTimeout(BODY_IDLE_TIMEOUT_SECONDS);
  const read = await readBodyWithin(
    context.req.raw,
    BODY_DEADLINE_MS,
    REQUEST_BODY_MAX_BYTES,
  );
  if (read.kind === "timeout") {
    // The rest of the body may still be on its way; close rather than keep
    // the connection for the next request behind it.
    context.header("Connection", "close");
    // Nothing has run yet, so sending the same request again is safe.
    return errorResponse(
      context,
      408,
      "REQUEST_TIMEOUT",
      "Request body was not received in time",
      true,
    );
  }
  if (read.size > REQUEST_BODY_MAX_BYTES) {
    return errorResponse(
      context,
      413,
      "PAYLOAD_TOO_LARGE",
      "Request body too large",
    );
  }
  // Hono keeps the pending read per body type here (#cachedBody); its
  // declared type is the Body interface, not what it actually stores.
  (
    context.req.bodyCache as unknown as { arrayBuffer?: Promise<ArrayBuffer> }
  ).arrayBuffer = Promise.resolve(read.bytes);
  return null;
}

// Body under the clock, then the handler's clock: what every route outside
// the /v1 principal middleware does. Public /v1 routes attach
// it per route, never as a `*` middleware: that router is mounted ahead of
// the authenticated one, so a wildcard there would read every /v1 body
// before authentication and undo the auth-before-body rule.
export async function ingestThenStopClock(
  context: Context<ApiEnvironment>,
  next: () => Promise<void>,
): Promise<Response | undefined> {
  const rejected = await ingestBody(context);
  if (rejected) {
    return rejected;
  }
  setHandlerClock(context);
  await next();
  return undefined;
}

export function createApiApp(options: CreateApiAppOptions = {}): ApiRouter {
  const authMode = options.authMode ?? process.env.AUTH_MODE;
  const keyStore = options.keyStore ?? missingKeyStore;
  const logger = options.logger ?? createLogger();
  const app = new Hono<ApiEnvironment>({ strict: false });
  const v1 = new Hono<ApiEnvironment>({ strict: false });
  app.use("*", async (context, next) => {
    const requestId = crypto.randomUUID();
    context.set("requestId", requestId);
    context.header("X-Request-Id", requestId);
    await logger.withContext({ request_id: requestId }, next);
  });

  if (authMode === "none") {
    logger.warn("API authentication is disabled", { auth_mode: "none" });
  }

  // Probes sit outside /v1 so an orchestrator needs no API key to call them.
  app.get("/healthz", (context) =>
    jsonWithSchema(context, healthResponseSchema, { status: "ok" }),
  );
  app.get("/readyz", async (context) => {
    const result = options.readiness
      ? await options.readiness()
      : ({
          ready: false,
          check: "config",
          reason: "no readiness probe",
        } as const);
    if (!result.ready) {
      logger.warn("API readiness check failed", {
        check: result.check,
        reason: result.reason,
      });
      return errorResponse(
        context,
        503,
        "NOT_READY",
        `Not ready: ${result.check} check failed`,
        true,
        { check: result.check },
      );
    }
    return jsonWithSchema(context, readyResponseSchema, {
      status: "ready",
      checks: { database: "ok", schema: "ok", config: "ok" },
    });
  });

  const authenticator = createAuthenticator({
    authMode,
    keyStore,
    ...(options.identity ? { identity: options.identity } : {}),
  });
  // Ahead of both /v1 routers, so the public routes are bounded too.
  app.use(
    "/v1/*",
    requestDeadline({
      logger,
      expired: storageUnavailableError,
      ...(options.requestDeadlineMs === undefined
        ? {}
        : { deadlineMs: options.requestDeadlineMs }),
    }),
  );
  v1.use("*", async (context, next) => {
    // Authenticate before touching the body, so an unauthenticated sender
    // cannot hold a connection open by dripping bytes; the key lookup is
    // database work, which requestDeadline already set the clock for.
    const authenticated = await authenticator.authenticate(context);
    if (!authenticated) {
      logger.warn("API authentication failed", {
        method: context.req.method,
        path: context.req.path,
      });
      return errorResponse(
        context,
        401,
        "UNAUTHORIZED",
        "Authentication is required",
      );
    }
    const violation = csrfViolation(context, authenticated.principal);
    if (violation) {
      logger.warn("API request refused by CSRF check", {
        method: context.req.method,
        path: context.req.path,
        reason: violation,
      });
      return errorResponse(context, 403, "FORBIDDEN", `Refused: ${violation}`);
    }
    context.set("principal", authenticated.principal);
    context.set("ownerId", ownerIdOf(authenticated.principal));
    context.set("reauthenticate", authenticated.reauthenticate);
    if (authenticated.webSession) {
      context.set("webSession", authenticated.webSession);
    }

    // Ingest and bound the body under the idle clock, then hand the request
    // to the route with the handler's clock for its database work.
    if (!BODYLESS_METHODS.has(context.req.method)) {
      const rejected = await ingestBody(context);
      if (rejected) {
        return rejected;
      }
      setHandlerClock(context);
    }
    await next();
  });

  const rootHandler = (context: Context<ApiEnvironment>) =>
    jsonWithSchema(context, apiRootResponseSchema, {
      status: "ok",
      owner_id: context.get("ownerId"),
    });
  v1.get("", rootHandler);
  v1.get("/", rootHandler);
  options.registerRoutes?.(v1);
  if (options.registerPublicRoutes) {
    // No middleware here: see ingestThenStopClock.
    const publicV1 = new Hono<ApiEnvironment>({ strict: false });
    options.registerPublicRoutes(publicV1);
    app.route("/v1", publicV1);
  }
  app.route("/v1", v1);
  if (options.registerInternalRoutes) {
    const internal = new Hono<ApiEnvironment>({ strict: false });
    // These routes are outside the /v1 middleware but need the same clock
    // management, and more of it: the gateway's long poll holds a connection
    // open for longer than the server's idle default, so a poll that finds
    // no input would be cut off mid-wait. Each internal family authenticates
    // itself, so the body is read under the clock and the clock is then
    // stopped for the handler.
    internal.use("*", ingestThenStopClock);
    options.registerInternalRoutes(internal);
    app.route("/internal", internal);
  }

  app.notFound((context) =>
    errorResponse(context, 404, "NOT_FOUND", "Resource not found"),
  );
  app.onError((error, context) => {
    if (error instanceof ApiHttpError) {
      return errorResponse(
        context,
        error.status,
        error.code,
        error.message,
        error.retryable,
      );
    }
    // The key lookup in the auth middleware runs before any route, so a
    // database outage must map to 503 here, not only inside the handlers.
    if (isStorageUnavailable(error)) {
      const unavailable = storageUnavailableError();
      logger.warn("Storage unavailable during API request", {
        method: context.req.method,
        path: context.req.path,
      });
      return errorResponse(
        context,
        unavailable.status,
        unavailable.code,
        unavailable.message,
        unavailable.retryable,
      );
    }
    logger.error("Unhandled API request error", {
      error_name: error instanceof Error ? error.name : "UnknownError",
      method: context.req.method,
      path: context.req.path,
    });
    return errorResponse(
      context,
      500,
      "INTERNAL_ERROR",
      "Internal server error",
    );
  });

  return app;
}
