import { describe, expect, test } from "bun:test";
import type { SessionOutputsResult } from "../../checkpoints/checkpoint-service.ts";
import { createAchievementJudge } from "./achievement-judge.ts";
import type {
  AchievementJudgmentStore,
  ClaimedJudgment,
  JudgedRule,
  JudgmentContext,
  JudgmentResult,
} from "./achievement-judgment-store.ts";

const SESSION = "0f8b6a52-3d1e-4c7a-9b2f-5e6d7c8a9b01";
const CLAIMED: ClaimedJudgment = {
  id: "judgment-1",
  sessionId: SESSION,
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

function judgeOf(
  context: Omit<JudgmentContext, "session"> & {
    title?: string | null;
  },
  outputs: SessionOutputsResult = { status: "none" },
) {
  const finished: JudgmentResult[] = [];
  const warnings: string[] = [];
  const store: AchievementJudgmentStore = {
    claim: async () => [CLAIMED],
    context: async () => ({
      session: {
        id: SESSION,
        title: context.title ?? null,
        agentId: "agent-1",
        agentReleaseId: "release-1",
      },
      rules: context.rules,
      outcomes: context.outcomes,
    }),
    finish: async (_judgment, result) => {
      finished.push(result);
      return true;
    },
    list: async () => null,
  };
  const reads: string[] = [];
  const judge = createAchievementJudge({
    store,
    outputs: {
      readOutputs: async (sessionId) => {
        reads.push(sessionId);
        return outputs;
      },
    },
    logger: { info() {}, warn: (message) => warnings.push(message) },
  });
  return { judge, finished, warnings, reads };
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
        link: `/v1/sessions/${SESSION}/outputs/out%2Freport.md`,
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

  test("an out/ list that cannot be read fails the judgment and counts nothing", async () => {
    const { judge, finished } = judgeOf(
      {
        rules: [
          rule("pull_request", "github_pull_request"),
          rule("document", "out_file"),
        ],
        outcomes: [PULL_REQUEST],
      },
      { status: "unavailable", reason: "manifest missing" },
    );
    await judge.runOnce();
    expect(finished[0]).toMatchObject({
      status: "failed",
      errorCode: "outputs_unavailable",
      achievements: [],
    });
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
