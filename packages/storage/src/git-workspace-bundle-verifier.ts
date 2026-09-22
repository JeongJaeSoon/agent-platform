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
 * Nothing about this run outlives it: the repository is created under a fresh
 * temp directory and removed whether git succeeds, fails or is killed for
 * running past the timeout. Every failure is an `unusable` verdict — the
 * service treats a throw here as an outage, and a bad bundle is not one.
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
      let directory: string | undefined;
      try {
        directory = await mkdtemp(
          join(options.tempRoot ?? tmpdir(), "bundle-verify-"),
        );
        const bundle = join(directory, "workspace.bundle");
        const repository = join(directory, "repo.git");
        await writeFile(bundle, bytes);
        await git(["init", "--quiet", "--bare", repository], directory);
        // fsck on the way in rejects malformed objects; the connectivity check
        // fetch runs by default rejects a tip the pack does not deliver.
        await git(
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
        await git(
          ["rev-list", "--objects", "--quiet", `${commit}^{commit}`, "--"],
          repository,
        );
        return { status: "restorable" };
      } catch (error) {
        return {
          status: "unusable",
          reason: error instanceof Error ? error.message : String(error),
        };
      } finally {
        if (directory !== undefined) {
          await rm(directory, { force: true, recursive: true });
        }
      }
    },
  };

  async function git(args: readonly string[], cwd: string): Promise<void> {
    const result = await gitRunner(args, {
      cwd,
      env: {
        // The verdict must not depend on whoever runs the control plane:
        // no user config, no system config, no prompts, no hooks.
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_TERMINAL_PROMPT: "0",
      },
      timeoutMs,
    });
    if (result.exitCode !== 0) {
      throw new Error(
        `git ${args[0] === "-c" ? "fetch" : args[0]} failed with exit code ${result.exitCode}: ${result.stderr.trim()}`,
      );
    }
  }
}
