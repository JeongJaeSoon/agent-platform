import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkspaceBundleVerifier } from "@agent-platform/platform";
import { gitBundleOffers } from "@agent-platform/runtime-core";

import { defaultGitRunner, type GitCommandRunner } from "./git-runner.ts";

export type GitWorkspaceBundleVerifierOptions = {
  readonly gitRunner?: GitCommandRunner;
  /**
   * Where the throwaway repository lives; defaults to the OS temp directory.
   * Tests point it at a directory they can list to prove nothing is left.
   */
  readonly tempRoot?: string;
  /**
   * Ceiling for each git invocation. Verifying is bounded by the bundle size
   * the service already caps, so a git that is still running past this is
   * wedged, not busy.
   */
  readonly timeoutMs?: number;
};

export const DEFAULT_GIT_VERIFY_TIMEOUT_MS = 60_000;

/**
 * The git-backed `WorkspaceBundleVerifier`: proves the bundle's pack really
 * holds the commit it claims, which is the one thing bytes alone cannot show.
 *
 * `git bundle verify` only reads the header, so a pack whose header was
 * rewritten passes it. A fetch into an empty bare repository does not: git
 * indexes every object, fsck-checks it, and then walks from the ref tip to
 * make sure every reachable object arrived. `rev-list --objects` afterwards
 * repeats that walk for the commit the manifest pinned, so the verdict covers
 * the pinned commit rather than whichever ref the bundle happened to name.
 *
 * Two kinds of failure, kept apart because the service turns a verdict into
 * a permanent rejection and a throw into a retryable outage. Git saying no —
 * a non-zero fetch or rev-list, including one killed at the timeout — is a
 * verdict about the bundle and comes back `unusable`. Not being able to ask
 * git at all — no temp space, no git binary, a spawn failure, a repository
 * that would not initialise — is a control-plane fault and is thrown, so a
 * healthy checkpoint is not retired over a full disk.
 *
 * Nothing about this run outlives it: the repository is created under a fresh
 * temp directory and removed whichever way the run ends.
 */
export function createGitWorkspaceBundleVerifier(
  options: GitWorkspaceBundleVerifierOptions = {},
): WorkspaceBundleVerifier {
  const gitRunner = options.gitRunner ?? defaultGitRunner;
  const timeoutMs = options.timeoutMs ?? DEFAULT_GIT_VERIFY_TIMEOUT_MS;
  return {
    async verify({ bytes, commit }) {
      // The structural read is the cheap gate: no git process for bytes that
      // are not a whole bundle offering the commit, and it hands back the ref
      // to fetch.
      const offer = gitBundleOffers(bytes, commit);
      if (offer.status !== "offers") {
        return { status: "unusable", reason: offer.reason };
      }
      const ref = offer.refs[0];
      if (ref === undefined) {
        return { status: "unusable", reason: "git bundle offers no ref" };
      }
      const directory = await mkdtemp(
        join(options.tempRoot ?? tmpdir(), "bundle-verify-"),
      );
      try {
        const bundle = join(directory, "workspace.bundle");
        const repository = join(directory, "repo.git");
        await writeFile(bundle, bytes);
        const init = await git(
          ["init", "--quiet", "--bare", repository],
          directory,
        );
        if (init.exitCode !== 0) {
          throw new Error(
            `git init failed with exit code ${init.exitCode}: ${init.stderr.trim()}`,
          );
        }
        // fsck on the way in rejects malformed objects; the connectivity check
        // fetch runs by default rejects a tip the pack does not deliver.
        const fetch = await git(
          [
            "-c",
            "fetch.fsckObjects=true",
            "-c",
            "transfer.fsckObjects=true",
            "fetch",
            "--quiet",
            "--no-tags",
            "--no-write-fetch-head",
            bundle,
            `${ref}:refs/verify/tip`,
          ],
          repository,
        );
        if (fetch.exitCode !== 0) return unusable("git fetch", fetch);
        const walk = await git(
          ["rev-list", "--objects", "--quiet", `${commit}^{commit}`, "--"],
          repository,
        );
        if (walk.exitCode !== 0) return unusable("git rev-list", walk);
        return { status: "restorable" };
      } finally {
        await rm(directory, { force: true, recursive: true });
      }
    },
  };

  function git(args: readonly string[], cwd: string) {
    return gitRunner(args, {
      cwd,
      env: {
        // The verdict must not depend on whoever runs the control plane:
        // no user config, no system config, no prompts.
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_TERMINAL_PROMPT: "0",
      },
      timeoutMs,
    });
  }
}

function unusable(
  command: string,
  result: { exitCode: number; stderr: string },
): { status: "unusable"; reason: string } {
  return {
    status: "unusable",
    reason: `${command} failed with exit code ${result.exitCode}: ${result.stderr.trim()}`,
  };
}
