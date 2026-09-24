import { createHash } from "node:crypto";
import { canonicalJsonOfJson } from "@agent-platform/contracts";
import { digestParts } from "@agent-platform/runtime-claude-codec";
import {
  type CheckpointObjectStore,
  type CheckpointTranscripts,
  type ObjectRef,
  type PutImmutableResult,
  type TranscriptEntry,
  type TranscriptKey,
  type TranscriptMirror,
  type TranscriptRevision,
  transcriptGenerationDirectory,
  transcriptSizeProblem,
} from "@agent-platform/runtime-core";

/** Give up rather than spin if a slot keeps being taken from under us. */
const SLOT_ATTEMPTS = 64;

/**
 * When a capture merges a transcript's parts (94S-314): once one transcript
 * pins more than `LANE_COMPACT_AT` of them, or the session more than
 * `SESSION_COMPACT_AT` across all of its transcripts. Parts are merged into
 * runs of at most `MERGED_PART_BYTES`, so what a capture pins is bounded by
 * the transcript's size rather than by how many appends made it — and that
 * size is bounded in turn (`MAX_TRANSCRIPT_BYTES`).
 */
const LANE_COMPACT_AT = 512;
const SESSION_COMPACT_AT = 4096;
const MERGED_PART_BYTES = 4 * 1024 * 1024;

/**
 * A capture refused because the transcript is past the limits a checkpoint
 * carries (`MAX_TRANSCRIPT_BYTES`), before anything was merged or written.
 */
export class TranscriptTooLarge extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "TranscriptTooLarge";
  }
}

/**
 * What a resumed launch adopts: the transcripts of the checkpoint it resumes,
 * exactly as that manifest pinned them.
 */
export type TranscriptInheritance = {
  /** The engine session being resumed — the manifest's `resume`. */
  readonly sessionId: string;
  readonly transcripts: CheckpointTranscripts;
};

export type ClaudeSessionStoreOptions = {
  readonly objects: CheckpointObjectStore;
  /** Key namespace; one session's transcripts never share it with another. */
  readonly prefix: string;
  /** The execution generation this launch runs as; it writes nowhere else. */
  readonly generation: number;
  /** Absent for a session that has never been checkpointed. */
  readonly inherit?: TranscriptInheritance;
};

/**
 * Mirrors the engine's root and subagent transcripts to the object store, and
 * pins them as exact revisions.
 *
 * Three properties carry the design (see spikes/94s-92 and 94S-203):
 *
 * - Parts are write-once under unique keys, so an append that times out and is
 *   retried stores both copies. Reads deduplicate by entry `uuid`: an entry
 *   seen twice with an identical body is restored once, and the same `uuid`
 *   carrying a different body is corruption and is refused rather than
 *   silently resolved.
 * - `captureRevision` freezes the part list and each part's digest. Whatever
 *   the mirror appends afterwards is invisible to `loadRevision`, which is what
 *   makes "the mirror is current" and "this checkpoint is resumable" different
 *   statements.
 * - Each execution generation writes under its own prefix, and a resumed one
 *   adopts its predecessors only as far as the checkpoint it resumes pinned
 *   them. A worker that lost its lease can go on appending for as long as it
 *   keeps running; those parts land in its own generation, past the pinned
 *   revision, where no later generation ever looks. The pinned part list,
 *   whose keys name the generation that wrote each part, is the whole handoff
 *   chain: generation 3's capture lists the parts it adopted from 1 and 2
 *   ahead of its own, so restoring it needs nothing the manifest does not
 *   already say.
 */
export class ClaudeSessionStore implements TranscriptMirror {
  /**
   * True only for a store that adopted a checkpoint: until its first append,
   * `load` answers with exactly what that checkpoint pinned, which is the one
   * moment the engine reads it.
   */
  readonly revisionScoped: boolean;
  readonly #objects: CheckpointObjectStore;
  /** `<prefix>/`, the session's mirror namespace. */
  readonly #namespace: string;
  /** `<prefix>/generation-<n>`: everything this store writes starts here. */
  readonly #prefix: string;
  readonly #inherit: Inheritance | undefined;
  /**
   * Per transcript (`""` for the root), what a capture pins ahead of this
   * generation's own parts once a merge replaced the adopted ones, and which
   * own parts it already covers.
   */
  readonly #merged = new Map<
    string,
    {
      readonly covers: ReadonlySet<string>;
      readonly refs: readonly ObjectRef[];
    }
  >();
  /** Settles once the generation is known to be this launch's alone. */
  readonly #opened: Promise<void>;
  readonly #sequence = new Map<string, number>();
  /** Adopted parts that matched their pinned length and digest. */
  readonly #adopted = new Map<string, Promise<Uint8Array>>();
  /**
   * Parts are write-once, so what a part holds never has to be fetched twice.
   * Without this, every capture re-downloads and re-parses the whole
   * transcript, and a session that checkpoints at each turn boundary pays for
   * its history again on every turn.
   */
  readonly #parts = new Map<string, Promise<Uint8Array>>();
  /**
   * The store's version of each part this store wrote, as `putImmutable`
   * answered it; a checkpoint names parts by version (94S-229). Absent on a
   * store without versions.
   */
  readonly #versions = new Map<string, string>();
  /**
   * One append at a time per transcript. Two appends racing for the same
   * slot would be ordered by whichever PUT landed first, which is not the
   * order they were called in — and replay order is conversation order.
   */
  readonly #writes = new Map<string, Promise<unknown>>();
  #appendFailures = 0;
  /** Transcripts whose latest append failed and no later one has landed. */
  readonly #unsettled = new Set<string>();
  #persistedAt: Date | null = null;

  constructor(options: ClaudeSessionStoreOptions) {
    const { generation } = options;
    if (!Number.isSafeInteger(generation) || generation < 0) {
      throw new Error(`Invalid execution generation: ${generation}`);
    }
    const trimmed = options.prefix.replace(/^\/+|\/+$/g, "");
    this.#objects = options.objects;
    this.#namespace = trimmed === "" ? "" : `${trimmed}/`;
    this.#prefix = `${this.#namespace}${transcriptGenerationDirectory(generation)}`;
    this.#inherit =
      options.inherit === undefined
        ? undefined
        : inheritance(options.inherit, this.#namespace, generation);
    this.revisionScoped = this.#inherit !== undefined;
    // Started now rather than on first use, so two stores a host opens
    // together for one generation both find it empty. Every operation awaits
    // it; the catch only keeps a store nobody used from reporting an
    // unhandled rejection.
    this.#opened = this.#assertFresh();
    this.#opened.catch(() => undefined);
  }

  /**
   * Appends this store itself rejected. The SDK retries and then emits
   * `system/mirror_error`, which is the authoritative signal; this counter is
   * for the case where the host never consumed the frames.
   */
  get appendFailures(): number {
    return this.#appendFailures;
  }

  /**
   * When an append last landed; null before the first. What the worker
   * reports as `persisted_at`.
   */
  get persistedAt(): Date | null {
    return this.#persistedAt;
  }

  /**
   * True while some transcript's latest append failed and nothing has landed
   * for it since. The SDK retries a failed batch and gives up only after its
   * own backoff, so between the failure and either outcome a capture would pin
   * a transcript that is missing a batch the engine still counts as written —
   * and the `mirror_error` that would say so has not been emitted yet.
   */
  get unsettled(): boolean {
    return this.#unsettled.size > 0;
  }

  /**
   * Settles once this launch is known to own its generation, and rejects when
   * another launch already wrote there. Awaited before the engine starts:
   * finding out on the first append is finding out after the engine ran.
   */
  ready(): Promise<void> {
    return this.#opened;
  }

  async append(key: TranscriptKey, entries: TranscriptEntry[]): Promise<void> {
    if (entries.length === 0) return;
    const prefix = this.#keyPrefix(key);
    const write = async () => {
      await this.#opened;
      try {
        await this.#write(prefix, entries);
      } catch (error) {
        this.#unsettled.add(prefix);
        throw error;
      }
      this.#unsettled.delete(prefix);
      this.#persistedAt = new Date();
    };
    const queued = (this.#writes.get(prefix) ?? Promise.resolve()).then(
      write,
      write,
    );
    this.#writes.set(
      prefix,
      queued.then(
        () => undefined,
        () => undefined,
      ),
    );
    await queued;
  }

  /**
   * Claims the next slot in the transcript and writes the batch into it.
   *
   * The slot number is not chosen, it is won: the create-only write *is* the
   * compare-and-set. Whoever's PUT lands first owns that index, and everyone
   * else re-reads the tail and tries the next one. That is what makes the
   * order deterministic across processes — two writers sharing a generation
   * replay in the order their writes committed, rather than in whatever order
   * a random key suffix happens to sort. A writer from another generation
   * never competes for these slots at all: it has its own prefix.
   */
  async #write(prefix: string, entries: TranscriptEntry[]): Promise<void> {
    const body = `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
    const bytes = new TextEncoder().encode(body);
    for (let attempt = 0; attempt < SLOT_ATTEMPTS; attempt += 1) {
      const key = `${prefix}part-${pad(await this.#nextIndex(prefix))}.jsonl`;
      let written: PutImmutableResult;
      try {
        written = await this.#objects.putImmutable(key, bytes);
      } catch (error) {
        this.#appendFailures += 1;
        throw error;
      }
      if (written.outcome !== "created") {
        // Taken — and "duplicate" counts as taken. A slot holding these exact
        // bytes is not proof that *this* call put them there: two workers
        // appending an identical uuid-less batch, say a `{"type":"title"}`
        // frame, produce identical bytes, and calling that success would drop
        // one of the two events with nothing downstream able to notice. A
        // batch that really is a retry of a landed write is instead stored
        // twice and deduplicated on read, which is the contract the mirror
        // already documents.
        this.#sequence.delete(prefix);
        continue;
      }
      this.#parts.set(key, Promise.resolve(bytes));
      if (written.version !== undefined)
        this.#versions.set(key, written.version);
      return;
    }
    this.#appendFailures += 1;
    throw new Error(`Transcript slot contention under ${prefix}`);
  }

  /**
   * The parts this store adopted for the key, then everything its own
   * generation holds. Never the latest suffix of an older generation: what a
   * predecessor recorded after the checkpoint being resumed — or after it
   * lost its lease — is not part of this session's conversation.
   */
  async load(key: TranscriptKey): Promise<TranscriptEntry[] | null> {
    await this.#opened;
    const adopted = this.#pinned(key);
    const own = await this.#listParts(key);
    if (adopted.length === 0 && own.length === 0) return null;
    const bodies = await Promise.all([
      ...adopted.map((part) => this.#adoptedBody(part)),
      ...own.map((part) => this.#cached(part)),
    ]);
    return deduplicate(bodies.flatMap(parseEntries));
  }

  /**
   * Fetches, checks and parses every part this store adopted, one at a time,
   * so a restore can refuse a checkpoint whose transcript is gone or was
   * edited while the workspace it would replace is still untouched. The
   * verified bytes stay cached for the engine's first `load`. Stops between
   * parts once `signal` aborts.
   */
  async verifyInherited(signal?: AbortSignal): Promise<void> {
    await this.#opened;
    for (const parts of this.#inherit?.parts.values() ?? []) {
      // Throws on a line that is not JSON and on one uuid with two bodies,
      // the two ways a pinned transcript fails only once the engine reads it.
      // Part by part, so only the bytes stay held, not every parsed entry.
      const check = deduplicator();
      for (const part of parts) {
        signal?.throwIfAborted();
        check(parseEntries(await this.#adoptedBody(part)));
      }
    }
  }

  async listSubkeys(key: {
    projectKey: string;
    sessionId: string;
  }): Promise<string[]> {
    await this.#opened;
    const prefix = this.#sessionPrefix(key, "subpaths");
    const subpaths = new Set<string>(this.#inherit?.subpaths);
    for (const objectKey of await this.#objects.list(prefix)) {
      const relative = objectKey.slice(prefix.length);
      const marker = Math.max(
        relative.lastIndexOf("/part-"),
        relative.lastIndexOf("/merged-"),
      );
      if (marker > 0) subpaths.add(relative.slice(0, marker));
    }
    return [...subpaths].sort();
  }

  /**
   * null when neither the checkpoint this store adopted nor the engine has
   * put anything under the key. Appends already queued for the key land
   * first; whether the engine has anything left to hand over is the caller's
   * to settle before asking.
   */
  async captureRevision(
    key: TranscriptKey,
  ): Promise<TranscriptRevision | null> {
    await this.#opened;
    await this.#writes.get(this.#keyPrefix(key));
    const { base, own } = this.#view(
      key.subpath ?? "",
      await this.#listParts(key),
    );
    if (base.length === 0 && own.length === 0) return null;
    return this.#revisionOf(base, own);
  }

  /**
   * Every transcript of one engine session — the root and each subagent —
   * pinned together, for a publisher that knows the session it checkpoints
   * but not the project key the engine filed it under. That key comes out of
   * the engine's own path handling, so it is read back from what the engine
   * wrote rather than recomputed and hoped to match. null when there is no
   * root transcript to pin.
   *
   * A transcript pinning too many parts is merged first (`#merge`), so a
   * long session keeps fitting in a manifest. Merged parts are written under
   * this generation like any other part, and a merge that fails leaves the
   * store pinning what it did before. A session past the transcript limits
   * is refused (`TranscriptTooLarge`) before any of that.
   */
  async captureTranscripts(
    sessionId: string,
  ): Promise<CheckpointTranscripts | null> {
    await this.#opened;
    this.#bind(sessionId);
    await Promise.all(this.#writes.values());
    const own = new Map<string, string[]>();
    const projectKeys = new Set<string>();
    for (const objectKey of await this.#objects.list(`${this.#prefix}/`)) {
      const location = locate(objectKey.slice(this.#namespace.length));
      if (location?.sessionId !== sessionId || location.merged) continue;
      projectKeys.add(location.projectKey);
      own.set(location.lane, [...(own.get(location.lane) ?? []), objectKey]);
    }
    if (projectKeys.size > 1) {
      throw new Error(
        `Engine session ${sessionId} is mirrored under more than one project key: ${[...projectKeys].sort().join(", ")}`,
      );
    }
    const pinned = this.#inherit?.parts ?? new Map<string, never>();
    const lanes = [...new Set([...pinned.keys(), ...own.keys()])].sort();
    if (!lanes.includes("")) return null;
    const views = new Map(
      lanes.map((lane) => [
        lane,
        this.#view(lane, (own.get(lane) ?? []).sort()),
      ]),
    );
    let total = 0;
    const sizes: Array<{ bytes: number; key: string }> = [];
    for (const view of views.values()) {
      total += view.base.length + view.own.length;
      sizes.push(...view.base);
      for (const key of view.own) {
        sizes.push({ bytes: (await this.#cached(key)).byteLength, key });
      }
    }
    const oversized = transcriptSizeProblem(sizes);
    if (oversized !== undefined) throw new TranscriptTooLarge(oversized);
    const revisions = new Map<string, TranscriptRevision>();
    for (const lane of lanes) {
      let { base, own: mine } = views.get(lane) as LaneView;
      const count = base.length + mine.length;
      if (
        count > LANE_COMPACT_AT ||
        (total > SESSION_COMPACT_AT && count > 1)
      ) {
        const projectKey =
          [...projectKeys][0] ?? this.#projectKeyOf(base[0]?.key);
        base = await this.#merge(
          lane,
          this.#keyPrefix({
            projectKey,
            sessionId,
            ...(lane === "" ? {} : { subpath: lane }),
          }),
          base,
          mine,
        );
        mine = [];
      }
      revisions.set(lane, await this.#revisionOf(base, mine));
    }
    const { "": root, ...subagents } = Object.fromEntries(revisions);
    if (root === undefined) return null;
    return { root, subagents };
  }

  /**
   * What a capture of one transcript pins: the refs it carries forward — the
   * adopted ones, or what the last merge replaced them with — then this
   * generation's parts that those do not already cover.
   */
  #view(lane: string, own: readonly string[]): LaneView {
    const merged = this.#merged.get(lane);
    if (merged === undefined) {
      return { base: this.#inherit?.parts.get(lane) ?? [], own };
    }
    return {
      base: merged.refs,
      own: own.filter((key) => !merged.covers.has(key)),
    };
  }

  /**
   * Rewrites a transcript's pinned parts as few merged parts, in order: each
   * run of consecutive parts that fits in `MERGED_PART_BYTES` becomes one
   * part holding their bytes back to back, so reading it replays exactly
   * what reading them did — duplicates, uuid-less entries and all. A run of
   * one is kept as it is, which also keeps a merged part that is already
   * full from being rewritten.
   *
   * Merged parts go under this generation, as every write of this store
   * does, at a key named by their digest: create-only, and a retry after a
   * failure writes the same bytes to the same key rather than a second copy.
   * The store switches to them only once every one landed.
   */
  async #merge(
    lane: string,
    directory: string,
    base: readonly ObjectRef[],
    own: readonly string[],
  ): Promise<ObjectRef[]> {
    const bodies = await Promise.all([
      ...base.map((part) => this.#adoptedBody(part)),
      ...own.map((part) => this.#cached(part)),
    ]);
    const refOf = async (index: number): Promise<ObjectRef> => {
      const adopted = base[index];
      if (adopted !== undefined) return adopted;
      const key = own[index - base.length] as string;
      const body = bodies[index] as Uint8Array;
      const version = await this.#versionOf(key);
      // Carried forward as an adopted ref now, so its bytes answer from here.
      this.#adopted.set(key, Promise.resolve(body));
      return {
        bytes: body.byteLength,
        key,
        sha256: sha256(body),
        ...(version === undefined ? {} : { version }),
      };
    };
    const runs: number[][] = [];
    let run: number[] = [];
    let size = 0;
    bodies.forEach((body, index) => {
      if (run.length > 0 && size + body.byteLength > MERGED_PART_BYTES) {
        runs.push(run);
        run = [];
        size = 0;
      }
      run.push(index);
      size += body.byteLength;
    });
    if (run.length > 0) runs.push(run);
    const refs: ObjectRef[] = [];
    for (const indices of runs) {
      refs.push(
        indices.length === 1
          ? await refOf(indices[0] as number)
          : await this.#writeMerged(
              directory,
              indices.map((index) => bodies[index] as Uint8Array),
            ),
      );
    }
    const previous = this.#merged.get(lane);
    const covers = new Set([...(previous?.covers ?? []), ...own]);
    this.#merged.set(lane, { covers, refs });
    // A merged part this store wrote and has now rewritten is pinned by
    // nothing it will capture again; a capture still reading it fetches it.
    const current = new Set(refs.map((ref) => ref.key));
    for (const { key } of previous?.refs ?? []) {
      if (!current.has(key) && key.startsWith(`${this.#prefix}/`)) {
        this.#adopted.delete(key);
      }
    }
    return refs;
  }

  async #writeMerged(
    directory: string,
    bodies: readonly Uint8Array[],
  ): Promise<ObjectRef> {
    const bytes = Buffer.concat(
      bodies.flatMap((body) =>
        body.byteLength === 0 || body[body.byteLength - 1] === NEWLINE
          ? [body]
          : [body, LINE_BREAK],
      ),
    );
    const digest = sha256(bytes);
    const key = `${directory}merged-${digest}.jsonl`;
    const written = await this.#objects.putImmutable(key, bytes);
    if (written.outcome === "conflict") {
      throw new Error(`Merged transcript part ${key} holds other bytes`);
    }
    const version = written.version ?? (await this.#objects.head(key))?.version;
    this.#adopted.set(key, Promise.resolve(bytes));
    return {
      bytes: bytes.byteLength,
      key,
      sha256: digest,
      ...(version === undefined ? {} : { version }),
    };
  }

  #projectKeyOf(key: string | undefined): string {
    const location =
      key === undefined ? undefined : locate(key.slice(this.#namespace.length));
    if (location === undefined) {
      throw new Error("No project key to merge an adopted transcript under");
    }
    return location.projectKey;
  }

  async #revisionOf(
    adopted: readonly ObjectRef[],
    own: readonly string[],
  ): Promise<TranscriptRevision> {
    const [adoptedBodies, ownBodies, ownVersions] = await Promise.all([
      Promise.all(adopted.map((part) => this.#adoptedBody(part))),
      Promise.all(own.map((part) => this.#cached(part))),
      Promise.all(own.map((part) => this.#versionOf(part))),
    ]);
    // Adopted parts keep the refs the checkpoint pinned rather than ones
    // recomputed here: they are the claim a restore will check the bytes
    // against, and #adoptedBody has already held the bytes to it.
    const refs: ObjectRef[] = [
      ...adopted,
      ...own.map((part, index) => {
        const body = ownBodies[index] ?? new Uint8Array();
        const version = ownVersions[index];
        return {
          bytes: body.byteLength,
          key: part,
          sha256: sha256(body),
          ...(version === undefined ? {} : { version }),
        };
      }),
    ];
    return {
      entryCount: deduplicate(
        [...adoptedBodies, ...ownBodies].flatMap(parseEntries),
      ).length,
      parts: refs,
      sha256: digestParts(refs),
    };
  }

  /**
   * The version a part of this generation was written as. A PUT whose answer
   * was lost stored the part all the same, and a checkpoint that names it
   * without a version is one a locked store refuses, every time after. The
   * key is create-only, so the one version it holds is the one written.
   */
  async #versionOf(key: string): Promise<string | undefined> {
    const known = this.#versions.get(key);
    if (known !== undefined) return known;
    const version = (await this.#objects.head(key))?.version;
    if (version !== undefined) this.#versions.set(key, version);
    return version;
  }

  /** Restores exactly the parts the revision names, or throws. */
  async loadRevision(revision: TranscriptRevision): Promise<TranscriptEntry[]> {
    await this.#opened;
    if (digestParts(revision.parts) !== revision.sha256) {
      throw new Error("Transcript revision digest mismatch");
    }
    const bodies = await Promise.all(
      revision.parts.map(async (part) => {
        const body = await this.#read(part.key, part.version);
        if (sha256(body) !== part.sha256) {
          throw new Error(`Transcript revision integrity failure: ${part.key}`);
        }
        return body;
      }),
    );
    // `entryCount` is deliberately not a gate. Every part's digest and the
    // part-list digest above already pin the exact bytes that were captured,
    // and deduplication is a pure function of those bytes under a build the
    // compatibility check has already matched — so the count asserts nothing
    // the digests do not. Failing on it would only turn a miscounting worker
    // into a session that can never be resumed.
    return deduplicate(bodies.flatMap(parseEntries));
  }

  /**
   * The slot this process will try next. Remembered so a quiet session does
   * not list the prefix on every append, and dropped whenever a write loses
   * the slot, because then the stored tail is the only thing that knows.
   */
  async #nextIndex(prefix: string): Promise<number> {
    const remembered = this.#sequence.get(prefix);
    if (remembered !== undefined) {
      this.#sequence.set(prefix, remembered + 1);
      return remembered;
    }
    let last = 0;
    for (const key of await this.#objects.list(prefix)) {
      if (key.slice(prefix.length).includes("/")) continue;
      const index = partIndex(key);
      if (index !== undefined) last = Math.max(last, index + 1);
    }
    this.#sequence.set(prefix, last + 1);
    return last;
  }

  /**
   * Parts appended directly under the key, excluding any nested subpath and
   * the merged parts a capture wrote.
   */
  async #listParts(key: TranscriptKey): Promise<string[]> {
    const prefix = this.#keyPrefix(key);
    return (await this.#objects.list(prefix))
      .filter(
        (objectKey) =>
          !objectKey.slice(prefix.length).includes("/") &&
          partIndex(objectKey) !== undefined,
      )
      .sort();
  }

  async #read(key: string, version?: string): Promise<Uint8Array> {
    const bytes = await this.#objects.get(key, version);
    if (bytes === undefined) throw new Error(`Missing transcript part: ${key}`);
    return bytes;
  }

  /**
   * Used wherever the question is "what did the mirror record", never in
   * `loadRevision`: restoring a checkpoint has to confront the bytes the store
   * actually holds now, not a copy this process happens to remember.
   */
  #cached(key: string): Promise<Uint8Array> {
    const hit = this.#parts.get(key);
    if (hit !== undefined) return hit;
    const pending = this.#read(key).catch((error: unknown) => {
      this.#parts.delete(key);
      throw error;
    });
    this.#parts.set(key, pending);
    return pending;
  }

  /**
   * An adopted part, held to the length and digest its checkpoint pinned
   * before anything reads it. Cached once it passes: the key is write-once,
   * and a capture that re-verified it every turn would re-download the whole
   * inherited history every turn.
   */
  #adoptedBody(part: ObjectRef): Promise<Uint8Array> {
    const hit = this.#adopted.get(part.key);
    if (hit !== undefined) return hit;
    const pending = this.#read(part.key, part.version)
      .then((body) => {
        if (body.byteLength !== part.bytes || sha256(body) !== part.sha256) {
          throw new Error(`Inherited transcript part changed: ${part.key}`);
        }
        return body;
      })
      .catch((error: unknown) => {
        this.#adopted.delete(part.key);
        throw error;
      });
    this.#adopted.set(part.key, pending);
    return pending;
  }

  #pinned(key: TranscriptKey): readonly ObjectRef[] {
    this.#bind(key.sessionId);
    return this.#inherit?.parts.get(key.subpath ?? "") ?? [];
  }

  /**
   * A generation belongs to one launch, so its prefix is empty when that
   * launch opens its store. Parts already there mean two launches were handed
   * the same generation, and a resume would replay the other one's
   * uncommitted suffix as if the checkpoint held it. This detects the misuse;
   * it does not fence it — two launches that open at the same moment both see
   * an empty prefix. Keeping generations unique is the scheduler's (94S-202).
   */
  async #assertFresh(): Promise<void> {
    const held = await this.#objects.list(`${this.#prefix}/`);
    if (held.length > 0) {
      throw new Error(
        `Execution generation already holds transcript parts: ${this.#prefix}/`,
      );
    }
  }

  #keyPrefix(key: TranscriptKey): string {
    return key.subpath === undefined
      ? this.#sessionPrefix(key, "main")
      : this.#sessionPrefix(key, "subpaths", ...safeSubpath(key.subpath));
  }

  /**
   * A store that adopted a checkpoint is bound to the engine session that
   * checkpoint resumes. The engine keeps its session id across a resume, so a
   * key for any other session means the host resumed something else on top of
   * this checkpoint — and answering `null` there would send the engine looking
   * for that session on the container's own disk.
   */
  #bind(sessionId: string): void {
    if (this.#inherit !== undefined && sessionId !== this.#inherit.sessionId) {
      throw new Error(
        `Transcript store adopted engine session ${this.#inherit.sessionId}, not ${sessionId}`,
      );
    }
  }

  #sessionPrefix(
    key: { projectKey: string; sessionId: string },
    ...rest: string[]
  ): string {
    this.#bind(key.sessionId);
    const segments = [key.projectKey, key.sessionId, ...rest];
    return `${[this.#prefix, ...segments.map(safeSegment)].join("/")}/`;
  }
}

type LaneView = {
  readonly base: readonly ObjectRef[];
  readonly own: readonly string[];
};

const NEWLINE = 0x0a;
const LINE_BREAK = new Uint8Array([NEWLINE]);

type Inheritance = {
  readonly sessionId: string;
  /** Pinned parts by subpath; the root transcript is `""`. */
  readonly parts: ReadonlyMap<string, readonly ObjectRef[]>;
  readonly subpaths: readonly string[];
};

/**
 * Checks and copies what a checkpoint hands over, once, before the store
 * trusts any of it. Copied because the caller's manifest object is not ours to
 * rely on staying the same; checked here because a part list that fails its
 * own digest, or that reaches outside this session's mirror, is not a
 * checkpoint worth resuming.
 *
 * Each adopted part must be a part of the transcript it is pinned as — the
 * engine session being resumed, and the root or that exact subagent — and
 * come from an earlier generation. A part from this one or a later one means
 * the checkpoint was captured by a launch that is not this one's predecessor,
 * and the generation that wrote it can still be appending under it.
 */
function inheritance(
  inherit: TranscriptInheritance,
  namespace: string,
  generation: number,
): Inheritance {
  safeSegment(inherit.sessionId);
  const parts = new Map<string, readonly ObjectRef[]>();
  const pinned: Array<[string, TranscriptRevision]> = [
    ["", inherit.transcripts.root],
    ...Object.entries(inherit.transcripts.subagents),
  ];
  for (const [subpath, revision] of pinned) {
    const label = subpath === "" ? "root" : subpath;
    if (subpath !== "") safeSubpath(subpath);
    const refs = revision.parts.map(({ bytes, key, sha256, version }) => ({
      bytes,
      key,
      sha256,
      ...(version === undefined ? {} : { version }),
    }));
    if (digestParts(refs) !== revision.sha256) {
      throw new Error(
        `Inherited transcript ${label} part list does not match its digest`,
      );
    }
    for (const { key } of refs) {
      if (!key.startsWith(namespace) || key.split("/").includes("..")) {
        throw new Error(
          `Inherited transcript part outside ${namespace}: ${key}`,
        );
      }
      const location = locate(key.slice(namespace.length));
      if (
        location?.sessionId !== inherit.sessionId ||
        location.lane !== subpath
      ) {
        throw new Error(
          `Inherited transcript part ${key} is not a part of ${inherit.sessionId}'s ${label} transcript`,
        );
      }
      if (location.generation >= generation) {
        throw new Error(
          `Inherited transcript part ${key} is not from a generation before ${generation}`,
        );
      }
    }
    parts.set(subpath, refs);
  }
  return {
    parts,
    sessionId: inherit.sessionId,
    subpaths: Object.keys(inherit.transcripts.subagents),
  };
}

type PartLocation = {
  readonly generation: number;
  /** A part a capture merged others into, rather than one an append wrote. */
  readonly merged: boolean;
  /** The subagent subpath, or `""` for the root transcript. */
  readonly lane: string;
  readonly projectKey: string;
  readonly sessionId: string;
};

/**
 * Reads a part key back into the transcript it belongs to. The path is
 * relative to the mirror namespace:
 * `generation-<n>/<projectKey>/<sessionId>/main/part-<i>.jsonl`, or
 * `.../subpaths/<subpath>/part-<i>.jsonl` for a subagent; a merged part is
 * `merged-<sha256>.jsonl` in the same place.
 */
function locate(relative: string): PartLocation | undefined {
  const match = relative.match(
    /^generation-(\d{10})\/([^/]+)\/([^/]+)\/(?:main|subpaths\/(.+))\/(?:part-\d{10}|(merged)-[0-9a-f]{64})\.jsonl$/,
  );
  if (
    match?.[1] === undefined ||
    match[2] === undefined ||
    match[3] === undefined
  ) {
    return undefined;
  }
  return {
    generation: Number(match[1]),
    lane: match[4] ?? "",
    merged: match[5] !== undefined,
    projectKey: match[2],
    sessionId: match[3],
  };
}

function pad(value: number): string {
  return String(value).padStart(10, "0");
}

function deduplicate(entries: readonly TranscriptEntry[]): TranscriptEntry[] {
  return deduplicator()(entries);
}

/**
 * Deduplication across calls, for a transcript fed in part by part. Each
 * uuid is remembered by the digest of its body rather than the body itself,
 * in canonical form: key order is not meaningful in JSON.
 */
function deduplicator(): (
  entries: readonly TranscriptEntry[],
) => TranscriptEntry[] {
  const seen = new Map<string, string>();
  return (entries) =>
    entries.filter((entry) => {
      if (typeof entry.uuid !== "string") return true;
      const encoded = createHash("sha256")
        .update(canonicalJsonOfJson(entry))
        .digest("hex");
      const previous = seen.get(entry.uuid);
      if (previous !== undefined) {
        if (previous !== encoded) {
          throw new Error(`Conflicting transcript entry uuid: ${entry.uuid}`);
        }
        return false;
      }
      seen.set(entry.uuid, encoded);
      return true;
    });
}

function parseEntries(bytes: Uint8Array): TranscriptEntry[] {
  return new TextDecoder()
    .decode(bytes)
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as TranscriptEntry);
}

function partIndex(key: string): number | undefined {
  const match = key.match(/\/part-(\d{10})\.jsonl$/);
  return match?.[1] === undefined ? undefined : Number(match[1]);
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function safeSegment(value: string): string {
  if (!value || value === "." || value === ".." || value.includes("/")) {
    throw new Error(`Unsafe transcript key segment: ${value}`);
  }
  return value;
}

function safeSubpath(value: string): string[] {
  const segments = value.split("/");
  if (
    segments.some((segment) => !segment || segment === "." || segment === "..")
  ) {
    throw new Error(`Unsafe transcript subpath: ${value}`);
  }
  return segments;
}
