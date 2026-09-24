import { createHash } from "node:crypto";
import {
  type CheckpointObjectStore,
  type ImmutableObjectSource,
  isImmutableObjectSource,
  type ObjectHead,
  type PutImmutableResult,
} from "@agent-platform/runtime-core";

export type MemoryCheckpointObjectStore = CheckpointObjectStore & {
  /** Keys written, in insertion order. */
  keys(): string[];
  /** Fails the next `n` writes of any kind, to exercise mirror failures. */
  failWrites(count: number): void;
  /**
   * Drops an object, standing in for a lifecycle rule or an operator delete.
   * On a versioned store this is a delete marker, as on S3: the key reads as
   * absent while every version stays readable by id.
   */
  remove(key: string): void;
  /**
   * Destroys one version outright — what a privileged delete does to an
   * object nothing locks. Throws for a held version, as S3 answers 403.
   */
  purgeVersion(key: string, version: string): void;
  /**
   * Lifts the legal hold on one version, as garbage collection does to a
   * superseded checkpoint before it deletes it.
   */
  releaseHold(key: string, version: string): void;
  /**
   * Every version under the prefix, as S3 lists them, and the release and
   * delete garbage collection performs on one: the store doubles as a
   * `CheckpointObjectCollector`. Delete markers are not modelled.
   */
  listVersions(
    prefix: string,
  ): Promise<{ deleteMarker: boolean; key: string; version: string }[]>;
  purge(entry: { key: string; version: string }): Promise<void>;
  /** Keys whose bodies were fetched since the last reset, in call order. */
  reads(): string[];
  /**
   * Every `putImmutable` given a streamed body, with the size of each chunk
   * it arrived in: how a test tells a streamed upload from a held one.
   */
  streamedWrites(): { chunks: number[]; key: string }[];
  resetReads(): void;
};

export type MemoryCheckpointObjectStoreOptions = {
  /**
   * Keep every write as its own version and answer with version ids, like an
   * S3 bucket with versioning on. Off by default: the store then has no
   * version concept at all, which is the other shape the contract allows.
   * Only a versioned store offers `hold`.
   */
  readonly versioned?: boolean;
  /**
   * Largest chunk `stream` hands out; defaults to 64 KiB. Every chunk is a
   * view of one buffer refilled for the next, which the store contract
   * allows, so a consumer that keeps a chunk instead of copying it reads
   * garbage in a test before it does in production.
   */
  readonly streamChunkBytes?: number;
};

type Version = { bytes: Uint8Array; held: boolean; id: string };
type Slot = { current: Version | undefined; versions: Version[] };

/**
 * In-memory checkpoint object store with the create-only semantics the S3
 * adapter implements, so unit tests can exercise the immutability contract
 * without LocalStack.
 */
export function createMemoryCheckpointObjectStore(
  options: MemoryCheckpointObjectStoreOptions = {},
): MemoryCheckpointObjectStore {
  const versioned = options.versioned === true;
  const chunkBytes = options.streamChunkBytes ?? 64 * 1024;
  const objects = new Map<string, Slot>();
  const reads: string[] = [];
  const streamed: { chunks: number[]; key: string }[] = [];
  let failuresLeft = 0;
  let nextVersion = 0;

  function guardWrite(key: string): void {
    if (failuresLeft <= 0) return;
    failuresLeft -= 1;
    throw new Error(`Injected object store failure: ${key}`);
  }

  function write(key: string, bytes: Uint8Array): Version {
    nextVersion += 1;
    const written = {
      bytes: bytes.slice(),
      held: false,
      id: `v${nextVersion}`,
    };
    const slot = objects.get(key) ?? { current: undefined, versions: [] };
    slot.current = written;
    slot.versions = versioned ? [...slot.versions, written] : [written];
    objects.set(key, slot);
    return written;
  }

  function lookup(key: string, version?: string): Version | undefined {
    const slot = objects.get(key);
    if (slot === undefined) return undefined;
    if (version === undefined) return slot.current;
    // An unversioned store has no version by that name, just as S3 answers
    // 404 for an id it never issued.
    if (!versioned) return undefined;
    return slot.versions.find((candidate) => candidate.id === version);
  }

  function purgeVersion(key: string, version: string): void {
    const slot = objects.get(key);
    if (slot === undefined) return;
    if (lookup(key, version)?.held) {
      throw new Error(`Version ${version} of ${key} is under a legal hold`);
    }
    slot.versions = slot.versions.filter(
      (candidate) => candidate.id !== version,
    );
    if (slot.current?.id === version) slot.current = slot.versions.at(-1);
  }

  function releaseHold(key: string, version: string): void {
    const found = lookup(key, version);
    if (found !== undefined) found.held = false;
  }

  function answer(found: Version): { version?: string } {
    return versioned ? { version: found.id } : {};
  }

  return {
    async get(key, version) {
      reads.push(key);
      return lookup(key, version)?.bytes.slice();
    },

    async stream(key, version) {
      reads.push(key);
      const found = lookup(key, version);
      if (found === undefined) return undefined;
      // Taken now, as S3 pins the object that answered the GET: a write
      // landing mid-read does not change what this read delivers.
      const bytes = found.bytes;
      return (async function* () {
        const buffer = new Uint8Array(Math.min(chunkBytes, bytes.byteLength));
        for (let offset = 0; offset < bytes.byteLength; offset += chunkBytes) {
          const piece = bytes.subarray(offset, offset + chunkBytes);
          buffer.set(piece);
          yield buffer.subarray(0, piece.byteLength);
        }
      })();
    },

    async head(key, version): Promise<ObjectHead | undefined> {
      const found = lookup(key, version);
      return found === undefined
        ? undefined
        : {
            bytes: found.bytes.byteLength,
            ...(found.held ? { held: true } : {}),
            ...answer(found),
          };
    },

    async list(prefix) {
      return [...objects.entries()]
        .filter(([key, slot]) => slot.current && key.startsWith(prefix))
        .map(([key]) => key)
        .sort();
    },

    async put(key, bytes) {
      guardWrite(key);
      write(key, bytes);
    },

    async putImmutable(key, body): Promise<PutImmutableResult> {
      guardWrite(key);
      const bytes = isImmutableObjectSource(body)
        ? await drain(key, body, streamed)
        : body;
      const existing = objects.get(key)?.current;
      if (existing === undefined) {
        return { outcome: "created", ...answer(write(key, bytes)) };
      }
      const found = sha256(existing.bytes);
      return found === sha256(bytes)
        ? { outcome: "duplicate", ...answer(existing) }
        : { outcome: "conflict", sha256: found };
    },

    ...(versioned
      ? {
          async hold(key: string, version: string) {
            const found = lookup(key, version);
            if (found === undefined) {
              throw new Error(`No version ${version} of ${key} to hold`);
            }
            found.held = true;
          },
        }
      : {}),

    keys() {
      return [...objects.entries()]
        .filter(([, slot]) => slot.current)
        .map(([key]) => key);
    },

    failWrites(count) {
      failuresLeft = count;
    },

    remove(key) {
      const slot = objects.get(key);
      if (slot === undefined) return;
      if (versioned) slot.current = undefined;
      else objects.delete(key);
    },

    purgeVersion,
    releaseHold,

    async listVersions(prefix) {
      return [...objects.entries()]
        .filter(([key]) => key.startsWith(prefix))
        .flatMap(([key, slot]) =>
          slot.versions.map((found) => ({
            deleteMarker: false,
            key,
            version: found.id,
          })),
        );
    },

    async purge({ key, version }) {
      releaseHold(key, version);
      purgeVersion(key, version);
    },

    reads() {
      return [...reads];
    },

    streamedWrites() {
      return streamed.map((write) => ({ ...write, chunks: [...write.chunks] }));
    },

    resetReads() {
      reads.length = 0;
    },
  };
}

/**
 * A streamed body in one piece, copied chunk by chunk as a store must (the
 * source may refill its buffer), and held to the size and digest it
 * declared, as S3 holds it to `Content-Length` and the checksum header.
 */
async function drain(
  key: string,
  source: ImmutableObjectSource,
  streamed: { chunks: number[]; key: string }[],
): Promise<Uint8Array> {
  const chunks: number[] = [];
  const bytes = new Uint8Array(source.bytes);
  let filled = 0;
  for await (const chunk of source.open()) {
    chunks.push(chunk.byteLength);
    if (filled + chunk.byteLength > source.bytes) {
      throw new Error(
        `${key}: the body is longer than its ${source.bytes} bytes`,
      );
    }
    bytes.set(chunk, filled);
    filled += chunk.byteLength;
  }
  if (filled !== source.bytes) {
    throw new Error(
      `${key}: the body ended at ${filled} of its ${source.bytes} bytes`,
    );
  }
  if (sha256(bytes) !== source.sha256) {
    throw new Error(`${key}: the body does not match its declared sha256`);
  }
  streamed.push({ chunks, key });
  return bytes;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
