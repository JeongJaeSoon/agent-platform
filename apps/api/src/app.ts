import {
  type ApiErrorCode,
  apiErrorResponseSchema,
  apiRootResponseSchema,
} from "@agent-platform/contracts";
import {
  createLogger,
  type StructuredLogger,
} from "@agent-platform/observability";
import { type Context, Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { z } from "zod";
import { type ApiKeyStore, hashApiKey } from "./keys.ts";

export interface ApiVariables {
  ownerId: string;
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
}

export class ApiHttpError extends Error {
  constructor(
    readonly status: ContentfulStatusCode,
    readonly code: ApiErrorCode,
    message: string,
  ) {
    super(message);
  }
}

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
): Response {
  return context.json(
    apiErrorResponseSchema.parse({ error: { code, message } }),
    status,
  );
}

export async function parseJsonBody<T extends z.ZodType>(
  context: Context<ApiEnvironment>,
  schema: T,
): Promise<z.infer<T>> {
  let body: unknown;
  try {
    body = await context.req.json();
  } catch {
    throw new ApiHttpError(400, "bad_request", "Invalid JSON body");
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new ApiHttpError(400, "bad_request", "Request body is invalid");
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

  if (authMode === "none") {
    logger.warn("API authentication is disabled", { auth_mode: "none" });
  }

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
        "unauthorized",
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
    errorResponse(context, 404, "not_found", "Resource not found"),
  );
  app.onError((error, context) => {
    if (error instanceof ApiHttpError) {
      return errorResponse(context, error.status, error.code, error.message);
    }
    logger.error("Unhandled API request error", {
      error_name: error instanceof Error ? error.name : "UnknownError",
      method: context.req.method,
      path: context.req.path,
    });
    return errorResponse(
      context,
      500,
      "internal_error",
      "Internal server error",
    );
  });

  return app;
}
