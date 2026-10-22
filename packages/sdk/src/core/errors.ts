import type { ApiErrorCode, Open } from "../types.ts";

export type ClientErrorCode =
  | "NETWORK_ERROR"
  | "TIMEOUT"
  | "ABORTED"
  | "TURN_BLOCKED"
  | "STREAM_OVERFLOW"
  | "UNKNOWN";

export interface WerftErrorInit {
  attempts?: number;
  idempotencyKey?: string | undefined;
  cause?: unknown;
}

/** One class per failure mechanism, never per code: branch on `code`. */
export class WerftError extends Error {
  readonly code: Open<ApiErrorCode | ClientErrorCode>;
  readonly attempts: number;
  /** Set on every error from a keyed command, aborts included. Retry with this key, not a new one. */
  readonly idempotencyKey: string | undefined;

  constructor(
    code: Open<ApiErrorCode | ClientErrorCode>,
    message: string,
    init: WerftErrorInit = {},
  ) {
    super(
      message,
      init.cause === undefined ? undefined : { cause: init.cause },
    );
    this.name = new.target.name;
    this.code = code;
    this.attempts = init.attempts ?? 1;
    this.idempotencyKey = init.idempotencyKey;
  }
}

export interface APIErrorInit extends WerftErrorInit {
  retryable?: boolean;
  requestId?: string | null;
  details?: unknown;
  retryAfterMs?: number | undefined;
}

/** The server answered with an error. `code` is its `error.code` as sent. */
export class APIError extends WerftError {
  readonly status: number;
  readonly retryable: boolean;
  readonly requestId: string | null;
  readonly details: unknown;
  /** Retry-After in milliseconds, when the response had one. */
  readonly retryAfterMs: number | undefined;

  constructor(
    status: number,
    code: Open<ApiErrorCode | ClientErrorCode>,
    message: string,
    init: APIErrorInit = {},
  ) {
    super(code, message, init);
    this.status = status;
    this.retryable = init.retryable ?? false;
    this.requestId = init.requestId ?? null;
    this.details = init.details ?? null;
    this.retryAfterMs = init.retryAfterMs;
  }
}

/** No response was read: the command may or may not have run. */
export class ConnectionError extends WerftError {
  constructor(message: string, init: WerftErrorInit = {}) {
    super("NETWORK_ERROR", message, init);
  }
}

export class TimeoutError extends WerftError {
  constructor(message: string, init: WerftErrorInit = {}) {
    super("TIMEOUT", message, init);
  }
}

/** The caller's signal aborted. `name` is "AbortError" and `cause` the signal's reason. */
export class AbortedError extends WerftError {
  constructor(reason: unknown, init: Omit<WerftErrorInit, "cause"> = {}) {
    super("ABORTED", "The request was aborted", { ...init, cause: reason });
    this.name = "AbortError";
  }
}

/** waitForTurn only: the session left `active` and the turn cannot end until someone acts. */
export class TurnBlockedError extends WerftError {
  readonly details: { admission_state: string };

  constructor(admissionState: string) {
    super(
      "TURN_BLOCKED",
      `The session is ${admissionState}; the turn cannot finish until it is acted on`,
    );
    this.details = { admission_state: admissionState };
  }
}

export function isApiError<C extends ApiErrorCode>(
  error: unknown,
  code?: C,
): error is APIError & { code: C } {
  return (
    error instanceof APIError && (code === undefined || error.code === code)
  );
}
