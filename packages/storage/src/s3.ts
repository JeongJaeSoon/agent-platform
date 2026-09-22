import { createHash } from "node:crypto";

export interface S3ClientLike {
  send(command: unknown): Promise<unknown>;
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

export async function bodyBytes(body: unknown): Promise<Uint8Array> {
  if (
    typeof body === "object" &&
    body !== null &&
    "transformToByteArray" in body &&
    typeof body.transformToByteArray === "function"
  ) {
    return new Uint8Array(await body.transformToByteArray());
  }
  if (body instanceof Uint8Array) return body;
  if (typeof body === "string") return new TextEncoder().encode(body);
  if (Symbol.asyncIterator in Object(body)) {
    const parts: Uint8Array[] = [];
    for await (const part of body as AsyncIterable<Uint8Array | string>) {
      parts.push(
        typeof part === "string"
          ? new TextEncoder().encode(part)
          : new Uint8Array(part),
      );
    }
    return concatBytes(parts);
  }
  throw new Error("Unsupported S3 response body");
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

function awsError(error: unknown) {
  if (typeof error !== "object" || error === null) return undefined;
  return error as {
    $metadata?: { httpStatusCode?: number };
    Code?: string;
    name?: string;
  };
}
