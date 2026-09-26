// The control plane refuses a checkpoint over these and a worker refuses to
// capture one, so both sides read them from here.

/**
 * 256 MiB. Not memory any more (94S-230): what one bundle costs now is time
 * and disk, and this is the largest size every existing bound still covers
 * without being retuned. Measured under load (Apple M4 Pro, load average
 * ~130), the verifier's `git fetch` of a 133 MiB bundle of real source took
 * 9.5–15.7 s, so 256 MiB lands at roughly half of its 60 s per-invocation
 * timeout (`DEFAULT_GIT_VERIFY_TIMEOUT_MS`), which is also its CPU limit.
 * The read's 300 s budget (`DEFAULT_BODY_READ_BOUNDS.maxReadMs`) asks for
 * 0.85 MiB/s, and so does the 300 s upload bound workers write it under
 * (`S3_REQUEST_BOUNDS.requestTimeout`). Disk: the spool file plus git's copy
 * of the pack, 2 × 256 MiB per verification in flight.
 *
 * Those budgets now grow with the size above 256 MiB (94S-318:
 * `gitVerifyTimeoutMs`, `transferBudgetMs`), so going higher is a matter of
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
 * Bundles in one chain, the last included (94S-227). Each is a fetch of its
 * own when it is verified and restored; past this a worker starts over with
 * a bundle that stands alone.
 */
export const MAX_WORKSPACE_BUNDLE_CHAIN = 32;
