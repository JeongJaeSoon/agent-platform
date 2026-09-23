import { createHash } from "node:crypto";
import { GetObjectCommand } from "@aws-sdk/client-s3";
import { NodeHttpHandler } from "@smithy/node-http-handler";

export interface S3ClientLike {
  send(
    command: unknown,
    options?: { readonly requestTimeout?: number },
  ): Promise<unknown>;
}

export type S3RequestBounds = {
  /**
   * How long any response body may deliver nothing before the handler
   * destroys it. This is the only bound that reaches the bodies the SDK reads
   * for itself — an error document, a ListObjectsV2 page — which it collects
   * inside `send()` before we ever see them.
   */
  readonly bodyIdleMs: number;
  readonly connectionTimeout: number;
  readonly requestTimeout: number;
  readonly throwOnRequestTimeout: boolean;
};

/**
 * Request-stage bounds for every S3 client this package builds. The SDK's node
 * handler ships with neither, so a peer that completes the handshake and then
 * never answers leaves `send()` pending forever.
 *
 * `requestTimeout` runs from `send()` until the response *headers* arrive, the
 * upload included, and it does not care whether bytes are moving. The default
 * therefore has to cover the largest object this client carries — a 128 MiB
 * workspace bundle — which at five minutes means a floor of ~437 KiB/s. A
 * snappier value would abort healthy checkpoint uploads on a slow link, three
 * times over, and still fail. Reads do not upload anything and so do not wait
 * on that budget: they pass {@link BodyReadBounds.requestTimeoutMs} per
 * request instead.
 *
 * `throwOnRequestTimeout` is not optional dressing: without it
 * @smithy/node-http-handler 4.12.1 logs a warning when `requestTimeout`
 * expires and keeps waiting.
 *
 * `socketTimeout` is deliberately absent. It would be the better bound — plain
 * inactivity — but it is installed through `ClientRequest.setTimeout`, which
 * bun's `node:http` does not honour: measured against a peer that accepts and
 * never answers, a 500ms `socketTimeout` was still pending after 4s while the
 * same case under `requestTimeout` failed in 509ms.
 */
export const S3_REQUEST_BOUNDS: S3RequestBounds = {
  bodyIdleMs: 10_000,
  connectionTimeout: 3_000,
  requestTimeout: 300_000,
  throwOnRequestTimeout: true,
};

/**
 * `NodeHttpHandler` with every response body on a leash.
 *
 * Both request timeouts are cleared the moment the response *headers* arrive,
 * and the SDK then reads some bodies itself — an error document on any status
 * >= 300, a ListObjectsV2 page — inside `send()`, before `bodyBytes()` could
 * ever bound them. Measured: a peer that answers `503` with ten bytes of XML
 * and stops leaves `send()` pending forever, and an `abortSignal` passed to
 * `send` does not end it either. Destroying the stream does, and this is the
 * last place that still holds it.
 *
 * The bound is idle time, not total: it is armed from the socket's own data
 * events, so a 128 MiB GetObject that keeps arriving keeps resetting it.
 */
export class BoundedNodeHttpHandler extends NodeHttpHandler {
  readonly #bodyIdleMs: number;

  constructor(bounds: S3RequestBounds) {
    super(bounds);
    this.#bodyIdleMs = bounds.bodyIdleMs;
  }

  override async handle(
    ...args: Parameters<NodeHttpHandler["handle"]>
  ): ReturnType<NodeHttpHandler["handle"]> {
    const result = await super.handle(...args);
    guardResponseBody(result.response.body, this.#bodyIdleMs);
    return result;
  }
}

type GuardableBody = {
  destroy?: (error?: Error) => void;
  on?: (event: string, listener: () => void) => void;
  socket?: {
    on?: (event: string, listener: () => void) => void;
    off?: (event: string, listener: () => void) => void;
  };
};

function guardResponseBody(body: unknown, idleMs: number): void {
  const stream = body as GuardableBody | null;
  if (typeof stream?.destroy !== "function") return;

  let timer: ReturnType<typeof setTimeout> | undefined;
  const onData = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(onIdle, idleMs);
  };
  const onIdle = () => {
    // Listening on the socket rather than the body: a `data` listener on the
    // body would put it in flowing mode and eat the bytes its real consumer
    // is waiting for.
    stream.socket?.off?.("data", onData);
    stream.destroy?.(
      new BodyStallError(`S3 response body delivered nothing for ${idleMs}ms`),
    );
  };
  const settle = () => {
    if (timer) clearTimeout(timer);
    stream.socket?.off?.("data", onData);
  };

  stream.socket?.on?.("data", onData);
  stream.on?.("close", settle);
  stream.on?.("end", settle);
  timer = setTimeout(onIdle, idleMs);
}

/** Bounded retries on top of {@link S3_REQUEST_BOUNDS}. */
export const S3_MAX_ATTEMPTS = 3;

export type BodyReadBounds = {
  /** Attempts at one object's body before the read is given up on. */
  readonly attempts: number;
  /** Ceiling on what one body may accumulate in memory. */
  readonly maxBytes: number;
  /** Budget for one whole body, however steadily it trickles. */
  readonly maxReadMs: number;
  /**
   * Per-request bound for the GetObject itself, in place of the client's
   * upload-sized {@link S3_REQUEST_BOUNDS.requestTimeout}. A read sends almost
   * nothing, so waiting minutes for its response headers only holds the turn.
   */
  readonly requestTimeoutMs: number;
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
 * Three bounds, because one cannot do the job:
 *
 * - `stallMs` is the fast one and the reason this exists: no bytes, no wait.
 *   It is deliberately not a budget for the whole read, since a 128 MiB bundle
 *   may legitimately take minutes on a healthy connection.
 * - `maxReadMs` is the backstop a per-chunk bound cannot be: a peer dripping
 *   one byte just inside `stallMs` stays technically alive forever.
 * - `maxBytes` caps what a body can make this process hold. The checkpoint
 *   service's own 128 MiB gate is the meaningful limit; this one only keeps a
 *   lying `Content-Length` from growing the heap without end.
 */
export const DEFAULT_BODY_READ_BOUNDS: BodyReadBounds = {
  attempts: 3,
  maxBytes: 256 * 1024 * 1024,
  maxReadMs: 300_000,
  requestTimeoutMs: 30_000,
  stallMs: 10_000,
};

/**
 * A response body that stopped delivering bytes within its bound. Worth
 * another request: the stalled socket is gone, so the retry gets a fresh one.
 */
export class BodyStallError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BodyStallError";
  }
}

/**
 * A body that kept delivering but ran past {@link BodyReadBounds.maxReadMs} or
 * {@link BodyReadBounds.maxBytes}. Not retried: a peer that behaves this way
 * on one connection will behave this way on the next, and retrying only
 * multiplies the time a worker turn spends held.
 */
export class BodyLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BodyLimitError";
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
  bounds: BodyReadBounds = DEFAULT_BODY_READ_BOUNDS,
): Promise<Uint8Array> {
  // Iterating comes before `transformToByteArray()` even though SDK bodies
  // offer both: chunk arrival is the only progress signal there is, and
  // without it the bound would have to be a budget for the entire read, which
  // a large object would trip on a perfectly healthy connection.
  if (Symbol.asyncIterator in Object(body)) {
    return readIterable(body as AsyncIterable<Uint8Array | string>, bounds);
  }
  if (
    typeof body === "object" &&
    body !== null &&
    "transformToByteArray" in body &&
    typeof body.transformToByteArray === "function"
  ) {
    // No progress to observe, so the stall bound covers the whole read.
    const collect = body.transformToByteArray() as Promise<Uint8Array>;
    return new Uint8Array(
      await withStallBound(collect, bounds.stallMs, (error) =>
        closeBody(body, error),
      ),
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
  return (await getObjectVersion(client, bucket, key, { bounds }))?.bytes;
}

/**
 * `getObjectBytes` that can ask for one version and says which version
 * answered. A missing version is undefined, like a missing key: S3 answers
 * both with 404.
 */
export async function getObjectVersion(
  client: S3ClientLike,
  bucket: string,
  key: string,
  options: { bounds?: BodyReadBounds; version?: string } = {},
): Promise<{ bytes: Uint8Array; version?: string } | undefined> {
  const bounds = options.bounds ?? DEFAULT_BODY_READ_BOUNDS;
  let lastError: unknown;
  for (let attempt = 1; attempt <= bounds.attempts; attempt += 1) {
    try {
      const response = (await client.send(
        new GetObjectCommand({
          Bucket: bucket,
          Key: key,
          VersionId: options.version,
        }),
        { requestTimeout: bounds.requestTimeoutMs },
      )) as { Body?: unknown; VersionId?: string };
      if (response.Body === undefined) {
        throw new Error(`S3 object has no body: ${key}`);
      }
      const bytes = await bodyBytes(response.Body, bounds);
      const version = storedVersion(response.VersionId);
      return version === undefined ? { bytes } : { bytes, version };
    } catch (error) {
      if (isMissingObject(error)) return undefined;
      if (options.version !== undefined && isMalformedVersion(error)) {
        return undefined;
      }
      if (!(error instanceof BodyStallError)) throw error;
      lastError = error;
    }
  }
  throw new Error(`S3 object body stalled ${bounds.attempts} times: ${key}`, {
    cause: lastError,
  });
}

/**
 * A version id worth recording, or undefined. `"null"` is what S3 calls the
 * version of an object written while versioning was off or suspended, and it
 * is not a version in the sense that matters: the next unversioned write to
 * the key replaces it in place.
 */
export function storedVersion(value: string | undefined): string | undefined {
  return value === undefined || value === "" || value === "null"
    ? undefined
    : value;
}

/**
 * AWS answers a version id it cannot parse with 400 rather than 404. The id
 * came from a manifest a worker wrote, so to the caller it is one more version
 * the store does not have — not an outage worth retrying.
 */
export function isMalformedVersion(error: unknown): boolean {
  const value = awsError(error);
  return (
    value?.name === "InvalidArgument" ||
    value?.Code === "InvalidArgument" ||
    value?.$metadata?.httpStatusCode === 400
  );
}

export function isMissingObject(error: unknown): boolean {
  const value = awsError(error);
  return (
    value?.name === "NoSuchKey" ||
    value?.name === "NoSuchVersion" ||
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
  bounds: BodyReadBounds,
): Promise<Uint8Array> {
  const iterator = body[Symbol.asyncIterator]();
  const startedAt = Date.now();
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const step = await withStallBound(
      iterator.next(),
      bounds.stallMs,
      (error) => closeBody(body, error, iterator),
    );
    if (step.done === true) break;
    const part = step.value;
    const bytes =
      typeof part === "string"
        ? new TextEncoder().encode(part)
        : new Uint8Array(part);
    total += bytes.byteLength;
    // Checked per chunk rather than on a timer: a body that keeps delivering
    // never lets the stall bound fire, so this is the only place a drip is
    // seen for what it is.
    if (total > bounds.maxBytes) {
      throw overLimit(
        body,
        iterator,
        `S3 response body exceeded ${bounds.maxBytes} bytes`,
      );
    }
    if (Date.now() - startedAt > bounds.maxReadMs) {
      throw overLimit(
        body,
        iterator,
        `S3 response body took longer than ${bounds.maxReadMs}ms`,
      );
    }
    parts.push(bytes);
  }
  return concatBytes(parts);
}

function overLimit(
  body: unknown,
  iterator: AsyncIterator<Uint8Array | string>,
  message: string,
): BodyLimitError {
  const error = new BodyLimitError(message);
  try {
    closeBody(body, error, iterator);
  } catch {
    // Best effort, as in withStallBound: the caller still gets the error.
  }
  return error;
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
          try {
            close(error);
          } catch {
            // Letting go of the socket is best effort. A throw here must not
            // escape a timer callback and must not cost us the rejection —
            // that would leave the read pending, which is the hang this
            // whole bound exists to prevent.
          }
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
