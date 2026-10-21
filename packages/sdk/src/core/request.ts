import {
  AbortedError,
  APIError,
  ConnectionError,
  TimeoutError,
  type WerftError,
} from "./errors.ts";

/** Every method's last argument. `headers` can never set Authorization or Idempotency-Key. */
export interface RequestOptions {
  signal?: AbortSignal;
  /** Per attempt. */
  timeoutMs?: number;
  maxRetries?: number;
  headers?: Record<string, string>;
}

/** Commands that take an Idempotency-Key. Without one, a key is made per call and sent on every retry. */
export interface MutationOptions extends RequestOptions {
  idempotencyKey?: string;
}

export interface RetryPolicy {
  maxRetries: number;
  maxRetryDelayMs: number;
  timeoutMs: number;
  sleep?: (ms: number, signal: AbortSignal | undefined) => Promise<void>;
  random?: () => number;
}

/**
 * `read` and `keyed` calls are retried after a lost response too; an
 * `unkeyed` command is not, since the server may have run it.
 */
export type CallKind = "read" | "keyed" | "unkeyed";

export interface AttemptInit {
  signal: AbortSignal;
  headers: Record<string, string>;
  idempotencyKey: string;
}

export type Attempt<T> = (
  init: AttemptInit,
) => Promise<{ data?: T; error?: unknown; response: Response }>;

const RESERVED_HEADERS = new Set(["authorization", "idempotency-key"]);

export function checkHeaders(
  headers: Record<string, string> | undefined,
): Record<string, string> {
  for (const name of Object.keys(headers ?? {}))
    if (RESERVED_HEADERS.has(name.toLowerCase()))
      throw new TypeError(`headers cannot set ${name}`);
  return { ...headers };
}

/** The one place for deadlines, retries, the Idempotency-Key and error mapping. */
export async function call<T>(
  policy: RetryPolicy,
  kind: CallKind,
  attempt: Attempt<T>,
  options: MutationOptions = {},
  defaultKey?: string,
): Promise<T> {
  const headers = checkHeaders(options.headers);
  const key =
    kind === "keyed"
      ? (options.idempotencyKey ?? defaultKey ?? crypto.randomUUID())
      : undefined;
  const { signal } = options;
  const maxRetries = options.maxRetries ?? policy.maxRetries;
  const timeoutMs = options.timeoutMs ?? policy.timeoutMs;
  const sleep = policy.sleep ?? abortableSleep;
  const random = policy.random ?? Math.random;

  for (let retry = 0; ; retry++) {
    const attempts = retry + 1;
    const tags = { attempts, idempotencyKey: key };
    if (signal?.aborted)
      throw new AbortedError(signal.reason, { ...tags, attempts: retry });
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(), timeoutMs);
    let failure: WerftError;
    let retryable: boolean;
    try {
      const { data, error, response } = await attempt({
        signal: signal
          ? AbortSignal.any([signal, deadline.signal])
          : deadline.signal,
        headers,
        idempotencyKey: key ?? "",
      });
      if (response.ok) return data as T;
      const apiError = errorFromResponse(response, error, tags);
      failure = apiError;
      retryable = isRetryable(response.status, error);
    } catch (cause) {
      if (signal?.aborted) throw new AbortedError(signal.reason, tags);
      failure = deadline.signal.aborted
        ? new TimeoutError(`No response within ${timeoutMs} ms`, tags)
        : new ConnectionError(
            cause instanceof Error ? cause.message : String(cause),
            { ...tags, cause },
          );
      retryable = kind !== "unkeyed";
    } finally {
      clearTimeout(timer);
    }

    if (!retryable || retry >= maxRetries) throw failure;
    let wait = random() * Math.min(500 * 2 ** retry, 8_000);
    if (failure instanceof APIError && failure.retryAfterMs !== undefined) {
      if (failure.retryAfterMs > policy.maxRetryDelayMs) throw failure;
      wait = failure.retryAfterMs;
    }
    await sleep(wait, signal);
    if (signal?.aborted) throw new AbortedError(signal.reason, tags);
  }
}

interface ErrorBody {
  error?: {
    code?: unknown;
    message?: unknown;
    request_id?: unknown;
    retryable?: unknown;
    details?: unknown;
  };
}

function apiErrorBody(body: unknown): ErrorBody["error"] | undefined {
  const error = (body as ErrorBody | null | undefined)?.error;
  return typeof error?.code === "string" ? error : undefined;
}

/**
 * 409 is always a state conflict and 500 a server bug: neither is retried
 * whatever the body says. A 502 or 504 without the API's error body came
 * from a proxy in front of it.
 */
function isRetryable(status: number, body: unknown): boolean {
  if (status === 409 || status === 500) return false;
  const error = apiErrorBody(body);
  if (error) return error.retryable === true;
  return status === 502 || status === 504;
}

/** A failure `call` would have retried: worth another try on the next poll. */
export function isTransient(error: unknown): boolean {
  if (error instanceof ConnectionError || error instanceof TimeoutError)
    return true;
  if (!(error instanceof APIError)) return false;
  if (error.status === 409 || error.status === 500) return false;
  return (
    error.retryable ||
    ((error.status === 502 || error.status === 504) && error.code === "UNKNOWN")
  );
}

function retryAfterMs(response: Response): number | undefined {
  const header = response.headers.get("retry-after");
  if (header === null || header.trim() === "") return undefined;
  const seconds = Number(header);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1_000 : undefined;
}

const text = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;

export function errorFromResponse(
  response: Response,
  body: unknown,
  tags: { attempts: number; idempotencyKey: string | undefined },
): APIError {
  const error = apiErrorBody(body);
  return new APIError(
    response.status,
    text(error?.code) ?? "UNKNOWN",
    text(error?.message) ?? (response.statusText || `HTTP ${response.status}`),
    {
      ...tags,
      retryable: error?.retryable === true,
      requestId:
        text(error?.request_id) ?? response.headers.get("x-request-id"),
      details: error?.details ?? null,
      retryAfterMs: retryAfterMs(response),
    },
  );
}

export function abortableSleep(
  ms: number,
  signal: AbortSignal | undefined,
): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
  });
}
