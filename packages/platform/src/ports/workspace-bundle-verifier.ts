import { gitBundleOffers } from "@agent-platform/runtime-core";

export type WorkspaceBundleVerdict =
  | { readonly status: "restorable" }
  | { readonly reason: string; readonly status: "unusable" };

/**
 * Decides whether a stored git bundle can put a workspace back on a commit.
 *
 * It is a port because the strongest answer comes from git itself — `git
 * index-pack --strict` reconstructs every packed object and so proves the
 * commit is really in there — and the control plane does not run git. The
 * service supplies the bytes rather than the key so that the size policy stays
 * in one place: whatever a deployment plugs in, it never decides on its own how
 * much of the object store to pull into memory.
 */
export interface WorkspaceBundleVerifier {
  verify(input: {
    readonly bytes: Uint8Array;
    readonly commit: string;
    readonly key: string;
  }): Promise<WorkspaceBundleVerdict>;
}

/**
 * The default: everything the bytes alone can settle.
 *
 * The bundle header must name the commit as a ref tip and demand no
 * prerequisite a fresh workspace cannot have, and the packfile must match the
 * checksum git wrote into it. That is enough to refuse a commit that was never
 * captured, a truncated upload and a corrupted object — the failures a
 * checkpoint actually meets. A deployment that also wants "the commit object is
 * provably in this pack" injects a git-backed verifier in its place.
 */
export const structuralBundleVerifier: WorkspaceBundleVerifier = {
  async verify({ bytes, commit }) {
    const verdict = gitBundleOffers(bytes, commit);
    return verdict.status === "offers"
      ? { status: "restorable" }
      : { status: "unusable", reason: verdict.reason };
  },
};
