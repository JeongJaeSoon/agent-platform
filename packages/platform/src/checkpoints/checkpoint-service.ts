import { createHash } from "node:crypto";
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

import type {
  CheckpointFence,
  CheckpointPointer,
  CheckpointStore,
} from "../ports/checkpoint-store.ts";
import {
  rejectUnverifiedWorkspaceBundles,
  type WorkspaceBundleVerifier,
} from "../ports/workspace-bundle-verifier.ts";

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
  | { manifest: CheckpointManifest; status: "verified" }
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
  /** Every object key the plan needs, deduplicated, in download order. */
  objectKeys: readonly string[];
  resume: string;
  revision: number;
};

export type RestorePlanResult =
  | { plan: RestorePlan; status: "ready" }
  | { status: "none" }
  | { code: "CHECKPOINT_UNAVAILABLE"; reason: string; status: "unavailable" }
  | {
      code: "INCOMPATIBLE_CHECKPOINT";
      mismatches: readonly CompatibilityMismatch[];
      status: "incompatible";
    };

export type CheckpointServiceDependencies = {
  /** Manifest codecs by engine name. */
  codecs: Readonly<Record<string, CheckpointCodec>>;
  /**
   * How many workspace bundles may be read and verified at once.
   *
   * The size ceiling below bounds one bundle; this bounds the process. Without
   * it, ten sessions finalizing together each buy themselves a full bundle in
   * memory and the ceiling turns out to have promised nothing.
   */
  maxConcurrentBundleVerifications?: number;
  /**
   * Largest workspace bundle the control plane will read, in bytes.
   *
   * Verifying one means holding it whole to hash it, and the S3 adapter
   * gathers the chunks before joining them, so the real high-water mark is
   * about twice this per bundle in flight. Together with the concurrency
   * limit above that is the memory a finalize can cost.
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
  objects: CheckpointObjectStore;
  store: CheckpointStore;
  /**
   * Defaults to `rejectUnverifiedWorkspaceBundles`, so a deployment that has
   * not said how its bundles are verified commits no checkpoints at all
   * rather than commits ones that may not restore.
   */
  workspaceBundles?: WorkspaceBundleVerifier;
};

export const DEFAULT_MAX_WORKSPACE_BUNDLE_BYTES = 128 * 1024 * 1024;
export const DEFAULT_MAX_CONCURRENT_BUNDLE_VERIFICATIONS = 2;

/**
 * Every publish attempt gets its own key.
 *
 * Keying by revision alone deadlocks the session: a worker that uploads and
 * then dies before finalizing leaves an orphan object at the key the next
 * attempt is handed, and create-only then refuses every later manifest for that
 * revision forever. Two attempts may therefore both upload; which one becomes
 * the session's truth is decided by the fenced pointer CAS, not by who wrote
 * the object first.
 */
export function manifestRefFor(
  sessionId: string,
  revision: number,
  attemptId: string,
): string {
  // Zero-padded so a prefix listing of a session's checkpoints is ordered.
  const padded = String(revision).padStart(10, "0");
  return `${sessionObjectPrefix(sessionId)}checkpoints/${padded}/${attemptId}/manifest.json`;
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
  const bundleGate = createGate(
    deps.maxConcurrentBundleVerifications ??
      DEFAULT_MAX_CONCURRENT_BUNDLE_VERIFICATIONS,
  );

  async function validateManifest(input: {
    checkpoint: CheckpointRef;
    sessionId: string;
    /**
     * `key\u0000sha256` pairs a previous commit already read and hashed. Parts
     * are write-once, so re-hashing them would only re-download a transcript
     * that grows with the session.
     */
    verified?: ReadonlySet<string>;
  }): Promise<ManifestVerdict> {
    const { checkpoint, sessionId } = input;
    const bytes = await objects.get(checkpoint.manifest_ref);
    if (bytes === undefined) {
      return {
        status: "rejected",
        reason: `manifest object is missing: ${checkpoint.manifest_ref}`,
      };
    }
    const digest = sha256(bytes);
    if (digest !== checkpoint.manifest_sha256) {
      return {
        status: "rejected",
        reason: `manifest digest mismatch: stored ${digest}`,
      };
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
    );
    if (bad !== undefined) return { status: "rejected", reason: bad };
    return { status: "verified", manifest };
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
   * previous pointer are skipped, because parts are write-once: without that,
   * every checkpoint would re-download the whole transcript.
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
  ): Promise<string | undefined> {
    const refs = [
      ...manifest.transcripts.root.parts,
      ...Object.values(manifest.transcripts.subagents).flatMap(
        (revision) => revision.parts,
      ),
      ...manifest.workspace.untracked,
    ];
    const prefix = sessionObjectPrefix(sessionId);
    for (const ref of [...refs, manifest.workspace.bundle]) {
      if (!ref.key.startsWith(prefix) || ref.key.split("/").includes("..")) {
        return `manifest references an object outside ${prefix}: ${ref.key}`;
      }
    }
    // The key says where the object is stored; `path` says where restoring
    // writes it. A safe key with a climbing path lands outside the workspace,
    // so both are checked, and here rather than in whatever later unpacks it.
    const destinations = new Set<string>();
    for (const artifact of manifest.workspace.untracked) {
      if (!safeWorkspacePath(artifact.path)) {
        return `manifest restores ${artifact.key} to an unsafe path: ${artifact.path}`;
      }
      if (destinations.has(artifact.path)) {
        return `manifest restores two objects to ${artifact.path}`;
      }
      destinations.add(artifact.path);
    }
    // Bounded, because with eager mirroring a long session accumulates
    // thousands of parts and firing a request per part at once turns a valid
    // checkpoint into a throttled one.
    const problems = await inBatches(refs, 32, async (ref) => {
      const head = await objects.head(ref.key);
      if (head === undefined) {
        return `manifest references a missing object: ${ref.key}`;
      }
      if (head.bytes !== ref.bytes) {
        return `manifest object ${ref.key} is ${head.bytes} bytes, not ${ref.bytes}`;
      }
      if (verified.has(refToken(ref))) return undefined;
      const body = await objects.get(ref.key);
      if (body === undefined) {
        return `manifest references a missing object: ${ref.key}`;
      }
      const digest = sha256(body);
      if (digest !== ref.sha256) {
        return `manifest object ${ref.key} hashes to ${digest}, not ${ref.sha256}`;
      }
      return undefined;
    });
    const bad = problems.find((problem) => problem !== undefined);
    return bad ?? (await badWorkspaceBundle(manifest.workspace, manifestRef));
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
  ): Promise<string | undefined> {
    // Everything that needs the object itself runs under the gate; the
    // cheap refusals above it must not queue behind a gigabyte being hashed.
    return bundleGate(() => readAndVerifyBundle(workspace, manifestRef));
  }

  async function readAndVerifyBundle(
    workspace: CheckpointManifest["workspace"],
    manifestRef: string,
  ): Promise<string | undefined> {
    const { bundle, gitCommit } = workspace;
    // One attempt's directory holds one attempt's objects. A bundle at a key
    // the session reuses across revisions is either overwritten — so the
    // committed checkpoint stops describing what is stored — or refused by
    // create-only forever after the first one. Pinning it beside the manifest
    // that names it gives every revision its own write-once key, and gives a
    // worker from a dead epoch nothing of the live one to clobber.
    const attempt = manifestRef.slice(0, manifestRef.lastIndexOf("/") + 1);
    if (attempt.length === 0 || !bundle.key.startsWith(attempt)) {
      return `workspace bundle ${bundle.key} is not under this attempt's ${attempt}`;
    }
    // Both figures, and before the body: the manifest's is the worker's
    // claim and the store's is the truth, and either one over the ceiling
    // means this object is never pulled into the process at all.
    const tooBig = (found: number) =>
      `workspace bundle ${bundle.key} is ${found} bytes, over the ${maxBundleBytes} the control plane will verify`;
    if (bundle.bytes > maxBundleBytes) return tooBig(bundle.bytes);
    const head = await objects.head(bundle.key);
    if (head === undefined) {
      return `manifest references a missing workspace bundle: ${bundle.key}`;
    }
    if (head.bytes > maxBundleBytes) return tooBig(head.bytes);
    if (head.bytes !== bundle.bytes) {
      return `workspace bundle ${bundle.key} is ${head.bytes} bytes, not ${bundle.bytes}`;
    }
    const body = await objects.get(bundle.key);
    if (body === undefined) {
      return `manifest references a missing workspace bundle: ${bundle.key}`;
    }
    // A store that answered a smaller HEAD than it then served is the one
    // case the checks above cannot bound.
    if (body.byteLength > maxBundleBytes) return tooBig(body.byteLength);
    const digest = sha256(body);
    if (digest !== bundle.sha256) {
      return `workspace bundle ${bundle.key} hashes to ${digest}, not ${bundle.sha256}`;
    }
    const verdict = await bundles.verify({
      bytes: body,
      commit: gitCommit,
      key: bundle.key,
    });
    return verdict.status === "restorable"
      ? undefined
      : `workspace bundle ${bundle.key} cannot restore ${gitCommit}: ${verdict.reason}`;
  }

  function safeWorkspacePath(path: string): boolean {
    if (path.length === 0 || path.startsWith("/") || path.includes("\\")) {
      return false;
    }
    return !path
      .split("/")
      .some((segment) => segment === ".." || segment === "");
  }

  /**
   * What the currently committed checkpoint already proved. A pointer that
   * cannot be read yields nothing, which only costs a re-hash.
   */
  async function verifiedRefs(sessionId: string): Promise<Set<string>> {
    const tokens = new Set<string>();
    try {
      const pointer = await store.readPointer(sessionId);
      if (pointer === null) return tokens;
      const bytes = await objects.get(pointer.manifestRef);
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
        tokens.add(refToken(ref));
      }
    } catch {
      return new Set();
    }
    return tokens;
  }

  /**
   * The finalize-side check: the manifest the caller offers must be the one
   * key this session, revision and attempt could have written, and it must
   * validate. The caller supplies both the fence and the manifest reference,
   * and nothing else ties them together: a confused worker could hand over
   * the fence it holds and some other attempt's manifest, which would promote
   * exactly the orphan that per-attempt keys exist to isolate.
   */
  async function verifyAttemptManifest(input: {
    checkpoint: CheckpointRef;
    fence: CheckpointFence;
  }): Promise<ManifestVerdict> {
    const sessionId = input.fence.sessionId;
    const expectedRef = manifestRefFor(
      sessionId,
      input.checkpoint.revision,
      input.fence.attemptId,
    );
    if (input.checkpoint.manifest_ref !== expectedRef) {
      return {
        status: "rejected",
        reason: `manifest ${input.checkpoint.manifest_ref} is not this attempt's key ${expectedRef}`,
      };
    }
    return validateManifest({
      checkpoint: input.checkpoint,
      sessionId,
      verified: await verifiedRefs(sessionId),
    });
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
      const verdict = await validateManifest({
        checkpoint: {
          manifest_ref: pointer.manifestRef,
          manifest_sha256: pointer.manifestSha256,
          revision: pointer.revision,
        },
        sessionId: input.sessionId,
        // These are the objects finalize already hashed on the way in, and the
        // worker hashes them again as it downloads them. Re-reading the whole
        // transcript here would only add a round trip between the two.
        verified: await verifiedRefs(input.sessionId),
      });
      if (verdict.status === "rejected") {
        return {
          status: "unavailable",
          code: "CHECKPOINT_UNAVAILABLE",
          reason: verdict.reason,
        };
      }
      const { manifest } = verdict;
      const codec = own(codecs, manifest.engine);
      if (codec === undefined) {
        return {
          status: "unavailable",
          code: "CHECKPOINT_UNAVAILABLE",
          reason: `no codec for checkpoint engine: ${manifest.engine}`,
        };
      }
      const compatibility = codec.validateCompatibility(
        manifest,
        input.runtime,
      );
      if (compatibility.status === "incompatible") {
        return {
          status: "incompatible",
          code: "INCOMPATIBLE_CHECKPOINT",
          mismatches: compatibility.mismatches,
        };
      }
      return { status: "ready", plan: planOf(manifest, pointer.manifestRef) };
    },
  };
}

export type CheckpointService = ReturnType<typeof createCheckpointService>;

function planOf(
  manifest: CheckpointManifest,
  manifestRef: string,
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
 * Reads only the engine discriminator, to pick the codec that validates the
 * rest. The platform never interprets a manifest body itself.
 */
function engineOf(bytes: Uint8Array): string | undefined {
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const engine = (parsed as { engine?: unknown }).engine;
    return typeof engine === "string" ? engine : undefined;
  } catch {
    return undefined;
  }
}

/** Maps `items` in fixed-size waves, keeping the results in input order. */
async function inBatches<T, R>(
  items: readonly T[],
  size: number,
  map: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  for (let start = 0; start < items.length; start += size) {
    results.push(
      ...(await Promise.all(items.slice(start, start + size).map(map))),
    );
  }
  return results;
}

// Key and digest together: the same key carrying different bytes is exactly
// the case a verified-set must not wave through.
function refToken(ref: ObjectRef): string {
  return `${ref.key}\u0000${ref.sha256}`;
}

// Codec registries are plain objects; inherited keys are not codecs.
function own<T>(record: Readonly<Record<string, T>>, key: string) {
  return Object.hasOwn(record, key) ? record[key] : undefined;
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

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
