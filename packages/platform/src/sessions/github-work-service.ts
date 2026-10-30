import type {
  DispatchWorkflowRequest,
  DispatchWorkflowResponse,
  GitHubWorkflowRunView,
  ReceiptActor,
  RerunWorkflowRequest,
  RerunWorkflowResponse,
  SubmitPullRequestReviewRequest,
  SubmitPullRequestReviewResponse,
} from "@werft-ai/contracts";
import type { AuthorizationPolicy } from "../musterrolle/policy.ts";
import { ForgeCredentialError } from "../ports/forge.ts";
import {
  GitHubCallError,
  type GitHubGate,
  GitHubGateError,
  type GitHubGateStore,
  type GitHubGrant,
  GitHubUnavailableError,
  type GitHubWork,
  type GitHubWorkContext,
} from "../ports/github-gate.ts";
import {
  type PushActor,
  pushReceiptActor,
  requireVerified,
} from "./push-request-service.ts";
import { requirePermitted, SessionServiceError } from "./session-service.ts";

export interface GitHubWorkStore
  extends Pick<GitHubGateStore, "recordReceipt"> {
  /**
   * The `dispatch_workflow` receipt and, when GitHub named the run, its
   * github_workflow_dispatches row, in one transaction.
   */
  recordDispatch(input: {
    context: GitHubWorkContext;
    actor: ReceiptActor;
    result: Record<string, unknown>;
    run: { id: number; workflow: string; ref: string } | null;
  }): Promise<string>;
  /**
   * The owner's session and agent that opened pull request `number` of the
   * catalog repository through the platform; null for one it did not.
   */
  pullRequestOpener(
    ownerId: string,
    repositoryId: string,
    number: number,
  ): Promise<{ sessionId: string; agentId: string | null } | null>;
}

/**
 * GitHub work a session asks for beyond push and pull requests (design
 * github-agent.md §3): dispatching an allow-listed workflow, reading a run,
 * rerunning one the platform dispatched, reviewing a pull request. Each goes
 * through the gate, which decides and issues; this service calls GitHub and
 * writes the receipt. Neither a receipt nor a log keeps dispatch inputs, a
 * review's body or GitHub's error text.
 */
export function createGitHubWorkService(deps: {
  authorization: AuthorizationPolicy;
  gate: GitHubGate;
  store: GitHubWorkStore;
}) {
  const { authorization, gate, store } = deps;

  async function granted(
    actor: PushActor,
    rawSessionId: string,
    action: "session.read" | "session.submit",
    work: Omit<GitHubWork, "sessionId" | "actor">,
  ): Promise<GitHubGrant> {
    requireVerified(actor);
    const sessionId = rawSessionId.toLowerCase();
    await requirePermitted(authorization, actor.caller, action, {
      kind: "session",
      id: sessionId,
    });
    let grant: GitHubGrant | null;
    try {
      grant = await gate.grant({
        ...work,
        sessionId,
        actor: pushReceiptActor(actor),
      });
    } catch (error) {
      if (error instanceof GitHubGateError) {
        throw new SessionServiceError(
          "GITHUB_REFUSED",
          error.message,
          undefined,
          { reason_code: error.reasonCode, receipt_id: error.receiptId },
        );
      }
      if (error instanceof GitHubUnavailableError) {
        throw unavailable(error.receiptId);
      }
      if (error instanceof ForgeCredentialError) throw unavailable(null);
      throw error;
    }
    if (grant === null) {
      throw new SessionServiceError(
        "UNSUPPORTED_CAPABILITY",
        "The session's repository is not on GitHub",
      );
    }
    return grant;
  }

  /** What every receipt of this work names, beyond the gate's own fields. */
  const fieldsOf = (grant: GitHubGrant) => ({
    session_id: grant.context.sessionId,
    agent_id: grant.context.agentId,
    agent_release_id: grant.context.agentReleaseId,
    repository_id: grant.context.repositoryId,
    allowed_by: grant.allowedBy,
  });

  async function failed(
    grant: GitHubGrant,
    actor: PushActor,
    operation: "dispatch_workflow" | "rerun_workflow" | "review_pull_request",
    result: Record<string, unknown>,
    error: GitHubCallError,
  ): Promise<never> {
    const receiptId = await store.recordReceipt({
      ownerId: grant.context.ownerId,
      sessionId: grant.context.sessionId,
      actor: pushReceiptActor(actor),
      operation,
      status: "failed",
      result: {
        ...fieldsOf(grant),
        ...result,
        status: error.status,
        github_request_id: error.requestId,
      },
      error: null,
    });
    throw unavailable(receiptId);
  }

  return {
    async dispatch(
      actor: PushActor,
      sessionId: string,
      body: DispatchWorkflowRequest,
    ): Promise<DispatchWorkflowResponse> {
      const grant = await granted(actor, sessionId, "session.submit", {
        purpose: "dispatch",
        workflow: { file: body.workflow, ref: body.ref },
      });
      const inputs = body.inputs ?? {};
      const result = {
        workflow: body.workflow,
        ref: body.ref,
        // The names only: a value may be anything the caller chose.
        input_keys: Object.keys(inputs).sort(),
      };
      let run: { id: number; html_url: string } | null;
      try {
        run = await grant.api.dispatchWorkflow({
          workflow: body.workflow,
          ref: body.ref,
          inputs,
        });
      } catch (error) {
        if (error instanceof GitHubCallError) {
          return await failed(grant, actor, "dispatch_workflow", result, error);
        }
        throw error;
      }
      const receiptId = await store.recordDispatch({
        context: grant.context,
        actor: pushReceiptActor(actor),
        result: {
          ...fieldsOf(grant),
          ...result,
          run_id: run?.id ?? null,
        },
        run:
          run === null
            ? null
            : { id: run.id, workflow: body.workflow, ref: body.ref },
      });
      return { receipt_id: receiptId, run };
    },

    async getRun(
      actor: PushActor,
      sessionId: string,
      runId: number,
    ): Promise<GitHubWorkflowRunView> {
      const grant = await granted(actor, sessionId, "session.read", {
        purpose: "actions_read",
      });
      try {
        return await grant.api.getWorkflowRun(runId);
      } catch (error) {
        if (error instanceof GitHubCallError) {
          if (error.status === 404) {
            throw new SessionServiceError("NOT_FOUND", "Resource not found");
          }
          throw unavailable(null);
        }
        throw error;
      }
    },

    async rerun(
      actor: PushActor,
      sessionId: string,
      runId: number,
      body: RerunWorkflowRequest,
    ): Promise<RerunWorkflowResponse> {
      const grant = await granted(actor, sessionId, "session.submit", {
        purpose: "rerun",
        runId,
      });
      const failedOnly = body.failed_only ?? false;
      const result = {
        run_id: runId,
        failed_only: failedOnly,
        workflow: grant.allowedBy?.workflow ?? null,
      };
      try {
        await grant.api.rerunWorkflow(runId, failedOnly);
      } catch (error) {
        if (error instanceof GitHubCallError) {
          return await failed(grant, actor, "rerun_workflow", result, error);
        }
        throw error;
      }
      const receiptId = await store.recordReceipt({
        ownerId: grant.context.ownerId,
        sessionId: grant.context.sessionId,
        actor: pushReceiptActor(actor),
        operation: "rerun_workflow",
        status: "succeeded",
        result: { ...fieldsOf(grant), ...result },
        error: null,
      });
      return { receipt_id: receiptId };
    },

    /**
     * A review with the reviewer App (design github-agent.md §2 decision 1).
     * The platform does not refuse a review of a pull request the same
     * agent opened; the receipt names both sides so it can be found later.
     */
    async review(
      actor: PushActor,
      sessionId: string,
      number: number,
      body: SubmitPullRequestReviewRequest,
    ): Promise<SubmitPullRequestReviewResponse> {
      const grant = await granted(actor, sessionId, "session.submit", {
        purpose: "review",
        review: { number, commitId: body.commit_id, event: body.event },
      });
      const opener = await store.pullRequestOpener(
        grant.context.ownerId,
        grant.context.repositoryId,
        number,
      );
      const { allowed_by: _none, ...fields } = fieldsOf(grant);
      // Never the review's body: it is whatever the caller wrote.
      const result = {
        ...fields,
        number,
        commit_id: body.commit_id,
        event: body.event,
        opened_by_session_id: opener?.sessionId ?? null,
        opened_by_agent_id: opener?.agentId ?? null,
      };
      let review: { id: number; html_url: string };
      try {
        review = await grant.api.submitReview({
          number,
          commitId: body.commit_id,
          event: body.event,
          ...(body.body === undefined ? {} : { body: body.body }),
        });
      } catch (error) {
        if (error instanceof GitHubCallError) {
          return await failed(
            grant,
            actor,
            "review_pull_request",
            result,
            error,
          );
        }
        throw error;
      }
      const receiptId = await store.recordReceipt({
        ownerId: grant.context.ownerId,
        sessionId: grant.context.sessionId,
        actor: pushReceiptActor(actor),
        operation: "review_pull_request",
        status: "succeeded",
        result: { ...result, review_id: review.id },
        error: null,
      });
      return { receipt_id: receiptId, review };
    },
  };
}

function unavailable(receiptId: string | null): SessionServiceError {
  return new SessionServiceError(
    "BACKEND_UNAVAILABLE",
    "GitHub did not take the call",
    undefined,
    receiptId === null ? null : { receipt_id: receiptId },
  );
}

export type GitHubWorkService = ReturnType<typeof createGitHubWorkService>;
