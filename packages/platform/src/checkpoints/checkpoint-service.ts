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
import { gitBundleOffers } from "@agent-platform/runtime-core";

import type {
  CheckpointFence,
  CheckpointPointer,
  CheckpointStore,
} from "../ports/checkpoint-store.ts";

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
  objects: CheckpointObjectStore;
  store: CheckpointStore;
};

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
    const bad = await badArtifact(manifest, sessionId, input.verified);
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
    return bad ?? (await badWorkspaceBundle(manifest.workspace));
  }

  /**
   * The workspace half of "committed means restorable".
   *
   * Until now `gitCommit` was 40 hex characters and nothing more: a worker that
   * wrote a commit it never pushed, or transposed two characters, produced a
   * manifest that validated, a pointer that advanced past the last healthy
   * checkpoint, and a restore that died at `git checkout`. So the commit's
   * objects travel with the checkpoint, and the bundle carrying them is read
   * here — presence, size and digest like any other object, and then the one
   * question a digest cannot answer: does this bundle actually offer that
   * commit, on its own, to a workspace that starts empty?
   *
   * It is read whole every time rather than skipped via the verified set,
   * because what is being checked is not the object's integrity but its
   * relationship to *this* manifest's commit, and that changes with every
   * revision even when the bytes do not.
   */
  async function badWorkspaceBundle(
    workspace: CheckpointManifest["workspace"],
  ): Promise<string | undefined> {
    const { bundle, gitCommit } = workspace;
    const head = await objects.head(bundle.key);
    if (head === undefined) {
      return `manifest references a missing workspace bundle: ${bundle.key}`;
    }
    if (head.bytes !== bundle.bytes) {
      return `workspace bundle ${bundle.key} is ${head.bytes} bytes, not ${bundle.bytes}`;
    }
    const body = await objects.get(bundle.key);
    if (body === undefined) {
      return `manifest references a missing workspace bundle: ${bundle.key}`;
    }
    const digest = sha256(body);
    if (digest !== bundle.sha256) {
      return `workspace bundle ${bundle.key} hashes to ${digest}, not ${bundle.sha256}`;
    }
    const verdict = gitBundleOffers(body, gitCommit);
    return verdict.status === "offers"
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

  return {
    /**
     * Answers a checkpoint trigger: the runtime's own verdict decides whether
     * the session is at a safe boundary, and the current pointer decides which
     * revision the worker may claim next.
     */
    async requestCheckpoint(input: {
      attemptId: string;
      preparation: CheckpointPreparation;
      sessionId: string;
    }): Promise<CheckpointRequestDecision> {
      if (input.preparation.status === "rejected") {
        return {
          status: "blocked",
          reason: input.preparation.reason,
          detail: input.preparation.detail,
        };
      }
      const pointer = await store.readPointer(input.sessionId);
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

    /**
     * Promotes a validated manifest to the session pointer. A checkpoint that
     * does not validate is never committed, and a pointer that has already
     * moved past this revision is a conflict the caller answers with 409.
     *
     * The fence travels into the same transaction as the pointer update, so a
     * worker whose lease was taken over cannot win the next revision merely by
     * uploading first — object-store ordering decides nothing here.
     *
     * The caller supplies both the fence and the manifest reference, and
     * nothing yet ties them together: a confused worker could hand over the
     * fence it holds and some other attempt's manifest, which would promote
     * exactly the orphan that per-attempt keys exist to isolate. So the
     * reference is not taken as given — it must be the one key this session,
     * revision and attempt could have written.
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
      const expectedRef = manifestRefFor(
        input.sessionId,
        input.checkpoint.revision,
        input.fence.attemptId,
      );
      if (input.checkpoint.manifest_ref !== expectedRef) {
        return {
          outcome: "rejected",
          reason: `manifest ${input.checkpoint.manifest_ref} is not this attempt's key ${expectedRef}`,
        };
      }
      const verdict = await validateManifest({
        checkpoint: input.checkpoint,
        sessionId: input.sessionId,
        verified: await verifiedRefs(input.sessionId),
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
    }): Promise<RestorePlanResult> {
      const pointer: CheckpointPointer | null = await store.readPointer(
        input.sessionId,
      );
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

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
