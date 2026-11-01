import { describe, expect, test } from "bun:test";
import type { Principal } from "@werft-ai/contracts";
import { testCaller } from "@werft-ai/testkit";
import { createAuthorizationPolicy } from "../musterrolle/policy.ts";
import {
  type GitHubApi,
  GitHubCallError,
  type GitHubGate,
  GitHubGateError,
  type GitHubGateReceipt,
  type GitHubGrant,
  type GitHubWork,
} from "../ports/github-gate.ts";
import {
  createGitHubWorkService,
  type GitHubWorkStore,
} from "./github-work-service.ts";
import { SessionServiceError } from "./session-service.ts";

const SESSION = "11111111-1111-4111-8111-111111111111";
const SECRET_INPUT = "s3cret-input-value";
const principal: Principal = {
  kind: "api_key",
  id: "owner-a",
  owner_id: "owner-a",
  workspace_id: null,
  scopes: ["sessions:read", "sessions:write"],
};
const actor = {
  caller: testCaller("owner-a"),
  principal,
  ownerId: "owner-a",
  verified: true,
};

function harness(
  options: {
    refuse?: GitHubGateError;
    fail?: GitHubCallError;
    run?: { id: number; html_url: string } | null;
  } = {},
) {
  const works: GitHubWork[] = [];
  const calls: string[] = [];
  const receipts: GitHubGateReceipt[] = [];
  const dispatches: Parameters<GitHubWorkStore["recordDispatch"]>[0][] = [];
  const fail = () => {
    if (options.fail) throw options.fail;
  };
  const api: GitHubApi = {
    maxBodyLength: 65_536,
    getRepository: async () => {
      throw new Error("not used");
    },
    findPullRequestForBranch: async () => {
      throw new Error("not used");
    },
    createPullRequest: async () => {
      throw new Error("not used");
    },
    getPullRequest: async () => {
      throw new Error("not used");
    },
    updatePullRequestBody: async () => {
      throw new Error("not used");
    },
    upsertComment: async () => {
      throw new Error("not used");
    },
    dispatchWorkflow: async (input) => {
      calls.push(`dispatch ${input.workflow} ${input.ref}`);
      fail();
      return options.run === undefined
        ? { id: 42, html_url: "https://github.com/acme/app/actions/runs/42" }
        : options.run;
    },
    getWorkflowRun: async (runId) => {
      calls.push(`run ${runId}`);
      fail();
      return {
        id: runId,
        path: ".github/workflows/ci.yml",
        head_branch: "main",
        status: "completed",
        conclusion: "success",
        html_url: `https://github.com/acme/app/actions/runs/${runId}`,
      };
    },
    rerunWorkflow: async (runId, failedOnly) => {
      calls.push(`rerun ${runId} ${failedOnly}`);
      fail();
    },
    submitReview: async (input) => {
      calls.push(
        `review ${input.number} ${input.event} ${input.commitId} ${input.body ?? "-"}`,
      );
      fail();
      return {
        id: 77,
        html_url: `https://github.com/acme/app/pull/${input.number}#pullrequestreview-77`,
      };
    },
  };
  const gate: GitHubGate = {
    grant: async (work) => {
      works.push(work);
      if (options.refuse) throw options.refuse;
      const grant: GitHubGrant = {
        role: "author",
        repo: { owner: "acme", name: "app" },
        permissions: { actions: "write" },
        gitCredential: { username: "x-access-token", password: "issued" },
        api,
        unit: async () => "app:test:1",
        allowedBy: { workflow: "ci.yml" },
        context: {
          ownerId: "owner-a",
          sessionId: work.sessionId,
          agentId: "agent-1",
          agentReleaseId: "release-1",
          repositoryId: "app",
        },
      };
      return grant;
    },
  };
  const store: GitHubWorkStore = {
    recordReceipt: async (receipt) => {
      receipts.push(receipt);
      return `receipt-${receipts.length}`;
    },
    recordDispatch: async (input) => {
      dispatches.push(input);
      return "receipt-dispatch";
    },
    pullRequestOpener: async (ownerId, repositoryId, number) => {
      calls.push(`opener ${ownerId} ${repositoryId} ${number}`);
      return number === 12
        ? {
            sessionId: "33333333-3333-4333-8333-333333333333",
            agentId: "agent-1",
          }
        : null;
    },
  };
  const service = createGitHubWorkService({
    authorization: createAuthorizationPolicy(),
    gate,
    store,
  });
  return { service, works, calls, receipts, dispatches };
}

async function refusal(promise: Promise<unknown>) {
  const error = await promise.then(
    () => {
      throw new Error("expected a refusal");
    },
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(SessionServiceError);
  const { code, details } = error as SessionServiceError;
  return { code, details };
}

describe("dispatching a workflow", () => {
  test("records the dispatch with input names only", async () => {
    const { service, works, calls, dispatches, receipts } = harness();
    const answered = await service.dispatch(actor, SESSION.toUpperCase(), {
      workflow: "ci.yml",
      ref: "main",
      inputs: { target: SECRET_INPUT, env: "staging" },
    });
    expect(answered).toEqual({
      receipt_id: "receipt-dispatch",
      run: { id: 42, html_url: "https://github.com/acme/app/actions/runs/42" },
    });
    expect(works).toMatchObject([
      {
        sessionId: SESSION,
        purpose: "dispatch",
        workflow: { file: "ci.yml", ref: "main" },
      },
    ]);
    expect(calls).toEqual(["dispatch ci.yml main"]);
    expect(receipts).toEqual([]);
    expect(dispatches).toHaveLength(1);
    expect(dispatches[0]).toMatchObject({
      run: { id: 42, workflow: "ci.yml", ref: "main" },
      result: {
        session_id: SESSION,
        repository_id: "app",
        workflow: "ci.yml",
        ref: "main",
        input_keys: ["env", "target"],
        run_id: 42,
        allowed_by: { workflow: "ci.yml" },
      },
    });
    expect(JSON.stringify(dispatches)).not.toContain(SECRET_INPUT);
    expect(JSON.stringify(dispatches)).not.toContain("staging");
  });

  test("a run GitHub does not name is recorded without a run row", async () => {
    const { service, dispatches } = harness({ run: null });
    expect(
      await service.dispatch(actor, SESSION, {
        workflow: "ci.yml",
        ref: "main",
      }),
    ).toEqual({ receipt_id: "receipt-dispatch", run: null });
    expect(dispatches[0]).toMatchObject({
      run: null,
      result: { run_id: null, input_keys: [] },
    });
  });

  test("a GitHub failure is BACKEND_UNAVAILABLE with a failed receipt that keeps no input value", async () => {
    const { service, receipts, dispatches } = harness({
      fail: new GitHubCallError("dispatch", 422, "req-1"),
    });
    expect(
      await refusal(
        service.dispatch(actor, SESSION, {
          workflow: "ci.yml",
          ref: "main",
          inputs: { target: SECRET_INPUT },
        }),
      ),
    ).toEqual({
      code: "BACKEND_UNAVAILABLE",
      details: { receipt_id: "receipt-1" },
    });
    expect(dispatches).toEqual([]);
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({
      operation: "dispatch_workflow",
      status: "failed",
      result: {
        workflow: "ci.yml",
        input_keys: ["target"],
        status: 422,
        github_request_id: "req-1",
      },
    });
    expect(JSON.stringify(receipts)).not.toContain(SECRET_INPUT);
  });

  test("a gate refusal is GITHUB_REFUSED with its reason_code and receipt_id, and GitHub is not called", async () => {
    for (const reason of [
      "workflow_not_allowed",
      "over_workspace_ceiling",
    ] as const) {
      const { service, calls } = harness({
        refuse: new GitHubGateError(reason, "receipt-gate"),
      });
      expect(
        await refusal(
          service.dispatch(actor, SESSION, { workflow: "ci.yml", ref: "main" }),
        ),
      ).toEqual({
        code: "GITHUB_REFUSED",
        details: { reason_code: reason, receipt_id: "receipt-gate" },
      });
      expect(calls).toEqual([]);
    }
  });

  test("a caller without session.submit is refused before the gate", async () => {
    const { service, works } = harness();
    const reader = {
      ...actor,
      caller: testCaller("owner-a", ["sessions:read"]),
    };
    expect(
      (
        await refusal(
          service.dispatch(reader, SESSION, {
            workflow: "ci.yml",
            ref: "main",
          }),
        )
      ).code,
    ).toBe("FORBIDDEN");
    expect((await refusal(service.rerun(reader, SESSION, 42, {}))).code).toBe(
      "FORBIDDEN",
    );
    expect(works).toEqual([]);
  });
});

describe("reading a run", () => {
  test("asks the gate for actions_read and answers GitHub's run", async () => {
    const { service, works } = harness();
    expect(await service.getRun(actor, SESSION, 7)).toMatchObject({
      id: 7,
      conclusion: "success",
    });
    expect(works[0]?.purpose).toBe("actions_read");
  });

  test("a run GitHub does not have is NOT_FOUND", async () => {
    const { service } = harness({
      fail: new GitHubCallError("run", 404, null),
    });
    expect((await refusal(service.getRun(actor, SESSION, 7))).code).toBe(
      "NOT_FOUND",
    );
  });

  test("another GitHub failure is BACKEND_UNAVAILABLE", async () => {
    const { service } = harness({
      fail: new GitHubCallError("run", 500, null),
    });
    expect((await refusal(service.getRun(actor, SESSION, 7))).code).toBe(
      "BACKEND_UNAVAILABLE",
    );
  });
});

describe("rerunning a run", () => {
  test("reruns and records a succeeded receipt", async () => {
    const { service, works, calls, receipts } = harness();
    expect(
      await service.rerun(actor, SESSION, 42, { failed_only: true }),
    ).toEqual({ receipt_id: "receipt-1" });
    expect(works).toMatchObject([{ purpose: "rerun", runId: 42 }]);
    expect(calls).toEqual(["rerun 42 true"]);
    expect(receipts).toEqual([
      {
        ownerId: "owner-a",
        sessionId: SESSION,
        actor: {
          principal: { kind: "api_key", id: "owner-a" },
          actor_user_id: null,
          agent_id: null,
        },
        operation: "rerun_workflow",
        status: "succeeded",
        result: {
          session_id: SESSION,
          agent_id: "agent-1",
          agent_release_id: "release-1",
          repository_id: "app",
          allowed_by: { workflow: "ci.yml" },
          run_id: 42,
          failed_only: true,
          workflow: "ci.yml",
        },
        error: null,
      },
    ]);
  });

  test("a gate refusal is GITHUB_REFUSED", async () => {
    const { service, calls } = harness({
      refuse: new GitHubGateError("run_ref_unprovable", "receipt-gate"),
    });
    expect(await refusal(service.rerun(actor, SESSION, 42, {}))).toEqual({
      code: "GITHUB_REFUSED",
      details: {
        reason_code: "run_ref_unprovable",
        receipt_id: "receipt-gate",
      },
    });
    expect(calls).toEqual([]);
  });
});

describe("reviewing a pull request", () => {
  const COMMIT = "0123456789abcdef0123456789abcdef01234567";
  const REVIEW_BODY = "looks-good-private-note";

  test("submits on the commit read and records who opened the pull request, never the body", async () => {
    const { service, works, calls, receipts } = harness();
    expect(
      await service.review(actor, SESSION, 12, {
        event: "REQUEST_CHANGES",
        commit_id: COMMIT,
        body: REVIEW_BODY,
      }),
    ).toEqual({
      receipt_id: "receipt-1",
      review: {
        id: 77,
        html_url: "https://github.com/acme/app/pull/12#pullrequestreview-77",
      },
    });
    expect(works).toMatchObject([
      {
        purpose: "review",
        review: { number: 12, commitId: COMMIT, event: "REQUEST_CHANGES" },
      },
    ]);
    expect(calls).toEqual([
      "opener owner-a app 12",
      `review 12 REQUEST_CHANGES ${COMMIT} ${REVIEW_BODY}`,
    ]);
    expect(receipts).toEqual([
      {
        ownerId: "owner-a",
        sessionId: SESSION,
        actor: {
          principal: { kind: "api_key", id: "owner-a" },
          actor_user_id: null,
          agent_id: null,
        },
        operation: "review_pull_request",
        status: "succeeded",
        result: {
          session_id: SESSION,
          agent_id: "agent-1",
          agent_release_id: "release-1",
          repository_id: "app",
          number: 12,
          commit_id: COMMIT,
          event: "REQUEST_CHANGES",
          opened_by_session_id: "33333333-3333-4333-8333-333333333333",
          opened_by_agent_id: "agent-1",
          review_id: 77,
        },
        error: null,
      },
    ]);
    expect(JSON.stringify(receipts)).not.toContain(REVIEW_BODY);
  });

  test("a pull request the platform did not open names no opener", async () => {
    const { service, receipts } = harness();
    await service.review(actor, SESSION, 5, {
      event: "APPROVE",
      commit_id: COMMIT,
    });
    expect(receipts[0]?.result).toMatchObject({
      number: 5,
      event: "APPROVE",
      opened_by_session_id: null,
      opened_by_agent_id: null,
    });
  });

  test("GitHub refusing the review is BACKEND_UNAVAILABLE with a failed receipt and no body", async () => {
    const { service, receipts } = harness({
      fail: new GitHubCallError("pull request review", 422, "req-9"),
    });
    expect(
      await refusal(
        service.review(actor, SESSION, 12, {
          event: "COMMENT",
          commit_id: COMMIT,
          body: REVIEW_BODY,
        }),
      ),
    ).toEqual({
      code: "BACKEND_UNAVAILABLE",
      details: { receipt_id: "receipt-1" },
    });
    expect(receipts[0]).toMatchObject({
      operation: "review_pull_request",
      status: "failed",
      result: { number: 12, status: 422, github_request_id: "req-9" },
    });
    expect(JSON.stringify(receipts)).not.toContain(REVIEW_BODY);
  });

  test("a gate refusal (no reviewer App) is GITHUB_REFUSED and GitHub is not called", async () => {
    const { service, calls } = harness({
      refuse: new GitHubGateError("no_reviewer_app", "receipt-gate"),
    });
    expect(
      await refusal(
        service.review(actor, SESSION, 12, {
          event: "APPROVE",
          commit_id: COMMIT,
        }),
      ),
    ).toEqual({
      code: "GITHUB_REFUSED",
      details: { reason_code: "no_reviewer_app", receipt_id: "receipt-gate" },
    });
    expect(calls).toEqual([]);
  });

  test("a caller without session.submit is refused before the gate", async () => {
    const { service, works } = harness();
    const reader = {
      ...actor,
      caller: testCaller("owner-a", ["sessions:read"]),
    };
    expect(
      (
        await refusal(
          service.review(reader, SESSION, 12, {
            event: "APPROVE",
            commit_id: COMMIT,
          }),
        )
      ).code,
    ).toBe("FORBIDDEN");
    expect(works).toEqual([]);
  });
});
