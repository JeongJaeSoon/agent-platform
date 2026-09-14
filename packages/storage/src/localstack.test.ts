import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CreateBucketCommand,
  DeleteBucketCommand,
  DeleteObjectsCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import {
  claudeTranscriptPath,
  createSessionStorage,
  type GitCommandRunner,
  type StorageConfig,
} from "./index.ts";

const localstackTest =
  process.env.STORAGE_LOCALSTACK_TEST === "1" ? test : test.skip;

localstackTest(
  "round-trips chunked transcript bytes through LocalStack",
  async () => {
    const endpoint = process.env.AWS_ENDPOINT_URL;
    const region = process.env.AWS_REGION;
    const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
    const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;
    if (!endpoint || !region || !accessKeyId || !secretAccessKey) {
      throw new Error("LocalStack integration environment is incomplete");
    }
    const bucket = `storage-it-${randomUUID()}`;
    const s3 = new S3Client({
      credentials: { accessKeyId, secretAccessKey },
      endpoint,
      forcePathStyle: true,
      region,
    });
    const directory = await mkdtemp(join(tmpdir(), "storage-localstack-"));
    const sessionId = "localstack-session";
    const claudeSessionId = "localstack-claude";
    const original = new TextEncoder().encode(
      `${Array.from({ length: 100 }, (_, index) =>
        JSON.stringify({ index, text: `line-${index}-한글` }),
      ).join("\n")}\n`,
    );
    const config: StorageConfig = {
      bucket,
      chunkBytes: 256,
      git: {
        authorEmail: "storage@example.test",
        authorName: "Storage Test",
        token: "unused-token",
        username: "unused-user",
      },
      s3: { accessKeyId, endpoint, region, secretAccessKey },
    };
    const branch = `session/${sessionId}`;
    const gitRunner: GitCommandRunner = async (args) => {
      if (args[0] === "branch") return gitResult(0, `${branch}\n`);
      if (args[0] === "ls-remote") return gitResult(0, "present\n");
      if (args[0] === "rev-parse") return gitResult(0, "localstack-commit\n");
      return gitResult(0);
    };
    const storage = createSessionStorage(config, { gitRunner, s3Client: s3 });
    let objectKeys: readonly string[] = [];

    await s3.send(
      new CreateBucketCommand({
        Bucket: bucket,
        CreateBucketConfiguration: {
          LocationConstraint: region as "ap-northeast-1",
        },
      }),
    );
    try {
      const sourceHome = join(directory, "source", ".claude");
      const sourcePath = claudeTranscriptPath(
        sourceHome,
        "/workspace",
        claudeSessionId,
      );
      await mkdir(join(sourceHome, "projects", "-workspace"), {
        recursive: true,
      });
      await writeFile(sourcePath, original);
      const checkpoint = await storage.checkpoint({
        claudeHome: sourceHome,
        claudeSessionId,
        cwd: "/workspace",
        sessionId,
        workspacePath: join(directory, "source-workspace"),
      });
      objectKeys = checkpoint.transcriptObjects;
      expect(objectKeys.length).toBeGreaterThan(1);

      const restored = await storage.hydrate({
        baseBranch: "main",
        claudeHome: join(directory, "restored", ".claude"),
        cwd: "/workspace",
        repositoryUrl: "unused",
        sessionId,
        workspacePath: join(directory, "restored-workspace"),
      });
      expect(restored.mode).toBe("resumed");
      expect(
        new Uint8Array(await readFile(restored.transcriptPath ?? "")),
      ).toEqual(original);
    } finally {
      const keys = [...objectKeys, `sessions/${sessionId}/meta.json`];
      if (keys.length > 0) {
        await s3.send(
          new DeleteObjectsCommand({
            Bucket: bucket,
            Delete: { Objects: keys.map((Key) => ({ Key })) },
          }),
        );
      }
      await s3.send(new DeleteBucketCommand({ Bucket: bucket }));
      s3.destroy();
      await rm(directory, { force: true, recursive: true });
    }
  },
  30_000,
);

function gitResult(exitCode: number, stdout = "", stderr = "") {
  return { exitCode, stderr, stdout };
}
