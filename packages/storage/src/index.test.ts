import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  claudeTranscriptPath,
  createSessionStorage,
  encodeClaudeProjectDirectory,
  type GitCommandRunner,
  type S3ClientLike,
  type StorageConfig,
  storageConfigFromEnv,
} from "./index.ts";

const temporaryDirectories: string[] = [];

afterAll(async () => {
  for (const directory of temporaryDirectories) {
    await rm(directory, { force: true, recursive: true });
  }
});

class MemoryS3 implements S3ClientLike {
  readonly objects = new Map<string, Uint8Array>();
  failNextPut = false;
  puts = 0;

  async send(command: unknown): Promise<unknown> {
    const value = command as {
      constructor: { name: string };
      input: { Body?: unknown; Key?: string };
    };
    const key = value.input.Key;
    if (key === undefined) throw new Error("Command is missing Key");
    if (value.constructor.name === "PutObjectCommand") {
      this.puts += 1;
      if (this.failNextPut) {
        this.failNextPut = false;
        throw new Error("injected S3 failure");
      }
      this.objects.set(key, await bytes(value.input.Body));
      return {};
    }
    if (value.constructor.name === "GetObjectCommand") {
      const body = this.objects.get(key);
      if (body === undefined) {
        throw Object.assign(new Error("missing"), { name: "NoSuchKey" });
      }
      return { Body: body };
    }
    throw new Error(`Unexpected command: ${value.constructor.name}`);
  }
}

const baseConfig: StorageConfig = {
  bucket: "test-bucket",
  chunkBytes: 1024,
  git: {
    authorEmail: "storage@example.test",
    authorName: "Storage Test",
    token: "unused-token",
    username: "unused-user",
  },
  s3: {
    accessKeyId: "unused-access-key",
    region: "ap-northeast-1",
    secretAccessKey: "unused-secret-key",
  },
};

describe("storage configuration", () => {
  test("rejects every missing credential instead of supplying code defaults", () => {
    expect(() => storageConfigFromEnv({})).toThrow(
      "Missing required storage environment variable: S3_BUCKET",
    );
    expect(() =>
      storageConfigFromEnv({
        AWS_ACCESS_KEY_ID: "key",
        AWS_REGION: "region",
        AWS_SECRET_ACCESS_KEY: "secret",
        GIT_AUTHOR_EMAIL: "test@example.test",
        GIT_AUTHOR_NAME: "Test",
        GIT_TOKEN: "",
        GIT_USERNAME: "user",
        S3_BUCKET: "bucket",
      }),
    ).toThrow("Missing required storage environment variable: GIT_TOKEN");
  });

  test("rejects an invalid chunk threshold", () => {
    expect(() =>
      storageConfigFromEnv({
        AWS_ACCESS_KEY_ID: "key",
        AWS_REGION: "region",
        AWS_SECRET_ACCESS_KEY: "secret",
        GIT_AUTHOR_EMAIL: "test@example.test",
        GIT_AUTHOR_NAME: "Test",
        GIT_TOKEN: "token",
        GIT_USERNAME: "user",
        S3_BUCKET: "bucket",
        TRANSCRIPT_CHUNK_BYTES: "0",
      }),
    ).toThrow("TRANSCRIPT_CHUNK_BYTES must be a positive integer");
  });
});

describe("Claude transcript path", () => {
  test("pins Claude Code cwd encoding", () => {
    expect(encodeClaudeProjectDirectory("/workspace")).toBe("-workspace");
    expect(encodeClaudeProjectDirectory("/Users/dev.soon/my_repo")).toBe(
      "-Users-dev-soon-my-repo",
    );
    expect(
      claudeTranscriptPath("/home/worker/.claude", "/workspace", "claude-01"),
    ).toBe("/home/worker/.claude/projects/-workspace/claude-01.jsonl");
  });
});

test("hydrates new and resumed branches and preserves transcript bytes", async () => {
  const root = await makeTempDirectory();
  const source = join(root, "source");
  const remote = join(root, "remote.git");
  await mkdir(source);
  await runGit(["init", "--initial-branch", "main"], source);
  await writeFile(join(source, "README.md"), "base\n");
  await runGit(["add", "README.md"], source);
  await runGit(
    [
      "-c",
      "user.name=Storage Test",
      "-c",
      "user.email=storage@example.test",
      "commit",
      "-m",
      "Initial",
    ],
    source,
  );
  await runGit(["clone", "--bare", source, remote], root);
  const baseCommit = (
    await runGit(["rev-parse", "refs/heads/main"], remote)
  ).trim();

  const s3 = new MemoryS3();
  const storage = createSessionStorage(baseConfig, { s3Client: s3 });
  const firstWorkspace = join(root, "first-workspace");
  const firstClaudeHome = join(root, "first-home", ".claude");
  const first = await storage.hydrate({
    baseBranch: "main",
    claudeHome: firstClaudeHome,
    cwd: "/workspace",
    repositoryUrl: remote,
    sessionId: "session-01",
    workspacePath: firstWorkspace,
  });
  expect(first).toEqual({ mode: "new" });

  await writeFile(join(firstWorkspace, "feature.txt"), "session change\n");
  const originalTranscript = new TextEncoder().encode(
    '{"type":"user","message":"안녕"}\n{"type":"assistant","message":"hello"}\n',
  );
  const firstTranscriptPath = claudeTranscriptPath(
    firstClaudeHome,
    "/workspace",
    "claude-01",
  );
  await mkdir(join(firstClaudeHome, "projects", "-workspace"), {
    recursive: true,
  });
  await writeFile(firstTranscriptPath, originalTranscript);
  const checkpoint = await storage.checkpoint({
    claudeHome: firstClaudeHome,
    claudeSessionId: "claude-01",
    cwd: "/workspace",
    sessionId: "session-01",
    workspacePath: firstWorkspace,
  });

  expect(checkpoint.transcriptObjects).toEqual([
    "sessions/session-01/transcript.jsonl",
  ]);
  expect(s3.objects.has("sessions/session-01/meta.json")).toBe(true);
  expect(s3.objects.get("sessions/session-01/transcript.jsonl")).toEqual(
    originalTranscript,
  );
  expect((await runGit(["rev-parse", "refs/heads/main"], remote)).trim()).toBe(
    baseCommit,
  );
  expect(
    (
      await runGit(["rev-parse", "refs/heads/session/session-01"], remote)
    ).trim(),
  ).toBe(checkpoint.gitCommit);
  expect(checkpoint.gitCommit).not.toBe(baseCommit);

  const secondWorkspace = join(root, "second-workspace");
  const secondClaudeHome = join(root, "second-home", ".claude");
  const resumed = await storage.hydrate({
    baseBranch: "main",
    claudeHome: secondClaudeHome,
    cwd: "/workspace",
    repositoryUrl: remote,
    sessionId: "session-01",
    workspacePath: secondWorkspace,
  });
  expect(resumed.mode).toBe("resumed");
  expect(resumed.claudeSessionId).toBe("claude-01");
  expect(await readFile(join(secondWorkspace, "feature.txt"), "utf8")).toBe(
    "session change\n",
  );
  expect(new Uint8Array(await readFile(resumed.transcriptPath ?? ""))).toEqual(
    originalTranscript,
  );
});

test("chunks a long transcript and reassembles it byte-for-byte", async () => {
  const root = await makeTempDirectory();
  const claudeHome = join(root, ".claude");
  const original = new TextEncoder().encode("가나다라\nabcdef\n0123456789\n");
  const transcriptPath = claudeTranscriptPath(
    claudeHome,
    "/workspace",
    "claude-02",
  );
  await mkdir(join(claudeHome, "projects", "-workspace"), { recursive: true });
  await writeFile(transcriptPath, original);
  const s3 = new MemoryS3();
  const runner = successfulGitRunner("session/session-02");
  const storage = createSessionStorage(
    { ...baseConfig, chunkBytes: 7 },
    { gitRunner: runner, s3Client: s3 },
  );

  const checkpoint = await storage.checkpoint({
    claudeHome,
    claudeSessionId: "claude-02",
    cwd: "/workspace",
    sessionId: "session-02",
    workspacePath: join(root, "workspace"),
  });
  expect(checkpoint.transcriptObjects.length).toBeGreaterThan(1);
  expect(checkpoint.transcriptObjects[0]).toBe(
    "sessions/session-02/transcript/000000.jsonl",
  );
  expect(checkpoint.transcriptObjects.at(-1)).toMatch(
    /^sessions\/session-02\/transcript\/\d{6}\.jsonl$/,
  );

  const restoredHome = join(root, "restored", ".claude");
  const restored = await storage.hydrate({
    baseBranch: "main",
    claudeHome: restoredHome,
    cwd: "/workspace",
    repositoryUrl: "unused",
    sessionId: "session-02",
    workspacePath: join(root, "restored-workspace"),
  });
  expect(restored.mode).toBe("resumed");
  expect(new Uint8Array(await readFile(restored.transcriptPath ?? ""))).toEqual(
    original,
  );
});

test("uploads only changed chunks after an append", async () => {
  const root = await makeTempDirectory();
  const claudeHome = join(root, ".claude");
  const transcriptPath = claudeTranscriptPath(
    claudeHome,
    "/workspace",
    "claude-append",
  );
  await mkdir(join(claudeHome, "projects", "-workspace"), { recursive: true });
  await writeFile(transcriptPath, "12345678");
  const s3 = new MemoryS3();
  const storage = createSessionStorage(
    { ...baseConfig, chunkBytes: 4 },
    {
      gitRunner: successfulGitRunner("session/session-append"),
      s3Client: s3,
    },
  );
  const input = {
    claudeHome,
    claudeSessionId: "claude-append",
    cwd: "/workspace",
    sessionId: "session-append",
    workspacePath: join(root, "workspace"),
  } as const;

  await storage.checkpoint(input);
  expect(s3.puts).toBe(3);
  await writeFile(transcriptPath, "12345678ab");
  await storage.checkpoint(input);
  expect(s3.puts).toBe(5);
});

test("retries git push and does not upload a transcript while push is failing", async () => {
  const root = await makeTempDirectory();
  const claudeHome = join(root, ".claude");
  await writeTranscript(
    claudeHome,
    "claude-03",
    new TextEncoder().encode("{}\n"),
  );
  const s3 = new MemoryS3();
  let pushAttempts = 0;
  const gitRunner: GitCommandRunner = async (args) => {
    if (args[0] === "branch") {
      return result(0, "session/session-03\n");
    }
    if (args[0] === "push") {
      pushAttempts += 1;
      return result(pushAttempts < 3 ? 1 : 0, "", "remote unavailable");
    }
    if (args[0] === "rev-parse") return result(0, "commit-03\n");
    return result(0);
  };
  const storage = createSessionStorage(baseConfig, {
    gitRunner,
    s3Client: s3,
    sleep: async () => undefined,
  });

  await storage.checkpoint({
    claudeHome,
    claudeSessionId: "claude-03",
    cwd: "/workspace",
    sessionId: "session-03",
    workspacePath: join(root, "workspace"),
  });
  expect(pushAttempts).toBe(3);
  expect(s3.objects.has("sessions/session-03/transcript.jsonl")).toBe(true);

  pushAttempts = 0;
  const untouchedS3 = new MemoryS3();
  const alwaysFailingStorage = createSessionStorage(baseConfig, {
    gitRunner: async (args) => {
      if (args[0] === "branch") return result(0, "session/session-03\n");
      if (args[0] === "push") {
        pushAttempts += 1;
        return result(1, "", "remote unavailable");
      }
      return result(0);
    },
    s3Client: untouchedS3,
    sleep: async () => undefined,
  });
  await expect(
    alwaysFailingStorage.checkpoint({
      claudeHome,
      claudeSessionId: "claude-03",
      cwd: "/workspace",
      sessionId: "session-03",
      workspacePath: join(root, "workspace"),
    }),
  ).rejects.toThrow("git push");
  expect(pushAttempts).toBe(3);
  expect(untouchedS3.puts).toBe(0);
});

test("retries both halves on the next checkpoint after an S3 partial failure", async () => {
  const root = await makeTempDirectory();
  const claudeHome = join(root, ".claude");
  await writeTranscript(
    claudeHome,
    "claude-04",
    new TextEncoder().encode("{}\n"),
  );
  const s3 = new MemoryS3();
  s3.failNextPut = true;
  let pushes = 0;
  const baseRunner = successfulGitRunner("session/session-04");
  const storage = createSessionStorage(baseConfig, {
    gitRunner: async (args, options) => {
      if (args[0] === "push") pushes += 1;
      return baseRunner(args, options);
    },
    s3Client: s3,
    sleep: async () => undefined,
  });
  const input = {
    claudeHome,
    claudeSessionId: "claude-04",
    cwd: "/workspace",
    sessionId: "session-04",
    workspacePath: join(root, "workspace"),
  } as const;

  await expect(storage.checkpoint(input)).rejects.toThrow(
    "injected S3 failure",
  );
  await storage.checkpoint(input);
  expect(pushes).toBe(2);
  expect(s3.objects.has("sessions/session-04/transcript.jsonl")).toBe(true);
  expect(s3.objects.has("sessions/session-04/meta.json")).toBe(true);
});

test("serializes overlapping checkpoints for one session and keeps the newest metadata", async () => {
  const root = await makeTempDirectory();
  const claudeHome = join(root, ".claude");
  const oldTranscript = new TextEncoder().encode('{"version":"old"}\n');
  const newTranscript = new TextEncoder().encode('{"version":"new"}\n');
  await writeTranscript(claudeHome, "claude-old", oldTranscript);
  await writeTranscript(claudeHome, "claude-new", newTranscript);
  const s3 = new BlockingFirstMetaS3();
  let pushes = 0;
  const baseRunner = successfulGitRunner("session/session-overlap");
  const storage = createSessionStorage(baseConfig, {
    gitRunner: async (args, options) => {
      if (args[0] === "push") pushes += 1;
      return baseRunner(args, options);
    },
    s3Client: s3,
  });
  const common = {
    claudeHome,
    cwd: "/workspace",
    sessionId: "session-overlap",
    workspacePath: join(root, "workspace"),
  } as const;

  const first = storage.checkpoint({
    ...common,
    claudeSessionId: "claude-old",
  });
  await s3.firstMetaStarted;
  const second = storage.checkpoint({
    ...common,
    claudeSessionId: "claude-new",
  });
  await Promise.resolve();
  await Promise.resolve();
  expect(pushes).toBe(1);

  s3.releaseFirstMeta();
  await Promise.all([first, second]);
  expect(pushes).toBe(2);

  const restored = await storage.hydrate({
    baseBranch: "main",
    claudeHome: join(root, "restored", ".claude"),
    cwd: "/workspace",
    repositoryUrl: "unused",
    sessionId: "session-overlap",
    workspacePath: join(root, "restored-workspace"),
  });
  expect(restored.claudeSessionId).toBe("claude-new");
  expect(new Uint8Array(await readFile(restored.transcriptPath ?? ""))).toEqual(
    newTranscript,
  );
});

class BlockingFirstMetaS3 extends MemoryS3 {
  readonly firstMetaStarted: Promise<void>;
  private firstMetaSeen = false;
  private readonly notifyFirstMetaStarted: () => void;
  private readonly unblockFirstMeta: Promise<void>;
  readonly releaseFirstMeta: () => void;

  constructor() {
    super();
    let notifyFirstMetaStarted: () => void = () => undefined;
    let releaseFirstMeta: () => void = () => undefined;
    this.firstMetaStarted = new Promise<void>((resolve) => {
      notifyFirstMetaStarted = resolve;
    });
    this.unblockFirstMeta = new Promise<void>((resolve) => {
      releaseFirstMeta = resolve;
    });
    this.notifyFirstMetaStarted = notifyFirstMetaStarted;
    this.releaseFirstMeta = releaseFirstMeta;
  }

  override async send(command: unknown): Promise<unknown> {
    const value = command as {
      constructor: { name: string };
      input: { Key?: string };
    };
    if (
      !this.firstMetaSeen &&
      value.constructor.name === "PutObjectCommand" &&
      value.input.Key === "sessions/session-overlap/meta.json"
    ) {
      this.firstMetaSeen = true;
      this.notifyFirstMetaStarted();
      await this.unblockFirstMeta;
    }
    return super.send(command);
  }
}

function successfulGitRunner(branch: string): GitCommandRunner {
  return async (args) => {
    if (args[0] === "branch") return result(0, `${branch}\n`);
    if (args[0] === "ls-remote")
      return result(0, "commit refs/heads/session\n");
    if (args[0] === "rev-parse") return result(0, "test-commit\n");
    return result(0);
  };
}

function result(exitCode: number, stdout = "", stderr = "") {
  return { exitCode, stderr, stdout };
}

async function makeTempDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "storage-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function writeTranscript(
  claudeHome: string,
  claudeSessionId: string,
  value: Uint8Array,
): Promise<void> {
  const directory = join(claudeHome, "projects", "-workspace");
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, `${claudeSessionId}.jsonl`), value);
}

async function runGit(args: readonly string[], cwd: string): Promise<string> {
  const processHandle = Bun.spawn(["git", ...args], {
    cwd,
    stderr: "pipe",
    stdout: "pipe",
  });
  const [exitCode, stderr, stdout] = await Promise.all([
    processHandle.exited,
    new Response(processHandle.stderr).text(),
    new Response(processHandle.stdout).text(),
  ]);
  if (exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${stderr}`);
  }
  return stdout;
}

async function bytes(value: unknown): Promise<Uint8Array> {
  if (value instanceof Uint8Array) return new Uint8Array(value);
  if (typeof value === "string") return new TextEncoder().encode(value);
  throw new Error("Unexpected body type");
}
