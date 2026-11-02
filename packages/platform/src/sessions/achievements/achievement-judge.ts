import {
  type AchievementJudgmentError,
  type AchievementPayload,
  BUILTIN_ACHIEVEMENT_PAYLOAD_SCHEMAS,
} from "@werft-ai/contracts";
import type { SessionOutputSource } from "../output-service.ts";
import {
  ACHIEVEMENT_JUDGMENT_RETRY_MS,
  type AchievementJudgmentStore,
  type ClaimedJudgment,
  type JudgedRule,
  type JudgmentContext,
  type JudgmentResult,
  type NewAchievement,
} from "./achievement-judgment-store.ts";
import { nextUtcDay, utcDayStart } from "./judgment-token.ts";

export const ACHIEVEMENT_JUDGE_INTERVAL_MS = 30_000;
/** A judgment a dead replica held is claimed again after this. */
export const ACHIEVEMENT_JUDGMENT_LEASE_MS = 120_000;
export const ACHIEVEMENT_JUDGMENT_CLAIM_MAX = 20;

type Logger = {
  info(message: string, fields?: Readonly<Record<string, unknown>>): void;
  warn(message: string, fields?: Readonly<Record<string, unknown>>): void;
};

type Evidence = {
  kind: JudgedRule["evidenceKind"];
  id: string | null;
  title: string;
  link: string;
  /** What a built-in type's payload copies. */
  payload: Record<string, unknown>;
};

/** `owner/repo` of a GitHub pull request or review URL. */
function repositoryOf(url: string): string | null {
  try {
    const [owner, repo] = new URL(url).pathname.split("/").filter(Boolean);
    return owner && repo ? `${owner}/${repo}` : null;
  } catch {
    return null;
  }
}

function evidenceOf(
  context: JudgmentContext,
  files: readonly { path: string; bytes: number }[],
): Evidence[] {
  const sessionId = context.session.id;
  const evidence: Evidence[] = [];
  for (const outcome of context.outcomes) {
    const repository = repositoryOf(outcome.url);
    if (repository === null) continue;
    const base = {
      kind: outcome.kind,
      id: outcome.id,
      title: `${repository}#${outcome.number}`,
      link: outcome.url,
    };
    evidence.push(
      outcome.kind === "github_pull_request"
        ? {
            ...base,
            payload: {
              repository,
              number: outcome.number,
              url: outcome.url,
              state: outcome.state,
              merged_at: outcome.mergedAt?.toISOString() ?? null,
              additions: outcome.additions,
              deletions: outcome.deletions,
            },
          }
        : {
            ...base,
            payload: {
              repository,
              number: outcome.number,
              url: outcome.url,
              event: outcome.event,
              commit_id: outcome.commitId,
            },
          },
    );
  }
  for (const file of files) {
    evidence.push({
      kind: "out_file",
      id: file.path,
      title: file.path,
      // The console addresses the session, not its outputs tab or a file.
      link: `/sessions/${sessionId}`,
      payload: { path: file.path, size: file.bytes },
    });
  }
  // A session has a conversation once its first message gave it a title.
  if (context.session.title !== null) {
    evidence.push({
      kind: "conversation",
      id: null,
      title: context.session.title,
      link: `/sessions/${sessionId}`,
      payload: {},
    });
  }
  return evidence;
}

/**
 * Judges each claimed judgment's session against the workspace's rules in
 * use (design achievement-rules.md §4). Each API replica runs one; a claim
 * leases its judgments, and the achievements and the result are written in
 * one transaction under that lease. An `always` rule counts each of its
 * evidence at no cost. A `luna` rule's pairs wait for the next UTC day once
 * the workspace's judgments have spent the day's budget, and are skipped
 * for a session at its cap (`session_limit`); no judge backend exists yet,
 * so otherwise they leave the judgment `skipped` (`judge_unavailable`). A
 * try that fails is tried again 1, 5 and 30 minutes later, then ends
 * `failed`.
 */
export function createAchievementJudge(deps: {
  store: Pick<AchievementJudgmentStore, "claim" | "context" | "finish">;
  outputs: Pick<SessionOutputSource, "readOutputs">;
  logger: Logger;
  claimMax?: number;
  leaseMs?: number;
  now?: () => Date;
}) {
  const { store, outputs, logger } = deps;
  const now = deps.now ?? (() => new Date());
  const claimMax = deps.claimMax ?? ACHIEVEMENT_JUDGMENT_CLAIM_MAX;
  const leaseMs = deps.leaseMs ?? ACHIEVEMENT_JUDGMENT_LEASE_MS;

  /** The next retry of a failed try, or `failed` once the retries are spent. */
  function again(
    claimed: ClaimedJudgment,
    errorCode: AchievementJudgmentError | null,
  ):
    | { status: "queued"; retryInMs: number; errorCode: typeof errorCode }
    | { status: "failed"; errorCode: typeof errorCode } {
    const retryInMs = ACHIEVEMENT_JUDGMENT_RETRY_MS[claimed.attempts - 1];
    return retryInMs === undefined
      ? { status: "failed", errorCode }
      : { status: "queued", retryInMs, errorCode };
  }

  function payloadOf(
    rule: JudgedRule,
    evidence: Evidence,
  ): { ok: true; payload: AchievementPayload | null } | { ok: false } {
    if (
      !rule.builtin ||
      !Object.hasOwn(BUILTIN_ACHIEVEMENT_PAYLOAD_SCHEMAS, rule.typeKey)
    ) {
      return { ok: true, payload: null };
    }
    const schema =
      BUILTIN_ACHIEVEMENT_PAYLOAD_SCHEMAS[
        rule.typeKey as keyof typeof BUILTIN_ACHIEVEMENT_PAYLOAD_SCHEMAS
      ];
    const parsed = schema.safeParse(evidence.payload);
    return parsed.success ? { ok: true, payload: parsed.data } : { ok: false };
  }

  async function judge(claimed: ClaimedJudgment): Promise<JudgmentResult> {
    const at = now();
    const context = await store.context(claimed, utcDayStart(at));
    let files: { path: string; bytes: number }[] = [];
    let outputsUnavailable = false;
    if (context.rules.some((rule) => rule.evidenceKind === "out_file")) {
      const listed = await outputs
        .readOutputs(claimed.sessionId)
        .catch((error: unknown) => {
          logger.warn("Achievement judgment could not list out/", {
            judgment_id: claimed.id,
            error: error instanceof Error ? error.name : String(error),
          });
          return { status: "unavailable" as const };
        });
      // The pairs that need no out/ list are counted all the same.
      if (listed.status === "unavailable") outputsUnavailable = true;
      if (listed.status === "ready") {
        files = listed.outputs.map(({ path, bytes }) => ({ path, bytes }));
      }
    }
    const evidence = evidenceOf(context, files);
    const rules = new Set<string>();
    const evidenceIds = new Set<string>();
    const achievements: NewAchievement[] = [];
    let unjudged = false;
    for (const rule of context.rules) {
      for (const item of evidence) {
        if (item.kind !== rule.evidenceKind) continue;
        rules.add(rule.id);
        if (item.id !== null) evidenceIds.add(item.id);
        if (rule.judge !== "always") {
          unjudged = true;
          continue;
        }
        const payload = payloadOf(rule, item);
        if (!payload.ok) {
          logger.warn("Achievement payload failed its schema; not counted", {
            judgment_id: claimed.id,
            rule_id: rule.id,
            evidence_kind: item.kind,
          });
          continue;
        }
        achievements.push({
          ruleId: rule.id,
          ruleFamilyId: rule.familyId,
          typeId: rule.typeId,
          agentId: context.session.agentId,
          agentReleaseId: context.session.agentReleaseId,
          title: item.title,
          link: item.link,
          evidenceKind: item.kind,
          evidenceId: item.id,
          payload: payload.payload,
          judge: "always",
          reviewState:
            item.kind === "github_pull_request" || item.kind === "github_review"
              ? "auto"
              : "needs_review",
        });
      }
    }
    const paired = {
      rules: [...rules],
      evidenceIds: [...evidenceIds],
      achievements,
    };
    if (outputsUnavailable) {
      return { ...again(claimed, "outputs_unavailable"), ...paired };
    }
    if (!unjudged) return { status: "succeeded", errorCode: null, ...paired };
    const { judge } = context;
    if (judge.connectionId !== null && judge.spentUsd >= judge.dailyBudgetUsd) {
      return {
        status: "deferred",
        until: nextUtcDay(at),
        errorCode: null,
        ...paired,
      };
    }
    if (
      judge.connectionId !== null &&
      judge.sessionJudgments >= judge.maxPerSession
    ) {
      return { status: "skipped", errorCode: "session_limit", ...paired };
    }
    return { status: "skipped", errorCode: "judge_unavailable", ...paired };
  }

  /** One pass. Returns how many judgments it finished. */
  async function runOnce(): Promise<number> {
    const claimed = await store.claim({ max: claimMax, leaseMs });
    let finished = 0;
    for (const judgment of claimed) {
      const nothing = { rules: [], evidenceIds: [], achievements: [] };
      let result: JudgmentResult;
      if (judgment.attempts > ACHIEVEMENT_JUDGMENT_RETRY_MS.length + 1) {
        // Replicas kept dying on it, so no try ever finished.
        result = { status: "failed", errorCode: null, ...nothing };
      } else {
        try {
          result = await judge(judgment);
        } catch (error) {
          logger.warn("Achievement judgment failed", {
            judgment_id: judgment.id,
            error: error instanceof Error ? error.name : String(error),
          });
          result = { ...again(judgment, null), ...nothing };
        }
      }
      try {
        const kept = await store.finish(judgment, result);
        if (kept) {
          finished += 1;
        } else {
          logger.info("Achievement judgment was taken over", {
            judgment_id: judgment.id,
          });
        }
      } catch (error) {
        // The lease runs out and another pass claims it again.
        logger.warn("Achievement judgment not recorded", {
          judgment_id: judgment.id,
          error: error instanceof Error ? error.name : String(error),
        });
      }
    }
    return finished;
  }

  function start(intervalMs = ACHIEVEMENT_JUDGE_INTERVAL_MS) {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let running: Promise<void> = Promise.resolve();
    const tick = () => {
      running = (async () => {
        try {
          await runOnce();
        } catch (error) {
          logger.warn("Achievement judge pass failed", {
            error: error instanceof Error ? error.name : String(error),
          });
        }
        if (!stopped) timer = setTimeout(tick, intervalMs);
      })();
    };
    timer = setTimeout(tick, intervalMs);
    return {
      async stop() {
        stopped = true;
        clearTimeout(timer);
        await running;
      },
    };
  }

  return { runOnce, start };
}

export type AchievementJudge = ReturnType<typeof createAchievementJudge>;
