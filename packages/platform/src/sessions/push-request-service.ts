import type {
  DecidePushRequestRequest,
  ListPushRequestsResponse,
  Principal,
  PushRefusal,
  PushRequest,
  ReceiptActor,
} from "@werft-ai/contracts";
import type { PushSourceResult } from "../checkpoints/checkpoint-service.ts";
import {
  type AuthorizationPolicy,
  type Caller,
  receiptActorOf,
} from "../musterrolle/policy.ts";
import {
  PUSH_REFUSAL_ERRORS,
  type PushRequestStore,
  type PushWriteResult,
} from "../ports/push-requests.ts";
import { repositoryBinding, type SessionCatalog } from "./catalog.ts";
import {
  idempotencyConflict,
  payloadHash,
  requirePermitted,
  SessionServiceError,
} from "./session-service.ts";

export type PushActor = {
  /** Who asks the authorization policy, as every other session entry does. */
  caller: Caller;
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

const DECIDER_KINDS: ReadonlySet<Principal["kind"]> = new Set([
  "user",
  "api_key",
]);

/** A caller assembled outside the API middleware may carry no recorded actor. */
export function pushReceiptActor(actor: PushActor): ReceiptActor {
  return (
    receiptActorOf(actor.caller) ?? {
      principal: { kind: actor.principal.kind, id: actor.principal.id },
      actor_user_id: null,
      agent_id: null,
    }
  );
}

/** Refuses a caller nothing authenticated; no receipt, as nothing is known of it. */
export function requireVerified(actor: PushActor) {
  if (!actor.verified) refused("unverified_principal", null);
}

/**
 * Who may decide a push, and so open a pull request from it: a credential
 * holding sessions:approve that is an API key or a signed-in user.
 */
export function mayDecidePush(
  principal: Principal,
): "missing_scope" | "unverified_principal" | null {
  if (!(principal.scopes as readonly string[]).includes("sessions:approve")) {
    return "missing_scope";
  }
  return DECIDER_KINDS.has(principal.kind) ? null : "unverified_principal";
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
 * (94S-629, push-executor.ts).
 */
export function createPushRequestService(deps: {
  authorization: AuthorizationPolicy;
  store: PushRequestStore;
  source: PushSource;
  /** Pins the repository entry the push must still match (94S-629). */
  catalog: SessionCatalog;
}) {
  const { authorization, store, source, catalog } = deps;

  // The session's share decides who may see or act on it, as for every other
  // session command; a session the caller cannot see is NOT_FOUND.
  const requireSession = (
    actor: PushActor,
    action: "session.read" | "session.submit" | "session.approve",
    sessionId: string,
  ) =>
    requirePermitted(authorization, actor.caller, action, {
      kind: "session",
      id: sessionId,
    });

  return {
    async create(
      actor: PushActor,
      rawSessionId: string,
      input: { idempotencyKey: string },
    ): Promise<PushRequest> {
      requireVerified(actor);
      const sessionId = rawSessionId.toLowerCase();
      await requireSession(actor, "session.submit", sessionId);
      const refuse = async (
        refusal: PushRefusal,
        fields: { repository_id?: string } = {},
      ) =>
        refused(
          refusal,
          await store.recordRefusal({
            ownerId: actor.ownerId,
            sessionId,
            actor: pushReceiptActor(actor),
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
      const replay = await store.replayCreate({
        ownerId: actor.ownerId,
        sessionId,
        idempotencyKey: input.idempotencyKey,
        payloadHash: payloadHash({}),
      });
      if (replay !== null) return settled(replay);
      const session = await store.findSession(actor.ownerId, sessionId);
      if (session === null) {
        throw new SessionServiceError("NOT_FOUND", "Resource not found");
      }
      if (session.repositoryId === null) return refuse("no_repository");
      const repository = { repository_id: session.repositoryId };
      const entry = Object.hasOwn(catalog.repositories, session.repositoryId)
        ? catalog.repositories[session.repositoryId]
        : undefined;
      if (entry === undefined) return refuse("no_repository", repository);
      const pinned = await source.readPushSource(sessionId);
      if (pinned.status === "none") return refuse("no_checkpoint", repository);
      if (pinned.status === "unavailable") {
        return refuse("checkpoint_unavailable", repository);
      }
      return settled(
        await store.create({
          ownerId: actor.ownerId,
          sessionId,
          actor: pushReceiptActor(actor),
          idempotencyKey: input.idempotencyKey,
          payloadHash: payloadHash({}),
          repositoryId: session.repositoryId,
          repositoryBinding: repositoryBinding(session.repositoryId, entry),
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
      await requireSession(actor, "session.read", sessionId);
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
      await requireSession(actor, "session.read", sessionId);
      const request = await store.get(actor.ownerId, sessionId, pushRequestId);
      if (request === null) {
        throw new SessionServiceError("NOT_FOUND", "Resource not found");
      }
      return request;
    },

    async decide(
      actor: PushActor,
      rawSessionId: string,
      rawPushRequestId: string,
      input: {
        idempotencyKey: string;
        readBody: () => Promise<DecidePushRequestRequest>;
      },
    ): Promise<PushRequest> {
      requireVerified(actor);
      const sessionId = rawSessionId.toLowerCase();
      const pushRequestId = rawPushRequestId.toLowerCase();
      const receiptActor = pushReceiptActor(actor);
      const refusal = mayDecidePush(actor.principal);
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
      await requireSession(actor, "session.approve", sessionId);
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
  };
}

export type PushRequestService = ReturnType<typeof createPushRequestService>;
