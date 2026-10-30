import type { SessionOutcomeCheckError } from "@werft-ai/contracts";
import {
  ForgeCredentialError,
  type RepoRef,
  repoRefOf,
} from "../ports/forge.ts";
import {
  GitHubCallError,
  type GitHubConnection,
  type GitHubConnections,
  type GitHubGate,
  GitHubGateError,
  type GitHubRateLimit,
  GitHubUnavailableError,
} from "../ports/github-gate.ts";
import type {
  ClaimedOutcome,
  OutcomeCheck,
  SessionOutcomeStore,
} from "../ports/session-outcomes.ts";
import type { SessionCatalog } from "./catalog.ts";

export const OUTCOME_REFRESH_INTERVAL_MS = 60_000;
/** A claimed row a dead replica held is claimed again after this. */
export const OUTCOME_LEASE_MS = 120_000;
/** The most rows one claim of a unit leases. */
export const OUTCOME_CLAIM_MAX = 50;
/** Rows of earlier images' pull requests given an outcome per pass. */
const FILL_PER_PASS = 500;
/** Below this share of the limit left, the unit pauses until its reset. */
const PAUSE_BELOW_SHARE = 0.2;
const PAUSE_WITHOUT_RESET_MS = 60_000;

type Logger = {
  info(message: string, fields?: Readonly<Record<string, unknown>>): void;
  warn(message: string, fields?: Readonly<Record<string, unknown>>): void;
};

function rateLimited(error: GitHubCallError): boolean {
  return (
    error.status === 429 ||
    (error.status === 403 &&
      (error.rateLimit?.remaining === 0 ||
        error.rateLimit?.retryAfterSeconds != null))
  );
}

/**
 * Reads the state of the pull requests the platform recorded (design
 * github-agent.md §10), one GET each, within each rate-limit unit's budget.
 * Each API replica runs one; a claim leases its rows, so no database lock is
 * held while GitHub answers and a late answer never overwrites a newer one.
 */
export function createOutcomeRefresher(deps: {
  store: SessionOutcomeStore;
  gate: GitHubGate;
  catalog: SessionCatalog;
  connections: GitHubConnections;
  logger: Logger;
  claimMax?: number;
  leaseMs?: number;
  now?: () => Date;
}) {
  const { store, gate, catalog, connections, logger } = deps;
  const claimMax = deps.claimMax ?? OUTCOME_CLAIM_MAX;
  const leaseMs = deps.leaseMs ?? OUTCOME_LEASE_MS;
  const now = deps.now ?? (() => new Date());
  const limits = new Map<string, number>();

  /**
   * Why an App could not reach the repository: its own JWT says whether it is
   * still installed there. A pinned or cached installation id hides that
   * until a token is asked for.
   */
  async function appFailure(
    connection: GitHubConnection,
    repo: RepoRef,
  ): Promise<SessionOutcomeCheckError> {
    const installed = await connection.installed(repo).catch(() => null);
    return installed === false ? "not_found" : "forge_failed";
  }

  /**
   * The due repositories under the unit each one's next request spends from,
   * and those no read can reach with the check error their rows get instead.
   */
  async function units(repositoryIds: readonly string[]) {
    const byKey = new Map<string, string[]>();
    const unreachable = new Map<SessionOutcomeCheckError, string[]>();
    const fail = (id: string, checkError: SessionOutcomeCheckError) =>
      unreachable.set(checkError, [...(unreachable.get(checkError) ?? []), id]);
    for (const id of repositoryIds) {
      const entry = Object.hasOwn(catalog.repositories, id)
        ? catalog.repositories[id]
        : undefined;
      const repo = entry ? repoRefOf(entry.url) : null;
      if (repo === null) continue;
      const connection = connections(id, "author");
      // The gate would refuse every grant: no App or PAT serves it now.
      if (connection === null) {
        fail(id, "github_refused");
        continue;
      }
      let key: string;
      try {
        key = await connection.quotaKey(repo);
      } catch (error) {
        logger.warn("Outcome refresh: rate-limit unit unknown", {
          repository_id: id,
          error: error instanceof Error ? error.name : "error",
        });
        // A PAT whose user is unknown waits out its hour unread (§10); an
        // App's installation lookup failing is the read's own failure.
        if (connection.kind === "app") {
          fail(id, await appFailure(connection, repo));
        }
        continue;
      }
      byKey.set(key, [...(byKey.get(key) ?? []), id]);
    }
    return { byKey, unreachable };
  }

  /** The repository and the connection serving it now, as the gate picks. */
  function reachOf(repositoryId: string) {
    const entry = Object.hasOwn(catalog.repositories, repositoryId)
      ? catalog.repositories[repositoryId]
      : undefined;
    const repo = entry ? repoRefOf(entry.url) : null;
    return { repo, connection: connections(repositoryId, "author") };
  }

  async function read(
    outcome: ClaimedOutcome,
    leased: () => boolean,
    quotaKey: string,
  ): Promise<{
    check: OutcomeCheck;
    rateLimit: GitHubRateLimit | null;
    limited: boolean;
  }> {
    const failed = (checkError: SessionOutcomeCheckError) => ({
      check: { kind: "error" as const, checkError },
      rateLimit: null,
      limited: false,
    });
    const release = {
      check: { kind: "release" as const },
      rateLimit: null,
      limited: false,
    };
    let grant: Awaited<ReturnType<GitHubGate["grant"]>>;
    try {
      grant = await gate.grant({
        sessionId: outcome.sessionId,
        purpose: "outcome_refresh",
        actor: null,
      });
    } catch (error) {
      if (error instanceof GitHubGateError) return failed("github_refused");
      if (error instanceof ForgeCredentialError) {
        const { repo, connection } = reachOf(outcome.repositoryId);
        return failed(
          repo !== null && connection?.kind === "app"
            ? await appFailure(connection, repo)
            : "forge_failed",
        );
      }
      if (error instanceof GitHubUnavailableError) {
        return failed("forge_failed");
      }
      throw error;
    }
    if (grant === null) return release;
    // The App was replaced, or its installation moved, after the claim: this
    // read would spend from a unit other than the one that paid for it.
    const unit = await grant.unit().catch(() => null);
    // A slow grant or unit lookup can outlast the lease; another replica may
    // read the row by now.
    if (unit !== quotaKey || !leased()) return release;
    try {
      const { pullRequest, rateLimit } = await grant.api.getPullRequest(
        outcome.number,
      );
      const state =
        pullRequest.mergedAt !== null
          ? "merged"
          : pullRequest.state === "closed"
            ? "closed"
            : "open";
      const time = (value: string | null) =>
        value === null ? null : new Date(value);
      return {
        check: {
          kind: "state",
          state,
          mergedAt: time(pullRequest.mergedAt),
          closedAt: time(pullRequest.closedAt),
          metadata: {
            merge_commit_sha: pullRequest.mergeCommitSha,
            additions: pullRequest.additions,
            deletions: pullRequest.deletions,
            changed_files: pullRequest.changedFiles,
            commits: pullRequest.commits,
          },
        },
        rateLimit,
        limited: false,
      };
    } catch (error) {
      if (!(error instanceof GitHubCallError)) {
        return failed("forge_failed");
      }
      if (rateLimited(error)) {
        return {
          check: { kind: "release" },
          rateLimit: error.rateLimit,
          limited: true,
        };
      }
      return {
        ...failed(error.status === 404 ? "not_found" : "forge_failed"),
        rateLimit: error.rateLimit,
      };
    }
  }

  /** When the unit must stop, by what the response said; null to go on. */
  function pauseUntil(
    rateLimit: GitHubRateLimit | null,
    limited: boolean,
  ): Date | null {
    const low =
      limited ||
      (rateLimit?.limit != null &&
        rateLimit.remaining != null &&
        rateLimit.remaining < rateLimit.limit * PAUSE_BELOW_SHARE);
    if (!low) return null;
    if (rateLimit?.retryAfterSeconds != null) {
      return new Date(now().getTime() + rateLimit.retryAfterSeconds * 1000);
    }
    return (
      rateLimit?.reset ?? new Date(now().getTime() + PAUSE_WITHOUT_RESET_MS)
    );
  }

  /** One pass over every unit. Returns how many pull requests it read. */
  async function runOnce(): Promise<number> {
    await store.fillMissing(FILL_PER_PASS);
    const { byKey, unreachable } = await units(await store.dueRepositories());
    for (const [checkError, repositoryIds] of unreachable) {
      await store.failDue(repositoryIds, checkError, claimMax);
    }
    let reads = 0;
    for (const [quotaKey, repositoryIds] of byKey) {
      // The lease runs from the claim's transaction start, which is no
      // earlier than this, so the rows are surely still ours before it.
      const leasedUntil = now().getTime() + leaseMs;
      const leased = () => now().getTime() < leasedUntil;
      const claimed = await store.claim({
        quotaKey,
        repositoryIds,
        max: claimMax,
        leaseMs,
      });
      let paused = false;
      for (const outcome of claimed) {
        // Once the unit pauses, the rest go back unread; so do rows whose
        // lease ran out meanwhile, which another replica may hold by now.
        if (paused || !leased()) {
          await store.finish(outcome, { kind: "release" });
          continue;
        }
        const { check, rateLimit, limited } = await read(
          outcome,
          leased,
          quotaKey,
        );
        reads += 1;
        const kept = await store.finish(outcome, check);
        if (!kept) {
          logger.info("Outcome refresh was taken over", {
            outcome_id: outcome.id,
          });
        }
        const until = pauseUntil(rateLimit, limited);
        const limit = rateLimit?.limit ?? null;
        if (
          until !== null ||
          (limit !== null && limits.get(quotaKey) !== limit)
        ) {
          await store.noteRateLimit(quotaKey, { limit, pausedUntil: until });
          if (limit !== null) limits.set(quotaKey, limit);
        }
        if (until !== null) {
          paused = true;
          logger.warn("Outcome refresh paused for a GitHub rate limit", {
            quota_key: quotaKey,
            paused_until: until.toISOString(),
          });
        }
      }
    }
    return reads;
  }

  function start(intervalMs = OUTCOME_REFRESH_INTERVAL_MS) {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let running: Promise<void> = Promise.resolve();
    const tick = () => {
      running = (async () => {
        try {
          await runOnce();
        } catch (error) {
          logger.warn("Outcome refresh pass failed", {
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

export type OutcomeRefresher = ReturnType<typeof createOutcomeRefresher>;
