import {
  appendEventsRequestSchema,
  appendEventsResponseSchema,
  bootstrapClaimRequestSchema,
  bootstrapClaimResponseSchema,
  checkpointRequestResponseSchema,
  checkpointRequestSchema,
  finalizeRequestSchema,
  finalizeResponseSchema,
  heartbeatRequestSchema,
  heartbeatResponseSchema,
  nextInputRequestSchema,
  nextInputResponseSchema,
  releaseRequestSchema,
  releaseResponseSchema,
  restorePlanRequestSchema,
  restorePlanResponseSchema,
} from "@agent-platform/contracts";
import {
  type WorkerGateway,
  WorkerGatewayError,
  type WorkerPrincipal,
} from "@agent-platform/platform";
import type { Context } from "hono";
import type { z } from "zod";
import {
  type ApiEnvironment,
  ApiHttpError,
  type ApiRouter,
  isStorageUnavailable,
  jsonWithSchema,
  parseJsonBody,
  storageUnavailableError,
} from "../app.ts";

export const WORKER_ROUTE_PREFIX = "/worker";

function bearerToken(value: string | undefined): string | null {
  const match = value ? /^Bearer ([^\s]+)$/.exec(value) : null;
  return match?.[1] ?? null;
}

async function mapped<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof WorkerGatewayError) {
      throw new ApiHttpError(
        error.status,
        error.code,
        error.message,
        error.retryable,
      );
    }
    if (isStorageUnavailable(error)) {
      throw storageUnavailableError();
    }
    throw error;
  }
}

// Internal worker protocol. It never shares the /v1 API-key middleware: the
// bearer token here is a launch nonce (bootstrapClaim only) or the session
// token bootstrapClaim issued, and the gateway checks it names the binding
// the body claims to act for.
export function registerWorkerRoutes(
  router: ApiRouter,
  gateway: WorkerGateway,
) {
  const authenticate = (context: Context<ApiEnvironment>) =>
    mapped(() =>
      gateway.authenticate(bearerToken(context.req.header("Authorization"))),
    );

  function call<Req extends z.ZodType, Res extends z.ZodType>(
    path: string,
    request: Req,
    response: Res,
    handle: (
      principal: WorkerPrincipal,
      body: z.infer<Req>,
    ) => Promise<z.input<Res>>,
  ) {
    router.post(`${WORKER_ROUTE_PREFIX}${path}`, async (context) => {
      const principal = await authenticate(context);
      const body = await parseJsonBody(context, request);
      const result = await mapped(() => handle(principal, body));
      return jsonWithSchema(context, response, result);
    });
  }

  call(
    "/bootstrap-claim",
    bootstrapClaimRequestSchema,
    bootstrapClaimResponseSchema,
    (principal, body) => gateway.bootstrapClaim(principal, body),
  );
  call(
    "/next-input",
    nextInputRequestSchema,
    nextInputResponseSchema,
    (principal, body) => gateway.nextInput(principal, body),
  );
  call(
    "/heartbeat",
    heartbeatRequestSchema,
    heartbeatResponseSchema,
    (principal, body) => gateway.heartbeat(principal, body),
  );
  call(
    "/append-events",
    appendEventsRequestSchema,
    appendEventsResponseSchema,
    (principal, body) => gateway.appendEvents(principal, body),
  );
  call(
    "/checkpoint-request",
    checkpointRequestSchema,
    checkpointRequestResponseSchema,
    (principal, body) => gateway.requestCheckpoint(principal, body),
  );
  call(
    "/restore-plan",
    restorePlanRequestSchema,
    restorePlanResponseSchema,
    (principal, body) => gateway.restorePlan(principal, body),
  );
  call(
    "/finalize",
    finalizeRequestSchema,
    finalizeResponseSchema,
    (principal, body) => gateway.finalize(principal, body),
  );
  call(
    "/release",
    releaseRequestSchema,
    releaseResponseSchema,
    (principal, body) => gateway.release(principal, body),
  );
}
