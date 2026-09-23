import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  CheckpointRequestResponse,
  RegisterPendingRequest,
  RegisterPendingResponse,
  RuntimeConfig,
  WorkspaceDescriptor,
} from "@agent-platform/contracts";
import {
  type CheckpointPointer,
  type CheckpointStore,
  createCheckpointService,
} from "@agent-platform/platform";
import { claudeCheckpointCodec } from "@agent-platform/runtime-claude";
import {
  createGitWorkspaceBundleVerifier,
  scopedCheckpointObjectStore,
} from "@agent-platform/storage";
import { createMemoryCheckpointObjectStore } from "@agent-platform/testkit/checkpoint-objects";
import {
  type FakeAnthropicServer,
  startFakeAnthropicServer,
  textReply,
  toolReply,
} from "@agent-platform/testkit/fake-anthropic";
import {
  createIsolatedWorkspace,
  type IsolatedWorkspace,
} from "@agent-platform/testkit/workspace";

import {
  claudeClaimFingerprint,
  claudeRuntimeRegistry,
} from "../apps/worker/src/composition.ts";
import type {
  WorkerConfig,
  WorkerTimeouts,
} from "../apps/worker/src/config.ts";
import { EngineProcesses } from "../apps/worker/src/engine-processes.ts";
import { FakeWorkerGateway } from "../apps/worker/src/fake-gateway.ts";
import { WorkerGatewayRequestError } from "../apps/worker/src/gateway-client.ts";
import { SessionCheckpoints } from "../apps/worker/src/session-checkpoints.ts";
import {
  WorkerHost,
  type WorkerLogger,
} from "../apps/worker/src/worker-host.ts";
import { GitWorkspace } from "../apps/worker/src/workspace.ts";

/**
 * One turn through the worker as composition will wire it once the restorer
 * lands: the real Agent SDK against a fake Anthropic endpoint, a real clone,
 * the publisher on a session-scoped store, and a gateway whose checkpoint
 * half is the control plane's own CheckpointService — so the manifest the
 * worker writes is the one finalize verifies and a restore plan is read from.
 */

const SESSION_ID = "44444444-4444-4444-8444-444444444444";
const MODEL = "claude-sonnet-4-5";
// Untracked files are read through /proc/self/fd, so off Linux a capture
// that holds one is refused; the tracked edit is captured everywhere.
const procfs = existsSync("/proc/self/fd");

const timeouts: WorkerTimeouts = {
  answerPollIntervalMs: 50,
  claimTimeoutMs: 5_000,
  drainTimeoutMs: 10_000,
  heartbeatIntervalMs: 60_000,
  idleTimeoutMs: 300,
  maxTurnMs: 60_000,
  nextInputRetryTimeoutMs: 60_000,
  nextInputWaitMs: 100,
  questionTimeoutMs: 10_000,
  requestTimeoutMs: 5_000,
  startupTimeoutMs: 60_000,
};

let isolated: IsolatedWorkspace | undefined;
let server: FakeAnthropicServer | undefined;

afterEach(async () => {
  server?.stop();
  await isolated?.dispose();
  isolated = undefined;
  server = undefined;
});

function git(args: string[], cwd: string): string {
  const result = Bun.spawnSync(
    ["git", "-c", "user.name=t", "-c", "user.email=t@example.test", ...args],
    { cwd, stderr: "pipe", stdout: "pipe" },
  );
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`);
  }
  return result.stdout.toString();
}

function memoryPointerStore(): CheckpointStore & {
  pointer(): CheckpointPointer | null;
} {
  let pointer: CheckpointPointer | null = null;
  return {
    async readPointer() {
      return pointer;
    },
    async commitAtomic(input) {
      const revision = input.checkpoint.revision;
      if (pointer !== null && revision <= pointer.revision) {
        return {
          outcome: "conflict" as const,
          currentRevision: pointer.revision,
        };
      }
      pointer = {
        committedAt: input.now,
        manifestRef: input.checkpoint.manifest_ref,
        manifestSha256: input.checkpoint.manifest_sha256,
        revision,
        turnId: input.turnId,
      };
      return { outcome: "committed" as const, revision };
    },
    pointer: () => pointer,
  };
}

/** Approves every tool the engine asks for, the way a user answering would. */
class ApprovingGateway extends FakeWorkerGateway {
  override async registerPending(
    request: RegisterPendingRequest,
  ): Promise<RegisterPendingResponse> {
    const registered = await super.registerPending(request);
    this.answer({
      request_id: request.request_id,
      kind: "permission",
      decision: "allow",
    });
    return registered;
  }
}

describe("the worker's checkpoint publisher against the control plane's service", () => {
  test("a turn that edits the checkout commits a checkpoint a restore plan can be read from", async () => {
    isolated = await createIsolatedWorkspace({ prefix: "94s-246-" });
    const { home, root, workspace } = isolated;
    await rm(workspace, { force: true, recursive: true });
    await mkdir(workspace);
    const origin = join(root, "origin.git");
    const seed = join(root, "seed");
    git(["init", "--quiet", "--bare", "--initial-branch=main", origin], root);
    git(["clone", "--quiet", origin, seed], root);
    await writeFile(join(seed, "README.md"), "original\n");
    git(["add", "-A"], seed);
    git(["commit", "--quiet", "-m", "seed"], seed);
    git(["push", "--quiet", "origin", "HEAD:main"], seed);
    const descriptor: WorkspaceDescriptor = {
      repository: { id: "sample", url: origin, branch: "main" },
    };

    const command = procfs
      ? "printf 'edited\\n' > README.md && printf 'fresh\\n' > notes.txt && chmod +x notes.txt"
      : "printf 'edited\\n' > README.md";
    server = startFakeAnthropicServer((_request, index) =>
      index === 0
        ? toolReply("Bash", { command }, "toolu_edit")
        : textReply("done"),
    );
    const runtimeConfig: RuntimeConfig = {
      model: MODEL,
      tools: ["Bash"],
      permission_mode: "default",
      provider: {
        kind: "anthropic",
        endpoint: server.url,
        auth: { kind: "api_key", value: "placeholder-local" },
      },
    };

    const bucket = createMemoryCheckpointObjectStore();
    const pointers = memoryPointerStore();
    const service = createCheckpointService({
      codecs: { claude: claudeCheckpointCodec },
      // The mirror does not record part versions yet; the restorer half of
      // 94S-246 carries them.
      objectProtection: "unversioned",
      objects: bucket,
      store: pointers,
      workspaceBundles: createGitWorkspaceBundleVerifier(),
    });
    const gateway = new ApprovingGateway({
      runtimeConfig,
      sessionId: SESSION_ID,
      workspace: descriptor,
      checkpoints: {
        async requestCheckpoint(request): Promise<CheckpointRequestResponse> {
          const decision = await service.requestCheckpoint({
            attemptId: request.attempt_id,
            preparation: request.preparation,
            sessionId: request.session_id,
          });
          return decision.status === "ready"
            ? {
                status: "ready",
                revision: decision.request.revision,
                manifest_ref: decision.request.manifestRef,
              }
            : decision;
        },
        async commit(request) {
          const result = await service.finalize({
            checkpoint: request.checkpoint,
            fence: {
              attemptId: request.attempt_id,
              authRevision: request.auth_revision,
              executionGeneration: request.execution_generation,
              leaseEpoch: request.lease_epoch,
              sessionId: request.session_id,
            },
            now: new Date(),
            sessionId: request.session_id,
            turnId: request.turn_id,
          });
          if (result.outcome === "rejected") {
            throw new WorkerGatewayRequestError(
              409,
              "CHECKPOINT_UNAVAILABLE",
              `Checkpoint manifest rejected: ${result.reason}`,
              false,
            );
          }
          if (result.outcome !== "committed") {
            throw new Error(`unexpected commit outcome ${result.outcome}`);
          }
        },
        async restorePlan() {
          return { status: "none" };
        },
      },
    });
    gateway.enqueue("edit the readme");

    const config = {
      runtime: { claudeConfigDir: home, cwd: workspace, home },
    } as WorkerConfig;
    const failures: unknown[] = [];
    const logger: WorkerLogger = {
      info: () => {},
      warn: (event, fields) => {
        if (event === "worker.checkpoint.failed") failures.push(fields);
      },
      error: (event, fields) => failures.push({ event, fields }),
    };
    const fingerprint = claudeClaimFingerprint(config);
    const engines = new EngineProcesses();
    const host = new WorkerHost({
      checkpoints: new SessionCheckpoints({
        fingerprint,
        gateway,
        logger,
        objectPrefix: `sessions/${SESSION_ID}/`,
        objects: scopedCheckpointObjectStore(bucket, `sessions/${SESSION_ID}/`),
        workspaceRoot: workspace,
      }),
      engines,
      execution: { bootstrapNonce: "wln_local", generation: 1, id: "exec-1" },
      gateway,
      logger,
      runtimes: claudeRuntimeRegistry(config, engines),
      timeouts,
      workspace: new GitWorkspace(workspace),
    });

    const summary = await host.runLoop();

    expect(failures).toEqual([]);
    expect(summary.turns).toEqual([
      { turnId: "1", status: "completed", reason: null },
    ]);
    const committed = gateway.finalized[0]?.checkpoint;
    expect(committed?.revision).toBe(0);
    expect(pointers.pointer()?.manifestRef).toBe(
      committed?.manifest_ref as string,
    );
    expect(pointers.pointer()?.manifestSha256).toBe(
      committed?.manifest_sha256 as string,
    );
    // The heartbeat that ended the run reported the mirror as written.
    expect(gateway.heartbeats.at(-1)?.transcript).toMatchObject({
      mirror_error: null,
    });

    const claim = await gateway.bootstrapClaim({
      execution_id: "exec-2",
      execution_generation: 2,
      credential: { kind: "launch_nonce", nonce: "nonce" },
    });
    const restore = await service.getRestorePlan({
      runtime: fingerprint(claim),
      sessionId: SESSION_ID,
    });
    if (restore.status !== "ready") {
      throw new Error(`expected a plan, got ${JSON.stringify(restore)}`);
    }
    const bundle = restore.plan.artifacts.find(
      (artifact) => artifact.kind === "workspace_bundle",
    )?.objects[0];
    if (bundle === undefined) throw new Error("the plan names no bundle");
    const bytes = await bucket.get(bundle.key);
    if (bytes === undefined) throw new Error("the bundle is missing");
    const bundlePath = join(root, "restore.bundle");
    await writeFile(bundlePath, bytes);
    const restored = join(root, "restored");
    git(["init", "--quiet", restored], root);
    git(["fetch", "--quiet", bundlePath, "refs/*:refs/bundle/*"], restored);
    git(["checkout", "--quiet", "--detach", restore.plan.gitCommit], restored);
    expect(await readFile(join(restored, "README.md"), "utf8")).toBe(
      "edited\n",
    );
    // What the engine left committed on the branch is untouched: the capture
    // commit is the checkpoint's, not the session's history.
    expect(git(["rev-list", "--count", "HEAD"], workspace).trim()).toBe("1");
    const untracked = restore.plan.artifacts.find(
      (artifact) => artifact.kind === "workspace_untracked",
    );
    if (procfs) {
      expect(
        untracked?.objects.map((object) => [
          (object as { path?: string }).path,
          (object as { executable?: true }).executable,
        ]),
      ).toEqual([["notes.txt", true]]);
    } else {
      expect(untracked).toBeUndefined();
    }
    expect(restore.plan.cwd).toBe(workspace);

    // Another partition on the same endpoint resumes nothing of this one.
    const stranger = await service.getRestorePlan({
      runtime: fingerprint({ ...claim, principal: { owner_scope: "owner-b" } }),
      sessionId: SESSION_ID,
    });
    expect(stranger.status).toBe("incompatible");
  }, 120_000);
});
