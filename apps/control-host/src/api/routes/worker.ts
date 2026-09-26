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
  pendingControlRequestSchema,
  pendingControlResponseSchema,
  registerPendingRequestSchema,
  registerPendingResponseSchema,
  releaseRequestSchema,
  releaseResponseSchema,
  restorePlanRequestSchema,
  restorePlanResponseSchema,
  workerReadyRequestSchema,
  workerReadyResponseSchema,
} from "@agent-platform/contracts";
import {
  type WorkerGateway,
  WorkerGatewayError,
  type WorkerPrincipal,
} from "@agent-platform/platform";
import type { z } from "zod";
import {
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
// token bootstrapClaim issued. A session token must name the binding the body
// acts for (the gateway checks); a launch nonce must be the one the body
// claims with.
export function registerWorkerRoutes(
  router: ApiRouter,
  gateway: WorkerGateway,
) {
  function call<Req extends z.ZodType, Res extends z.ZodType>(
    path: string,
    request: Req,
    response: Res,
    handle: (
      principal: WorkerPrincipal,
      body: z.infer<Req>,
      token: string | null,
    ) => Promise<z.input<Res>>,
  ) {
    router.post(`${WORKER_ROUTE_PREFIX}${path}`, async (context) => {
      const token = bearerToken(context.req.header("Authorization"));
      const principal = await mapped(() => gateway.authenticate(token));
      const body = await parseJsonBody(context, request);
      const result = await mapped(() => handle(principal, body, token));
      return jsonWithSchema(context, response, result);
    });
  }

  call(
    "/bootstrap-claim",
    bootstrapClaimRequestSchema,
    bootstrapClaimResponseSchema,
    (principal, body, token) => {
      if (
        principal.kind === "bootstrap" &&
        body.credential.kind === "launch_nonce" &&
        body.credential.nonce !== token
      ) {
        throw new WorkerGatewayError(
          401,
          "UNAUTHORIZED",
          "The bearer launch nonce is not the one the claim carries",
        );
      }
      return gateway.bootstrapClaim(principal, body);
    },
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
    "/ready",
    workerReadyRequestSchema,
    workerReadyResponseSchema,
    (principal, body) => gateway.ready(principal, body),
  );
  call(
    "/register-pending",
    registerPendingRequestSchema,
    registerPendingResponseSchema,
    (principal, body) => gateway.registerPending(principal, body),
  );
  call(
    "/pending-control",
    pendingControlRequestSchema,
    pendingControlResponseSchema,
    (principal, body) => gateway.pendingControl(principal, body),
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
