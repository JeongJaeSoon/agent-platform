import type {
  AchievementEvidenceKind,
  AchievementJudgmentError,
  AchievementPayload,
  AchievementReviewState,
  AchievementRuleJudge,
  GitHubPullRequestOutcomeState,
  GitHubReviewEvent,
  ListSessionAchievementsResponse,
} from "@werft-ai/contracts";

/** Triggers within this of the last one merge into one judgment. */
export const ACHIEVEMENT_JUDGMENT_QUIET_MS = 120_000;

/** A judgment the judge holds the lease of. */
export type ClaimedJudgment = {
  id: string;
  sessionId: string;
  leaseToken: string;
};

/** A rule in use for the session, with its type. */
export type JudgedRule = {
  id: string;
  familyId: string;
  typeId: string;
  typeKey: string;
  builtin: boolean;
  evidenceKind: AchievementEvidenceKind;
  judge: AchievementRuleJudge;
};

/** A session_outcomes row, as evidence. */
export type OutcomeEvidence =
  | {
      kind: "github_pull_request";
      id: string;
      url: string;
      number: number;
      state: GitHubPullRequestOutcomeState;
      mergedAt: Date | null;
      additions: number | null;
      deletions: number | null;
    }
  | {
      kind: "github_review";
      id: string;
      url: string;
      number: number;
      event: GitHubReviewEvent;
      commitId: string;
    };

export type JudgmentContext = {
  session: {
    id: string;
    title: string | null;
    agentId: string | null;
    agentReleaseId: string | null;
  };
  rules: JudgedRule[];
  outcomes: OutcomeEvidence[];
};

export type NewAchievement = {
  ruleId: string;
  ruleFamilyId: string;
  typeId: string;
  agentId: string | null;
  agentReleaseId: string | null;
  title: string;
  link: string;
  evidenceKind: AchievementEvidenceKind;
  evidenceId: string | null;
  payload: AchievementPayload | null;
  judge: AchievementRuleJudge;
  reviewState: AchievementReviewState;
};

export type JudgmentResult = {
  status: "succeeded" | "skipped" | "failed";
  errorCode: AchievementJudgmentError | null;
  /** The rule versions and evidence ids paired. */
  rules: string[];
  evidenceIds: string[];
  achievements: NewAchievement[];
};

/** The judgments and achievements of sessions; the judge is the only writer. */
export interface AchievementJudgmentStore {
  /**
   * Leases at most `max` judgments due: queued ones whose last trigger is
   * older than the quiet time, and running ones whose lease ran out.
   */
  claim(input: { max: number; leaseMs: number }): Promise<ClaimedJudgment[]>;
  /** What the judgment pairs: the session, its rules in use, its outcomes. */
  context(judgment: ClaimedJudgment): Promise<JudgmentContext>;
  /**
   * Writes the result and the achievements in one transaction under the
   * lease; one a rule family already has for the evidence is kept. False
   * when the lease was taken over meanwhile.
   */
  finish(judgment: ClaimedJudgment, result: JudgmentResult): Promise<boolean>;
  /** Null when the owner has no such session. */
  list(
    ownerId: string,
    sessionId: string,
  ): Promise<ListSessionAchievementsResponse | null>;
}
