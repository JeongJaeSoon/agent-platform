import {
  type CommentPullRequestRequest,
  type CommentPullRequestResponse,
  DEFAULT_PULL_REQUEST_COMMENT_MARKER,
  type OpenPullRequestRequest,
  type OpenPullRequestResponse,
  type PullRequestReceiptResult,
  type PullRequestRefusal,
  pushBranchFor,
} from "@werft-ai/contracts";
import type { AuthorizationPolicy } from "../musterrolle/policy.ts";
import { ForgeCredentialError } from "../ports/forge.ts";
import {
  type GitHubGate,
  GitHubGateError,
  type GitHubGrant,
  GitHubUnavailableError,
} from "../ports/github-gate.ts";
import {
  PULL_REQUEST_REFUSAL_ERRORS,
  type PullRequestOperation,
  type PullRequestSource,
  type PullRequestStore,
} from "../ports/pull-requests.ts";
import { repositoryBinding, type SessionCatalog } from "./catalog.ts";
import { cleanBody, cleanTitle } from "./pull-request-text.ts";
import {
  mayDecidePush,
  type PushActor,
  pushReceiptActor,
  requireVerified,
} from "./push-request-service.ts";
import { requirePermitted, SessionServiceError } from "./session-service.ts";

const EMPTY_RESULT: PullRequestReceiptResult = {
  push_request_id: null,
  verdict: "refuse",
  refusal: null,
  repository_id: null,
  number: null,
  url: null,
  head: null,
  base: null,
  created: null,
};

/** The hidden line that tells the platform's comment apart on the forge. */
export function commentMarker(sessionId: string, marker: string): string {
  return `<!-- agent-platform:${sessionId}:${marker} -->`;
}

/**
 * Pull requests (94S-630): a pull request from a pushed request's
 * `agent/<session-id>` into the catalog branch, and a comment on it. Whoever
 * may decide a push may; so may whoever may submit to the session, once the
 * request is pushed. The token comes from the GitHub gate. Every attempt
 * leaves a receipt, and every entry that opens one comes through `open`.
 */
export function createPullRequestService(deps: {
  authorization: AuthorizationPolicy;
  store: PullRequestStore;
  catalog: SessionCatalog;
  gate: GitHubGate;
  /** Applied to each line of caller text before the forge sees it. */
  redact: (line: string) => string;
}) {
  const { authorization, store, catalog, gate, redact } = deps;

  async function begin(
    actor: PushActor,
    rawSessionId: string,
    rawPushRequestId: string,
    operation: PullRequestOperation,
  ) {
    requireVerified(actor);
    const sessionId = rawSessionId.toLowerCase();
    const pushRequestId = rawPushRequestId.toLowerCase();
    const receipt = {
      ownerId: actor.ownerId,
      sessionId,
      pushRequestId,
      actor: pushReceiptActor(actor),
      operation,
    };
    const refuse = async (
      refusal: PullRequestRefusal,
      fields: Partial<PullRequestReceiptResult> = {},
    ): Promise<never> => {
      const receiptId = await store.recordReceipt({
        ...receipt,
        result: {
          ...EMPTY_RESULT,
          push_request_id: pushRequestId,
          ...fields,
          verdict: "refuse",
          refusal,
        },
      });
      const { code, message } = PULL_REQUEST_REFUSAL_ERRORS[refusal];
      throw new SessionServiceError(code, message, undefined, {
        refusal,
        receipt_id: receiptId,
        ...(code === "GITHUB_REFUSED"
          ? { reason_code: fields.reason_code ?? refusal }
          : {}),
      });
    };
    const session = { kind: "session", id: sessionId } as const;
    const scopeRefusal = mayDecidePush(actor.principal);
    // As for a push decision, the session's share decides who may act on it;
    // a session the caller cannot see is NOT_FOUND.
    const forbidden = (error: unknown) =>
      error instanceof SessionServiceError && error.code === "FORBIDDEN";
    if (scopeRefusal === null) {
      try {
        await requirePermitted(
          authorization,
          actor.caller,
          "session.approve",
          session,
        );
        return { sessionId, pushRequestId, receipt, refuse, submitter: false };
      } catch (error) {
        if (!forbidden(error)) throw error;
        // The share may let this caller submit without approving.
        try {
          await requirePermitted(
            authorization,
            actor.caller,
            "session.submit",
            session,
          );
        } catch (submitError) {
          throw forbidden(submitError) ? error : submitError;
        }
        return { sessionId, pushRequestId, receipt, refuse, submitter: true };
      }
    }
    // What was pushed is what a person or the release's policy approved; a
    // pull request opens from exactly that branch and commit, so whoever may
    // submit to the session (an agent key included) may open it.
    try {
      await requirePermitted(
        authorization,
        actor.caller,
        "session.submit",
        session,
      );
    } catch (error) {
      if (forbidden(error)) await refuse(scopeRefusal);
      throw error;
    }
    return { sessionId, pushRequestId, receipt, refuse, submitter: true };
  }

  async function forgeFor(
    actor: PushActor,
    source: PullRequestSource,
    refuse: (
      refusal: PullRequestRefusal,
      fields?: Partial<PullRequestReceiptResult>,
    ) => Promise<never>,
  ) {
    const fields = { repository_id: source.repositoryId };
    const entry = Object.hasOwn(catalog.repositories, source.repositoryId)
      ? catalog.repositories[source.repositoryId]
      : undefined;
    if (
      entry === undefined ||
      source.repositoryBinding === null ||
      repositoryBinding(source.repositoryId, entry) !== source.repositoryBinding
    ) {
      return await refuse("catalog_changed", fields);
    }
    let grant: GitHubGrant | null;
    try {
      grant = await gate.grant({
        sessionId: source.sessionId,
        purpose: "pull_request",
        actor: pushReceiptActor(actor),
      });
    } catch (error) {
      if (error instanceof GitHubGateError) {
        return await refuse("github_refused", {
          ...fields,
          reason_code: error.reasonCode,
        });
      }
      if (error instanceof GitHubUnavailableError) {
        return await refuse("no_forge", fields);
      }
      if (error instanceof ForgeCredentialError) {
        return await refuse("forge_failed", fields);
      }
      throw error;
    }
    if (grant === null) return await refuse("no_forge", fields);
    return { forge: grant.api, base: entry.branch };
  }

  return {
    async open(
      actor: PushActor,
      rawSessionId: string,
      rawPushRequestId: string,
      input: { readBody: () => Promise<OpenPullRequestRequest> },
    ): Promise<OpenPullRequestResponse> {
      const { sessionId, pushRequestId, receipt, refuse } = await begin(
        actor,
        rawSessionId,
        rawPushRequestId,
        "open_pull_request",
      );
      const body = await input.readBody();
      const source = await store.findSource(
        actor.ownerId,
        sessionId,
        pushRequestId,
      );
      if (source === null) return await refuse("not_found");
      const recorded = await store.findPullRequest(actor.ownerId, source.id);
      if (recorded !== null) {
        const receiptId = await store.recordReceipt({
          ...receipt,
          result: {
            push_request_id: source.id,
            verdict: "allow",
            refusal: null,
            repository_id: recorded.repository_id,
            number: recorded.number,
            url: recorded.url,
            head: recorded.head,
            base: recorded.base,
            created: false,
          },
        });
        return {
          pull_request: recorded,
          created: false,
          receipt_id: receiptId,
        };
      }
      const fields = { repository_id: source.repositoryId };
      if (source.state !== "pushed") return await refuse("not_pushed", fields);
      const head = source.targetBranch;
      if (head !== pushBranchFor(source.sessionId)) {
        return await refuse("not_pushed", fields);
      }
      const { forge, base } = await forgeFor(actor, source, refuse);
      let opened: { number: number; url: string; base: string };
      let created: boolean;
      try {
        const found = await forge.findPullRequestForBranch(head);
        created = found?.state !== "open";
        opened =
          found?.state === "open"
            ? found
            : await forge.createPullRequest({
                head,
                base,
                title: cleanTitle(
                  body.title ?? `Agent session ${source.sessionId}`,
                  redact,
                ),
                body: `${cleanBody(body.body ?? "", forge.maxBodyLength - 1_000, redact)}\n\n---\nOpened by agent-platform from session \`${source.sessionId}\`, commit \`${source.gitCommit}\`.`,
              });
      } catch (error) {
        if (error instanceof ForgeCredentialError) {
          return await refuse("forge_failed", { ...fields, head, base });
        }
        throw error;
      }
      const saved = await store.savePullRequest({
        ...receipt,
        pushRequestId: source.id,
        repositoryId: source.repositoryId,
        number: opened.number,
        url: opened.url,
        head,
        base: opened.base,
        created,
      });
      return {
        pull_request: saved.pullRequest,
        created: saved.created,
        receipt_id: saved.receiptId,
      };
    },

    async comment(
      actor: PushActor,
      rawSessionId: string,
      rawPushRequestId: string,
      input: { readBody: () => Promise<CommentPullRequestRequest> },
    ): Promise<CommentPullRequestResponse> {
      const { sessionId, pushRequestId, receipt, refuse, submitter } =
        await begin(
          actor,
          rawSessionId,
          rawPushRequestId,
          "comment_pull_request",
        );
      const body = await input.readBody();
      const marker = body.marker ?? DEFAULT_PULL_REQUEST_COMMENT_MARKER;
      const source = await store.findSource(
        actor.ownerId,
        sessionId,
        pushRequestId,
      );
      if (source === null) return await refuse("not_found", { marker });
      // A later push request of the session updates the same branch, so it
      // comments on the pull request an earlier one opened.
      const pullRequest =
        (await store.findPullRequest(actor.ownerId, source.id)) ??
        (source.state === "pushed"
          ? await store.findBranchPullRequest(
              actor.ownerId,
              source.sessionId,
              source.targetBranch,
            )
          : null);
      const fields = {
        repository_id: source.repositoryId,
        marker,
        ...(pullRequest === null
          ? {}
          : {
              number: pullRequest.number,
              url: pullRequest.url,
              head: pullRequest.head,
              base: pullRequest.base,
            }),
      };
      if (pullRequest === null) return await refuse("no_pull_request", fields);
      if (submitter && source.state !== "pushed") {
        return await refuse("not_pushed", fields);
      }
      const { forge } = await forgeFor(actor, source, (refusal, extra) =>
        refuse(refusal, { ...fields, ...extra }),
      );
      const hidden = commentMarker(source.sessionId, marker);
      let comment: { id: number; url: string; created: boolean };
      try {
        comment = await forge.upsertComment(
          pullRequest.number,
          hidden,
          cleanBody(body.body, forge.maxBodyLength - hidden.length - 2, redact),
        );
      } catch (error) {
        if (error instanceof ForgeCredentialError) {
          return await refuse("forge_failed", fields);
        }
        throw error;
      }
      const receiptId = await store.recordReceipt({
        ...receipt,
        pushRequestId: source.id,
        result: {
          ...EMPTY_RESULT,
          ...fields,
          push_request_id: source.id,
          verdict: "allow",
          created: comment.created,
          comment_id: comment.id,
          comment_url: comment.url,
        },
      });
      return {
        pull_request: pullRequest,
        comment: { ...comment, marker },
        receipt_id: receiptId,
      };
    },
  };
}

export type PullRequestService = ReturnType<typeof createPullRequestService>;
