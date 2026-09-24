import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  PutObjectCommand,
  S3Client,
  type S3ClientConfig,
} from "@aws-sdk/client-s3";
import {
  defaultGitRunner,
  type GitCommandResult,
  type GitCommandRunner,
} from "./git-runner.ts";
import {
  concatBytes,
  FreshAddressHttpHandler,
  getObjectBytes,
  S3_MAX_ATTEMPTS,
  S3_REQUEST_BOUNDS,
  type S3ClientLike,
  type S3RequestBounds,
  sha256,
} from "./s3.ts";

export * from "./checkpoint-objects.ts";
export * from "./git-runner.ts";
export * from "./git-workspace-bundle-verifier.ts";
export * from "./object-route.ts";
export {
  BodyLimitError,
  type BodyReadBounds,
  BodyStallError,
  BodyTruncatedError,
  DEFAULT_BODY_READ_BOUNDS,
  FreshAddressHttpHandler,
  MAX_BUDGETED_READ_BYTES,
  MIN_TRANSFER_BYTES_PER_SECOND,
  readBudgetMs,
  S3_MAX_ATTEMPTS,
  S3_REQUEST_BOUNDS,
  type S3ClientLike,
  type S3RequestBounds,
  transferBudgetMs,
} from "./s3.ts";
export * from "./scoped-objects.ts";

export const DEFAULT_TRANSCRIPT_CHUNK_BYTES = 5 * 1024 * 1024;
const META_VERSION = 1;

export interface StorageEnvironment {
  readonly AWS_ACCESS_KEY_ID?: string;
  readonly AWS_ENDPOINT_URL?: string;
  readonly AWS_REGION?: string;
  readonly AWS_SECRET_ACCESS_KEY?: string;
  readonly GIT_AUTHOR_EMAIL?: string;
  readonly GIT_AUTHOR_NAME?: string;
  readonly GIT_TOKEN?: string;
  readonly GIT_USERNAME?: string;
  readonly S3_BUCKET?: string;
  readonly TRANSCRIPT_CHUNK_BYTES?: string;
}

export interface StorageConfig {
  readonly bucket: string;
  readonly chunkBytes: number;
  readonly git: {
    readonly authorEmail: string;
    readonly authorName: string;
    readonly token: string;
    readonly username: string;
  };
  readonly s3: {
    readonly accessKeyId: string;
    readonly endpoint?: string;
    readonly region: string;
    readonly secretAccessKey: string;
  };
}

export interface SessionStorageDependencies {
  readonly gitRunner?: GitCommandRunner;
  readonly now?: () => Date;
  readonly s3Client: S3ClientLike;
  readonly sleep?: (milliseconds: number) => Promise<void>;
}

export interface HydrateSessionInput {
  readonly baseBranch: string;
  readonly claudeHome: string;
  readonly cwd: string;
  readonly repositoryUrl: string;
  readonly sessionId: string;
  readonly workspacePath: string;
}

export interface HydrateSessionResult {
  readonly claudeSessionId?: string;
  readonly mode: "new" | "resumed";
  readonly transcriptPath?: string;
}

export interface CheckpointSessionInput {
  readonly claudeHome: string;
  readonly claudeSessionId: string;
  readonly cwd: string;
  readonly sessionId: string;
  readonly workspacePath: string;
}

export interface CheckpointSessionResult {
  readonly gitCommit: string;
  readonly transcriptBytes: number;
  readonly transcriptObjects: readonly string[];
  readonly transcriptSha256: string;
}

export interface SessionStorage {
  checkpoint(input: CheckpointSessionInput): Promise<CheckpointSessionResult>;
  hydrate(input: HydrateSessionInput): Promise<HydrateSessionResult>;
}

interface TranscriptObject {
  readonly bytes: number;
  readonly key: string;
  readonly sha256: string;
}

interface TranscriptMeta {
  readonly version: typeof META_VERSION;
  readonly claude_session_id: string;
  readonly cwd: string;
  readonly uploaded_at: string;
  readonly transcript: {
    readonly bytes: number;
    readonly mode: "single" | "chunked";
    readonly objects: readonly TranscriptObject[];
    readonly sha256: string;
  };
}

function requireEnvironment(
  environment: StorageEnvironment,
  key: keyof StorageEnvironment,
): string {
  const value = environment[key];
  if (value === undefined || value.trim() === "") {
    throw new Error(`Missing required storage environment variable: ${key}`);
  }
  return value;
}

export function storageConfigFromEnv(
  environment: StorageEnvironment = process.env as StorageEnvironment,
): StorageConfig {
  const rawChunkBytes = environment.TRANSCRIPT_CHUNK_BYTES;
  const chunkBytes =
    rawChunkBytes === undefined
      ? DEFAULT_TRANSCRIPT_CHUNK_BYTES
      : Number(rawChunkBytes);
  if (!Number.isSafeInteger(chunkBytes) || chunkBytes <= 0) {
    throw new Error("TRANSCRIPT_CHUNK_BYTES must be a positive integer");
  }

  const endpoint = environment.AWS_ENDPOINT_URL?.trim();
  return {
    bucket: requireEnvironment(environment, "S3_BUCKET"),
    chunkBytes,
    git: {
      authorEmail: requireEnvironment(environment, "GIT_AUTHOR_EMAIL"),
      authorName: requireEnvironment(environment, "GIT_AUTHOR_NAME"),
      token: requireEnvironment(environment, "GIT_TOKEN"),
      username: requireEnvironment(environment, "GIT_USERNAME"),
    },
    s3: {
      accessKeyId: requireEnvironment(environment, "AWS_ACCESS_KEY_ID"),
      ...(endpoint === undefined || endpoint === "" ? {} : { endpoint }),
      region: requireEnvironment(environment, "AWS_REGION"),
      secretAccessKey: requireEnvironment(environment, "AWS_SECRET_ACCESS_KEY"),
    },
  };
}

/**
 * The one place this package builds an S3 client, so the bounds it runs under
 * are the ones in {@link S3_REQUEST_BOUNDS}. `bounds` exists for tests that
 * cannot wait out the shipped values. Only the `s3` settings are read, so a
 * caller with no git configuration can build one too.
 */
export function createStorageS3Client(
  config: Pick<StorageConfig, "s3">,
  bounds: S3RequestBounds = S3_REQUEST_BOUNDS,
): S3Client {
  const s3Config: S3ClientConfig = {
    credentials: {
      accessKeyId: config.s3.accessKeyId,
      secretAccessKey: config.s3.secretAccessKey,
    },
    maxAttempts: S3_MAX_ATTEMPTS,
    region: config.s3.region,
    requestHandler: new FreshAddressHttpHandler(bounds),
    ...(config.s3.endpoint === undefined
      ? {}
      : { endpoint: config.s3.endpoint, forcePathStyle: true }),
  };
  return new S3Client(s3Config);
}

export function createSessionStorageFromEnv(
  environment: StorageEnvironment = process.env as StorageEnvironment,
): SessionStorage {
  const config = storageConfigFromEnv(environment);
  return createSessionStorage(config, {
    s3Client: createStorageS3Client(config),
  });
}

export function encodeClaudeProjectDirectory(cwd: string): string {
  if (!cwd.startsWith("/")) {
    throw new Error(`Claude cwd must be absolute: ${cwd}`);
  }
  return cwd.replaceAll(/[^a-zA-Z0-9]/g, "-");
}

export function claudeTranscriptPath(
  claudeHome: string,
  cwd: string,
  claudeSessionId: string,
): string {
  assertSafeIdentifier(claudeSessionId, "Claude session ID");
  return join(
    claudeHome,
    "projects",
    encodeClaudeProjectDirectory(cwd),
    `${claudeSessionId}.jsonl`,
  );
}

export function createSessionStorage(
  config: StorageConfig,
  dependencies: SessionStorageDependencies,
): SessionStorage {
  const checkpointQueues = new Map<string, Promise<void>>();
  const gitRunner = dependencies.gitRunner ?? defaultGitRunner;
  const now = dependencies.now ?? (() => new Date());
  const sleep = dependencies.sleep ?? delay;
  const gitEnvironment = {
    GIT_AUTHOR_EMAIL: config.git.authorEmail,
    GIT_AUTHOR_NAME: config.git.authorName,
    GIT_COMMITTER_EMAIL: config.git.authorEmail,
    GIT_COMMITTER_NAME: config.git.authorName,
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "credential.helper",
    GIT_CONFIG_VALUE_0:
      '!f() { printf \'username=%s\\npassword=%s\\n\' "$GIT_USERNAME" "$GIT_TOKEN"; }; f',
    GIT_TERMINAL_PROMPT: "0",
    GIT_TOKEN: config.git.token,
    GIT_USERNAME: config.git.username,
  };

  async function git(
    args: readonly string[],
    cwd?: string,
    acceptedExitCodes: readonly number[] = [0],
  ): Promise<GitCommandResult> {
    const result = await gitRunner(args, {
      ...(cwd === undefined ? {} : { cwd }),
      env: gitEnvironment,
    });
    if (!acceptedExitCodes.includes(result.exitCode)) {
      const rendered = ["git", ...args].join(" ");
      throw new Error(
        `${rendered} failed with exit code ${result.exitCode}: ${result.stderr.trim()}`,
      );
    }
    return result;
  }

  async function pushCheckpoint(
    sessionId: string,
    workspacePath: string,
  ): Promise<string> {
    const branch = sessionBranch(sessionId);
    const currentBranch = (
      await git(["branch", "--show-current"], workspacePath)
    ).stdout.trim();
    if (currentBranch !== branch) {
      throw new Error(
        `Refusing to checkpoint ${currentBranch || "detached HEAD"}; expected ${branch}`,
      );
    }

    await git(["add", "--all"], workspacePath);
    const diff = await git(
      ["diff", "--cached", "--quiet"],
      workspacePath,
      [0, 1],
    );
    if (diff.exitCode === 1) {
      await git(
        ["commit", "-m", `Checkpoint session ${sessionId}`],
        workspacePath,
      );
    }

    await retry(
      () =>
        git(
          ["push", "--set-upstream", "origin", `HEAD:refs/heads/${branch}`],
          workspacePath,
        ),
      sleep,
    );
    return (await git(["rev-parse", "HEAD"], workspacePath)).stdout.trim();
  }

  async function putObject(key: string, body: Uint8Array): Promise<void> {
    await dependencies.s3Client.send(
      new PutObjectCommand({ Bucket: config.bucket, Key: key, Body: body }),
    );
  }

  async function getObject(key: string): Promise<Uint8Array | undefined> {
    return getObjectBytes(dependencies.s3Client, config.bucket, key);
  }

  async function uploadTranscript(
    input: CheckpointSessionInput,
  ): Promise<{ bytes: number; objects: readonly string[]; sha256: string }> {
    const path = claudeTranscriptPath(
      input.claudeHome,
      input.cwd,
      input.claudeSessionId,
    );
    const bytes = new Uint8Array(await readFile(path));
    const prefix = sessionPrefix(input.sessionId);
    const previousMetaBytes = await getObject(`${prefix}/meta.json`);
    const previousMeta =
      previousMetaBytes === undefined
        ? undefined
        : parseTranscriptMeta(previousMetaBytes);
    const chunks = splitBytes(bytes, config.chunkBytes);
    const objectEntries: TranscriptObject[] = [];

    if (bytes.byteLength <= config.chunkBytes) {
      const key = `${prefix}/transcript.jsonl`;
      const object = {
        bytes: bytes.byteLength,
        key,
        sha256: sha256(bytes),
      };
      if (!hasIdenticalObject(previousMeta, object))
        await putObject(key, bytes);
      objectEntries.push(object);
    } else {
      for (const [index, chunk] of chunks.entries()) {
        const key = `${prefix}/transcript/${String(index).padStart(6, "0")}.jsonl`;
        const object = {
          bytes: chunk.byteLength,
          key,
          sha256: sha256(chunk),
        };
        if (!hasIdenticalObject(previousMeta, object))
          await putObject(key, chunk);
        objectEntries.push(object);
      }
    }

    const transcriptSha256 = sha256(bytes);
    const meta: TranscriptMeta = {
      version: META_VERSION,
      claude_session_id: input.claudeSessionId,
      cwd: input.cwd,
      uploaded_at: now().toISOString(),
      transcript: {
        bytes: bytes.byteLength,
        mode: bytes.byteLength <= config.chunkBytes ? "single" : "chunked",
        objects: objectEntries,
        sha256: transcriptSha256,
      },
    };
    await putObject(
      `${prefix}/meta.json`,
      new TextEncoder().encode(`${JSON.stringify(meta)}\n`),
    );
    return {
      bytes: bytes.byteLength,
      objects: objectEntries.map(({ key }) => key),
      sha256: transcriptSha256,
    };
  }

  async function downloadTranscript(
    input: HydrateSessionInput,
  ): Promise<HydrateSessionResult> {
    const prefix = sessionPrefix(input.sessionId);
    const metaBytes = await getObject(`${prefix}/meta.json`);
    if (metaBytes === undefined) return { mode: "new" };

    const meta = parseTranscriptMeta(metaBytes);
    if (meta.cwd !== input.cwd) {
      throw new Error(
        `Transcript cwd mismatch: stored ${meta.cwd}, requested ${input.cwd}`,
      );
    }
    const parts: Uint8Array[] = [];
    for (const object of meta.transcript.objects) {
      const part = await getObject(object.key);
      if (part === undefined)
        throw new Error(`Missing transcript object: ${object.key}`);
      if (part.byteLength !== object.bytes || sha256(part) !== object.sha256) {
        throw new Error(
          `Transcript object integrity check failed: ${object.key}`,
        );
      }
      parts.push(part);
    }
    const transcript = concatBytes(parts);
    if (
      transcript.byteLength !== meta.transcript.bytes ||
      sha256(transcript) !== meta.transcript.sha256
    ) {
      throw new Error(
        `Transcript integrity check failed for session ${input.sessionId}`,
      );
    }
    const path = claudeTranscriptPath(
      input.claudeHome,
      input.cwd,
      meta.claude_session_id,
    );
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, transcript);
    return {
      claudeSessionId: meta.claude_session_id,
      mode: "resumed",
      transcriptPath: path,
    };
  }

  return {
    async checkpoint(input) {
      assertSafeIdentifier(input.sessionId, "Session ID");
      return serializeByKey(checkpointQueues, input.sessionId, async () => {
        const gitCommit = await pushCheckpoint(
          input.sessionId,
          input.workspacePath,
        );
        const transcript = await uploadTranscript(input);
        return {
          gitCommit,
          transcriptBytes: transcript.bytes,
          transcriptObjects: transcript.objects,
          transcriptSha256: transcript.sha256,
        };
      });
    },

    async hydrate(input) {
      assertSafeIdentifier(input.sessionId, "Session ID");
      const branch = sessionBranch(input.sessionId);
      const branchLookup = await git(
        [
          "ls-remote",
          "--exit-code",
          "--heads",
          input.repositoryUrl,
          `refs/heads/${branch}`,
        ],
        undefined,
        [0, 2],
      );
      if (branchLookup.exitCode === 0) {
        await git([
          "clone",
          "--branch",
          branch,
          "--single-branch",
          input.repositoryUrl,
          input.workspacePath,
        ]);
      } else {
        await git([
          "clone",
          "--branch",
          input.baseBranch,
          "--single-branch",
          input.repositoryUrl,
          input.workspacePath,
        ]);
        await git(["switch", "--create", branch], input.workspacePath);
        await retry(
          () =>
            git(
              ["push", "--set-upstream", "origin", `HEAD:refs/heads/${branch}`],
              input.workspacePath,
            ),
          sleep,
        );
      }

      return downloadTranscript(input);
    },
  };
}

function serializeByKey<T>(
  queues: Map<string, Promise<void>>,
  key: string,
  operation: () => Promise<T>,
): Promise<T> {
  const previous = queues.get(key) ?? Promise.resolve();
  const current = previous.then(operation);
  const tail = current.then(
    () => undefined,
    () => undefined,
  );
  queues.set(key, tail);
  void tail.then(() => {
    if (queues.get(key) === tail) queues.delete(key);
  });
  return current;
}

function sessionPrefix(sessionId: string): string {
  assertSafeIdentifier(sessionId, "Session ID");
  return `sessions/${sessionId}`;
}

function sessionBranch(sessionId: string): string {
  return `session/${sessionId}`;
}

function assertSafeIdentifier(value: string, label: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(value)) {
    throw new Error(`${label} contains unsupported characters: ${value}`);
  }
}

async function retry<T>(
  operation: () => Promise<T>,
  sleep: (milliseconds: number) => Promise<void>,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt < 2) await sleep(50 * 2 ** attempt);
    }
  }
  throw lastError;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function splitBytes(bytes: Uint8Array, chunkBytes: number): Uint8Array[] {
  if (bytes.byteLength === 0) return [bytes];
  const chunks: Uint8Array[] = [];
  for (let offset = 0; offset < bytes.byteLength; offset += chunkBytes) {
    chunks.push(
      bytes.slice(offset, Math.min(offset + chunkBytes, bytes.byteLength)),
    );
  }
  return chunks;
}

function parseTranscriptMeta(bytes: Uint8Array): TranscriptMeta {
  const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("Invalid transcript metadata");
  }
  const candidate = parsed as Partial<TranscriptMeta>;
  if (
    candidate.version !== META_VERSION ||
    typeof candidate.claude_session_id !== "string" ||
    typeof candidate.cwd !== "string" ||
    typeof candidate.uploaded_at !== "string" ||
    typeof candidate.transcript !== "object" ||
    candidate.transcript === null ||
    !Array.isArray(candidate.transcript.objects) ||
    typeof candidate.transcript.bytes !== "number" ||
    typeof candidate.transcript.sha256 !== "string" ||
    (candidate.transcript.mode !== "single" &&
      candidate.transcript.mode !== "chunked")
  ) {
    throw new Error("Invalid transcript metadata");
  }
  for (const object of candidate.transcript.objects) {
    if (
      typeof object !== "object" ||
      object === null ||
      typeof object.key !== "string" ||
      typeof object.bytes !== "number" ||
      typeof object.sha256 !== "string"
    ) {
      throw new Error("Invalid transcript metadata object");
    }
  }
  return candidate as TranscriptMeta;
}

function hasIdenticalObject(
  meta: TranscriptMeta | undefined,
  expected: TranscriptObject,
): boolean {
  return (
    meta?.transcript.objects.some(
      (object) =>
        object.key === expected.key &&
        object.bytes === expected.bytes &&
        object.sha256 === expected.sha256,
    ) ?? false
  );
}
