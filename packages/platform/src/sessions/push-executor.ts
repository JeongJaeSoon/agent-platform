import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PUSH_BRANCH_PREFIX,
  type PushRefusal,
  pushBranchFor,
} from "@werft-ai/contracts";
import type { PushBundlesResult } from "../checkpoints/checkpoint-service.ts";
import type { ForgeResolver } from "../ports/forge.ts";
import { repoRefOf } from "../ports/forge.ts";
import type { GitPusher } from "../ports/git-push.ts";
import type { SessionGitHubSettings } from "../ports/github-settings.ts";
import type {
  PushJob,
  PushOutcome,
  PushRequestStore,
} from "../ports/push-requests.ts";
import {
  repositoryBinding,
  repositoryUpstreamOf,
  type SessionCatalog,
} from "./catalog.ts";

/**
 * How long a claim holds its row. The push's git is cut off at
 * `PUSH_DEADLINE_SHARE` of it, so only a dead pusher loses its row, and the
 * rest is slack for clock skew between this host and the database.
 */
export const PUSH_LEASE_MS = 15 * 60_000;
export const PUSH_DEADLINE_SHARE = 0.8;
/** Claims of one request before it is failed instead of taken up again. */
export const PUSH_MAX_ATTEMPTS = 3;
export const PUSH_POLL_INTERVAL_MS = 3_000;

export type PushExecutorLogger = {
  info(message: string, fields?: Readonly<Record<string, unknown>>): void;
  warn(message: string, fields?: Readonly<Record<string, unknown>>): void;
};

export interface PushBundleSource {
  spoolPushBundles(input: {
    directory: string;
    gitCommit: string;
    revision: number;
    sessionId: string;
  }): Promise<PushBundlesResult>;
}

/**
 * The platform's half of a push request (94S-629): takes an approved request,
 * checks it may still go where it was pinned, and pushes exactly its commit to
 * `agent/<session-id>` without force. Every way it ends is a `push` receipt.
 *
 * Only `approved` rows are ever claimed (and `pushing` rows whose pusher died),
 * so a request still waiting, rejected or already finished cannot reach git.
 */
export function createPushExecutor(deps: {
  store: PushRequestStore;
  catalog: SessionCatalog;
  forges: ForgeResolver;
  github: SessionGitHubSettings;
  bundles: PushBundleSource;
  pusher: GitPusher;
  logger: PushExecutorLogger;
  leaseMs?: number;
  maxAttempts?: number;
  tempRoot?: string;
}) {
  const { store, catalog, logger } = deps;
  const leaseMs = deps.leaseMs ?? PUSH_LEASE_MS;
  const maxAttempts = deps.maxAttempts ?? PUSH_MAX_ATTEMPTS;

  async function execute(job: PushJob, deadline: number): Promise<PushOutcome> {
    const refuse = (
      refusal: PushRefusal,
      remote?: { remoteUrl: string; remoteRef: string },
    ): PushOutcome => ({ state: "failed", refusal, ...remote });
    if (job.attempt > maxAttempts) return refuse("lease_expired");
    const repository = Object.hasOwn(catalog.repositories, job.repositoryId)
      ? catalog.repositories[job.repositoryId]
      : undefined;
    if (
      repository === undefined ||
      job.repositoryBinding === null ||
      repositoryBinding(job.repositoryId, repository) !== job.repositoryBinding
    ) {
      return refuse("catalog_changed");
    }
    const branch = job.targetBranch;
    const remote = {
      remoteUrl: repository.url,
      remoteRef: `refs/heads/${branch}`,
    };
    if (
      branch !== pushBranchFor(job.sessionId) ||
      !branch.startsWith(PUSH_BRANCH_PREFIX)
    ) {
      return refuse("target_refused", remote);
    }
    if (branch === repository.branch) return refuse("default_branch", remote);
    if (await deps.github.pinned(job.sessionId)) {
      return refuse("github_settings_unsupported", remote);
    }
    const forge = deps.forges(job.repositoryId);
    const repo = repoRefOf(repository.url);
    let headers: ReadonlyArray<readonly [string, string]>;
    if (forge !== null && repo !== null) {
      const { defaultBranch } = await forge.getRepository(repo);
      if (branch === defaultBranch) return refuse("default_branch", remote);
      headers = repositoryUpstreamOf(
        repository,
        await forge.gitCredential(repo, "write"),
      ).headers;
    } else if (repository.auth?.kind === "github_app") {
      return refuse("no_push_credential", remote);
    } else {
      headers = repositoryUpstreamOf(repository).headers;
    }
    if (headers.length === 0) return refuse("no_push_credential", remote);

    const directory = await mkdtemp(
      join(deps.tempRoot ?? tmpdir(), "platform-push-"),
    );
    try {
      const spool = join(directory, "bundles");
      await mkdir(spool);
      const source = await deps.bundles.spoolPushBundles({
        directory: spool,
        gitCommit: job.gitCommit,
        revision: job.checkpointRevision,
        sessionId: job.sessionId,
      });
      if (source.status !== "ready") {
        logger.warn("Push source is unavailable", {
          push_request_id: job.id,
          reason: source.reason,
        });
        return refuse("checkpoint_unavailable", remote);
      }
      const work = join(directory, "git");
      await mkdir(work);
      const pushed = await deps.pusher.push({
        directory: work,
        bundles: source.files,
        commit: job.gitCommit,
        remoteUrl: repository.url,
        ref: remote.remoteRef,
        headers,
        deadline,
      });
      if (pushed.status === "refused") {
        logger.warn("Push refused", {
          push_request_id: job.id,
          refusal: pushed.refusal,
          detail: pushed.detail,
        });
        return refuse(pushed.refusal, remote);
      }
      return {
        state: "pushed",
        ...remote,
        previousCommit: pushed.previousCommit,
      };
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  }

  /** Runs one claimed request to its end. False when none was waiting. */
  async function runOnce(): Promise<boolean> {
    // Read before the claim, so the deadline cannot trail the lease the
    // database starts at the claim.
    const claimedAt = Date.now();
    const job = await store.claimNextApproved(leaseMs);
    if (job === null) return false;
    let outcome: PushOutcome;
    try {
      outcome = await execute(job, claimedAt + leaseMs * PUSH_DEADLINE_SHARE);
    } catch (error) {
      // A forge or git failure carries no secret in its message
      // (ForgeCredentialError, the pusher's own wording).
      logger.warn("Push failed", {
        push_request_id: job.id,
        error: error instanceof Error ? error.message : String(error),
      });
      outcome = { state: "failed", refusal: "push_failed" };
    }
    const finished = await store.finish(job, outcome);
    logger.info(
      finished ? "Push request finished" : "Push request was taken over",
      {
        push_request_id: job.id,
        attempt: job.attempt,
        state: outcome.state,
        ...(outcome.state === "failed" ? { refusal: outcome.refusal } : {}),
      },
    );
    return true;
  }

  /**
   * Polls until stopped. Each replica of the API runs one; the claim's
   * SKIP LOCKED keeps them off each other's rows.
   */
  function start(intervalMs = PUSH_POLL_INTERVAL_MS) {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let running: Promise<void> = Promise.resolve();
    const tick = () => {
      running = (async () => {
        try {
          while (!stopped && (await runOnce())) {}
        } catch (error) {
          logger.warn("Push executor could not claim", {
            error: error instanceof Error ? error.message : String(error),
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

export type PushExecutor = ReturnType<typeof createPushExecutor>;
