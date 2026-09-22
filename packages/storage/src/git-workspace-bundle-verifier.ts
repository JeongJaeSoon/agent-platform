import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkspaceBundleVerifier } from "@agent-platform/platform";
import { gitBundleOffers } from "@agent-platform/runtime-core";

import {
  defaultGitRunner,
  type GitCommandResult,
  type GitCommandRunner,
} from "./git-runner.ts";

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
 * Stricter than `git check-ref-format`: `HEAD` (what `git bundle create …
 * HEAD` records) or a full `refs/` name whose components use the characters
 * git bundles actually produce, none starting with a dot or a dash, none
 * ending in a dot and none ending in `.lock`.
 */
const SAFE_REF_NAME =
  /^(HEAD|refs(\/[A-Za-z0-9_](?:[A-Za-z0-9_.-]*[A-Za-z0-9_-])?(?<!\.lock))+)$/;

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
 * a permanent rejection and a throw into a retryable outage. Git refusing the
 * pack — a missing or corrupt object, a tip the pack did not deliver — is a
 * verdict about the bundle and comes back `unusable`. Everything else — no
 * temp space, no git binary, a spawn failure, a repository that would not
 * initialise, a git killed by a signal or by the timeout, or a failure this
 * code does not recognise — is thrown, so a healthy checkpoint is never
 * retired over a full disk or a busy host. Recognition is by git's own
 * wording under `LC_ALL=C`; the list is git's refusals, not the OS errors, so
 * that an unknown message errs toward a retry rather than a rejection.
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
      // The ref name goes into a refspec and, if git objects to it, into
      // stderr. Only a name git itself would accept gets that far, so a
      // bundle cannot choose what the failure below looks like.
      if (!SAFE_REF_NAME.test(ref) || ref.includes("..")) {
        return {
          status: "unusable",
          reason: `git bundle ref name is not one git would accept: ${JSON.stringify(ref)}`,
        };
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
        // Maintenance is off because fetch otherwise detaches
        // `git maintenance run --auto`, which outlives this call and can
        // recreate the repository after it has been removed.
        const fetch = await git(
          [
            "-c",
            "fetch.fsckObjects=true",
            "-c",
            "transfer.fsckObjects=true",
            "-c",
            "maintenance.auto=false",
            "-c",
            "gc.auto=0",
            "fetch",
            "--quiet",
            "--no-tags",
            "--no-write-fetch-head",
            bundle,
            `${ref}:refs/verify/tip`,
          ],
          repository,
        );
        if (fetch.exitCode !== 0) return refused("git fetch", fetch);
        const walk = await git(
          ["rev-list", "--objects", "--quiet", `${commit}^{commit}`, "--"],
          repository,
        );
        if (walk.exitCode !== 0) return refused("git rev-list", walk);
        return { status: "restorable" };
      } finally {
        await rm(directory, { force: true, recursive: true });
      }
    },
  };

  function git(args: readonly string[], cwd: string) {
    return gitRunner(args, {
      clearGitEnvironment: true,
      cwd,
      env: {
        // The verdict must not depend on whoever runs the control plane:
        // no user config, no system config, no prompts, and git's messages
        // in the one language `refused` below reads.
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_TERMINAL_PROMPT: "0",
        LC_ALL: "C",
      },
      timeoutMs,
    });
  }
}

/**
 * How git words a refusal of the pack or of the commit, under `LC_ALL=C`.
 * Specific diagnostics only: `fetch` names a corrupt or truncated pack, a
 * malformed object or a tip the pack did not deliver; `rev-list` names a
 * commit that never arrived. Generic words such as "pack" or "index-pack"
 * also appear when git fails to fork or open a directory, so they are not
 * here.
 */
const GIT_REFUSALS = [
  // fetch: connectivity and fsck.
  "did not send all necessary objects",
  "bad object",
  "missing blob",
  "missing tree",
  "missing commit",
  "missing tag",
  "fsck error",
  "not all child objects",
  "object of unexpected type",
  "did not receive expected object",
  // index-pack: the pack itself, as builtin/index-pack.c words it.
  "pack signature mismatch",
  "pack version",
  "premature end of pack file",
  "pack has junk at the end",
  "pack is corrupted",
  "pack has bad object",
  "bad pack",
  "is corrupt",
  "inflate returned",
  "serious inflate inconsistency",
  "unresolved deltas",
  "delta base offset",
  "bad object header",
  "bad object type",
  "unknown object type",
  "invalid object",
  "not a valid object",
  "sha1 collision",
  "pack too large",
  // rev-list: the pinned commit never arrived.
  "bad revision",
  "does not appear to be a git repository",
  // Belt and braces behind SAFE_REF_NAME: a ref the gate let through and git
  // still will not fetch is the bundle's doing, not the host's.
  "invalid refspec",
];

/**
 * The host getting in git's way, wherever the message otherwise lands. These
 * take precedence: `cannot fork() for git index-pack: Resource temporarily
 * unavailable` mentions the pack helper and is still not about the pack.
 */
const HOST_FAULTS = [
  "resource temporarily unavailable",
  "cannot fork",
  "permission denied",
  "no space left on device",
  "disk quota exceeded",
  "too many open files",
  "input/output error",
  "cannot allocate memory",
  "out of memory",
  "read-only file system",
];

function refused(
  command: string,
  result: GitCommandResult,
): { status: "unusable"; reason: string } {
  const detail = result.stderr.trim();
  const message = `${command} failed with exit code ${result.exitCode}: ${detail}`;
  if (result.timedOut) throw new Error(message);
  if (result.signal !== undefined) {
    throw new Error(`${command} was killed by ${result.signal}`);
  }
  const lowered = detail.toLowerCase();
  if (HOST_FAULTS.some((fault) => lowered.includes(fault))) {
    throw new Error(message);
  }
  if (GIT_REFUSALS.some((refusal) => lowered.includes(refusal))) {
    return { status: "unusable", reason: message };
  }
  throw new Error(`${message} (not a refusal git is known to give a bundle)`);
}
