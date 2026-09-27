// The control plane refuses a checkpoint over these and a worker refuses to
// capture one, so both sides read them from here.

/**
 * The primary per-bundle cost is time and disk. 256 MiB fits the verifier's
 * 60 s CPU bound, the 300 s read and upload bounds, and two on-disk copies per
 * verification: the spool file and git's pack.
 *
 * The derived `gitVerifyTimeoutMs` and `transferBudgetMs` grow with the size,
 * so going higher is a matter of
 * disk and of the git memory cap (`CHECKPOINT_GIT_MEMORY_MB`). Workers
 * capture up to this same limit, streamed from and to disk.
 */
export const DEFAULT_MAX_WORKSPACE_BUNDLE_BYTES = 256 * 1024 * 1024;
// A reference is about 200 bytes of canonical JSON, so the object limit
// is what binds first; both sit far above what a mirror of a long session
// produces today (one part per flushed batch).
export const DEFAULT_MAX_MANIFEST_BYTES = 8 * 1024 * 1024;
export const DEFAULT_MAX_MANIFEST_OBJECTS = 20_000;
/**
 * Bundles in one chain, the last included. Each is a fetch of its
 * own when it is verified and restored; past this a worker starts over with
 * a bundle that stands alone.
 */
export const MAX_WORKSPACE_BUNDLE_CHAIN = 32;
