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
// Where the proxy reports what a Messages call used (94S-409), on the same
// listener for the same reason: only the proxy may say what a session spent.
export const EGRESS_USAGE_PATH = "/usage";
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

const tokenCount = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

const usageReportSchema = z
  .object({
    exchange_id: z.string().uuid(),
    session_id: z.string().uuid(),
    attempt_id: z.string().min(1).max(256),
    usage: z
      .object({
        model: z.string().min(1).max(256),
        input_tokens: tokenCount,
        output_tokens: tokenCount,
        cache_creation_input_tokens: tokenCount,
        cache_creation_1h_input_tokens: tokenCount,
        cache_read_input_tokens: tokenCount,
        // Optional so a proxy from before 94S-451 still reports; its calls
        // may have been fast, so a missing speed is priced high.
        speed: z.string().min(1).max(64).default("unknown"),
        // Before 94S-454 as well; the call may have run in the US.
        inference_geo: z.string().min(1).max(64).default("unknown"),
        web_search_requests: tokenCount.default(0),
        web_fetch_requests: tokenCount.default(0),
        code_execution_requests: tokenCount.default(0),
        estimated: z.boolean(),
      })
      .strict(),
  })
  .strict();

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
  gateway: Pick<
    WorkerGateway,
    "authorizeEgress" | "authorizeObjectAccess" | "recordProviderUsage"
  >;
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
    if (
      request.method !== "POST" ||
      (url.pathname !== EGRESS_AUTHORIZER_PATH &&
        url.pathname !== EGRESS_USAGE_PATH)
    ) {
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
    if (url.pathname === EGRESS_USAGE_PATH) {
      let report: z.infer<typeof usageReportSchema>;
      try {
        report = usageReportSchema.parse(JSON.parse(text));
      } catch {
        return problem(
          400,
          "BAD_REQUEST",
          "Expected {exchange_id, session_id, attempt_id, usage}",
        );
      }
      return answerWithin(() => recordUsage(report), { purpose: "usage" });
    }
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
    return answerWithin(
      () =>
        body.purpose === "object_store"
          ? authorizeObjectStore(body.token, body)
          : deps.gateway.authorizeEgress(body),
      {
        purpose: body.purpose,
        // Which object store request was refused and why; a key is not a
        // secret, and the worker is told only that it was refused.
        ...(body.purpose === "object_store"
          ? {
              method: body.request.method,
              target: body.request.target.split("?")[0],
            }
          : {}),
      },
    );
  };

  async function recordUsage(report: z.infer<typeof usageReportSchema>) {
    const { usage } = report;
    const priced = await deps.gateway.recordProviderUsage({
      exchangeId: report.exchange_id,
      sessionId: report.session_id,
      attemptId: report.attempt_id,
      usage: {
        model: usage.model,
        inputTokens: usage.input_tokens,
        outputTokens: usage.output_tokens,
        cacheCreationInputTokens: usage.cache_creation_input_tokens,
        cacheCreation1hInputTokens: usage.cache_creation_1h_input_tokens,
        cacheReadInputTokens: usage.cache_read_input_tokens,
        speed: usage.speed,
        inferenceGeo: usage.inference_geo,
        webSearchRequests: usage.web_search_requests,
        webFetchRequests: usage.web_fetch_requests,
        codeExecutionRequests: usage.code_execution_requests,
        estimated: usage.estimated,
      },
    });
    if (priced.pricedBy === "fallback") {
      deps.logger.warn("Provider usage priced at the fallback rate", {
        session_id: report.session_id,
        model: usage.model,
        speed: usage.speed,
        inference_geo: usage.inference_geo,
        cost_usd: priced.costUsd,
      });
    }
    return { cost_usd: priced.costUsd, priced_by: priced.pricedBy };
  }

  async function answerWithin(
    work: () => Promise<unknown>,
    fields: Record<string, string | undefined>,
  ): Promise<Response> {
    const deadline = new RequestDeadline(performance.now() + deadlineMs);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<"expired">((resolve) => {
      timer = setTimeout(() => resolve("expired"), deadlineMs);
    });
    const answered = runWithDeadline(deadline, work);
    try {
      const outcome = await Promise.race([answered, expired]);
      if (outcome === "expired") {
        deadline.expire();
        answered.catch(() => {});
        deps.logger.warn("Egress authorization deadline exceeded", {
          purpose: fields.purpose,
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
          ...fields,
          status: error.status,
          code: error.code,
          ...(fields.purpose === "object_store"
            ? { reason: error.message }
            : {}),
        });
        return problem(error.status, error.code, error.message);
      }
      if (!isStorageUnavailable(error)) {
        deps.logger.error("Egress authorization failed", {
          purpose: fields.purpose,
          error: error instanceof Error ? error.name : "error",
        });
      }
      return problem(503, "BACKEND_UNAVAILABLE", "Authorization unavailable");
    } finally {
      clearTimeout(timer);
    }
  }
}
