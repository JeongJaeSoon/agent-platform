import { describe, expect, test } from "bun:test";
import type { SessionOutputsResult } from "../../checkpoints/checkpoint-service.ts";
import { createAchievementJudge } from "./achievement-judge.ts";
import type {
  AchievementJudgmentStore,
  ClaimedJudgment,
  JudgedRule,
  JudgeInForce,
  JudgmentContext,
  JudgmentResult,
} from "./achievement-judgment-store.ts";

const SESSION = "0f8b6a52-3d1e-4c7a-9b2f-5e6d7c8a9b01";
const CLAIMED: ClaimedJudgment = {
  id: "judgment-1",
  sessionId: SESSION,
  attempts: 1,
  leaseToken: "lease-1",
};

function rule(
  typeKey: string,
  evidenceKind: JudgedRule["evidenceKind"],
  extra: Partial<JudgedRule> = {},
): JudgedRule {
  return {
    id: `rule-${typeKey}`,
    familyId: `family-${typeKey}`,
    typeId: `type-${typeKey}`,
    typeKey,
    builtin: true,
    evidenceKind,
    judge: "always",
    ...extra,
  };
}

const PULL_REQUEST = {
  kind: "github_pull_request" as const,
  id: "outcome-pr",
  url: "https://github.com/acme/app/pull/12",
  number: 12,
  state: "open" as const,
  mergedAt: null,
  additions: 3,
  deletions: 1,
};
const REVIEW = {
  kind: "github_review" as const,
  id: "outcome-review",
  url: "https://github.com/acme/app/pull/9#pullrequestreview-77",
  number: 9,
  event: "APPROVE" as const,
  commitId: "c".repeat(40),
};

const NO_JUDGE: JudgeInForce = {
  connectionId: null,
  dailyBudgetUsd: 1,
  maxPerSession: 20,
  spentUsd: 0,
  sessionJudgments: 0,
};

function judgeOf(
  context: Omit<JudgmentContext, "session" | "judge"> & {
    title?: string | null;
    judge?: Partial<JudgeInForce>;
  },
  outputs: SessionOutputsResult = { status: "none" },
  options: {
    attempts?: number;
    contextFails?: boolean;
    outputsThrow?: boolean;
    now?: Date;
  } = {},
) {
  const finished: JudgmentResult[] = [];
  const days: Date[] = [];
  const warnings: string[] = [];
  const store: Pick<AchievementJudgmentStore, "claim" | "context" | "finish"> =
    {
      claim: async () => [{ ...CLAIMED, attempts: options.attempts ?? 1 }],
      context: async (_judgment, today) => {
        days.push(today);
        if (options.contextFails) throw new Error("connection refused");
        return {
          session: {
            id: SESSION,
            title: context.title ?? null,
            agentId: "agent-1",
            agentReleaseId: "release-1",
          },
          rules: context.rules,
          outcomes: context.outcomes,
          judge: { ...NO_JUDGE, ...context.judge },
        };
      },
      finish: async (_judgment, result) => {
        finished.push(result);
        return true;
      },
    };
  const reads: string[] = [];
  const judge = createAchievementJudge({
    store,
    outputs: {
      readOutputs: async (sessionId) => {
        reads.push(sessionId);
        if (options.outputsThrow) throw new Error("object store down");
        return outputs;
      },
    },
    logger: { info() {}, warn: (message) => warnings.push(message) },
    ...(options.now === undefined ? {} : { now: () => options.now as Date }),
  });
  return { judge, finished, warnings, reads, days };
}

describe("achievement judge", () => {
  test("an always rule counts each evidence of its kind, with the built-in payload and the review state of the kind", async () => {
    const { judge, finished, reads } = judgeOf(
      {
        rules: [
          rule("pull_request", "github_pull_request"),
          rule("code_review", "github_review"),
          rule("document", "out_file"),
        ],
        outcomes: [PULL_REQUEST, REVIEW],
      },
      {
        status: "ready",
        revision: 3,
        outputs: [
          { path: "out/report.md", bytes: 120, omitted: "too_large" },
        ] as never,
      },
    );
    expect(await judge.runOnce()).toBe(1);
    expect(reads).toEqual([SESSION]);
    const [result] = finished;
    expect(result?.status).toBe("succeeded");
    expect(result?.errorCode).toBeNull();
    expect(result?.rules).toEqual([
      "rule-pull_request",
      "rule-code_review",
      "rule-document",
    ]);
    expect(result?.evidenceIds).toEqual([
      "outcome-pr",
      "outcome-review",
      "out/report.md",
    ]);
    expect(result?.achievements).toEqual([
      {
        ruleId: "rule-pull_request",
        ruleFamilyId: "family-pull_request",
        typeId: "type-pull_request",
        agentId: "agent-1",
        agentReleaseId: "release-1",
        title: "acme/app#12",
        link: "https://github.com/acme/app/pull/12",
        evidenceKind: "github_pull_request",
        evidenceId: "outcome-pr",
        payload: {
          repository: "acme/app",
          number: 12,
          url: "https://github.com/acme/app/pull/12",
          state: "open",
          merged_at: null,
          additions: 3,
          deletions: 1,
        },
        judge: "always",
        reviewState: "auto",
      },
      {
        ruleId: "rule-code_review",
        ruleFamilyId: "family-code_review",
        typeId: "type-code_review",
        agentId: "agent-1",
        agentReleaseId: "release-1",
        title: "acme/app#9",
        link: REVIEW.url,
        evidenceKind: "github_review",
        evidenceId: "outcome-review",
        payload: {
          repository: "acme/app",
          number: 9,
          url: REVIEW.url,
          event: "APPROVE",
          commit_id: "c".repeat(40),
        },
        judge: "always",
        reviewState: "auto",
      },
      {
        ruleId: "rule-document",
        ruleFamilyId: "family-document",
        typeId: "type-document",
        agentId: "agent-1",
        agentReleaseId: "release-1",
        title: "out/report.md",
        link: `/sessions/${SESSION}`,
        evidenceKind: "out_file",
        evidenceId: "out/report.md",
        payload: { path: "out/report.md", size: 120 },
        judge: "always",
        reviewState: "needs_review",
      },
    ]);
  });

  test("a type a person made gets no payload; the conversation is the session's title", async () => {
    const { judge, finished, reads } = judgeOf({
      rules: [
        rule("bug_fix", "github_pull_request", { builtin: false }),
        rule("answered", "conversation", { builtin: false }),
      ],
      outcomes: [PULL_REQUEST],
      title: "Fix the payment retry",
    });
    await judge.runOnce();
    // No out_file rule: the checkpoint is not read.
    expect(reads).toEqual([]);
    const achievements = finished[0]?.achievements ?? [];
    expect(
      achievements.map((a) => [a.title, a.payload, a.reviewState]),
    ).toEqual([
      ["acme/app#12", null, "auto"],
      ["Fix the payment retry", null, "needs_review"],
    ]);
    expect(achievements[1]).toMatchObject({
      evidenceKind: "conversation",
      evidenceId: null,
      link: `/sessions/${SESSION}`,
    });
  });

  test("with luna rules only and no judge, the judgment is skipped and counts nothing", async () => {
    const { judge, finished } = judgeOf({
      rules: [rule("pull_request", "github_pull_request", { judge: "luna" })],
      outcomes: [PULL_REQUEST],
    });
    await judge.runOnce();
    expect(finished).toEqual([
      {
        status: "skipped",
        errorCode: "judge_unavailable",
        rules: ["rule-pull_request"],
        evidenceIds: ["outcome-pr"],
        achievements: [],
      },
    ]);
  });

  test("over the day's budget, a luna pair defers the judgment to the next UTC midnight; always rules still count", async () => {
    const { judge, finished, days } = judgeOf(
      {
        rules: [
          rule("pull_request", "github_pull_request", { judge: "luna" }),
          rule("code_review", "github_review"),
        ],
        outcomes: [PULL_REQUEST, REVIEW],
        judge: { connectionId: "conn-1", dailyBudgetUsd: 1, spentUsd: 1 },
      },
      { status: "none" },
      { now: new Date("2026-11-02T15:30:00.000Z") },
    );
    await judge.runOnce();
    expect(days).toEqual([new Date("2026-11-02T00:00:00.000Z")]);
    expect(finished).toHaveLength(1);
    expect(finished[0]).toMatchObject({
      status: "deferred",
      until: new Date("2026-11-03T00:00:00.000Z"),
      errorCode: null,
    });
    expect(finished[0]?.achievements.map((a) => a.ruleId)).toEqual([
      "rule-code_review",
    ]);
  });

  test("under the budget, a session at its judgment cap is skipped with session_limit", async () => {
    const at = (spentUsd: number, sessionJudgments: number) =>
      judgeOf({
        rules: [rule("pull_request", "github_pull_request", { judge: "luna" })],
        outcomes: [PULL_REQUEST],
        judge: {
          connectionId: "conn-1",
          dailyBudgetUsd: 1,
          maxPerSession: 2,
          spentUsd,
          sessionJudgments,
        },
      });
    const capped = at(0.5, 2);
    await capped.judge.runOnce();
    expect(capped.finished[0]).toMatchObject({
      status: "skipped",
      errorCode: "session_limit",
    });
    // Under both, a judge is still missing until its backend exists.
    const open = at(0.5, 1);
    await open.judge.runOnce();
    expect(open.finished[0]).toMatchObject({
      status: "skipped",
      errorCode: "judge_unavailable",
    });
  });

  test("with no connection, budget and cap are not consulted", async () => {
    const { judge, finished } = judgeOf({
      rules: [rule("pull_request", "github_pull_request", { judge: "luna" })],
      outcomes: [PULL_REQUEST],
      judge: { spentUsd: 5, sessionJudgments: 50 },
    });
    await judge.runOnce();
    expect(finished[0]).toMatchObject({
      status: "skipped",
      errorCode: "judge_unavailable",
    });
  });

  test("a rule without evidence of its kind leaves the judgment succeeded with nothing", async () => {
    const { judge, finished } = judgeOf({
      rules: [rule("pull_request", "github_pull_request", { judge: "luna" })],
      outcomes: [REVIEW],
    });
    await judge.runOnce();
    expect(finished[0]).toMatchObject({
      status: "succeeded",
      errorCode: null,
      rules: [],
      achievements: [],
    });
  });

  test("an out/ list that cannot be read still counts the pull request and retries 1, 5 and 30 minutes later, then fails", async () => {
    const unread = (attempts: number) =>
      judgeOf(
        {
          rules: [
            rule("pull_request", "github_pull_request"),
            rule("document", "out_file"),
          ],
          outcomes: [PULL_REQUEST],
        },
        { status: "unavailable", reason: "manifest missing" },
        { attempts },
      );
    const results = [];
    for (const attempts of [1, 2, 3, 4]) {
      const { judge, finished } = unread(attempts);
      await judge.runOnce();
      results.push(finished[0]);
    }
    expect(
      results.map((result) => [
        result?.status,
        result && "retryInMs" in result ? result.retryInMs : null,
        result?.errorCode,
        result?.achievements.map((a) => a.evidenceKind),
      ]),
    ).toEqual([
      ["queued", 60_000, "outputs_unavailable", ["github_pull_request"]],
      ["queued", 300_000, "outputs_unavailable", ["github_pull_request"]],
      ["queued", 1_800_000, "outputs_unavailable", ["github_pull_request"]],
      ["failed", null, "outputs_unavailable", ["github_pull_request"]],
    ]);
  });

  test("an out/ list that throws is an unreadable one: the pull request still counts and the try is retried", async () => {
    const { judge, finished, warnings } = judgeOf(
      {
        rules: [
          rule("pull_request", "github_pull_request"),
          rule("document", "out_file"),
        ],
        outcomes: [PULL_REQUEST],
      },
      undefined,
      { outputsThrow: true },
    );
    await judge.runOnce();
    expect(finished).toMatchObject([
      { status: "queued", retryInMs: 60_000, errorCode: "outputs_unavailable" },
    ]);
    expect(finished[0]?.achievements.map((a) => a.evidenceKind)).toEqual([
      "github_pull_request",
    ]);
    expect(warnings).toEqual(["Achievement judgment could not list out/"]);
  });

  test("a try that throws is retried the same way, and a judgment past its retries is failed without judging", async () => {
    const thrown = judgeOf({ rules: [], outcomes: [] }, undefined, {
      attempts: 1,
      contextFails: true,
    });
    await thrown.judge.runOnce();
    expect(thrown.finished).toEqual([
      {
        status: "queued",
        retryInMs: 60_000,
        errorCode: null,
        rules: [],
        evidenceIds: [],
        achievements: [],
      },
    ]);
    const last = judgeOf({ rules: [], outcomes: [] }, undefined, {
      attempts: 4,
      contextFails: true,
    });
    await last.judge.runOnce();
    expect(last.finished[0]).toMatchObject({
      status: "failed",
      errorCode: null,
    });
    // A replica that died on every try never finished one.
    const spent = judgeOf(
      {
        rules: [rule("pull_request", "github_pull_request")],
        outcomes: [PULL_REQUEST],
      },
      undefined,
      { attempts: 5 },
    );
    await spent.judge.runOnce();
    expect(spent.finished).toEqual([
      {
        status: "failed",
        errorCode: null,
        rules: [],
        evidenceIds: [],
        achievements: [],
      },
    ]);
  });

  test("evidence whose built-in payload fails its schema is not counted", async () => {
    const { judge, finished, warnings } = judgeOf({
      rules: [rule("pull_request", "github_pull_request")],
      outcomes: [{ ...PULL_REQUEST, number: 0 }],
    });
    await judge.runOnce();
    expect(finished[0]?.achievements).toEqual([]);
    expect(warnings).toHaveLength(1);
  });
});
