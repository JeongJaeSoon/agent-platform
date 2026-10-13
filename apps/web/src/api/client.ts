import type { ApiErrorCode } from "@agent-platform/contracts";
import createClient, { type Middleware } from "openapi-fetch";
import type { paths } from "./schema.gen.ts";

export type ApiClient = ReturnType<typeof createApiClient>;

export interface ApiClientOptions {
  readonly baseUrl?: string;
  readonly fetch?: typeof fetch;
}

/**
 * What every failed call becomes. Screens branch on `code` (the server's
 * `error.code`), never on the HTTP status alone, and show `message` as the
 * server wrote it — a 403 says which scope was missing.
 */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: ApiErrorCode | "NETWORK_ERROR" | "UNKNOWN",
    message: string,
    readonly requestId: string | null = null,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export const CSRF_HEADER_NAME = "x-requested-with";
export const CSRF_HEADER_VALUE = "agent-platform-web";

const browserSession: Middleware = {
  onRequest({ request }) {
    request.headers.set(CSRF_HEADER_NAME, CSRF_HEADER_VALUE);
    return request;
  },
};

export function createApiClient(options: ApiClientOptions = {}) {
  const client = createClient<paths>({
    baseUrl: options.baseUrl ?? "",
    credentials: "same-origin",
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });
  client.use(browserSession);
  return client;
}

interface ErrorBody {
  error?: { code?: string; message?: string; request_id?: string };
}

/**
 * The data of a successful call, or an ApiError. Every query and mutation
 * goes through this so a screen sees one error shape.
 */
export async function unwrap<T>(
  call: Promise<{ data?: T; error?: unknown; response: Response }>,
): Promise<T> {
  let result: Awaited<typeof call>;
  try {
    result = await call;
  } catch (cause) {
    throw new ApiError(
      0,
      "NETWORK_ERROR",
      cause instanceof Error ? cause.message : String(cause),
    );
  }
  const { data, error, response } = result;
  if (response.ok) return data as T;
  const body = (error ?? {}) as ErrorBody;
  throw new ApiError(
    response.status,
    (body.error?.code as ApiErrorCode | undefined) ?? "UNKNOWN",
    body.error?.message ?? response.statusText,
    body.error?.request_id ?? response.headers.get("x-request-id"),
  );
}

export function isApiError(error: unknown, code?: string): error is ApiError {
  return (
    error instanceof ApiError && (code === undefined || error.code === code)
  );
}
