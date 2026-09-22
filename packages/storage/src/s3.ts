import { createHash } from "node:crypto";
import { GetObjectCommand } from "@aws-sdk/client-s3";

export interface S3ClientLike {
  send(command: unknown): Promise<unknown>;
}

export type S3RequestBounds = {
  readonly connectionTimeout: number;
  readonly requestTimeout: number;
  readonly throwOnRequestTimeout: boolean;
};

/**
 * Request-stage bounds for every S3 client this package builds. The SDK's node
 * handler ships without either timeout, so a peer that completes the handshake
 * and then never answers leaves `send()` pending forever.
 *
 * `throwOnRequestTimeout` is not optional dressing: without it
 * @smithy/node-http-handler 4.12.1 logs a warning when `requestTimeout`
 * expires and keeps waiting.
 *
 * `requestTimeout` runs from `send()` until the response headers arrive, the
 * request upload included, so it has to cover the largest object that travels
 * through this client — a 128 MiB workspace bundle.
 */
export const S3_REQUEST_BOUNDS: S3RequestBounds = {
  connectionTimeout: 3_000,
  requestTimeout: 60_000,
  throwOnRequestTimeout: true,
};

/** Bounded retries on top of {@link S3_REQUEST_BOUNDS}. */
export const S3_MAX_ATTEMPTS = 3;

export type BodyReadBounds = {
  /** Attempts at one object's body before the read is given up on. */
  readonly attempts: number;
  /** How long a body may deliver nothing before the read is abandoned. */
  readonly stallMs: number;
};

/**
 * A GetObject settles when the response *headers* arrive; the body is a stream
 * consumed afterwards, and nothing in the AWS SDK bounds that read — neither
 * `requestTimeout` nor an `abortSignal` passed to `send` reaches a stream the
 * handler has already handed over. 94S-217 measured both still hanging after
 * 20s against a peer that stopped mid-body. Destroying the stream is the only
 * thing that ends the wait, so the bound lives here rather than in the client.
 *
 * It bounds a *stall*, not the whole read: a 128 MiB bundle may take as long as
 * it needs as long as bytes keep arriving.
 */
export const DEFAULT_BODY_READ_BOUNDS: BodyReadBounds = {
  attempts: 3,
  stallMs: 10_000,
};

/** A response body that stopped delivering bytes within its bound. */
export class BodyStallError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BodyStallError";
  }
}

export function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
  const combined = new Uint8Array(
    parts.reduce((sum, part) => sum + part.byteLength, 0),
  );
  let offset = 0;
  for (const part of parts) {
    combined.set(part, offset);
    offset += part.byteLength;
  }
  return combined;
}

export async function bodyBytes(
  body: unknown,
  stallMs: number = DEFAULT_BODY_READ_BOUNDS.stallMs,
): Promise<Uint8Array> {
  // Iterating comes before `transformToByteArray()` even though SDK bodies
  // offer both: chunk arrival is the only progress signal there is, and
  // without it the bound would have to be a budget for the entire read, which
  // a large object would trip on a perfectly healthy connection.
  if (Symbol.asyncIterator in Object(body)) {
    return readIterable(body as AsyncIterable<Uint8Array | string>, stallMs);
  }
  if (
    typeof body === "object" &&
    body !== null &&
    "transformToByteArray" in body &&
    typeof body.transformToByteArray === "function"
  ) {
    // No progress to observe, so the one bound covers the whole read.
    const collect = body.transformToByteArray() as Promise<Uint8Array>;
    return new Uint8Array(
      await withStallBound(collect, stallMs, (error) => closeBody(body, error)),
    );
  }
  if (body instanceof Uint8Array) return body;
  if (typeof body === "string") return new TextEncoder().encode(body);
  throw new Error("Unsupported S3 response body");
}

/**
 * GetObject with the body read bounded and, on a stall, retried.
 *
 * A stalled body is a property of the connection, not of the object: the bound
 * destroys the stream on its way out, so the retry's request opens a fresh
 * socket instead of queueing behind the dead one. Returns undefined for a
 * missing key, which is how both callers tell "absent" from "failed".
 */
export async function getObjectBytes(
  client: S3ClientLike,
  bucket: string,
  key: string,
  bounds: BodyReadBounds = DEFAULT_BODY_READ_BOUNDS,
): Promise<Uint8Array | undefined> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= bounds.attempts; attempt += 1) {
    try {
      const response = (await client.send(
        new GetObjectCommand({ Bucket: bucket, Key: key }),
      )) as { Body?: unknown };
      if (response.Body === undefined) {
        throw new Error(`S3 object has no body: ${key}`);
      }
      return await bodyBytes(response.Body, bounds.stallMs);
    } catch (error) {
      if (isMissingObject(error)) return undefined;
      if (!(error instanceof BodyStallError)) throw error;
      lastError = error;
    }
  }
  throw new Error(`S3 object body stalled ${bounds.attempts} times: ${key}`, {
    cause: lastError,
  });
}

export function isMissingObject(error: unknown): boolean {
  const value = awsError(error);
  return (
    value?.name === "NoSuchKey" ||
    value?.name === "NotFound" ||
    value?.$metadata?.httpStatusCode === 404
  );
}

/**
 * How S3 reports a failed `If-None-Match: *`. Implementations differ on where
 * they put the marker, so any of the three counts.
 */
export function isPreconditionFailed(error: unknown): boolean {
  const value = awsError(error);
  return (
    value?.name === "PreconditionFailed" ||
    value?.Code === "PreconditionFailed" ||
    value?.$metadata?.httpStatusCode === 412
  );
}

/**
 * The other answer a conditional write can get. S3 returns 409
 * `ConditionalRequestConflict` when two conditional writes to one key overlap,
 * and its contract says to retry — unlike 412, it is not a verdict about who
 * won. Treating it as fatal turns an ordinary race into a mirror failure.
 */
export function isConditionalConflict(error: unknown): boolean {
  const value = awsError(error);
  return (
    value?.name === "ConditionalRequestConflict" ||
    value?.Code === "ConditionalRequestConflict" ||
    value?.$metadata?.httpStatusCode === 409
  );
}

async function readIterable(
  body: AsyncIterable<Uint8Array | string>,
  stallMs: number,
): Promise<Uint8Array> {
  const iterator = body[Symbol.asyncIterator]();
  const parts: Uint8Array[] = [];
  for (;;) {
    const step = await withStallBound(iterator.next(), stallMs, (error) =>
      closeBody(body, error, iterator),
    );
    if (step.done === true) break;
    const part = step.value;
    parts.push(
      typeof part === "string"
        ? new TextEncoder().encode(part)
        : new Uint8Array(part),
    );
  }
  return concatBytes(parts);
}

async function withStallBound<T>(
  pending: Promise<T>,
  stallMs: number,
  close: (error: Error) => void,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      pending,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          const error = new BodyStallError(
            `S3 response body delivered nothing for ${stallMs}ms`,
          );
          close(error);
          reject(error);
        }, stallMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Lets go of a stalled body. `destroy()` is what releases the socket, which is
 * why a retry reaches a fresh connection rather than waiting behind the dead
 * one; an async iterable with no `destroy` is closed through `return()`.
 */
function closeBody(
  body: unknown,
  error: Error,
  iterator?: AsyncIterator<Uint8Array | string>,
): void {
  const destroy = (body as { destroy?: (cause?: Error) => void }).destroy;
  if (typeof destroy === "function") {
    destroy.call(body, error);
    return;
  }
  void Promise.resolve(iterator?.return?.()).catch(() => undefined);
}

function awsError(error: unknown) {
  if (typeof error !== "object" || error === null) return undefined;
  return error as {
    $metadata?: { httpStatusCode?: number };
    Code?: string;
    name?: string;
  };
}
