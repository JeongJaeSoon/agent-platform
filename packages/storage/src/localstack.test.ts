import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  localstackEnabled,
  withLocalstackBucket,
} from "@agent-platform/testkit/localstack";
import {
  claudeTranscriptPath,
  createSessionStorage,
  type GitCommandRunner,
  type StorageConfig,
} from "./index.ts";

const localstackTest = localstackEnabled() ? test : test.skip;

localstackTest(
  "round-trips chunked transcript bytes through LocalStack",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "storage-localstack-"));
    try {
      await withLocalstackBucket(
        async ({ bucket, env, s3 }) => {
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
            s3: {
              accessKeyId: env.accessKeyId,
              endpoint: env.endpoint,
              region: env.region,
              secretAccessKey: env.secretAccessKey,
            },
          };
          const branch = `session/${sessionId}`;
          const gitRunner: GitCommandRunner = async (args) => {
            if (args[0] === "branch") return gitResult(0, `${branch}\n`);
            if (args[0] === "ls-remote") return gitResult(0, "present\n");
            if (args[0] === "rev-parse")
              return gitResult(0, "localstack-commit\n");
            return gitResult(0);
          };
          const storage = createSessionStorage(config, {
            gitRunner,
            s3Client: s3,
          });

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
          expect(checkpoint.transcriptObjects.length).toBeGreaterThan(1);

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
        },
        { prefix: "storage-it" },
      );
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  },
  30_000,
);

function gitResult(exitCode: number, stdout = "", stderr = "") {
  return { exitCode, stderr, stdout };
}
