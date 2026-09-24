import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CheckpointRef } from "@agent-platform/contracts";
import type {
  CheckpointBlockReason,
  CheckpointCodec,
  CheckpointManifest,
  CheckpointObjectStore,
  CheckpointPreparation,
  CompatibilityMismatch,
  ObjectRef,
  RuntimeFingerprint,
  WorkspaceArtifact,
} from "@agent-platform/runtime-core";
import { workspacePathsProblem } from "@agent-platform/runtime-core";

import type {
  CheckpointFence,
  CheckpointPointer,
  CheckpointStore,
} from "../ports/checkpoint-store.ts";
import {
  rejectUnverifiedWorkspaceBundles,
  type WorkspaceBundleVerifier,
} from "../ports/workspace-bundle-verifier.ts";
import {
  engineOf,
  inBatches,
  own,
  parentOf,
  sha256,
} from "./checkpoint-support.ts";

export type CheckpointRequest = {
  /** Where this attempt must upload its manifest. */
  manifestRef: string;
  revision: number;
  sessionId: string;
};

export type CheckpointRequestDecision =
  | { status: "ready"; request: CheckpointRequest }
  | { detail: string; reason: CheckpointBlockReason; status: "blocked" };

export type ManifestVerdict =
  | {
      manifest: CheckpointManifest;
      status: "verified";
      /**
       * Set by a `locked` finalize once every version the checkpoint names
       * was hashed by version and held — by this finalize, or, for what it
       * inherited, by the finalizes behind the pointer it follows
       * (`verifiedRefs`). The pointer records it, and it is the only thing
       * that lets a later read trust those versions unhashed.
       */
      versionsHeld?: true;
    }
  | { reason: string; status: "rejected" };

/**
 * Every object a session may own lives under this prefix, and nothing else
 * does. A manifest naming a key outside its own session's namespace is refused
 * rather than trusted, so a worker fenced for one session cannot pin another
 * session's transcript into its restore plan. Hosts build the transcript mirror
 * prefix from this too.
 */
export function sessionObjectPrefix(sessionId: string): string {
  return `sessions/${sessionId}/`;
}

export type FinalizeCheckpointInput = {
  checkpoint: CheckpointRef;
  fence: CheckpointFence;
  now: Date;
  sessionId: string;
  turnId: string | null;
};

export type FinalizeCheckpointResult =
  | { outcome: "committed" | "replayed"; revision: number }
  | { currentRevision: number | null; outcome: "conflict" }
  | { outcome: "rejected"; reason: string }
  | { outcome: "stale_epoch" | "lease_expired" };

export type RestoreArtifact =
  | {
      /**
       * The subagent subpath for a subagent transcript, and "" for the root
       * transcript and the workspace bundle.
       */
      label: string;
      objects: readonly ObjectRef[];
      kind: "transcript_root" | "transcript_subagent" | "workspace_bundle";
    }
  // Each object names the workspace-relative path it is restored to.
  | {
      label: string;
      objects: readonly WorkspaceArtifact[];
      kind: "workspace_untracked";
    };

export type RestorePlan = {
  artifacts: readonly RestoreArtifact[];
  cwd: string;
  engine: string;
  /**
   * The commit the workspace is restored to. It is fetched out of the
   * `workspace_bundle` artifact below, never from a remote — see
   * `CheckpointWorkspace.bundle`.
   */
  gitCommit: string;
  manifestRef: string;
  /**
   * The digest the restored revision committed its manifest with. The claim
   * carries the pointer's; after a fallback this is the only place the
   * worker learns the one to pin the manifest it downloads to.
   */
  manifestSha256: string;
  /** The manifest version the restored revision pinned, when there is one. */
  manifestVersion?: string;
  /**
   * Every object key the plan needs, deduplicated, in download order. Keys
   * only: where an object carries a `version`, the artifact list is what the
   * worker downloads from, because the key's current object may be a later
   * write than the one this checkpoint verified.
   */
  objectKeys: readonly string[];
  resume: string;
  /** The revision this plan restores, which is the pointer's unless `fallback`. */
  revision: number;
  /**
   * Present only when the pointer's own checkpoint did not verify and an
   * earlier revision is restored instead: the resumed session is then older
   * than the one the pointer recorded, and whoever resumes it must be able
   * to tell.
   */
  fallback?: RestoreFallback;
};

export type RestoreFallbackSkip = { reason: string; revision: number };

export type RestoreFallback = {
  /** The revision the session pointer names, and could not be restored. */
  pointerRevision: number;
  /**
   * Every revision tried and refused before the restored one, newest first,
   * starting with the pointer's.
   */
  skipped: readonly RestoreFallbackSkip[];
};

export type RestorePlanResult =
  | { plan: RestorePlan; status: "ready" }
  | { status: "none" }
  | { code: "CHECKPOINT_UNAVAILABLE"; reason: string; status: "unavailable" }
  | {
      code: "INCOMPATIBLE_CHECKPOINT";
      /**
       * Present when the pointer's checkpoint was damaged and it is the
       * earlier `revision` that the runtime cannot resume.
       */
      fallback?: RestoreFallback & { revision: number };
      mismatches: readonly CompatibilityMismatch[];
      status: "incompatible";
    };

export type CheckpointServiceDependencies = {
  /** Manifest codecs by engine name. */
  codecs: Readonly<Record<string, CheckpointCodec>>;
  /**
   * Where a workspace bundle is spooled while it is verified; defaults to the
   * OS temp directory. It needs room for `maxConcurrentBundleVerifications`
   * bundles of `maxWorkspaceBundleBytes` each, and a git-backed verifier
   * puts its own copy of the pack beside that, usually under the same root.
   */
  bundleSpoolRoot?: string;
  /**
   * How long a bundle whose verification threw is answered with that same
   * retryable error instead of being verified again (94S-271). A throw is a
   * limit or a host fault, never a verdict, so the checkpoint is not retired;
   * but a bundle that runs the verifier out of its limits does so on every
   * retry, and each retry holds one of the few verification slots for up to
   * the verifier's timeout. Keyed by the bundle's digest, the commit and the
   * verifier's `policy`, so new limits verify it again at once. 0 turns it
   * off.
   */
  bundleRetryCooldownMs?: number;
  /** Milliseconds since the epoch; tests pin it to step the cooldown. */
  clock?: () => number;
  /**
   * How many workspace bundles may be read and verified at once.
   *
   * Reading one no longer holds it in memory — it is streamed to disk — but
   * verifying it still starts git processes, each allowed its own address
   * space (`CHECKPOINT_GIT_MEMORY_MB`, fetch and index-pack alive together),
   * and spools a bundle and a copy of its pack to disk. The size ceiling
   * below bounds one of those; this bounds how many the process runs at
   * once, which is what the API container's memory limit is sized against.
   */
  maxConcurrentBundleVerifications?: number;
  /**
   * Largest manifest the control plane will read, in bytes, and the most
   * objects one may name. The worker writes the manifest, so both are
   * untrusted: without them a claimed worker makes a finalize hold an
   * arbitrarily large object in memory, or fan out one HEAD and GET per
   * reference it cares to list. The size is checked with a HEAD before the
   * body is fetched and again on the bytes that arrived.
   */
  maxManifestBytes?: number;
  maxManifestObjects?: number;
  /**
   * How many committed revisions below the pointer a restore may try when
   * the pointer's own checkpoint does not verify. Each one tried is read and
   * hashed in full, bundle included, so this bounds what one restore can
   * cost; 0 turns fallback off.
   */
  maxRestoreFallbacks?: number;
  /**
   * Largest workspace bundle the control plane will read, in bytes.
   *
   * A policy, not a memory budget: the bundle is streamed through a hash to
   * disk and never held. What it does bound is the time and disk one
   * verification takes — the read, the spool file, git indexing the pack
   * under its per-invocation timeout — so raising it means checking those
   * (see `DEFAULT_MAX_WORKSPACE_BUNDLE_BYTES`).
   *
   * Two consequences worth knowing before changing it. A checkpoint over the
   * limit is refused rather than promoted unverified, so a session whose
   * workspace outgrows the limit stops checkpointing entirely and says so in
   * the rejection reason; 94S-227 (incremental bundles) is what keeps a long
   * session from walking into that. And the limit is applied on the way out as
   * well as in, so lowering it retires restore plans that were committed under
   * the old one — raise it back and they return.
   */
  maxWorkspaceBundleBytes?: number;
  /**
   * How far a committed checkpoint's objects are protected once verified.
   *
   * `locked`, the default: every object — the manifest, each transcript part,
   * the bundle, each untracked file — must be named by version. Finalize
   * reads those versions, and before answering "verified" places a legal hold
   * on each one, so the bytes it judged are the bytes restore reads, and
   * nobody without the hold permission can delete them. A key being
   * overwritten, deleted or reused after that changes nothing a checkpoint
   * names. The store must offer `hold`.
   *
   * `unversioned`: for a store without versions or Object Lock, or one whose
   * version ids are not the ones the manifests name (a bucket restored from a
   * backup). Objects are read by key; versions a manifest carries are ignored
   * and left out of the restore plan; nothing is held; and every object is
   * hashed again on every finalize, since only a version can vouch for bytes
   * read earlier. What finalize verified is then only as durable as the key:
   * a delete or overwrite after the commit is found at restore, not
   * prevented.
   */
  objectProtection?: ObjectProtection;
  /** Tests pin it; it must match `PUBLISH_ID`. */
  newPublishId?: () => string;
  objects: CheckpointObjectStore;
  store: CheckpointStore;
  /**
   * Defaults to `rejectUnverifiedWorkspaceBundles`, so a deployment that has
   * not said how its bundles are verified commits no checkpoints at all
   * rather than commits ones that may not restore.
   */
  workspaceBundles?: WorkspaceBundleVerifier;
};

export type ObjectProtection = "locked" | "unversioned";

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
 * Going higher means scaling that git timeout and both S3 budgets with the
 * size first. Workers stop at their own capture limit, which is lower
 * because a worker still holds the bundle in memory to upload it.
 */
export const DEFAULT_MAX_WORKSPACE_BUNDLE_BYTES = 256 * 1024 * 1024;
// A reference is about 200 bytes of canonical JSON, so the object limit
// is what binds first; both sit far above what a mirror of a long session
// produces today (one part per flushed batch).
export const DEFAULT_MAX_MANIFEST_BYTES = 8 * 1024 * 1024;
export const DEFAULT_MAX_MANIFEST_OBJECTS = 20_000;
export const DEFAULT_MAX_CONCURRENT_BUNDLE_VERIFICATIONS = 2;
export const DEFAULT_MAX_RESTORE_FALLBACKS = 3;
// The git verifier's own timeout: a bundle that keeps throwing then holds a
// verification slot at most half the time.
export const DEFAULT_BUNDLE_RETRY_COOLDOWN_MS = 60_000;
// Bundles cooling down at once. A full table forgets the oldest entry, which
// only lets that bundle be verified again early.
export const MAX_COOLING_BUNDLES = 1024;
// One revision tried can cost the manifest's full object limit in reads plus
// a bundle hashed whole; this is what keeps a restore from becoming a scan.
export const MAX_RESTORE_FALLBACKS_CEILING = 10;

/**
 * Every publish gets its own key: the attempt's, and within it one per
 * `requestCheckpoint` answer.
 *
 * Keying by revision alone deadlocks the session: a worker that uploads and
 * then dies before finalizing leaves an orphan object at the key the next
 * attempt is handed, and create-only then refuses every later manifest for that
 * revision forever. Keying by attempt alone does the same inside one attempt:
 * a manifest that was uploaded and never committed — its finalize refused, or
 * its put timed out after landing — sits at the key the attempt's next turn is
 * handed for the same revision. So both may upload; which one becomes the
 * session's truth is decided by the fenced pointer CAS, not by who wrote the
 * object first.
 */
export function manifestRefFor(
  sessionId: string,
  revision: number,
  attemptId: string,
  publishId: string,
): string {
  // Zero-padded so a prefix listing of a session's checkpoints is ordered.
  const padded = String(revision).padStart(10, "0");
  return `${sessionObjectPrefix(sessionId)}checkpoints/${padded}/${attemptId}/${publishId}/manifest.json`;
}

/** What `requestCheckpoint` mints; finalize accepts nothing else in its place. */
const PUBLISH_ID = /^[0-9a-f]{32}$/;

function newPublishId(): string {
  return randomUUID().replaceAll("-", "");
}

/**
 * Turns an uploaded manifest into the session's durable restore point, and
 * reads it back as a restore plan.
 *
 * The service never trusts the pointer or the object store on its own. A
 * pointer names a manifest, the manifest's bytes must hash to what the pointer
 * claims, and the manifest names the exact objects to restore. Anything that
 * does not line up is refused, because the alternative — resuming from the
 * latest mirror suffix or the branch head — silently produces a session that
 * never existed.
 */
export function createCheckpointService(deps: CheckpointServiceDependencies) {
  const { codecs, objects, store } = deps;
  const maxBundleBytes =
    deps.maxWorkspaceBundleBytes ?? DEFAULT_MAX_WORKSPACE_BUNDLE_BYTES;
  const bundles = deps.workspaceBundles ?? rejectUnverifiedWorkspaceBundles;
  const maxManifestBytes = deps.maxManifestBytes ?? DEFAULT_MAX_MANIFEST_BYTES;
  const maxManifestObjects =
    deps.maxManifestObjects ?? DEFAULT_MAX_MANIFEST_OBJECTS;
  const bundleGate = createGate(
    deps.maxConcurrentBundleVerifications ??
      DEFAULT_MAX_CONCURRENT_BUNDLE_VERIFICATIONS,
  );
  const maxRestoreFallbacks =
    deps.maxRestoreFallbacks ?? DEFAULT_MAX_RESTORE_FALLBACKS;
  const spoolRoot = deps.bundleSpoolRoot ?? tmpdir();
  const cooling = createCooldown(
    deps.bundleRetryCooldownMs ?? DEFAULT_BUNDLE_RETRY_COOLDOWN_MS,
    deps.clock ?? Date.now,
  );
  if (
    !Number.isInteger(maxRestoreFallbacks) ||
    maxRestoreFallbacks < 0 ||
    maxRestoreFallbacks > MAX_RESTORE_FALLBACKS_CEILING
  ) {
    throw new Error(
      `maxRestoreFallbacks must be an integer from 0 to ${MAX_RESTORE_FALLBACKS_CEILING}: ${maxRestoreFallbacks}`,
    );
  }
  const protection = deps.objectProtection ?? "locked";
  if (protection === "locked" && objects.hold === undefined) {
    throw new Error(
      'objectProtection "locked" needs an object store that can hold versions; pass "unversioned" for one without versions or Object Lock',
    );
  }
  // What a version the manifest or the pointer names is worth here: the one
  // to read in `locked`, and nothing in `unversioned`, which reads by key.
  const pinnedVersion = (version: string | null | undefined) =>
    protection === "locked" ? (version ?? undefined) : undefined;
  const publishId = deps.newPublishId ?? newPublishId;

  /**
   * `validateManifest`, plus whether a refusal means the checkpoint is
   * damaged: an object it names is gone, or is no longer the bytes it named.
   * Only damage lets a restore fall back to an earlier revision. Anything
   * else — a limit lowered since, a codec or verifier that changed, a
   * version this deployment now requires — would refuse the earlier
   * revisions for the same reason, or pass them only because they are
   * smaller, and a restore must not trade a session's newest state for a
   * configuration change.
   */
  async function judgeManifest(input: {
    checkpoint: CheckpointRef;
    /**
     * Finalize only: the manifest may name objects in no checkpoint
     * directory but its own publish's (`badArtifact`). A restore does not
     * ask, so a checkpoint committed before the rule still restores.
     */
    confined?: boolean;
    /**
     * Collects every version this validation read, with whether a legal
     * hold already covers it. Finalize holds the rest; restore passes none.
     */
    pinned?: PinnedVersions;
    sessionId: string;
    /**
     * Tokens (`refToken`) of versions a previous commit already read and
     * hashed. A version never changes, so re-hashing it would only
     * re-download a transcript that grows with the session.
     */
    verified?: ReadonlySet<string>;
    /**
     * Finalize only: `verified` also speaks for those versions still being
     * stored and held (`verifiedRefs`), so they are skipped without a
     * request. A restore passes none and HEADs them all: it is where a
     * version that went anyway is caught.
     */
    held?: boolean;
  }): Promise<Judgement> {
    const { checkpoint, sessionId } = input;
    const version = pinnedVersion(checkpoint.manifest_version);
    if (protection === "locked" && version === undefined) {
      return {
        status: "rejected",
        reason: `manifest ${checkpoint.manifest_ref} is not named by version, and this deployment pins every checkpoint object by version`,
      };
    }
    const missing = damaged(
      `manifest object is missing: ${checkpoint.manifest_ref}${versionSuffix(version)}`,
    );
    const tooLarge = (bytes: number): ManifestVerdict => ({
      status: "rejected",
      reason: `manifest is ${bytes} bytes, over the ${maxManifestBytes}-byte limit`,
    });
    const size = await objects.head(checkpoint.manifest_ref, version);
    if (size === undefined) return missing;
    if (size.bytes > maxManifestBytes) return tooLarge(size.bytes);
    const bytes = await objects.get(checkpoint.manifest_ref, version);
    if (bytes === undefined) return missing;
    // Replaced between the two reads: judge what actually arrived.
    if (bytes.byteLength > maxManifestBytes) return tooLarge(bytes.byteLength);
    const digest = sha256(bytes);
    if (digest !== checkpoint.manifest_sha256) {
      return damaged(`manifest digest mismatch: stored ${digest}`);
    }
    const engine = engineOf(bytes);
    const codec = engine === undefined ? undefined : own(codecs, engine);
    if (codec === undefined) {
      return {
        status: "rejected",
        reason: `no codec for checkpoint engine: ${engine ?? "<unreadable>"}`,
      };
    }
    let manifest: CheckpointManifest;
    try {
      manifest = codec.decode(bytes);
    } catch (error) {
      return { status: "rejected", reason: (error as Error).message };
    }
    if (protection === "unversioned") manifest = withoutVersions(manifest);
    if (manifest.sessionId !== sessionId) {
      return {
        status: "rejected",
        reason: `manifest belongs to session ${manifest.sessionId}`,
      };
    }
    if (manifest.revision !== checkpoint.revision) {
      return {
        status: "rejected",
        reason: `manifest is revision ${manifest.revision}, not ${checkpoint.revision}`,
      };
    }
    const bad = await badArtifact(
      manifest,
      sessionId,
      checkpoint.manifest_ref,
      input.verified,
      input.pinned,
      input.confined === true,
      input.held === true,
    );
    if (bad !== undefined) {
      return bad.damaged ? damaged(bad.reason) : rejected(bad.reason);
    }
    if (version !== undefined) {
      input.pinned?.note(checkpoint.manifest_ref, version, size);
    }
    return { status: "verified", manifest };
  }

  async function validateManifest(
    input: Parameters<typeof judgeManifest>[0],
  ): Promise<ManifestVerdict> {
    const verdict = await judgeManifest(input);
    return verdict.status === "rejected" ? rejected(verdict.reason) : verdict;
  }

  /**
   * A manifest that parses is not yet a restorable checkpoint, and the pointer
   * must never advance to one that is not. Four things are checked, in the
   * order that fails cheapest first.
   *
   * *Namespace.* Object keys come from the worker. One that names another
   * session's object would put that transcript into this session's restore
   * plan, so anything outside the session's own prefix is refused before it is
   * ever fetched.
   *
   * *Presence and size.* A partial upload or a lifecycle deletion leaves the
   * manifest naming objects that are not there.
   *
   * *Digest.* A same-length overwrite passes a size check and then fails at
   * restore — by which point the pointer has already superseded the last
   * healthy checkpoint and the session is unresumable. Hashing here is what
   * makes "committed" mean "restorable". Parts already hashed under the
   * previous pointer are not hashed again, because parts are write-once:
   * without that, every checkpoint would re-download the whole transcript.
   * With `held` they are not even HEADed, or finalize would still cost a
   * request per part the session ever wrote (94S-342).
   *
   * *The workspace commit.* Same idea one level up: an object that hashes
   * correctly is still the wrong object if it does not carry the commit the
   * manifest pins.
   */
  async function badArtifact(
    manifest: CheckpointManifest,
    sessionId: string,
    manifestRef: string,
    verified: ReadonlySet<string> = new Set(),
    pinned?: PinnedVersions,
    confined = false,
    held = false,
  ): Promise<Problem | undefined> {
    const refs = [
      ...manifest.transcripts.root.parts,
      ...Object.values(manifest.transcripts.subagents).flatMap(
        (revision) => revision.parts,
      ),
      ...manifest.workspace.untracked,
    ];
    // Counted before any request goes out: the bundle is the one more.
    if (refs.length + 1 > maxManifestObjects) {
      return refused(
        `manifest names ${refs.length + 1} objects, over the ${maxManifestObjects}-object limit`,
      );
    }
    const prefix = sessionObjectPrefix(sessionId);
    for (const ref of [...refs, manifest.workspace.bundle]) {
      if (!ref.key.startsWith(prefix) || ref.key.split("/").includes("..")) {
        return refused(
          `manifest references an object outside ${prefix}: ${ref.key}`,
        );
      }
    }
    // Checkpoint directories belong to the publish that wrote them: a
    // manifest being committed may name objects in its own and in no other.
    // Garbage collection relies on it — a directory it may reclaim is never
    // one a manifest that can still commit points into
    // (checkpoint-collector.ts). The bundle is held to the same directory
    // below, on every read.
    const publish = manifestRef.slice(0, manifestRef.lastIndexOf("/") + 1);
    const directories = `${prefix}checkpoints/`;
    const stray = confined
      ? refs.find(
          (ref) =>
            ref.key.startsWith(directories) && !ref.key.startsWith(publish),
        )
      : undefined;
    if (stray !== undefined) {
      return refused(
        `manifest references ${stray.key}, which is not under this publish's ${publish}`,
      );
    }
    // The key says where the object is stored; `path` says where restoring
    // writes it. A safe key with a climbing path lands outside the workspace,
    // so both are checked, and here rather than in whatever later unpacks it.
    // This is the text half; the restorer's writer refuses what only the disk
    // can show, like a checked-out symlink on the way (workspace-restore.ts).
    // Before any request: a ref without a version can only be read as "the
    // key's current object", which is exactly what this mode exists to stop
    // trusting.
    if (protection === "locked") {
      const loose = [...refs, manifest.workspace.bundle].find(
        (ref) => ref.version === undefined,
      );
      if (loose !== undefined) {
        return refused(
          `manifest names ${loose.key} without a version, and this deployment pins every checkpoint object by version`,
        );
      }
    }
    const pathProblem = workspacePathsProblem(
      manifest.workspace.untracked.map((artifact) => artifact.path),
    );
    if (pathProblem !== undefined) {
      return refused(
        `manifest restores untracked files unsafely: ${pathProblem}`,
      );
    }
    // Bounded, because with eager mirroring a long session accumulates
    // thousands of parts and firing a request per part at once turns a valid
    // checkpoint into a throttled one.
    const problems = await inBatches(refs, 32, async (ref) => {
      const token = refToken(ref);
      const known = token !== undefined && verified.has(token);
      if (known && held) return undefined;
      const head = await objects.head(ref.key, ref.version);
      if (head === undefined) {
        return broken(
          `manifest references a missing object: ${ref.key}${versionSuffix(ref.version)}`,
        );
      }
      if (head.bytes !== ref.bytes) {
        return broken(
          `manifest object ${ref.key} is ${head.bytes} bytes, not ${ref.bytes}`,
        );
      }
      if (ref.version !== undefined) pinned?.note(ref.key, ref.version, head);
      if (known) return undefined;
      const body = await digestObject(objects, ref.key, ref.version, ref.bytes);
      if (body === undefined) {
        return broken(
          `manifest references a missing object: ${ref.key}${versionSuffix(ref.version)}`,
        );
      }
      if (body.status === "over") {
        return broken(
          `manifest object ${ref.key} delivered more than the ${ref.bytes} bytes it was stored with`,
        );
      }
      if (body.sha256 !== ref.sha256) {
        return broken(
          `manifest object ${ref.key} hashes to ${body.sha256}, not ${ref.sha256}`,
        );
      }
      return undefined;
    });
    const bad = problems.find((problem) => problem !== undefined);
    return (
      bad ?? (await badWorkspaceBundle(manifest.workspace, manifestRef, pinned))
    );
  }

  /**
   * The workspace half of "committed means restorable".
   *
   * `gitCommit` on its own is 40 hex characters and nothing more. A worker
   * that names a commit it never pushed, or transposes two of them, would
   * otherwise produce a manifest that validates, a pointer that advances past
   * the last healthy checkpoint, and a restore that dies at `git checkout`. So
   * the commit's objects travel with the checkpoint, and the bundle carrying
   * them is read here — presence, size and digest like any other object, and
   * then the one question a digest cannot answer: does this bundle actually
   * offer that commit, on its own, to a workspace that starts empty?
   *
   * It is read whole every time rather than skipped via the verified set,
   * because what is being checked is not the object's integrity but its
   * relationship to *this* manifest's commit, and that changes with every
   * revision even when the bytes do not.
   */
  function badWorkspaceBundle(
    workspace: CheckpointManifest["workspace"],
    manifestRef: string,
    pinned?: PinnedVersions,
  ): Promise<Problem | undefined> {
    // Before the gate and the download: a bundle cooling down costs neither.
    const cooled = cooling.pending(bundleCooldownKey(workspace));
    if (cooled !== undefined) throw cooled;
    // Everything that needs the object itself runs under the gate; the
    // cheap refusals above it must not queue behind a gigabyte being hashed.
    return bundleGate(() =>
      readAndVerifyBundle(workspace, manifestRef, pinned),
    );
  }

  // The commit too: the same bytes asked for another commit is other work.
  function bundleCooldownKey(
    workspace: CheckpointManifest["workspace"],
  ): string {
    return JSON.stringify([
      bundles.policy ?? null,
      workspace.bundle.sha256,
      workspace.gitCommit,
    ]);
  }

  async function readAndVerifyBundle(
    workspace: CheckpointManifest["workspace"],
    manifestRef: string,
    pinned?: PinnedVersions,
  ): Promise<Problem | undefined> {
    const { bundle, gitCommit } = workspace;
    // One attempt's directory holds one attempt's objects. A bundle at a key
    // the session reuses across revisions is either overwritten — so the
    // committed checkpoint stops describing what is stored — or refused by
    // create-only forever after the first one. Pinning it beside the manifest
    // that names it gives every revision its own write-once key, and gives a
    // worker from a dead epoch nothing of the live one to clobber.
    const attempt = manifestRef.slice(0, manifestRef.lastIndexOf("/") + 1);
    if (attempt.length === 0 || !bundle.key.startsWith(attempt)) {
      return refused(
        `workspace bundle ${bundle.key} is not under this attempt's ${attempt}`,
      );
    }
    // Both figures, and before the body: the manifest's is the worker's
    // claim and the store's is the truth, and either one over the ceiling
    // means this object is never pulled into the process at all.
    const tooBig = (found: number) =>
      refused(
        `workspace bundle ${bundle.key} is ${found} bytes, over the ${maxBundleBytes} the control plane will verify`,
      );
    if (bundle.bytes > maxBundleBytes) return tooBig(bundle.bytes);
    const head = await objects.head(bundle.key, bundle.version);
    if (head === undefined) {
      return broken(
        `manifest references a missing workspace bundle: ${bundle.key}${versionSuffix(bundle.version)}`,
      );
    }
    if (head.bytes > maxBundleBytes) return tooBig(head.bytes);
    if (head.bytes !== bundle.bytes) {
      return broken(
        `workspace bundle ${bundle.key} is ${head.bytes} bytes, not ${bundle.bytes}`,
      );
    }
    // The bundle is read exactly once, by this loop, which both hashes it
    // and spools it to a file of its own; the verifier gets the file, and
    // only after the digest proved it is the object the manifest names. A
    // tee would let a slow second reader make the stream buffer for it, and
    // would show the verifier bytes nobody had checked yet.
    const spool = await mkdtemp(join(spoolRoot, "bundle-spool-"));
    try {
      const path = join(spool, "workspace.bundle");
      const file = await open(path, "wx", 0o600);
      let body: Awaited<ReturnType<typeof digestObject>>;
      try {
        body = await digestObject(
          objects,
          bundle.key,
          bundle.version,
          maxBundleBytes,
          (chunk) => writeFully(file, chunk),
        );
      } finally {
        await file.close();
      }
      if (body === undefined) {
        return broken(
          `manifest references a missing workspace bundle: ${bundle.key}${versionSuffix(bundle.version)}`,
        );
      }
      // A store that answered a smaller HEAD than it then served is the one
      // case the checks above cannot bound; the read stopped at the ceiling.
      if (body.status === "over") {
        return refused(
          `workspace bundle ${bundle.key} delivered more than the ${maxBundleBytes} bytes the control plane will verify`,
        );
      }
      if (body.sha256 !== bundle.sha256) {
        return broken(
          `workspace bundle ${bundle.key} hashes to ${body.sha256}, not ${bundle.sha256}`,
        );
      }
      let verdict: Awaited<ReturnType<typeof bundles.verify>>;
      try {
        verdict = await bundles.verify({
          bytes: body.bytes,
          commit: gitCommit,
          key: bundle.key,
          path,
        });
      } catch (error) {
        // Only the verifier's own throws: a store that failed the read above
        // says nothing about this bundle.
        cooling.start(bundleCooldownKey(workspace), bundle.key, error);
        throw error;
      }
      if (verdict.status !== "restorable") {
        // The bytes are the ones committed, so it is the verifier that
        // changed.
        return refused(
          `workspace bundle ${bundle.key} cannot restore ${gitCommit}: ${verdict.reason}`,
        );
      }
    } finally {
      await rm(spool, { force: true, recursive: true });
    }
    if (bundle.version !== undefined) {
      pinned?.note(bundle.key, bundle.version, head);
    }
    return undefined;
  }

  /**
   * What the currently committed checkpoint already proved. A pointer that
   * cannot be read yields nothing, which only costs a re-hash.
   *
   * In `locked` only a pointer recorded with `versionsHeld` vouches for the
   * versions it names. One committed under `unversioned` recorded whatever
   * version the worker reported, and nothing ever read those; trusting them
   * would let a same-length stranger through. The hold state cannot stand in
   * for the record: any later candidate may name an old manifest as one of
   * its own objects and get it held without ever committing.
   *
   * Such a pointer also vouches that those versions are still stored and
   * held, which is what lets finalize skip them without a request
   * (`held`). Its finalize held every one before it committed (`holdAll`),
   * and nothing releases a version the live pointer names: garbage
   * collection keeps every version the pointer and its fallback window
   * name and never touches transcript parts (checkpoint-collector.ts,
   * 94S-281), and transcript reclaim must release only parts no retained
   * checkpoint names (94S-326). The pointer read here is still the pointer
   * when the finalize commits: finalize passes the revision just below its
   * candidate as `parent`, the commit takes the candidate only as the next
   * revision, and the pointer advances one revision at a time, so a pointer
   * that moved in between leaves the candidate not next. A version released
   * or destroyed by hand anyway is caught by the next restore, which HEADs
   * every version of the pointer's checkpoint.
   */
  async function verifiedRefs(
    sessionId: string,
    parent?: number,
  ): Promise<Set<string>> {
    const tokens = new Set<string>();
    try {
      const pointer = await store.readPointer(sessionId);
      if (pointer === null) return tokens;
      if (parent !== undefined && pointer.revision !== parent) return tokens;
      if (protection === "locked" && pointer.versionsHeld !== true) {
        return tokens;
      }
      const bytes = await objects.get(
        pointer.manifestRef,
        pinnedVersion(pointer.manifestVersion),
      );
      if (bytes === undefined || sha256(bytes) !== pointer.manifestSha256) {
        return tokens;
      }
      const engine = engineOf(bytes);
      const codec = engine === undefined ? undefined : own(codecs, engine);
      if (codec === undefined) return tokens;
      const manifest = codec.decode(bytes);
      for (const ref of [
        ...manifest.transcripts.root.parts,
        ...Object.values(manifest.transcripts.subagents).flatMap(
          (revision) => revision.parts,
        ),
        ...manifest.workspace.untracked,
      ]) {
        const token = refToken(ref);
        if (token !== undefined) tokens.add(token);
      }
    } catch {
      return new Set();
    }
    return tokens;
  }

  /**
   * The finalize-side check: the manifest the caller offers must be at a key
   * this session, revision and attempt could have been handed, and it must
   * validate. The caller supplies both the fence and the manifest reference,
   * and nothing else ties them together: a confused worker could hand over
   * the fence it holds and some other attempt's manifest, which would promote
   * exactly the orphan that per-attempt keys exist to isolate.
   *
   * Which publish id the key carries is not checked against anything the
   * server remembers — it remembers none. Any key of exactly the shape
   * `requestCheckpoint` mints under this attempt's directory is one only this
   * attempt could have written, which is the property that matters.
   */
  async function verifyAttemptManifest(input: {
    checkpoint: CheckpointRef;
    fence: CheckpointFence;
  }): Promise<ManifestVerdict> {
    const sessionId = input.fence.sessionId;
    const ref = input.checkpoint.manifest_ref;
    const shape = manifestRefFor(
      sessionId,
      input.checkpoint.revision,
      input.fence.attemptId,
      "<publish>",
    );
    const [directory, file] = shape.split("<publish>") as [string, string];
    const minted =
      ref.startsWith(directory) &&
      ref.endsWith(file) &&
      PUBLISH_ID.test(ref.slice(directory.length, ref.length - file.length));
    if (!minted) {
      return {
        status: "rejected",
        reason: `manifest ${ref} is not a key this attempt was handed under ${directory}`,
      };
    }
    const pinned = pinnedVersions();
    const verdict = await validateManifest({
      checkpoint: input.checkpoint,
      confined: true,
      held: protection === "locked",
      pinned,
      sessionId,
      verified: await verifiedRefs(sessionId, input.checkpoint.revision - 1),
    });
    if (verdict.status === "verified" && protection === "locked") {
      await holdAll(pinned.unheld());
      return { ...verdict, versionsHeld: true };
    }
    return verdict;
  }

  /**
   * Holds every version a verified checkpoint names that is not held yet.
   * The ones finalize skipped as the pointer's are not among them: a
   * `versionsHeld` pointer speaks for their protection as well as their
   * bytes (`verifiedRefs`). A restore's verified set speaks only for the
   * bytes, so a restore holds whatever its HEADs found unheld. Awaited in full before
   * finalize may answer "verified": a failure throws, the caller reports the
   * store as unavailable, and the pointer stays where it was. Holds that did
   * land are left in place — a retry needs them, and another checkpoint may
   * already share them. Releasing any hold is garbage collection's job
   * (checkpoint-collector.ts), which never reaches into a directory a
   * finalize in flight may still commit.
   */
  async function holdAll(
    versions: readonly { key: string; version: string }[],
  ): Promise<void> {
    const hold = objects.hold?.bind(objects);
    if (hold === undefined) return;
    await inBatches(versions, 32, ({ key, version }) => hold(key, version));
  }

  /**
   * An earlier revision is judged like the pointer, with three differences.
   * Nothing is trusted from a cache — `verifiedRefs` speaks for the pointer's
   * checkpoint, not this one — so every object is hashed again. In `locked`
   * the revision must have been committed with its versions held, and every
   * version it names must still be held: a hold that is gone means garbage
   * collection has released that generation and may be deleting it, and
   * holding it again here would race that deletion rather than stop it. And
   * only damage moves the search further back (`judgeManifest`); a refusal
   * for any other reason ends it. Both hold conditions are refusals: they
   * say the protection policy no longer stands behind this revision, and an
   * older one below it would only lose more state for the same reason. So is
   * any damage in `locked`: a held version can neither change nor go, so a
   * committed one that did was released first, and the object that went is
   * not always the one that says so.
   */
  async function judgeEarlier(
    candidate: CheckpointPointer,
    sessionId: string,
  ): Promise<
    | { reason: string; verdict: "damaged" | "refused" }
    | { manifest: CheckpointManifest; verdict: "verified" }
  > {
    if (protection === "locked" && candidate.versionsHeld !== true) {
      return {
        verdict: "refused",
        reason: `revision ${candidate.revision} was not committed with its versions held`,
      };
    }
    const pinned = pinnedVersions();
    const judged = await judgeManifest({
      checkpoint: checkpointRefOf(candidate),
      pinned,
      sessionId,
    });
    if (judged.status === "rejected") {
      return {
        verdict:
          "damaged" in judged && protection !== "locked"
            ? "damaged"
            : "refused",
        reason: judged.reason,
      };
    }
    if (protection === "locked") {
      const released = pinned.unheld()[0];
      if (released !== undefined) {
        return {
          verdict: "refused",
          reason: `version ${released.version} of ${released.key} is no longer held`,
        };
      }
    }
    return { verdict: "verified", manifest: judged.manifest };
  }

  /**
   * The verified manifest as a plan, once the runtime asking can resume it.
   * `protect` runs only when the plan is about to be handed out.
   */
  async function restoreFrom(
    manifest: CheckpointManifest,
    checkpoint: CheckpointPointer,
    runtime: RuntimeFingerprint,
    protect: () => Promise<void> | undefined,
    fallback?: RestoreFallback,
  ): Promise<RestorePlanResult> {
    const codec = own(codecs, manifest.engine);
    if (codec === undefined) {
      return {
        status: "unavailable",
        code: "CHECKPOINT_UNAVAILABLE",
        reason: `no codec for checkpoint engine: ${manifest.engine}`,
      };
    }
    const compatibility = codec.validateCompatibility(manifest, runtime);
    // Judged on the newest intact revision only. Walking further back past
    // an incompatible one would make how much history a session loses
    // depend on which runtime happens to ask.
    if (compatibility.status === "incompatible") {
      return {
        status: "incompatible",
        code: "INCOMPATIBLE_CHECKPOINT",
        mismatches: compatibility.mismatches,
        ...(fallback === undefined
          ? {}
          : { fallback: { ...fallback, revision: checkpoint.revision } }),
      };
    }
    await protect();
    const plan = planOf(
      manifest,
      checkpoint.manifestRef,
      checkpoint.manifestSha256,
      pinnedVersion(checkpoint.manifestVersion),
    );
    return {
      status: "ready",
      plan: fallback === undefined ? plan : { ...plan, fallback },
    };
  }

  return {
    /**
     * Answers a checkpoint trigger: the runtime's own verdict decides whether
     * the session is at a safe boundary, and the current pointer decides which
     * revision the worker may claim next.
     */
    async requestCheckpoint(input: {
      attemptId: string;
      // Only the status and the refusal matter here; the engine handle a
      // ready preparation carries stays with the worker.
      preparation:
        | Pick<Extract<CheckpointPreparation, { status: "ready" }>, "status">
        | Extract<CheckpointPreparation, { status: "rejected" }>;
      sessionId: string;
      /**
       * The pointer as a caller's fenced transaction read it. Given, it is
       * the snapshot the answer is built from; left out, the store is read
       * here, unfenced.
       */
      pointer?: CheckpointPointer | null;
    }): Promise<CheckpointRequestDecision> {
      if (input.preparation.status === "rejected") {
        return {
          status: "blocked",
          reason: input.preparation.reason,
          detail: input.preparation.detail,
        };
      }
      const pointer =
        input.pointer === undefined
          ? await store.readPointer(input.sessionId)
          : input.pointer;
      const revision = (pointer?.revision ?? -1) + 1;
      return {
        status: "ready",
        request: {
          manifestRef: manifestRefFor(
            input.sessionId,
            revision,
            input.attemptId,
            publishId(),
          ),
          revision,
          sessionId: input.sessionId,
        },
      };
    },

    validateManifest,
    verifyAttemptManifest,

    /**
     * Promotes a validated manifest to the session pointer on its own, with
     * no turn to close. A checkpoint that does not validate is never
     * committed, and a pointer that has already moved past this revision is
     * a conflict the caller answers with 409.
     *
     * The fence travels into the same transaction as the pointer update, so a
     * worker whose lease was taken over cannot win the next revision merely by
     * uploading first — object-store ordering decides nothing here.
     *
     * Not the turn path. A checkpoint riding a turn's finalize commits through
     * `WorkerUnitOfWork.finalizeAtomic`, in the same transaction as the turn's
     * terminal, receipt and queue ACK (94S-201); the gateway verifies with
     * `verifyAttemptManifest` and never calls this. This is the turn-less
     * commit a drain or pause needs (94S-137).
     */
    async finalize(
      input: FinalizeCheckpointInput,
    ): Promise<FinalizeCheckpointResult> {
      if (input.fence.sessionId !== input.sessionId) {
        return {
          outcome: "rejected",
          reason: `fence belongs to session ${input.fence.sessionId}`,
        };
      }
      const verdict = await verifyAttemptManifest({
        checkpoint: input.checkpoint,
        fence: input.fence,
      });
      if (verdict.status === "rejected") {
        return { outcome: "rejected", reason: verdict.reason };
      }
      const result = await store.commitAtomic({
        checkpoint: input.checkpoint,
        fence: input.fence,
        now: input.now,
        sessionId: input.sessionId,
        turnId: input.turnId,
        versionsHeld: verdict.versionsHeld === true,
      });
      switch (result.outcome) {
        case "conflict":
          return {
            outcome: "conflict",
            currentRevision: result.currentRevision,
          };
        case "stale_epoch":
        case "lease_expired":
          return { outcome: result.outcome };
        default:
          return { outcome: result.outcome, revision: result.revision };
      }
    },

    /**
     * What a new execution must download before it may start the engine. A
     * session with no pointer is a new session, not a broken one; a pointer
     * whose manifest cannot be read or replayed is reported rather than
     * approximated, so the worker fails its claim instead of quietly starting
     * a fresh conversation.
     */
    /**
     * When the pointer's own checkpoint no longer verifies — its manifest or
     * an object it names was deleted or damaged after the commit — the
     * committed revisions below it are tried newest first, up to
     * `maxRestoreFallbacks` of them, and the first that verifies in full is
     * restored instead. The plan then says so (`fallback`), because resuming
     * from an older generation loses whatever the newer ones recorded.
     *
     * Only a verdict falls back. A store that throws is an outage, not a
     * missing object: the error goes to the caller as retryable, so a
     * restore never settles for an older checkpoint because S3 blinked.
     */
    async getRestorePlan(input: {
      runtime: RuntimeFingerprint;
      sessionId: string;
      /** As for requestCheckpoint: the caller's fenced snapshot, when it has one. */
      pointer?: CheckpointPointer | null;
    }): Promise<RestorePlanResult> {
      const pointer: CheckpointPointer | null =
        input.pointer === undefined
          ? await store.readPointer(input.sessionId)
          : input.pointer;
      if (pointer === null) return { status: "none" };
      const pinned = pinnedVersions();
      const verdict = await judgeManifest({
        pinned,
        checkpoint: checkpointRefOf(pointer),
        sessionId: input.sessionId,
        // These are the objects finalize already hashed on the way in, and the
        // worker hashes them again as it downloads them. Re-reading the whole
        // transcript here would only add a round trip between the two.
        verified: await verifiedRefs(input.sessionId),
      });
      if (verdict.status === "verified") {
        // A no-op for a checkpoint a locked finalize committed. Any other was
        // just hashed version by version above, since `verifiedRefs` trusts
        // none of it, and is held before any worker is told to download it.
        // The pointer keeps saying it was not, so the next restore hashes it
        // again: restore does not write the pointer.
        return restoreFrom(verdict.manifest, pointer, input.runtime, () =>
          protection === "locked" ? holdAll(pinned.unheld()) : undefined,
        );
      }
      const unavailable = (reason: string): RestorePlanResult => ({
        status: "unavailable",
        code: "CHECKPOINT_UNAVAILABLE",
        reason,
      });
      if (!("damaged" in verdict) || maxRestoreFallbacks === 0) {
        return unavailable(verdict.reason);
      }
      const skipped: RestoreFallbackSkip[] = [
        { revision: pointer.revision, reason: verdict.reason },
      ];
      // The walk follows the state each checkpoint was built on, not the
      // revision numbers: after a fallback the next checkpoint's parent is the
      // revision restored, and the ones skipped then belong to a history the
      // session abandoned, however healthy they look later.
      let tried = 0;
      for (
        let parent = parentOf(pointer);
        parent !== null && tried < maxRestoreFallbacks;
        tried += 1
      ) {
        const [candidate] = await store.listCheckpoints(input.sessionId, {
          belowRevision: parent + 1,
          limit: 1,
        });
        if (candidate?.revision !== parent) {
          throw new Error(
            `Session ${input.sessionId} has no checkpoint row for revision ${parent}, which a later one was built on`,
          );
        }
        const judged = await judgeEarlier(candidate, input.sessionId);
        switch (judged.verdict) {
          case "damaged":
            skipped.push({
              revision: candidate.revision,
              reason: judged.reason,
            });
            parent = parentOf(candidate);
            continue;
          case "refused":
            return unavailable(
              `${verdict.reason}; earlier revision ${candidate.revision} is refused, and a refusal is not damage to walk past: ${judged.reason}`,
            );
          default:
            return restoreFrom(
              judged.manifest,
              candidate,
              input.runtime,
              noop,
              {
                pointerRevision: pointer.revision,
                skipped,
              },
            );
        }
      }
      return unavailable(
        tried === 0
          ? verdict.reason
          : `${verdict.reason}; none of the ${tried} earlier revisions tried verified either`,
      );
    },
  };
}

function noop() {
  return undefined;
}

type Problem = { damaged: boolean; reason: string };

function broken(reason: string): Problem {
  return { damaged: true, reason };
}

function refused(reason: string): Problem {
  return { damaged: false, reason };
}

type Judgement =
  | ManifestVerdict
  | { damaged: true; reason: string; status: "rejected" };

function damaged(reason: string): Judgement {
  return { damaged: true, reason, status: "rejected" };
}

function rejected(reason: string): ManifestVerdict {
  return { reason, status: "rejected" };
}

function checkpointRefOf(checkpoint: CheckpointPointer): CheckpointRef {
  return {
    manifest_ref: checkpoint.manifestRef,
    manifest_sha256: checkpoint.manifestSha256,
    ...(checkpoint.manifestVersion == null
      ? {}
      : { manifest_version: checkpoint.manifestVersion }),
    revision: checkpoint.revision,
  };
}

export type CheckpointService = ReturnType<typeof createCheckpointService>;

function planOf(
  manifest: CheckpointManifest,
  manifestRef: string,
  manifestSha256: string,
  manifestVersion: string | undefined,
): RestorePlan {
  const artifacts: RestoreArtifact[] = [
    {
      kind: "transcript_root",
      label: "",
      objects: manifest.transcripts.root.parts,
    },
    ...Object.entries(manifest.transcripts.subagents)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([subpath, revision]): RestoreArtifact => {
        return {
          kind: "transcript_subagent",
          label: subpath,
          objects: revision.parts,
        };
      }),
  ];
  // Before the untracked files: they are restored on top of the checkout, and
  // an ordered download list is the only thing telling a worker so.
  artifacts.push({
    kind: "workspace_bundle",
    label: "",
    objects: [manifest.workspace.bundle],
  });
  if (manifest.workspace.untracked.length > 0) {
    artifacts.push({
      kind: "workspace_untracked",
      label: "",
      objects: manifest.workspace.untracked,
    });
  }
  return {
    artifacts,
    cwd: manifest.cwd,
    engine: manifest.engine,
    gitCommit: manifest.workspace.gitCommit,
    manifestRef,
    manifestSha256,
    ...(manifestVersion === undefined ? {} : { manifestVersion }),
    objectKeys: [
      ...new Set(
        artifacts.flatMap((artifact) =>
          artifact.objects.map((object) => object.key),
        ),
      ),
    ],
    resume: manifest.resume,
    revision: manifest.revision,
  };
}

/**
 * Reads one object through once, hashing it as it arrives and handing each
 * chunk to `sink` before asking for the next; nothing is kept. Undefined for
 * an absent object. Stops at the first chunk that takes the total past
 * `limit`, so an object that is larger than it claimed costs at most that
 * much to find out.
 */
async function digestObject(
  objects: CheckpointObjectStore,
  key: string,
  version: string | undefined,
  limit: number,
  sink?: (chunk: Uint8Array) => Promise<void>,
): Promise<
  | { bytes: number; sha256: string; status: "read" }
  | { status: "over" }
  | undefined
> {
  const chunks = await objects.stream(key, version);
  if (chunks === undefined) return undefined;
  const hash = createHash("sha256");
  let bytes = 0;
  // Returning from inside the loop ends the iteration, which lets go of the
  // store's connection.
  for await (const chunk of chunks) {
    bytes += chunk.byteLength;
    if (bytes > limit) return { status: "over" };
    hash.update(chunk);
    await sink?.(chunk);
  }
  return { bytes, sha256: hash.digest("hex"), status: "read" };
}

/** `FileHandle.write` may take less than it was handed. */
async function writeFully(
  file: Awaited<ReturnType<typeof open>>,
  chunk: Uint8Array,
): Promise<void> {
  for (let offset = 0; offset < chunk.byteLength; ) {
    const { bytesWritten } = await file.write(chunk, offset);
    offset += bytesWritten;
  }
}

// Only a versioned ref has one. Key and digest alone are not enough: an
// unversioned key can be overwritten with different bytes of the same length,
// which passes the HEAD that still runs and would then skip the hash. A
// version cannot be rewritten, so its token stays true. The size is in it
// because a finalize that matches the token skips the HEAD that checks it.
function refToken(ref: ObjectRef): string | undefined {
  return ref.version === undefined
    ? undefined
    : JSON.stringify([ref.key, ref.sha256, ref.version, ref.bytes]);
}

function versionSuffix(version: string | undefined): string {
  return version === undefined ? "" : ` (version ${version})`;
}

type PinnedVersions = ReturnType<typeof pinnedVersions>;

/**
 * The manifest as an `unversioned` deployment reads it: by key alone. The
 * versions are dropped rather than honoured because a store that is not
 * versioned the same way cannot answer them — a bucket restored from a backup
 * gives every object a new version id — and a plan naming them would send the
 * worker after versions that are not there.
 */
function withoutVersions(manifest: CheckpointManifest): CheckpointManifest {
  const strip = <T extends ObjectRef>(ref: T): T => {
    const { version: _version, ...rest } = ref;
    return rest as T;
  };
  const revision = (value: CheckpointManifest["transcripts"]["root"]) => ({
    ...value,
    parts: value.parts.map(strip),
  });
  return {
    ...manifest,
    transcripts: {
      root: revision(manifest.transcripts.root),
      subagents: Object.fromEntries(
        Object.entries(manifest.transcripts.subagents).map(([label, value]) => [
          label,
          revision(value),
        ]),
      ),
    },
    workspace: {
      ...manifest.workspace,
      bundle: strip(manifest.workspace.bundle),
      untracked: manifest.workspace.untracked.map(strip),
    },
  };
}

/** The versions one validation read, deduplicated, and which are held. */
function pinnedVersions() {
  const seen = new Map<
    string,
    { held: boolean; key: string; version: string }
  >();
  return {
    note(key: string, version: string, head: { held?: boolean }) {
      const id = JSON.stringify([key, version]);
      const held = (seen.get(id)?.held ?? false) || head.held === true;
      seen.set(id, { held, key, version });
    },
    unheld() {
      return [...seen.values()]
        .filter((entry) => !entry.held)
        .map(({ key, version }) => ({ key, version }));
    },
  };
}

/**
 * Bundles whose verification threw, and the error each one threw, until
 * `cooldownMs` has passed. Every entry lives the same time, so insertion
 * order is expiry order and the oldest is the first to drop.
 */
function createCooldown(cooldownMs: number, clock: () => number) {
  if (!Number.isFinite(cooldownMs) || cooldownMs < 0) {
    throw new Error(`Bundle retry cooldown must be at least 0: ${cooldownMs}`);
  }
  const entries = new Map<string, { error: Error; until: number }>();
  return {
    pending(id: string): Error | undefined {
      const entry = entries.get(id);
      if (entry === undefined) return undefined;
      if (clock() < entry.until) return entry.error;
      entries.delete(id);
      return undefined;
    },
    start(id: string, key: string, cause: unknown) {
      if (cooldownMs === 0) return;
      const until = clock() + cooldownMs;
      const reason = cause instanceof Error ? cause.message : String(cause);
      entries.delete(id);
      entries.set(id, {
        error: new Error(
          `workspace bundle ${key} is not verified again before ${new Date(until).toISOString()}; its last verification failed: ${reason}`,
          { cause },
        ),
        until,
      });
      for (const oldest of entries.keys()) {
        if (entries.size <= MAX_COOLING_BUNDLES) break;
        entries.delete(oldest);
      }
    },
  };
}

/**
 * Runs at most `limit` tasks at once, handing a finishing task's slot
 * straight to the next in line so a burst cannot briefly exceed the limit.
 */
function createGate(limit: number) {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error(`Concurrency limit must be a positive integer: ${limit}`);
  }
  let active = 0;
  const waiting: Array<() => void> = [];
  return async function run<T>(task: () => Promise<T>): Promise<T> {
    if (active >= limit) {
      await new Promise<void>((resolve) => waiting.push(resolve));
    } else {
      active += 1;
    }
    try {
      return await task();
    } finally {
      const next = waiting.shift();
      // Hand the slot over rather than release it, so nobody slips between.
      if (next === undefined) active -= 1;
      else next();
    }
  };
}
