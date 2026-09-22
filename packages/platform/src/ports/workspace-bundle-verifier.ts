import { gitBundleOffers } from "@agent-platform/runtime-core";

export type WorkspaceBundleVerdict =
  | { readonly status: "restorable" }
  | { readonly reason: string; readonly status: "unusable" };

/**
 * Decides whether a stored git bundle can put a workspace back on a commit.
 *
 * It is a port because the only answer worth trusting comes from git itself.
 * `git index-pack --strict` reconstructs every packed object through its delta
 * chain, which is what proves the commit is in there; nothing short of that
 * distinguishes a real pack from bytes shaped like one. The control plane does
 * not run git, so the implementation is injected.
 *
 * The service supplies the bytes rather than the key so that the size policy
 * stays in one place: whatever a deployment plugs in, it never decides on its
 * own how much of the object store to pull into memory.
 */
export interface WorkspaceBundleVerifier {
  verify(input: {
    readonly bytes: Uint8Array;
    readonly commit: string;
    readonly key: string;
  }): Promise<WorkspaceBundleVerdict>;
}

/**
 * The default, and the only safe one: a checkpoint is refused until a
 * deployment says what verifies its workspace bundles.
 *
 * The alternative default would be to promote pointers on a check that git
 * does not have to agree with, and the damage only surfaces at the next
 * restore — when the execution that wrote the checkpoint is gone and the last
 * healthy revision has already been superseded. 94S-228 supplies the
 * git-backed implementation a composition root wires here.
 */
export const rejectUnverifiedWorkspaceBundles: WorkspaceBundleVerifier = {
  async verify() {
    return {
      status: "unusable",
      reason: "no workspace bundle verifier configured",
    };
  },
};

/**
 * Everything the bytes alone can settle, and deliberately not more.
 *
 * The bundle header must name the commit as a ref tip and demand no
 * prerequisite a fresh workspace cannot have, and the packfile must match the
 * checksum git wrote into it. That rules out a commit that was never captured,
 * a truncated upload and a corrupted object — the accidents a checkpoint
 * actually meets.
 *
 * What it cannot rule out is a *fabricated* pack: a header, an object count
 * and a recomputed trailer are all things whoever wrote the object could have
 * produced, and the manifest's own digest is no help because the worker hashed
 * the same bytes. Only reconstructing the pack settles that. So a deployment
 * choosing this over a git-backed verifier is choosing to trust its workers
 * about their own commits, and should say so out loud by naming it.
 */
export const structuralBundleVerifier: WorkspaceBundleVerifier = {
  async verify({ bytes, commit }) {
    const verdict = gitBundleOffers(bytes, commit);
    return verdict.status === "offers"
      ? { status: "restorable" }
      : { status: "unusable", reason: verdict.reason };
  },
};
