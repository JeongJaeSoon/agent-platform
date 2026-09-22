import { createHash, randomUUID } from "node:crypto";
import type {
  SessionKey,
  SessionStore,
  SessionStoreEntry,
} from "@anthropic-ai/claude-agent-sdk";
import {
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  type S3Client,
} from "@aws-sdk/client-s3";

export type RevisionPart = {
  readonly key: string;
  readonly sha256: string;
};

export type SessionRevision = {
  readonly entryCount: number;
  readonly parts: readonly RevisionPart[];
  readonly sha256: string;
};

export type BodyReadBounds = {
  /** Attempts at reading one part's body before the read is given up on. */
  readonly attempts: number;
  /** How long one attempt may spend consuming a body. */
  readonly timeoutMs: number;
};

/**
 * A GetObject settles when the response *headers* arrive; the body is a stream
 * read afterwards. Nothing in the AWS SDK bounds that read — neither
 * `requestTimeout` nor an `abortSignal` passed to `send` reaches a stream that
 * has already been handed over — so a peer that stops mid-body hangs the caller
 * for as long as the socket stays open. Against LocalStack that happens often
 * enough to be the single biggest source of flake in this spike.
 */
export const defaultBodyReadBounds: BodyReadBounds = {
  attempts: 3,
  timeoutMs: 5_000,
};

export type S3SessionStoreOptions = {
  /** Defaults to {@link defaultBodyReadBounds}; tests pin shorter bounds. */
  readonly bodyRead?: BodyReadBounds;
  readonly bucket: string;
  readonly client: Pick<S3Client, "send">;
  readonly prefix: string;
};

export class S3SessionStoreProbe implements SessionStore {
  readonly #bodyRead: BodyReadBounds;
  readonly #bucket: string;
  readonly #client: Pick<S3Client, "send">;
  readonly #prefix: string;
  #lastTimestamp = 0;

  constructor(options: S3SessionStoreOptions) {
    this.#bodyRead = options.bodyRead ?? defaultBodyReadBounds;
    this.#bucket = options.bucket;
    this.#client = options.client;
    this.#prefix = options.prefix.replace(/^\/+|\/+$/g, "");
  }

  async append(key: SessionKey, entries: SessionStoreEntry[]): Promise<void> {
    if (entries.length === 0) return;
    const body = `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
    const timestamp = Math.max(Date.now(), this.#lastTimestamp + 1);
    this.#lastTimestamp = timestamp;
    await this.#client.send(
      new PutObjectCommand({
        Body: body,
        Bucket: this.#bucket,
        ContentType: "application/x-ndjson",
        Key: `${this.#keyPrefix(key)}part-${String(timestamp).padStart(13, "0")}-${randomUUID()}.jsonl`,
      }),
    );
  }

  async load(key: SessionKey): Promise<SessionStoreEntry[] | null> {
    const parts = await this.#listDirectParts(key);
    if (parts.length === 0) return null;
    return deduplicateEntries(
      (await Promise.all(parts.map((part) => this.#readPart(part)))).flat(),
    );
  }

  async listSessions(
    projectKey: string,
  ): Promise<Array<{ sessionId: string; mtime: number }>> {
    const prefix = this.#joinPrefix(projectKey);
    const objects = await this.#listAll(prefix);
    const sessions = new Map<string, number>();
    for (const object of objects) {
      const relative = object.key.slice(prefix.length);
      const segments = relative.split("/");
      if (segments.length !== 3 || segments[1] !== "main") continue;
      const sessionId = segments[0];
      if (sessionId === undefined) continue;
      const timestamp = partTimestamp(segments[2]);
      if (timestamp === undefined) continue;
      sessions.set(
        sessionId,
        Math.max(sessions.get(sessionId) ?? 0, timestamp),
      );
    }
    return [...sessions].map(([sessionId, mtime]) => ({ sessionId, mtime }));
  }

  async listSubkeys(key: {
    projectKey: string;
    sessionId: string;
  }): Promise<string[]> {
    const prefix = this.#joinPrefix(key.projectKey, key.sessionId, "subpaths");
    const objects = await this.#listAll(prefix);
    const values = new Set<string>();
    for (const object of objects) {
      const relative = object.key.slice(prefix.length);
      const marker = relative.lastIndexOf("/part-");
      if (marker > 0) values.add(relative.slice(0, marker));
    }
    return [...values].sort();
  }

  async captureRevision(key: SessionKey): Promise<SessionRevision | null> {
    const parts = await this.#listDirectParts(key);
    if (parts.length === 0) return null;
    const bodies = await Promise.all(
      parts.map((part) => this.#readPartBytes(part)),
    );
    const entries = deduplicateEntries(bodies.flatMap(parseEntries));
    const revisionParts = parts.map((part, index) => ({
      key: part,
      sha256: sha256(bodies[index] ?? new Uint8Array()),
    }));
    return {
      entryCount: entries.length,
      parts: revisionParts,
      sha256: sha256(new TextEncoder().encode(JSON.stringify(revisionParts))),
    };
  }

  async loadRevision(revision: SessionRevision): Promise<SessionStoreEntry[]> {
    const revisionHash = sha256(
      new TextEncoder().encode(JSON.stringify(revision.parts)),
    );
    if (revisionHash !== revision.sha256) {
      throw new Error("SessionStore revision manifest digest mismatch");
    }
    const bodies = await Promise.all(
      revision.parts.map(async (part) => {
        const body = await this.#readPartBytes(part.key);
        if (sha256(body) !== part.sha256) {
          throw new Error(
            `SessionStore revision integrity failure: ${part.key}`,
          );
        }
        return body;
      }),
    );
    const entries = deduplicateEntries(bodies.flatMap(parseEntries));
    if (entries.length !== revision.entryCount) {
      throw new Error("SessionStore revision entry count mismatch");
    }
    return entries;
  }

  async #listDirectParts(key: SessionKey): Promise<string[]> {
    const prefix = this.#keyPrefix(key);
    return (await this.#listAll(prefix))
      .map(({ key: objectKey }) => objectKey)
      .filter((objectKey) => !objectKey.slice(prefix.length).includes("/"))
      .sort();
  }

  async #listAll(prefix: string): Promise<Array<{ key: string }>> {
    const objects: Array<{ key: string }> = [];
    let continuationToken: string | undefined;
    do {
      const result = await this.#client.send(
        new ListObjectsV2Command({
          Bucket: this.#bucket,
          ContinuationToken: continuationToken,
          Prefix: prefix,
        }),
      );
      const page = result as {
        Contents?: Array<{ Key?: string }>;
        NextContinuationToken?: string;
      };
      for (const object of page.Contents ?? []) {
        if (object.Key) objects.push({ key: object.Key });
      }
      continuationToken = page.NextContinuationToken;
    } while (continuationToken !== undefined);
    return objects;
  }

  async #readPart(key: string): Promise<SessionStoreEntry[]> {
    return parseEntries(await this.#readPartBytes(key));
  }

  async #readPartBytes(key: string): Promise<Uint8Array> {
    const { attempts, timeoutMs } = this.#bodyRead;
    let lastError: unknown;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const result = await this.#client.send(
        new GetObjectCommand({ Bucket: this.#bucket, Key: key }),
      );
      const body = (result as { Body?: SdkResponseBody }).Body;
      if (!body) throw new Error(`Missing SessionStore part: ${key}`);
      try {
        return await readBodyWithin(body, timeoutMs);
      } catch (error) {
        // A stalled body is a property of the connection, not of the object:
        // the retry gets a fresh one, because the stalled socket was destroyed.
        lastError = error;
      }
    }
    throw new Error(
      `SessionStore part body stalled ${attempts} times: ${key}`,
      { cause: lastError },
    );
  }

  #keyPrefix(key: SessionKey): string {
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
    const joined = [this.#prefix, ...segments.map(safeSegment)]
      .filter(Boolean)
      .join("/");
    return `${joined}/`;
  }
}

function deduplicateEntries(
  entries: readonly SessionStoreEntry[],
): SessionStoreEntry[] {
  const seen = new Map<string, string>();
  return entries.filter((entry) => {
    if (typeof entry.uuid !== "string") return true;
    const encoded = JSON.stringify(canonicalValue(entry));
    const previous = seen.get(entry.uuid);
    if (previous !== undefined) {
      if (previous !== encoded) {
        throw new Error(`Conflicting SessionStore UUID: ${entry.uuid}`);
      }
      return false;
    }
    seen.set(entry.uuid, encoded);
    return true;
  });
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, canonicalValue(nested)]),
  );
}

function parseEntries(bytes: Uint8Array): SessionStoreEntry[] {
  return new TextDecoder()
    .decode(bytes)
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as SessionStoreEntry);
}

function safeSegment(value: string): string {
  if (!value || value === "." || value === ".." || value.includes("/")) {
    throw new Error(`Unsafe SessionStore key segment: ${value}`);
  }
  return value;
}

function safeSubpath(value: string): string[] {
  const segments = value.split("/");
  if (
    segments.some((segment) => !segment || segment === "." || segment === "..")
  ) {
    throw new Error(`Unsafe SessionStore subpath: ${value}`);
  }
  return segments;
}

type SdkResponseBody = {
  destroy?: (error?: Error) => void;
  transformToByteArray(): Promise<Uint8Array>;
};

/**
 * Consumes `body`, giving up after `timeoutMs`. The stream is destroyed on the
 * way out so the socket is released instead of being left half-read.
 */
async function readBodyWithin(
  body: SdkResponseBody,
  timeoutMs: number,
): Promise<Uint8Array> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      body.transformToByteArray(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          const error = new Error(`SessionStore part body stalled ${timeoutMs}ms`);
          body.destroy?.(error);
          reject(error);
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function partTimestamp(name: string | undefined): number | undefined {
  const match = name?.match(/^part-(\d{13})-/);
  return match?.[1] === undefined ? undefined : Number(match[1]);
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
