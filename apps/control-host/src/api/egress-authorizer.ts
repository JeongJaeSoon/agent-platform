import { createHash, timingSafeEqual } from "node:crypto";
import { RequestDeadline, runWithDeadline } from "@agent-platform/db/pool";
import type { StructuredLogger } from "@agent-platform/observability";
import {
  type WorkerGateway,
  WorkerGatewayError,
} from "@agent-platform/platform";
import { z } from "zod";
import { isStorageUnavailable } from "./app.ts";

/**
 * The egress proxy's line to the gateway (94S-252). Every request a worker
 * sends to one of the proxy's credential routes is authorized here, and the
 * answer carries the upstream credential the proxy injects. That is why
 * this is a listener of its own rather than a route on the API's port: the
 * API's port is on the workers' egress allowlist, and this one must never
 * be. The shared bearer is the second lock, not the first.
 */

export const EGRESS_AUTHORIZER_PATH = "/authorize";
// A token and a purpose; anything bigger is not a request from the proxy.
const MAX_BODY_BYTES = 4 * 1024;
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

const authorizeRequestSchema = z
  .object({
    token: z.string().min(1).max(512),
    purpose: z.enum(["provider", "repository"]),
  })
  .strict();

function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

function problem(status: number, code: string, message: string): Response {
  return Response.json({ code, message }, { status });
}

export function createEgressAuthorizer(deps: {
  gateway: Pick<WorkerGateway, "authorizeEgress">;
  logger: StructuredLogger;
  token: string;
  deadlineMs?: number;
}): (request: Request) => Promise<Response> {
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
    const text = await request.text();
    if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) {
      return problem(413, "PAYLOAD_TOO_LARGE", "Request body is too large");
    }
    let body: z.infer<typeof authorizeRequestSchema>;
    try {
      body = authorizeRequestSchema.parse(JSON.parse(text));
    } catch {
      return problem(400, "BAD_REQUEST", "Expected {token, purpose}");
    }
    const deadline = new RequestDeadline(performance.now() + deadlineMs);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<"expired">((resolve) => {
      timer = setTimeout(() => resolve("expired"), deadlineMs);
    });
    const answered = runWithDeadline(deadline, () =>
      deps.gateway.authorizeEgress(body),
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
