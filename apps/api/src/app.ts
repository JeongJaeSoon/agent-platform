import {
  type ApiErrorCode,
  apiErrorResponseSchema,
  apiRootResponseSchema,
  healthResponseSchema,
  PAYLOAD_TOO_LARGE_ISSUE,
  REQUEST_BODY_MAX_BYTES,
  readyResponseSchema,
} from "@agent-platform/contracts";
import {
  createLogger,
  type StructuredLogger,
} from "@agent-platform/observability";
import { type Context, Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { z } from "zod";
import { type ApiKeyStore, hashApiKey } from "./keys.ts";
import type { ReadinessProbe } from "./readiness.ts";

export interface ApiVariables {
  ownerId: string;
  requestId: string;
}

export type ApiEnvironment = {
  Variables: ApiVariables;
};

export type ApiRouter = Hono<ApiEnvironment>;

export interface CreateApiAppOptions {
  authMode?: string;
  keyStore?: ApiKeyStore;
  logger?: StructuredLogger;
  registerRoutes?: (router: ApiRouter) => void;
  // Backs GET /readyz; without one the process reports 503 NOT_READY, so a
  // build that forgot to wire the probe is never routed traffic.
  readiness?: ReadinessProbe;
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
  /^(Connection terminated|timeout expired|Query read timeout|timeout exceeded when trying to connect|Client has encountered a connection error)/;

// Postgres connection (08xxx), insufficient-resources (53xxx: too many
// connections, disk full) and operator-intervention (57xxx: admin shutdown,
// and 57014 for a statement_timeout cancel) SQLSTATEs, node socket errors,
// and pg's code-less connection failures. Walks the cause chain because
// Drizzle and pg-pool both wrap the original error.
export function isStorageUnavailable(error: unknown): boolean {
  for (let depth = 0, current = error; depth < 5; depth += 1) {
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

function bearerToken(value: string | undefined): string | null {
  if (!value) {
    return null;
  }
  const match = /^Bearer ([^\s]+)$/.exec(value);
  return match?.[1] ?? null;
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

  v1.use("*", async (context, next) => {
    let ownerId: string | null = null;
    if (authMode === "none") {
      ownerId = context.req.header("X-Owner-Id")?.trim() || null;
    } else {
      const token = bearerToken(context.req.header("Authorization"));
      if (token) {
        ownerId = await keyStore.findOwner(hashApiKey(token));
      }
    }

    if (!ownerId) {
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
    context.set("ownerId", ownerId);
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
  app.route("/v1", v1);

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
