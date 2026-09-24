import { createHash, timingSafeEqual } from "node:crypto";
import { RequestDeadline, runWithDeadline } from "@agent-platform/db/pool";
import type { StructuredLogger } from "@agent-platform/observability";
import {
  type WorkerGateway,
  WorkerGatewayError,
} from "@agent-platform/platform";
import type { ObjectRouteSigner } from "@agent-platform/storage";
import { z } from "zod";
import { isStorageUnavailable } from "./app.ts";

/**
 * The egress proxy's line to the gateway (94S-252). Every request a worker
 * sends to one of the proxy's credential routes is authorized here, and the
 * answer carries the upstream credential the proxy injects. That is why
 * this is a listener of its own rather than a route on the API's port: the
 * API's port is on the workers' egress allowlist, and this one must never
 * be. The shared bearer is the second lock, not the first.
 *
 * The object store route (94S-251) asks the same question and one more:
 * whether this one S3 request is one the session may make. Its answer is a
 * signature for that request, made here with the API's own key.
 */

export const EGRESS_AUTHORIZER_PATH = "/authorize";
// A token, a purpose and, for the object store, one S3 request line and its
// headers; anything bigger is not a request from the proxy.
const MAX_BODY_BYTES = 16 * 1024;
// The proxy waits for this before the worker's request goes anywhere, so a
// slow database answers 503 rather than holding the engine's call open.
export const AUTHORIZE_DEADLINE_MS = 10_000;
// A bearer an operator could type from memory is not a lock.
const MIN_TOKEN_LENGTH = 32;

export type EgressAuthorizerConfig = {
  hostname: string;
  port: number;
  token: string;
};

/**
 * Both variables or neither. Neither leaves the listener off, and then no
 * worker can reach its provider or repository: the claim no longer carries
 * a credential of its own to fall back on.
 */
export function egressAuthorizerConfigFromEnv(
  env: Record<string, string | undefined>,
): EgressAuthorizerConfig | null {
  const port = env.EGRESS_AUTHORIZER_PORT;
  const token = env.EGRESS_AUTHORIZER_TOKEN;
  if (port === undefined && token === undefined) return null;
  if (port === undefined || token === undefined) {
    throw new Error(
      "EGRESS_AUTHORIZER_PORT and EGRESS_AUTHORIZER_TOKEN are set together or not at all",
    );
  }
  const parsed = Number(port);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) {
    throw new Error(`EGRESS_AUTHORIZER_PORT ${port} is not a port`);
  }
  if (token.length < MIN_TOKEN_LENGTH) {
    throw new Error(
      `EGRESS_AUTHORIZER_TOKEN must be at least ${MIN_TOKEN_LENGTH} characters`,
    );
  }
  return {
    hostname: env.EGRESS_AUTHORIZER_HOST ?? "0.0.0.0",
    port: parsed,
    token,
  };
}

const tokenSchema = z.string().min(1).max(512);

const authorizeRequestSchema = z.union([
  z
    .object({
      token: tokenSchema,
      purpose: z.enum(["provider", "repository"]),
    })
    .strict(),
  z
    .object({
      token: tokenSchema,
      purpose: z.literal("object_store"),
      request: z
        .object({
          method: z.string().regex(/^[A-Z]{1,16}$/),
          target: z.string().min(1).max(4096),
          headers: z
            .array(z.tuple([z.string().min(1).max(128), z.string().max(1024)]))
            .max(32),
        })
        .strict(),
    })
    .strict(),
]);

/** The body, or null the moment it passes `max`: the rest is never read. */
async function readAtMost(
  request: Request,
  max: number,
): Promise<Uint8Array | null> {
  if (request.body === null) return new Uint8Array(0);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const next = await reader.read();
    if (next.done) break;
    total += next.value.byteLength;
    if (total > max) {
      reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(next.value);
  }
  return Buffer.concat(chunks, total);
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

function problem(status: number, code: string, message: string): Response {
  return Response.json({ code, message }, { status });
}

export function createEgressAuthorizer(deps: {
  gateway: Pick<WorkerGateway, "authorizeEgress" | "authorizeObjectAccess">;
  logger: StructuredLogger;
  /** Absent when the API runs without an object store: the route refuses. */
  objectStore?: ObjectRouteSigner;
  token: string;
  deadlineMs?: number;
}): (request: Request) => Promise<Response> {
  const { objectStore } = deps;
  // The fence first, then the request: a token whose attempt lost its
  // session learns nothing about which of its requests would have passed.
  async function authorizeObjectStore(
    token: string,
    request: z.infer<typeof authorizeRequestSchema> & {
      purpose: "object_store";
    },
  ) {
    const access = await deps.gateway.authorizeObjectAccess({ token });
    if (objectStore === undefined) {
      throw new WorkerGatewayError(
        503,
        "BACKEND_UNAVAILABLE",
        "This API has no object store to sign for",
      );
    }
    const signed = await objectStore.sign(request.request, access.scope);
    if (signed.kind === "refused") {
      throw new WorkerGatewayError(403, "FORBIDDEN", signed.reason);
    }
    return {
      session_id: access.session_id,
      attempt_id: access.attempt_id,
      upstream: {
        url: signed.url,
        target: signed.target,
        headers: signed.headers,
      },
    };
  }
  const expected = digest(`Bearer ${deps.token}`);
  const deadlineMs = deps.deadlineMs ?? AUTHORIZE_DEADLINE_MS;
  return async (request) => {
    const url = new URL(request.url);
    if (request.method !== "POST" || url.pathname !== EGRESS_AUTHORIZER_PATH) {
      return problem(404, "NOT_FOUND", "Not found");
    }
    // Compared as digests so neither the length nor a prefix of the secret
    // leaks through timing.
    if (
      !timingSafeEqual(
        digest(request.headers.get("authorization") ?? ""),
        expected,
      )
    ) {
      return problem(401, "UNAUTHORIZED", "Egress authorizer token required");
    }
    const declared = Number(request.headers.get("content-length") ?? "0");
    if (!Number.isFinite(declared) || declared > MAX_BODY_BYTES) {
      return problem(413, "PAYLOAD_TOO_LARGE", "Request body is too large");
    }
    const bytes = await readAtMost(request, MAX_BODY_BYTES);
    if (bytes === null) {
      return problem(413, "PAYLOAD_TOO_LARGE", "Request body is too large");
    }
    const text = new TextDecoder().decode(bytes);
    let body: z.infer<typeof authorizeRequestSchema>;
    try {
      body = authorizeRequestSchema.parse(JSON.parse(text));
    } catch {
      return problem(
        400,
        "BAD_REQUEST",
        "Expected {token, purpose} and, for the object store, {request}",
      );
    }
    const deadline = new RequestDeadline(performance.now() + deadlineMs);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<"expired">((resolve) => {
      timer = setTimeout(() => resolve("expired"), deadlineMs);
    });
    const answered = runWithDeadline(deadline, () =>
      body.purpose === "object_store"
        ? authorizeObjectStore(body.token, body)
        : deps.gateway.authorizeEgress(body),
    );
    try {
      const outcome = await Promise.race([answered, expired]);
      if (outcome === "expired") {
        deadline.expire();
        answered.catch(() => {});
        deps.logger.warn("Egress authorization deadline exceeded", {
          purpose: body.purpose,
          deadline_ms: deadlineMs,
        });
        return problem(503, "BACKEND_UNAVAILABLE", "Authorization timed out");
      }
      deadline.finish();
      return Response.json(outcome);
    } catch (error) {
      if (error instanceof WorkerGatewayError) {
        // The reason, never the token: a refused token is still a secret
        // that may belong to a live attempt.
        deps.logger.info("Egress authorization refused", {
          purpose: body.purpose,
          status: error.status,
          code: error.code,
          // Which object store request was refused and why; a key is not a
          // secret, and the worker is told only that it was refused.
          ...(body.purpose === "object_store"
            ? {
                method: body.request.method,
                target: body.request.target.split("?")[0],
                reason: error.message,
              }
            : {}),
        });
        return problem(error.status, error.code, error.message);
      }
      if (!isStorageUnavailable(error)) {
        deps.logger.error("Egress authorization failed", {
          purpose: body.purpose,
          error: error instanceof Error ? error.name : "error",
        });
      }
      return problem(503, "BACKEND_UNAVAILABLE", "Authorization unavailable");
    } finally {
      clearTimeout(timer);
    }
  };
}
