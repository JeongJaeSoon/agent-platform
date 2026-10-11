import type { ApiErrorCode } from "@agent-platform/contracts";
import createClient, { type Middleware } from "openapi-fetch";
import type { paths } from "./schema.gen.ts";

export type ApiClient = ReturnType<typeof createApiClient>;

export interface ApiClientOptions {
  /** Same origin as the page by default: the control host serves both. */
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

// Contracts are imported as types only, so the bundle does not carry zod;
// client.test.ts holds these to CSRF_HEADER_NAME and CSRF_HEADER_VALUE.
export const CSRF_HEADER_NAME = "x-requested-with";
export const CSRF_HEADER_VALUE = "agent-platform-web";

// The session cookie rides along on its own (same origin); the header is the
// CSRF proof the API requires of every cookie-authenticated mutation.
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
    // Resolved per call rather than captured, so a test can swap fetch.
    fetch: (request) => (options.fetch ?? globalThis.fetch)(request),
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
