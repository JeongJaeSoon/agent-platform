import type {
  DecidePushRequestRequest,
  ListPushRequestsResponse,
  Principal,
  PushRefusal,
  PushRequest,
  ReceiptActor,
} from "@agent-platform/contracts";
import type { PushSourceResult } from "../checkpoints/checkpoint-service.ts";
import {
  PUSH_REFUSAL_ERRORS,
  type PushRequestStore,
  type PushWriteResult,
} from "../ports/push-requests.ts";
import {
  idempotencyConflict,
  payloadHash,
  SessionServiceError,
} from "./session-service.ts";

export type PushActor = {
  principal: Principal;
  ownerId: string;
  /**
   * False when nothing checked who is calling (AUTH_MODE=none trusts any
   * X-Owner-Id, so code inside a worker could claim to be the owner).
   */
  verified: boolean;
};

export interface PushSource {
  readPushSource(sessionId: string): Promise<PushSourceResult>;
}

// The principal kinds that may decide. An allowlist, so a kind added later
// (a chat installation, an agent's own key) is refused until named here.
const DECIDER_KINDS: ReadonlySet<Principal["kind"]> = new Set([
  "user",
  "api_key",
]);

function receiptActorOf(principal: Principal): ReceiptActor {
  return {
    principal: { kind: principal.kind, id: principal.id },
    actor_user_id: principal.kind === "user" ? principal.id : null,
    agent_id: null,
  };
}

function refused(refusal: PushRefusal, receiptId: string | null): never {
  const { code, message } = PUSH_REFUSAL_ERRORS[refusal];
  throw new SessionServiceError(
    code,
    message,
    undefined,
    receiptId === null ? { refusal } : { refusal, receipt_id: receiptId },
  );
}

function settled(result: PushWriteResult): PushRequest {
  switch (result.outcome) {
    case "conflict":
      return idempotencyConflict();
    case "refused":
      return refused(result.refusal, result.receiptId);
    default:
      return result.request;
  }
}

/**
 * Push requests (94S-628): a human asks for the session's latest checkpoint
 * to be pushed to `agent/<session-id>`, and a human holding sessions:approve
 * approves or rejects exactly that commit. The push itself is the platform's
 * (94S-629), through claimNextApproved and finish.
 */
export function createPushRequestService(deps: {
  store: PushRequestStore;
  source: PushSource;
}) {
  const { store, source } = deps;

  // An unverified caller could be anyone, so nothing it says is recorded
  // under the owner it claims.
  function requireVerified(actor: PushActor) {
    if (!actor.verified) refused("unverified_principal", null);
  }

  return {
    async create(
      actor: PushActor,
      sessionId: string,
      input: { idempotencyKey: string },
    ): Promise<PushRequest> {
      requireVerified(actor);
      const refuse = async (
        refusal: PushRefusal,
        fields: { repository_id?: string } = {},
      ) =>
        refused(
          refusal,
          await store.recordRefusal({
            ownerId: actor.ownerId,
            sessionId,
            actor: receiptActorOf(actor.principal),
            operation: "request_push",
            refusal,
            result: {
              push_request_id: null,
              decision: null,
              verdict: "refuse",
              refusal,
              repository_id: fields.repository_id ?? null,
              checkpoint_revision: null,
              git_commit: null,
              target_branch: null,
            },
          }),
        );
      const session = await store.findSession(actor.ownerId, sessionId);
      if (session === null) {
        throw new SessionServiceError("NOT_FOUND", "Resource not found");
      }
      if (session.repositoryId === null) return refuse("no_repository");
      const repository = { repository_id: session.repositoryId };
      const pinned = await source.readPushSource(sessionId);
      if (pinned.status === "none") return refuse("no_checkpoint", repository);
      if (pinned.status === "unavailable") {
        return refuse("checkpoint_unavailable", repository);
      }
      return settled(
        await store.create({
          ownerId: actor.ownerId,
          sessionId,
          actor: receiptActorOf(actor.principal),
          idempotencyKey: input.idempotencyKey,
          payloadHash: payloadHash({}),
          repositoryId: session.repositoryId,
          checkpointRevision: pinned.revision,
          gitCommit: pinned.gitCommit,
        }),
      );
    },

    async list(
      actor: PushActor,
      sessionId: string,
    ): Promise<ListPushRequestsResponse> {
      requireVerified(actor);
      const items = await store.list(actor.ownerId, sessionId);
      if (items === null) {
        throw new SessionServiceError("NOT_FOUND", "Resource not found");
      }
      return { items };
    },

    async get(
      actor: PushActor,
      sessionId: string,
      pushRequestId: string,
    ): Promise<PushRequest> {
      requireVerified(actor);
      const request = await store.get(actor.ownerId, sessionId, pushRequestId);
      if (request === null) {
        throw new SessionServiceError("NOT_FOUND", "Resource not found");
      }
      return request;
    },

    /**
     * The scope is checked here rather than by the API's scope table, so a
     * refusal is a receipt like every other refused decision. Neither the
     * body nor the request is read before it: `readBody` runs only after.
     */
    async decide(
      actor: PushActor,
      sessionId: string,
      pushRequestId: string,
      input: {
        idempotencyKey: string;
        readBody: () => Promise<DecidePushRequestRequest>;
      },
    ): Promise<PushRequest> {
      requireVerified(actor);
      const receiptActor = receiptActorOf(actor.principal);
      const refusal: PushRefusal | null = !(
        actor.principal.scopes as readonly string[]
      ).includes("sessions:approve")
        ? "missing_scope"
        : DECIDER_KINDS.has(actor.principal.kind)
          ? null
          : "unverified_principal";
      if (refusal !== null) {
        refused(
          refusal,
          await store.recordRefusal({
            ownerId: actor.ownerId,
            sessionId,
            actor: receiptActor,
            operation: "decide_push",
            refusal,
            result: {
              push_request_id: pushRequestId,
              decision: null,
              verdict: "refuse",
              refusal,
              repository_id: null,
              checkpoint_revision: null,
              git_commit: null,
              target_branch: null,
            },
          }),
        );
      }
      const body = await input.readBody();
      return settled(
        await store.decide({
          ownerId: actor.ownerId,
          sessionId,
          pushRequestId,
          actor: receiptActor,
          decision: body.decision,
          gitCommit: body.git_commit,
          reason: body.reason ?? null,
          idempotencyKey: input.idempotencyKey,
          payloadHash: payloadHash(body),
        }),
      );
    },

    claimNextApproved: () => store.claimNextApproved(),
    finish: (...args: Parameters<PushRequestStore["finish"]>) =>
      store.finish(...args),
  };
}

export type PushRequestService = ReturnType<typeof createPushRequestService>;
