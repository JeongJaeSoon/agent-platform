import { createHash, randomUUID } from "node:crypto";
import type {
  CheckpointObjectStore,
  ObjectRef,
  TranscriptEntry,
  TranscriptKey,
  TranscriptMirror,
  TranscriptRevision,
} from "@agent-platform/runtime-core";

import { digestParts } from "./transcript-digest.ts";

export type ClaudeSessionStoreOptions = {
  readonly now?: () => number;
  readonly objects: CheckpointObjectStore;
  /** Key namespace; one session's transcripts never share it with another. */
  readonly prefix: string;
};

/**
 * Mirrors the engine's root and subagent transcripts to the object store, and
 * pins them as exact revisions.
 *
 * Two properties carry the design (see spikes/94s-92):
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
 */
export class ClaudeSessionStore implements TranscriptMirror {
  readonly #objects: CheckpointObjectStore;
  readonly #prefix: string;
  readonly #now: () => number;
  readonly #sequence = new Map<string, number>();
  /**
   * Parts are write-once, so what a part holds never has to be fetched twice.
   * Without this, every capture re-downloads and re-parses the whole
   * transcript, and a session that checkpoints at each turn boundary pays for
   * its history again on every turn.
   */
  readonly #parts = new Map<string, Promise<Uint8Array>>();
  /**
   * One append at a time per transcript, because the tick that orders parts is
   * chosen from what the previous append wrote. Two appends racing for the
   * first tick under a key would otherwise pick the same one and fall back to
   * their random suffixes for order, which is not the order they were called
   * in — and replay order is conversation order.
   */
  readonly #writes = new Map<string, Promise<unknown>>();
  #appendFailures = 0;

  constructor(options: ClaudeSessionStoreOptions) {
    this.#objects = options.objects;
    this.#prefix = options.prefix.replace(/^\/+|\/+$/g, "");
    this.#now = options.now ?? Date.now;
  }

  /**
   * Appends this store itself rejected. The SDK retries and then emits
   * `system/mirror_error`, which is the authoritative signal; this counter is
   * for the case where the host never consumed the frames.
   */
  get appendFailures(): number {
    return this.#appendFailures;
  }

  async append(key: TranscriptKey, entries: TranscriptEntry[]): Promise<void> {
    if (entries.length === 0) return;
    const prefix = this.#keyPrefix(key);
    const queued = (this.#writes.get(prefix) ?? Promise.resolve()).then(
      () => this.#write(prefix, entries),
      () => this.#write(prefix, entries),
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

  async #write(prefix: string, entries: TranscriptEntry[]): Promise<void> {
    const body = `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
    const name = `part-${String(await this.#nextTick(prefix)).padStart(13, "0")}-${randomUUID()}.jsonl`;
    const bytes = new TextEncoder().encode(body);
    // Create-only, because a part is the evidence a committed manifest points
    // at: once a checkpoint has pinned its digest, an overwrite is corruption
    // and the store is the only place that can refuse it outright.
    let outcome: string;
    try {
      ({ outcome } = await this.#objects.putImmutable(
        `${prefix}${name}`,
        bytes,
      ));
    } catch (error) {
      this.#appendFailures += 1;
      throw error;
    }
    if (outcome === "conflict") {
      this.#appendFailures += 1;
      throw new Error(`Transcript part already exists: ${prefix}${name}`);
    }
    this.#parts.set(`${prefix}${name}`, Promise.resolve(bytes));
  }

  /**
   * Everything the mirror currently holds for this key — which is deliberately
   * *not* what a resumed run should replay. A session resuming from checkpoint
   * N must be handed the parts that manifest pinned, via `loadRevision`;
   * whatever the mirror recorded between N and the crash is not part of the
   * checkpoint. Wiring that into a resumed SDK run is 94S-203's half.
   */
  async load(key: TranscriptKey): Promise<TranscriptEntry[] | null> {
    const parts = await this.#listParts(key);
    if (parts.length === 0) return null;
    const bodies = await Promise.all(parts.map((part) => this.#cached(part)));
    return deduplicate(bodies.flatMap(parseEntries));
  }

  async listSubkeys(key: {
    projectKey: string;
    sessionId: string;
  }): Promise<string[]> {
    const prefix = this.#joinPrefix(key.projectKey, key.sessionId, "subpaths");
    const subpaths = new Set<string>();
    for (const objectKey of await this.#objects.list(prefix)) {
      const relative = objectKey.slice(prefix.length);
      const marker = relative.lastIndexOf("/part-");
      if (marker > 0) subpaths.add(relative.slice(0, marker));
    }
    return [...subpaths].sort();
  }

  /** null when the engine has mirrored nothing for this key yet. */
  async captureRevision(
    key: TranscriptKey,
  ): Promise<TranscriptRevision | null> {
    const parts = await this.#listParts(key);
    if (parts.length === 0) return null;
    const bodies = await Promise.all(parts.map((part) => this.#cached(part)));
    const refs: ObjectRef[] = parts.map((part, index) => {
      const body = bodies[index] ?? new Uint8Array();
      return { bytes: body.byteLength, key: part, sha256: sha256(body) };
    });
    return {
      entryCount: deduplicate(bodies.flatMap(parseEntries)).length,
      parts: refs,
      sha256: digestParts(refs),
    };
  }

  /** Restores exactly the parts the revision names, or throws. */
  async loadRevision(revision: TranscriptRevision): Promise<TranscriptEntry[]> {
    if (digestParts(revision.parts) !== revision.sha256) {
      throw new Error("Transcript revision digest mismatch");
    }
    const bodies = await Promise.all(
      revision.parts.map(async (part) => {
        const body = await this.#read(part.key);
        if (sha256(body) !== part.sha256) {
          throw new Error(`Transcript revision integrity failure: ${part.key}`);
        }
        return body;
      }),
    );
    const entries = deduplicate(bodies.flatMap(parseEntries));
    if (entries.length !== revision.entryCount) {
      throw new Error("Transcript revision entry count mismatch");
    }
    return entries;
  }

  /**
   * The ordering tick for the next part under `prefix`.
   *
   * Parts are read back in lexicographic key order, so the tick has to keep
   * rising across processes too: a session resumed on a host whose clock lags
   * the previous one would otherwise write parts that sort *before* the
   * transcript it is continuing. The first append under a key therefore reads
   * the stored tail and starts above it, rather than trusting this process's
   * clock alone.
   */
  async #nextTick(prefix: string): Promise<number> {
    let last = this.#sequence.get(prefix);
    if (last === undefined) {
      last = 0;
      for (const key of await this.#objects.list(prefix)) {
        if (key.slice(prefix.length).includes("/")) continue;
        last = Math.max(last, partTick(key) ?? 0);
      }
    }
    const tick = Math.max(this.#now(), last + 1);
    this.#sequence.set(prefix, tick);
    return tick;
  }

  /** Parts written directly under the key, excluding any nested subpath. */
  async #listParts(key: TranscriptKey): Promise<string[]> {
    const prefix = this.#keyPrefix(key);
    return (await this.#objects.list(prefix))
      .filter((objectKey) => !objectKey.slice(prefix.length).includes("/"))
      .sort();
  }

  async #read(key: string): Promise<Uint8Array> {
    const bytes = await this.#objects.get(key);
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

  #keyPrefix(key: TranscriptKey): string {
    return key.subpath === undefined
      ? this.#joinPrefix(key.projectKey, key.sessionId, "main")
      : this.#joinPrefix(
          key.projectKey,
          key.sessionId,
          "subpaths",
          ...safeSubpath(key.subpath),
        );
  }

  #joinPrefix(...segments: string[]): string {
    return `${[this.#prefix, ...segments.map(safeSegment)].filter(Boolean).join("/")}/`;
  }
}

function deduplicate(entries: readonly TranscriptEntry[]): TranscriptEntry[] {
  const seen = new Map<string, string>();
  return entries.filter((entry) => {
    if (typeof entry.uuid !== "string") return true;
    const encoded = JSON.stringify(canonical(entry));
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

/** Key order is not meaningful in JSON, so compare entries independently of it. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, canonical(nested)]),
  );
}

function parseEntries(bytes: Uint8Array): TranscriptEntry[] {
  return new TextDecoder()
    .decode(bytes)
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as TranscriptEntry);
}

function partTick(key: string): number | undefined {
  const match = key.match(/\/part-(\d{13})-/);
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
