import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  BootstrapClaimResponse,
  CheckpointRequest,
  CheckpointRequestResponse,
} from "@agent-platform/contracts";
import {
  CLAUDE_RUNTIME_FINGERPRINT,
  claudeCheckpointCodec,
} from "@agent-platform/runtime-claude";
import type {
  CheckpointPreparation,
  RuntimeFingerprint,
  TranscriptMirror,
} from "@agent-platform/runtime-core";
import {
  createMemoryCheckpointObjectStore,
  type MemoryCheckpointObjectStore,
} from "@agent-platform/testkit/checkpoint-objects";

import { FakeWorkerGateway } from "./fake-gateway.ts";
import { WorkerGatewayRequestError } from "./gateway-client.ts";
import { SessionCheckpoints } from "./session-checkpoints.ts";
import type { WorkerLogger } from "./worker-host.ts";

const runtime: RuntimeFingerprint = {
  ...CLAUDE_RUNTIME_FINGERPRINT,
  profileSha256: "a".repeat(64),
};
/** FakeWorkerGateway's default session. */
const SESSION = "11111111-1111-4111-8111-111111111111";
const resume = "engine-session-1";
const ready: CheckpointPreparation = {
  status: "ready",
  checkpoint: {
    engine: CLAUDE_RUNTIME_FINGERPRINT.engine,
    resume,
    sdkVersion: CLAUDE_RUNTIME_FINGERPRINT.sdkVersion,
  },
};
const root = { projectKey: "-workspace", sessionId: resume };

let scratch: string;
let workspace: string;

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), "94s-246-publish-"));
  workspace = join(scratch, "workspace");
  await mkdir(workspace);
  await git("init", "--quiet", "--initial-branch=main");
  await writeFile(join(workspace, "README.md"), "hello\n");
  await git("add", "--all");
  await git("commit", "--quiet", "-m", "first");
});

afterEach(async () => {
  await rm(scratch, { force: true, recursive: true });
});

async function git(...args: string[]): Promise<string> {
  const child = Bun.spawn(["git", ...args], {
    cwd: workspace,
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: scratch,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_AUTHOR_NAME: "test",
      GIT_AUTHOR_EMAIL: "test@example.test",
      GIT_COMMITTER_NAME: "test",
      GIT_COMMITTER_EMAIL: "test@example.test",
    },
    stderr: "pipe",
    stdout: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`git ${args.join(" ")}: ${stderr}`);
  return stdout;
}

type Logged = { event: string; fields: Record<string, unknown> | undefined };

function harness(
  options: {
    gateway?: FakeWorkerGateway;
    objects?: MemoryCheckpointObjectStore;
    captureWorkspace?: ConstructorParameters<
      typeof SessionCheckpoints
    >[0]["captureWorkspace"];
  } = {},
) {
  const gateway = options.gateway ?? new FakeWorkerGateway();
  const objects = options.objects ?? createMemoryCheckpointObjectStore();
  const warnings: Logged[] = [];
  const logger: WorkerLogger = {
    info: () => {},
    warn: (event, fields) => warnings.push({ event, fields }),
    error: () => {},
  };
  const port = new SessionCheckpoints({
    fingerprint: () => runtime,
    gateway,
    logger,
    now: () => new Date("2026-09-23T00:00:00.000Z"),
    objectPrefix: `sessions/${SESSION}/`,
    objects,
    workspaceRoot: workspace,
    ...(options.captureWorkspace === undefined
      ? {}
      : { captureWorkspace: options.captureWorkspace }),
  });
  return { gateway, logger, objects, port, warnings };
}

async function claimOf(
  gateway: FakeWorkerGateway,
): Promise<BootstrapClaimResponse> {
  return gateway.bootstrapClaim({
    execution_id: "execution-1",
    execution_generation: 1,
    credential: { kind: "launch_nonce", nonce: "nonce" },
  });
}

function scopeOf(claim: BootstrapClaimResponse) {
  return {
    session_id: claim.session_id,
    turn_id: "turn-1",
    attempt_id: claim.attempt_id,
    lease_epoch: claim.lease_epoch,
    execution_generation: claim.execution_generation,
    auth_revision: claim.auth_revision,
  };
}

async function opened(h: ReturnType<typeof harness>) {
  const claim = await claimOf(h.gateway);
  const plan = await h.port.restorePlan(claim);
  if (plan.mode !== "new" || plan.sessionStore === undefined) {
    throw new Error("expected a fresh plan with a mirror");
  }
  return { claim, mirror: plan.sessionStore as TranscriptMirror };
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

describe("SessionCheckpoints", () => {
  test("publishes the workspace, the pinned transcript and a manifest under the key it was handed", async () => {
    const h = harness();
    const { claim, mirror } = await opened(h);
    await mirror.append(root, [{ type: "user", uuid: "u1", message: "hi" }]);
    await writeFile(join(workspace, "README.md"), "edited\n");

    const ref = await h.port.capture(ready, {
      scope: scopeOf(claim),
      recheck: async () => ready,
    });

    expect(ref).not.toBeNull();
    if (ref === null) return;
    expect(h.warnings).toEqual([]);
    const [request] = h.gateway.checkpointRequests;
    expect(request?.preparation).toEqual({ status: "ready" });
    expect(request?.turn_id).toBe("turn-1");
    const bytes = await h.objects.get(ref.manifest_ref);
    if (bytes === undefined) throw new Error("manifest missing");
    expect(sha256(bytes)).toBe(ref.manifest_sha256);
    const manifest = claudeCheckpointCodec.decode(bytes);
    expect(manifest.revision).toBe(ref.revision);
    expect(manifest.sessionId).toBe(claim.session_id);
    expect(manifest.resume).toBe(resume);
    expect(manifest.runtime).toEqual(runtime);
    expect(manifest.cwd).toBe(workspace);
    const directory = ref.manifest_ref.slice(
      0,
      ref.manifest_ref.lastIndexOf("/") + 1,
    );
    const bundle = manifest.workspace.bundle;
    expect(bundle.key.startsWith(directory)).toBe(true);
    const stored = await h.objects.get(bundle.key);
    if (stored === undefined) throw new Error("bundle missing");
    expect(sha256(stored)).toBe(bundle.sha256);
    expect(stored.byteLength).toBe(bundle.bytes);
    // The capture commits the edit on top of HEAD; HEAD itself is untouched.
    expect(manifest.workspace.gitCommit).not.toBe(
      (await git("rev-parse", "HEAD")).trim(),
    );
    expect(manifest.transcripts.root.parts).toHaveLength(1);
    const part = manifest.transcripts.root.parts[0];
    if (part === undefined) throw new Error("part missing");
    const partBytes = await h.objects.get(part.key);
    expect(partBytes === undefined ? null : sha256(partBytes)).toBe(
      part.sha256,
    );
  });

  test("a second publish of the same revision number never overwrites the first", async () => {
    const h = harness();
    const { claim, mirror } = await opened(h);
    await mirror.append(root, [{ type: "user", uuid: "u1", message: "hi" }]);
    const context = { scope: scopeOf(claim), recheck: async () => ready };

    const first = await h.port.capture(ready, context);
    const second = await h.port.capture(ready, context);

    expect(first?.revision).toBe(second?.revision as number);
    expect(first?.manifest_ref).not.toBe(second?.manifest_ref as string);
  });

  test("reports a refusal to the gateway and commits nothing", async () => {
    const h = harness();
    const { claim } = await opened(h);

    const ref = await h.port.capture(
      { status: "rejected", reason: "tool_in_flight", detail: "Bash running" },
      { scope: scopeOf(claim), recheck: async () => ready },
    );

    expect(ref).toBeNull();
    expect(h.gateway.checkpointRequests.map((r) => r.preparation)).toEqual([
      { status: "rejected", reason: "tool_in_flight", detail: "Bash running" },
    ]);
    expect(h.objects.keys().some((key) => key.includes("/checkpoints/"))).toBe(
      false,
    );
  });

  test("uploads nothing when the gateway answers blocked", async () => {
    const gateway = new FakeWorkerGateway({
      checkpoints: {
        commit: async () => {},
        requestCheckpoint: async () => ({
          status: "blocked",
          reason: "mirror_error",
          detail: "an earlier batch was dropped",
        }),
        restorePlan: async () => ({ status: "none" }),
      },
    });
    const h = harness({ gateway });
    const { claim, mirror } = await opened(h);
    await mirror.append(root, [{ type: "user", uuid: "u1", message: "hi" }]);

    const ref = await h.port.capture(ready, {
      scope: scopeOf(claim),
      recheck: async () => ready,
    });

    expect(ref).toBeNull();
    expect(h.objects.keys().some((key) => key.includes("/checkpoints/"))).toBe(
      false,
    );
  });

  test("a workspace the capture refuses fails the publish before the manifest", async () => {
    const h = harness({
      captureWorkspace: async () => ({
        status: "refused",
        reason: "the checkout is shallow",
      }),
    });
    const { claim, mirror } = await opened(h);
    await mirror.append(root, [{ type: "user", uuid: "u1", message: "hi" }]);

    const ref = await h.port.capture(ready, {
      scope: scopeOf(claim),
      recheck: async () => ready,
    });

    expect(ref).toBeNull();
    expect(h.warnings).toEqual([
      {
        event: "worker.checkpoint.failed",
        fields: expect.objectContaining({
          stage: "workspace",
          reason: "the checkout is shallow",
          revision: 0,
        }),
      },
    ]);
    expect(h.objects.keys().some((key) => key.endsWith("manifest.json"))).toBe(
      false,
    );
  });

  test("a transcript batch that failed to mirror keeps the manifest back", async () => {
    const h = harness();
    const { claim, mirror } = await opened(h);
    await mirror.append(root, [{ type: "user", uuid: "u1", message: "hi" }]);
    h.objects.failWrites(1);
    await expect(
      mirror.append(root, [{ type: "user", uuid: "u2", message: "lost" }]),
    ).rejects.toThrow("Injected");

    const ref = await h.port.capture(ready, {
      scope: scopeOf(claim),
      recheck: async () => ready,
    });

    expect(ref).toBeNull();
    expect(h.warnings[0]?.fields).toMatchObject({ stage: "transcript" });
    expect(h.objects.keys().some((key) => key.endsWith("manifest.json"))).toBe(
      false,
    );
  });

  test("a mirror error raised while it uploaded keeps the manifest back", async () => {
    const h = harness();
    const { claim, mirror } = await opened(h);
    await mirror.append(root, [{ type: "user", uuid: "u1", message: "hi" }]);

    const ref = await h.port.capture(ready, {
      scope: scopeOf(claim),
      recheck: async () => ({
        status: "rejected",
        reason: "mirror_error",
        detail: "Transcript mirror dropped a root batch",
      }),
    });

    expect(ref).toBeNull();
    expect(h.warnings[0]?.fields).toMatchObject({
      stage: "transcript",
      reason: "Transcript mirror dropped a root batch",
    });
  });

  test("a key that already holds another manifest is a failure, not an overwrite", async () => {
    const objects = createMemoryCheckpointObjectStore();
    const manifestRef =
      "sessions/11111111-1111-4111-8111-111111111111/checkpoints/0000000000/att_fake/0123456789abcdef0123456789abcdef/manifest.json";
    await objects.putImmutable(manifestRef, new TextEncoder().encode("{}"));
    const gateway = new FakeWorkerGateway({
      checkpoints: {
        commit: async () => {},
        requestCheckpoint: async (): Promise<CheckpointRequestResponse> => ({
          status: "ready",
          revision: 0,
          manifest_ref: manifestRef,
        }),
        restorePlan: async () => ({ status: "none" }),
      },
    });
    const h = harness({ gateway, objects });
    const { claim, mirror } = await opened(h);
    await mirror.append(root, [{ type: "user", uuid: "u1", message: "hi" }]);

    const ref = await h.port.capture(ready, {
      scope: scopeOf(claim),
      recheck: async () => ready,
    });

    expect(ref).toBeNull();
    expect(h.warnings[0]?.fields).toMatchObject({
      stage: "manifest",
      manifest_ref: manifestRef,
    });
    expect(new TextDecoder().decode(await objects.get(manifestRef))).toBe("{}");
  });

  test("refuses a manifest key outside the session it mirrors", async () => {
    const gateway = new FakeWorkerGateway({
      checkpoints: {
        commit: async () => {},
        requestCheckpoint: async (): Promise<CheckpointRequestResponse> => ({
          status: "ready",
          revision: 0,
          manifest_ref: "sessions/other/checkpoints/x/manifest.json",
        }),
        restorePlan: async () => ({ status: "none" }),
      },
    });
    const h = harness({ gateway });
    const { claim, mirror } = await opened(h);
    await mirror.append(root, [{ type: "user", uuid: "u1", message: "hi" }]);

    expect(
      await h.port.capture(ready, {
        scope: scopeOf(claim),
        recheck: async () => ready,
      }),
    ).toBeNull();
    expect(h.warnings[0]?.fields).toMatchObject({ stage: "request" });
    expect(h.objects.keys().some((key) => key.includes("/checkpoints/"))).toBe(
      false,
    );
  });

  test("a gateway that says the attempt lost the session is thrown, not logged", async () => {
    const lost = new WorkerGatewayRequestError(
      409,
      "STALE_EPOCH",
      "stale",
      false,
    );
    const gateway = new FakeWorkerGateway({
      checkpoints: {
        commit: async () => {},
        requestCheckpoint: async (_request: CheckpointRequest) => {
          throw lost;
        },
        restorePlan: async () => ({ status: "none" }),
      },
    });
    const h = harness({ gateway });
    const { claim } = await opened(h);

    await expect(
      h.port.capture(ready, {
        scope: scopeOf(claim),
        recheck: async () => ready,
      }),
    ).rejects.toBe(lost);
    await expect(
      h.port.capture(
        { status: "rejected", reason: "tool_in_flight", detail: "x" },
        { scope: scopeOf(claim), recheck: async () => ready },
      ),
    ).rejects.toBe(lost);
  });

  test("binds the mirror to the claim's generation and reports when it last wrote", async () => {
    const h = harness();
    expect(h.port.mirror()).toBeUndefined();
    const { mirror } = await opened(h);
    expect(h.port.mirror()).toEqual({ persistedAt: null });

    await mirror.append(root, [{ type: "user", uuid: "u1", message: "hi" }]);

    expect(h.port.mirror()?.persistedAt).toBeInstanceOf(Date);
    expect(
      h.objects
        .keys()
        .every((key) =>
          key.startsWith(
            "sessions/11111111-1111-4111-8111-111111111111/transcripts/",
          ),
        ),
    ).toBe(true);
  });

  test("refuses a claim that names a checkpoint to restore", async () => {
    const h = harness({
      gateway: new FakeWorkerGateway({
        restore: {
          revision: 3,
          manifest_ref: "sessions/x/manifest.json",
          manifest_sha256: "b".repeat(64),
        },
      }),
    });

    await expect(h.port.restorePlan(await claimOf(h.gateway))).rejects.toThrow(
      "revision 3",
    );
  });
});
