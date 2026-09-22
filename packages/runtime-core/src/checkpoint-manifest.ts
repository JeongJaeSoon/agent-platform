/**
 * The checkpoint contract every runtime adapter and the control plane share.
 *
 * A mirror that is up to date is not a checkpoint. What makes a session safely
 * resumable is one immutable manifest that pins, at a single quiescent moment,
 * the exact transcript parts, the workspace commit, and the engine build that
 * produced them. Restore reads that manifest and nothing else: never the latest
 * mirror suffix, never the branch head.
 */

export type ObjectRef = {
  readonly bytes: number;
  readonly key: string;
  readonly sha256: string;
};

/**
 * One transcript pinned to exact bytes. `parts` is the ordered part list at
 * capture time; suffixes the mirror writes afterwards are not part of it.
 * `sha256` digests the part list itself, so a manifest cannot be edited to
 * point at a different set of parts without detection.
 */
export type TranscriptRevision = {
  readonly entryCount: number;
  readonly parts: readonly ObjectRef[];
  readonly sha256: string;
};

/** Everything that must match for a stored transcript to be replayable. */
export type RuntimeFingerprint = {
  readonly cliVersion: string;
  readonly engine: string;
  /** Digest of the allowlisted config profile, secrets excluded. */
  readonly profileSha256: string;
  readonly sdkVersion: string;
};

export type CheckpointWorkspace = {
  readonly gitCommit: string;
  /** Files git does not track, uploaded individually so restore is exact. */
  readonly untracked: readonly ObjectRef[];
};

export type CheckpointTranscripts = {
  readonly root: TranscriptRevision;
  /** Keyed by the engine's subagent subpath. */
  readonly subagents: Readonly<Record<string, TranscriptRevision>>;
};

export type CheckpointManifest = {
  readonly createdAt: string;
  readonly cwd: string;
  readonly engine: string;
  /** The handle a later `mode: "resume"` config passes back to the engine. */
  readonly resume: string;
  /** Monotonic per session; the DB pointer only ever moves forward. */
  readonly revision: number;
  readonly runtime: RuntimeFingerprint;
  readonly sessionId: string;
  readonly transcripts: CheckpointTranscripts;
  readonly version: 1;
  readonly workspace: CheckpointWorkspace;
};

export type CompatibilityMismatch = {
  readonly expected: string;
  readonly field: "cliVersion" | "engine" | "profileSha256" | "sdkVersion";
  readonly found: string;
};

export type CompatibilityVerdict =
  | { readonly status: "compatible" }
  | {
      readonly mismatches: readonly CompatibilityMismatch[];
      readonly status: "incompatible";
    };

/**
 * Per-engine manifest serialization. The control plane holds codecs by engine
 * name and never parses manifest bytes itself, so a second runtime can define
 * its own manifest body without the platform learning its shape.
 */
export interface CheckpointCodec {
  decode(bytes: Uint8Array): CheckpointManifest;
  encode(manifest: CheckpointManifest): { bytes: Uint8Array; sha256: string };
  readonly engine: string;
  validateCompatibility(
    manifest: CheckpointManifest,
    runtime: RuntimeFingerprint,
  ): CompatibilityVerdict;
}

/**
 * `conflict` is the case that matters: a worker from a dead epoch uploading a
 * different body under a key a live worker already wrote. The store reports it
 * instead of overwriting, and the pointer never advances to it.
 */
export type PutImmutableResult =
  | { readonly outcome: "created" }
  | { readonly outcome: "duplicate" }
  | { readonly outcome: "conflict"; readonly sha256: string };

export interface CheckpointObjectStore {
  get(key: string): Promise<Uint8Array | undefined>;
  /** Size and presence without transferring the body; undefined when absent. */
  head(key: string): Promise<{ bytes: number } | undefined>;
  list(prefix: string): Promise<string[]>;
  /** Append-only mirror write; callers own key uniqueness. */
  put(key: string, bytes: Uint8Array): Promise<void>;
  /** Create-only write. Never replaces an object that already exists. */
  putImmutable(key: string, bytes: Uint8Array): Promise<PutImmutableResult>;
}

/**
 * The transcript entry shape as a store adapter sees it: a `type` discriminant,
 * usually a `uuid`, and otherwise opaque JSON that must survive a
 * stringify/parse round trip untouched.
 */
export type TranscriptEntry = {
  readonly [key: string]: unknown;
  readonly type: string;
  readonly uuid?: string;
};

export type TranscriptKey = {
  readonly projectKey: string;
  readonly sessionId: string;
  /** Absent for the root transcript; set for a subagent's. */
  readonly subpath?: string;
};

/**
 * Structural supertype of the engine SDK's session-store port. Declared here so
 * store implementations stay outside the module that imports the SDK.
 */
export interface TranscriptMirror {
  append(key: TranscriptKey, entries: TranscriptEntry[]): Promise<void>;
  /**
   * True when `load` answers with exactly the parts a committed checkpoint
   * pinned, rather than everything the mirror currently holds.
   *
   * A plain mirror is deliberately not revision-scoped: it keeps recording
   * after a checkpoint, and those entries are not part of it. Handing such a
   * mirror to a resumed engine replays a conversation that was never
   * committed, so a resume refuses a mirror that does not declare this.
   */
  readonly revisionScoped?: boolean;
  listSubkeys(key: {
    projectKey: string;
    sessionId: string;
  }): Promise<string[]>;
  load(key: TranscriptKey): Promise<TranscriptEntry[] | null>;
}
