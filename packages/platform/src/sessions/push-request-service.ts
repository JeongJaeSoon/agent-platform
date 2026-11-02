import {
  type CreatePushRequestRequest,
  type ListPushRequestsResponse,
  type Principal,
  type PushRefusal,
  type PushRequest,
  type PushResolution,
  pushBranchFor,
  type ReceiptActor,
} from "@werft-ai/contracts";
import type { PushSourceResult } from "../checkpoints/checkpoint-service.ts";
import {
  type AuthorizationPolicy,
  type Caller,
  deciderKeyOf,
  receiptActorOf,
} from "../musterrolle/policy.ts";
import {
  PUSH_REFUSAL_ERRORS,
  type PushRequestStore,
  type PushWriteResult,
} from "../ports/push-requests.ts";
import { additionalRepositoryAllowed } from "./additional-repositories.ts";
import { repositoryBinding, type SessionCatalog } from "./catalog.ts";
import {
  idempotencyConflict,
  payloadHash,
  requirePermitted,
  SessionServiceError,
  selfApproval,
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
 * to be pushed to `agent/<session-id>`, and a holder of sessions:approve other
 * than the key that started the session approves or rejects exactly that
 * commit (GA-8). The push itself is the platform's
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
      input: { idempotencyKey: string; body?: CreatePushRequestRequest },
    ): Promise<PushRequest> {
      requireVerified(actor);
      const sessionId = rawSessionId.toLowerCase();
      const body = input.body ?? {};
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
              action: null,
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
        payloadHash: payloadHash(body),
      });
      if (replay !== null) return settled(replay);
      const session = await store.findSession(actor.ownerId, sessionId);
      if (session === null) {
        throw new SessionServiceError("NOT_FOUND", "Resource not found");
      }
      const repositoryId = body.repository_id ?? session.repositoryId;
      if (repositoryId === null) return refuse("no_repository");
      const repository = { repository_id: repositoryId };
      const entry = Object.hasOwn(catalog.repositories, repositoryId)
        ? catalog.repositories[repositoryId]
        : undefined;
      if (entry === undefined) return refuse("no_repository", repository);
      if (
        repositoryId !== session.repositoryId &&
        additionalRepositoryAllowed(catalog, session, repositoryId) === null
      ) {
        return refuse("repository_not_allowed", repository);
      }
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
          payloadHash: payloadHash(body),
          repositoryId,
          repositoryBinding: repositoryBinding(repositoryId, entry),
          targetBranch: pushBranchFor(sessionId, body.branch),
          checkpointRevision: pinned.revision,
          gitCommit: pinned.gitCommit,
          approvedByRelease: session.approvalOffRelease,
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
        readBody: () => Promise<PushResolution>;
      },
    ): Promise<PushRequest> {
      requireVerified(actor);
      const sessionId = rawSessionId.toLowerCase();
      const pushRequestId = rawPushRequestId.toLowerCase();
      const receiptActor = pushReceiptActor(actor);
      const deciderKey = deciderKeyOf(actor.caller);
      const refuseDecision = async (refusal: PushRefusal): Promise<never> =>
        refused(
          refusal,
          await store.recordRefusal({
            ownerId: actor.ownerId,
            sessionId,
            actor: receiptActor,
            operation: "resolve_push",
            refusal,
            result: {
              push_request_id: pushRequestId,
              action: null,
              verdict: "refuse",
              refusal,
              repository_id: null,
              checkpoint_revision: null,
              git_commit: null,
              target_branch: null,
              decider_key: deciderKey,
            },
          }),
        );
      const refusal = mayDecidePush(actor.principal);
      if (refusal !== null) await refuseDecision(refusal);
      try {
        await requireSession(actor, "session.approve", sessionId);
      } catch (error) {
        if (selfApproval(error)) await refuseDecision("self_approval");
        throw error;
      }
      const body = await input.readBody();
      // Only consulted when the session checkpointed since the request; a
      // store that cannot answer leaves the exact-revision rule in force.
      const latest =
        body.decision === "approve"
          ? await source.readPushSource(sessionId).catch(() => null)
          : null;
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
          latest:
            latest?.status === "ready"
              ? { revision: latest.revision, gitCommit: latest.gitCommit }
              : null,
          deciderKey,
        }),
      );
    },
  };
}

export type PushRequestService = ReturnType<typeof createPushRequestService>;
