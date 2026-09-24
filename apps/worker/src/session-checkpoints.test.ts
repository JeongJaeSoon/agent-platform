import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  BootstrapClaimResponse,
  CheckpointRef,
  CheckpointRequest,
  CheckpointRequestResponse,
  RestorePlanRequest,
  RestorePlanResponse,
} from "@agent-platform/contracts";
import {
  CLAUDE_RUNTIME_FINGERPRINT,
  ClaudeSessionStore,
  claudeCheckpointCodec,
} from "@agent-platform/runtime-claude";
import {
  type CheckpointManifest,
  type CheckpointPreparation,
  MAX_TRANSCRIPT_PART_BYTES,
  ObjectIntegrityError,
  type ObjectRef,
  type RuntimeFingerprint,
  type TranscriptMirror,
  WorkerGatewayRequestError,
} from "@agent-platform/runtime-core";
import {
  createMemoryCheckpointObjectStore,
  type MemoryCheckpointObjectStore,
} from "@agent-platform/testkit/checkpoint-objects";

import { stageCheckpointBundle } from "./checkpoint-restore.ts";
import {
  FakeWorkerGateway,
  type FakeWorkerGatewayOptions,
} from "./fake-gateway.ts";
import { RestoreRefused, SessionCheckpoints } from "./session-checkpoints.ts";
import type { WorkerLogger } from "./worker-host.ts";
import type {
  WorkspaceCapture,
  WorkspaceCaptureResult,
} from "./workspace-capture.ts";

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
    fingerprint?: RuntimeFingerprint;
    instructionsCommit?: () => string | null;
  } = {},
) {
  const gateway = options.gateway ?? new FakeWorkerGateway();
  const objects = options.objects ?? createMemoryCheckpointObjectStore();
  const warnings: Logged[] = [];
  const errors: Logged[] = [];
  const logger: WorkerLogger = {
    info: () => {},
    warn: (event, fields) => warnings.push({ event, fields }),
    error: (event, fields) => errors.push({ event, fields }),
  };
  const port = new SessionCheckpoints({
    fingerprint: () => options.fingerprint ?? runtime,
    gateway,
    logger,
    now: () => new Date("2026-09-23T00:00:00.000Z"),
    objectPrefix: `sessions/${SESSION}/`,
    objects,
    workspaceRoot: workspace,
    ...(options.captureWorkspace === undefined
      ? {}
      : { captureWorkspace: options.captureWorkspace }),
    ...(options.instructionsCommit === undefined
      ? {}
      : { instructionsCommit: options.instructionsCommit }),
  });
  return { errors, gateway, logger, objects, port, warnings };
}

async function claimOf(
  gateway: FakeWorkerGateway,
  generation = gateway instanceof PlanningGateway ? 2 : 1,
): Promise<BootstrapClaimResponse> {
  return gateway.bootstrapClaim({
    execution_id: `execution-${generation}`,
    execution_generation: generation,
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
  const plan = await h.port.restorePlan(claim, new AbortController().signal);
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

  test("uploads the bundle from a file in chunks, and leaves no spool behind (94S-318)", async () => {
    const h = harness();
    const { claim, mirror } = await opened(h);
    await mirror.append(root, [{ type: "user", uuid: "u1", message: "hi" }]);
    // Incompressible, so the bundle spans many reads of the file.
    await writeFile(join(workspace, "noise.bin"), randomBytes(512 * 1024));
    await git("add", "noise.bin");
    await git("commit", "--quiet", "-m", "noise");

    const ref = await h.port.capture(ready, {
      scope: scopeOf(claim),
      recheck: async () => ready,
    });

    if (ref === null) throw new Error(`nothing published: ${h.warnings}`);
    const bytes = await h.objects.get(ref.manifest_ref);
    if (bytes === undefined) throw new Error("manifest missing");
    const { bundle } = claudeCheckpointCodec.decode(bytes).workspace;
    expect(bundle.bytes).toBeGreaterThan(512 * 1024);
    const [write, ...others] = h.objects
      .streamedWrites()
      .filter(({ key }) => key === bundle.key);
    expect(others).toEqual([]);
    expect(write?.chunks.length).toBeGreaterThan(1);
    expect(Math.max(...(write?.chunks ?? []))).toBeLessThanOrEqual(64 * 1024);
    expect(write?.chunks.reduce((total, size) => total + size, 0)).toBe(
      bundle.bytes,
    );
    expect(
      (await readdir(join(workspace, ".git"))).filter((name) =>
        name.startsWith("agent-platform-"),
      ),
    ).toEqual([]);
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
    // The gateway made that call itself; nothing is reported back to it.
    expect(
      h.gateway.checkpointRequests.map((request) => request.preparation),
    ).toEqual([{ status: "ready" }]);
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
    // Recorded as the blocking reason before the turn can finish without it.
    expect(h.gateway.checkpointRequests.at(-1)?.preparation).toEqual({
      status: "rejected",
      reason: "mirror_error",
      detail:
        "a transcript batch failed to mirror and has not been written since",
    });
  });

  test("an unsettled mirror is recorded even when the publish stopped for another reason", async () => {
    const h = harness({
      captureWorkspace: async () => ({
        status: "refused",
        reason: "the checkout is shallow",
      }),
    });
    const { claim, mirror } = await opened(h);
    await mirror.append(root, [{ type: "user", uuid: "u1", message: "hi" }]);
    h.objects.failWrites(1);
    await expect(
      mirror.append(root, [{ type: "user", uuid: "u2", message: "lost" }]),
    ).rejects.toThrow("Injected");

    expect(
      await h.port.capture(ready, {
        scope: scopeOf(claim),
        recheck: async () => ready,
      }),
    ).toBeNull();

    expect(h.gateway.checkpointRequests.at(-1)?.preparation).toMatchObject({
      status: "rejected",
      reason: "mirror_error",
    });
  });

  test("a mirror error the run reports is recorded however early the publish stopped", async () => {
    const h = harness({
      captureWorkspace: async () => ({
        status: "refused",
        reason: "bundle too large",
      }),
    });
    const { claim } = await opened(h);

    expect(
      await h.port.capture(ready, {
        scope: scopeOf(claim),
        recheck: async () => ({
          status: "rejected",
          reason: "mirror_error",
          detail: "late loss",
        }),
      }),
    ).toBeNull();

    expect(
      h.gateway.checkpointRequests.map((request) => request.preparation),
    ).toEqual([
      { status: "ready" },
      { status: "rejected", reason: "mirror_error", detail: "late loss" },
    ]);
  });

  test("a lost mirror the gateway could not be told about fails the capture", async () => {
    const gateway = new FakeWorkerGateway({
      checkpoints: {
        commit: async () => {},
        requestCheckpoint: async (request) => {
          if (request.preparation.status === "rejected") {
            throw new WorkerGatewayRequestError(503, null, "restarting", true);
          }
          return {
            status: "ready",
            revision: 0,
            manifest_ref: `sessions/${SESSION}/checkpoints/0000000000/att_fake/0123456789abcdef0123456789abcdef/manifest.json`,
          };
        },
        restorePlan: async () => ({ status: "none" }),
      },
    });
    const h = harness({ gateway });
    const { claim, mirror } = await opened(h);
    await mirror.append(root, [{ type: "user", uuid: "u1", message: "hi" }]);
    const context = {
      scope: scopeOf(claim),
      recheck: async (): Promise<CheckpointPreparation> => ({
        status: "rejected",
        reason: "mirror_error",
        detail: "Transcript mirror dropped a root batch",
      }),
    };

    await expect(h.port.capture(ready, context)).rejects.toThrow(
      "did not record it",
    );
    // The engine's own verdict takes the same path.
    await expect(
      h.port.capture(await context.recheck(), context),
    ).rejects.toThrow("did not record it");
    // An advisory refusal is no way around it: the mirror error the run
    // reports since is still recorded before the turn can close.
    await expect(
      h.port.capture(
        { status: "rejected", reason: "tool_in_flight", detail: "x" },
        context,
      ),
    ).rejects.toThrow("did not record it");
    // One that does not land, with the mirror whole, is only logged.
    expect(
      await h.port.capture(
        { status: "rejected", reason: "tool_in_flight", detail: "x" },
        { ...context, recheck: async () => ready },
      ),
    ).toBeNull();
  });

  test("an upload that fails leaves no manifest naming what is missing", async () => {
    const h = harness();
    const { claim, mirror } = await opened(h);
    await mirror.append(root, [{ type: "user", uuid: "u1", message: "hi" }]);
    // The bundle is the first write of the publish.
    h.objects.failWrites(1);

    expect(
      await h.port.capture(ready, {
        scope: scopeOf(claim),
        recheck: async () => ready,
      }),
    ).toBeNull();

    expect(h.warnings[0]?.fields).toMatchObject({ category: "error" });
    expect(h.objects.keys().some((key) => key.includes("/checkpoints/"))).toBe(
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
    expect(h.gateway.checkpointRequests.at(-1)?.preparation).toEqual({
      status: "rejected",
      reason: "mirror_error",
      detail: "Transcript mirror dropped a root batch",
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
});

describe("a publish that fails for a reason other than the mirror (94S-312)", () => {
  const manifestRef = `sessions/${SESSION}/checkpoints/0000000000/att_fake/0123456789abcdef0123456789abcdef/manifest.json`;
  const directory = manifestRef.slice(0, manifestRef.lastIndexOf("/") + 1);
  const bundle = new TextEncoder().encode("bundle bytes");
  const captured =
    (untracked: WorkspaceCapture["untracked"] = []) =>
    async (input: { bundlePath: string }): Promise<WorkspaceCaptureResult> => {
      await writeFile(input.bundlePath, bundle);
      return {
        status: "captured",
        capture: {
          bundle: {
            bytes: bundle.byteLength,
            path: input.bundlePath,
            sha256: sha256(bundle),
          },
          gitCommit: "c".repeat(40),
          untracked,
        },
      };
    };
  const untrackedFiles = (count: number, pathBytes = 8) =>
    Array.from({ length: count }, (_, index) => ({
      bytes: new TextEncoder().encode("same bytes"),
      executable: false,
      path: `${String(index).padStart(pathBytes, "0")}.txt`,
    }));
  /** Hands out `handed` for a ready request and records every refusal. */
  const handing = (
    handed = manifestRef,
    ready: () => Promise<void> = async () => {},
  ) =>
    new FakeWorkerGateway({
      checkpoints: {
        commit: async () => {},
        requestCheckpoint: async (request) => {
          if (request.preparation.status === "rejected") {
            return {
              status: "blocked",
              reason: request.preparation.reason,
              detail: request.preparation.detail,
            };
          }
          await ready();
          return { status: "ready", revision: 0, manifest_ref: handed };
        },
        restorePlan: async () => ({ status: "none" }),
      },
    });

  type Case = {
    stage: string;
    options: () => Promise<Parameters<typeof harness>[0]>;
    mirrored?: false;
    failWrites?: number;
  };
  const cases: Array<[string, Case]> = [
    [
      "a workspace the capture refuses",
      {
        stage: "workspace",
        options: async () => ({
          captureWorkspace: async () => ({
            status: "refused",
            reason: "5000 untracked files, over the 10 a checkpoint carries",
          }),
        }),
      },
    ],
    [
      "an upload key that already holds other bytes",
      {
        stage: "upload",
        options: async () => {
          const objects = createMemoryCheckpointObjectStore();
          await objects.putImmutable(
            `${directory}workspace-${sha256(bundle)}.bundle`,
            new TextEncoder().encode("other bytes"),
          );
          return {
            captureWorkspace: captured(),
            gateway: handing(),
            objects,
          };
        },
      },
    ],
    [
      "a manifest naming more objects than the control plane reads",
      {
        stage: "manifest",
        options: async () => ({
          captureWorkspace: captured(untrackedFiles(20_000)),
        }),
      },
    ],
    [
      "a manifest larger than the control plane reads",
      {
        stage: "manifest",
        options: async () => ({
          captureWorkspace: captured(untrackedFiles(15_000, 600)),
        }),
      },
    ],
    [
      "a manifest key that already holds another manifest",
      {
        stage: "manifest",
        options: async () => {
          const objects = createMemoryCheckpointObjectStore();
          await objects.putImmutable(
            manifestRef,
            new TextEncoder().encode("{}"),
          );
          return {
            captureWorkspace: captured(),
            gateway: handing(),
            objects,
          };
        },
      },
    ],
    [
      "a manifest key outside the session",
      {
        stage: "request",
        options: async () => ({
          gateway: handing("sessions/other/checkpoints/x/manifest.json"),
        }),
      },
    ],
    [
      "an engine session with nothing mirrored",
      {
        stage: "transcript",
        mirrored: false,
        options: async () => ({ captureWorkspace: captured() }),
      },
    ],
    [
      "a store that fails an upload",
      {
        stage: "publish",
        failWrites: 1,
        options: async () => ({ captureWorkspace: captured() }),
      },
    ],
    [
      "a gateway that cannot hand out a key",
      {
        stage: "request",
        options: async () => ({
          gateway: handing(manifestRef, async () => {
            throw new WorkerGatewayRequestError(
              503,
              "BACKEND_UNAVAILABLE",
              "checkpoint store unreachable",
              true,
            );
          }),
        }),
      },
    ],
  ];

  test.each(cases)(
    "%s is recorded as publish_failed",
    async (_name, { stage, options, mirrored, failWrites }) => {
      const h = harness(await options());
      const { claim, mirror } = await opened(h);
      if (mirrored !== false) {
        await mirror.append(root, [
          { type: "user", uuid: "u1", message: "hi" },
        ]);
      }
      if (failWrites !== undefined) h.objects.failWrites(failWrites);

      const ref = await h.port.capture(ready, {
        scope: scopeOf(claim),
        recheck: async () => ready,
      });

      expect(ref).toBeNull();
      expect(
        h.gateway.checkpointRequests
          .map((request) => request.preparation)
          .filter((preparation) => preparation.status === "rejected"),
      ).toEqual([
        {
          status: "rejected",
          reason: "publish_failed",
          detail: expect.stringMatching(new RegExp(`^${stage}: `)),
        },
      ]);
      expect(h.warnings[0]).toMatchObject({
        event: "worker.checkpoint.failed",
        fields: { stage },
      });
    },
    30_000,
  );

  test("a manifest the gateway refuses at finalize is recorded the same way", async () => {
    const h = harness();
    const { claim } = await opened(h);

    await h.port.finalizeRefused(
      "Checkpoint manifest rejected: digest mismatch",
      scopeOf(claim),
    );

    expect(h.gateway.checkpointRequests).toEqual([
      {
        ...scopeOf(claim),
        preparation: {
          status: "rejected",
          reason: "publish_failed",
          detail: "finalize: Checkpoint manifest rejected: digest mismatch",
        },
      },
    ]);
  });

  test("a gateway that does not take the report only costs a log line", async () => {
    const gateway = new FakeWorkerGateway({
      checkpoints: {
        commit: async () => {},
        requestCheckpoint: async (request) => {
          if (request.preparation.status === "rejected") {
            throw new WorkerGatewayRequestError(503, null, "restarting", true);
          }
          return { status: "ready", revision: 0, manifest_ref: manifestRef };
        },
        restorePlan: async () => ({ status: "none" }),
      },
    });
    const h = harness({
      gateway,
      captureWorkspace: async () => ({ status: "refused", reason: "shallow" }),
    });
    const { claim, mirror } = await opened(h);
    await mirror.append(root, [{ type: "user", uuid: "u1", message: "hi" }]);

    expect(
      await h.port.capture(ready, {
        scope: scopeOf(claim),
        recheck: async () => ready,
      }),
    ).toBeNull();
    expect(h.warnings.map(({ event }) => event)).toEqual([
      "worker.checkpoint.failed",
      "worker.checkpoint.report_failed",
    ]);
  });
});

/** A gateway whose restore plan is whatever the test says it is. */
class PlanningGateway extends FakeWorkerGateway {
  constructor(
    options: FakeWorkerGatewayOptions,
    answer: (request: RestorePlanRequest) => RestorePlanResponse,
  ) {
    super(options);
    this.#answer = answer;
  }

  readonly #answer: (request: RestorePlanRequest) => RestorePlanResponse;

  override async restorePlan(
    request: RestorePlanRequest,
  ): Promise<RestorePlanResponse> {
    this.restorePlans.push(request);
    return this.#answer(request);
  }
}

function neverStopped(): AbortSignal {
  return new AbortController().signal;
}

/** The plan the control plane would read out of `manifest`, versions included. */
function planOf(
  ref: CheckpointRef,
  manifest: CheckpointManifest,
): RestorePlanResponse {
  const wire = (object: ObjectRef) => ({
    key: object.key,
    bytes: object.bytes,
    sha256: object.sha256,
    ...(object.version === undefined ? {} : { version: object.version }),
  });
  const { root: rootTranscript, subagents } = manifest.transcripts;
  return {
    status: "ready",
    plan: {
      revision: ref.revision,
      manifest_ref: ref.manifest_ref,
      manifest_sha256: ref.manifest_sha256,
      ...(ref.manifest_version === undefined
        ? {}
        : { manifest_version: ref.manifest_version }),
      engine: manifest.engine,
      resume: manifest.resume,
      cwd: manifest.cwd,
      git_commit: manifest.workspace.gitCommit,
      artifacts: [
        {
          kind: "workspace_bundle",
          label: "workspace",
          objects: [wire(manifest.workspace.bundle)],
        },
        {
          kind: "transcript_root",
          label: "root",
          objects: rootTranscript.parts.map(wire),
        },
        ...Object.entries(subagents).map(([label, revision]) => ({
          kind: "transcript_subagent" as const,
          label,
          objects: revision.parts.map(wire),
        })),
      ],
      object_keys: [],
    },
  };
}

type Published = {
  manifest: CheckpointManifest;
  objects: MemoryCheckpointObjectStore;
  ref: CheckpointRef;
};

/**
 * One turn through a generation-1 worker: an edit in the checkout, a
 * transcript entry, and the checkpoint the gateway would commit.
 */
async function published(
  options: { versioned?: boolean; instructions?: boolean } = {},
): Promise<Published> {
  const objects = createMemoryCheckpointObjectStore({
    versioned: options.versioned === true,
  });
  let instructions: string | null = null;
  if (options.instructions === true) {
    await writeFile(join(workspace, "CLAUDE.md"), "rules as fetched\n");
    await git("add", "CLAUDE.md");
    await git("commit", "--quiet", "-m", "rules");
    instructions = (await git("rev-parse", "HEAD")).trim();
  }
  const h = harness({ instructionsCommit: () => instructions, objects });
  const { claim, mirror } = await opened(h);
  await mirror.append(root, [{ type: "user", uuid: "u1", message: "hi" }]);
  await writeFile(join(workspace, "README.md"), "edited\n");
  if (options.instructions === true) {
    await writeFile(join(workspace, "CLAUDE.md"), "rules the engine wrote\n");
  }
  const ref = await h.port.capture(ready, {
    scope: scopeOf(claim),
    recheck: async () => ready,
  });
  if (ref === null) throw new Error(`nothing published: ${h.warnings}`);
  const bytes = await objects.get(ref.manifest_ref, ref.manifest_version);
  if (bytes === undefined) throw new Error("manifest missing");
  return { manifest: claudeCheckpointCodec.decode(bytes), objects, ref };
}

/** The volume a replacement worker finds: whatever was there, or nothing. */
async function replaceWorkspaceWithLeftovers(): Promise<void> {
  await rm(workspace, { force: true, recursive: true });
  await mkdir(workspace);
  await writeFile(join(workspace, "left-behind.txt"), "stale\n");
}

function restoring(
  from: Published,
  options: {
    answer?: (request: RestorePlanRequest) => RestorePlanResponse;
    claimed?: Partial<CheckpointRef>;
    fingerprint?: RuntimeFingerprint;
  } = {},
) {
  const gateway = new PlanningGateway(
    { restore: { ...from.ref, ...options.claimed } },
    options.answer ?? (() => planOf(from.ref, from.manifest)),
  );
  return harness({
    gateway,
    objects: from.objects,
    ...(options.fingerprint === undefined
      ? {}
      : { fingerprint: options.fingerprint }),
  });
}

describe("SessionCheckpoints restoring a checkpoint", () => {
  test("puts back the checkout and the transcript, reading each object at the version the checkpoint pinned", async () => {
    const from = await published({ versioned: true, instructions: true });
    expect(from.ref.manifest_version).toBeDefined();
    expect(from.manifest.workspace.bundle.version).toBeDefined();
    expect(from.manifest.transcripts.root.parts[0]?.version).toBeDefined();
    // A later write under the same key is not what the checkpoint verified.
    await from.objects.put(
      from.manifest.workspace.bundle.key,
      new TextEncoder().encode("overwritten"),
    );
    await replaceWorkspaceWithLeftovers();
    const h = restoring(from);
    const claim = await claimOf(h.gateway);

    const plan = await h.port.restorePlan(claim, neverStopped());

    expect(h.errors).toEqual([]);
    expect(h.gateway.restorePlans[0]?.runtime).toEqual({
      cli_version: runtime.cliVersion,
      engine: runtime.engine,
      profile_sha256: runtime.profileSha256,
      sdk_version: runtime.sdkVersion,
    });
    if (plan.mode !== "resume") throw new Error("expected a resume plan");
    expect(plan.resume).toBe(resume);
    expect(plan.restoredRevision).toBe(from.ref.revision);
    expect(await readFile(join(workspace, "README.md"), "utf8")).toBe(
      "edited\n",
    );
    expect(existsSync(join(workspace, "left-behind.txt"))).toBe(false);
    // Uncommitted before, uncommitted again.
    expect(await git("status", "--porcelain")).toBe(
      " M CLAUDE.md\n M README.md\n",
    );
    // CLAUDE.md as fetched, not as the engine left it on disk.
    expect(plan.committedClaudeMd?.()).toBe("rules as fetched\n");
    expect(plan.sessionStore).toBeDefined();
  });

  test("restores the earlier revision a fallback plan names in place of the claim's damaged pointer (94S-204)", async () => {
    const from = await published({ versioned: true });
    await replaceWorkspaceWithLeftovers();
    const damaged: Partial<CheckpointRef> = {
      revision: from.ref.revision + 1,
      manifest_ref: `sessions/${SESSION}/checkpoints/damaged/manifest.json`,
      manifest_sha256: "f".repeat(64),
    };
    const fallbackFrom = (pointerRevision: number) => () => {
      const answer = planOf(from.ref, from.manifest);
      if (answer.status !== "ready") throw new Error("expected a plan");
      return {
        ...answer,
        plan: {
          ...answer.plan,
          fallback: {
            pointer_revision: pointerRevision,
            skipped: [{ revision: pointerRevision, reason: "manifest gone" }],
          },
        },
      };
    };

    // A fallback from some other pointer is not the claim's to take.
    const stray = restoring(from, {
      claimed: damaged,
      answer: fallbackFrom(from.ref.revision + 2),
    });
    await expect(
      stray.port.restorePlan(await claimOf(stray.gateway), neverStopped()),
    ).rejects.toBeInstanceOf(RestoreRefused);

    const h = restoring(from, {
      claimed: damaged,
      answer: fallbackFrom(from.ref.revision + 1),
    });
    const plan = await h.port.restorePlan(
      await claimOf(h.gateway),
      neverStopped(),
    );
    expect(h.errors).toEqual([]);
    if (plan.mode !== "resume") throw new Error("expected a resume plan");
    expect(plan.restoredRevision).toBe(from.ref.revision);
    expect(await readFile(join(workspace, "README.md"), "utf8")).toBe(
      "edited\n",
    );
  });

  test("a capture after the restore pins the same instructions commit", async () => {
    const from = await published({ instructions: true });
    const pinned = (await git("rev-parse", "HEAD")).trim();
    await replaceWorkspaceWithLeftovers();
    const h = restoring(from);
    const claim = await claimOf(h.gateway);
    await h.port.restorePlan(claim, neverStopped());
    await writeFile(join(workspace, "README.md"), "edited again\n");

    const next = await h.port.capture(ready, {
      scope: scopeOf(claim),
      recheck: async () => ready,
    });

    if (next === null) throw new Error(`nothing published: ${h.warnings}`);
    const bytes = await from.objects.get(next.manifest_ref);
    if (bytes === undefined) throw new Error("manifest missing");
    const manifest = claudeCheckpointCodec.decode(bytes);
    expect(manifest.resume).toBe(resume);
    const bundle = await from.objects.get(manifest.workspace.bundle.key);
    if (bundle === undefined) throw new Error("bundle missing");
    await writeFile(join(scratch, "next.bundle"), bundle);
    const staged = await stageCheckpointBundle({
      bundle: join(scratch, "next.bundle"),
      gitCommit: manifest.workspace.gitCommit,
      repository: join(scratch, "next.git"),
      signal: neverStopped(),
    });
    expect(staged.instructions).toBe(pinned);
  });

  test("refuses a checkpoint the gateway calls incompatible, before touching the workspace", async () => {
    const from = await published();
    await replaceWorkspaceWithLeftovers();
    const h = restoring(from, {
      answer: () => ({
        status: "incompatible",
        code: "INCOMPATIBLE_CHECKPOINT",
        mismatches: [
          {
            field: "profileSha256",
            expected: "b".repeat(64),
            found: "a".repeat(64),
          },
        ],
      }),
    });

    const refused = h.port.restorePlan(
      await claimOf(h.gateway),
      neverStopped(),
    );

    await expect(refused).rejects.toBeInstanceOf(RestoreRefused);
    await expect(refused).rejects.toMatchObject({
      code: "INCOMPATIBLE_CHECKPOINT",
    });
    expect(await readFile(join(workspace, "left-behind.txt"), "utf8")).toBe(
      "stale\n",
    );
    expect(h.errors.map(({ event }) => event)).toEqual([
      "worker.checkpoint.restore_refused",
    ]);
  });

  test("streams the bundle to the workspace volume, never through get, and keeps only the staged repository (94S-318)", async () => {
    const from = await published({ instructions: true });
    await replaceWorkspaceWithLeftovers();
    const get = from.objects.get.bind(from.objects);
    from.objects.get = async (key, version) => {
      if (key === from.manifest.workspace.bundle.key) {
        throw new Error("the bundle is read whole");
      }
      return get(key, version);
    };
    const h = restoring(from);

    const plan = await h.port.restorePlan(
      await claimOf(h.gateway),
      neverStopped(),
    );

    expect(plan.mode).toBe("resume");
    expect(await readFile(join(workspace, "README.md"), "utf8")).toBe(
      "edited\n",
    );
    expect(
      (await readdir(workspace)).filter((name) =>
        name.startsWith(".agent-platform-"),
      ),
    ).toEqual([]);
    expect(
      await readdir(join(workspace, ".git", "agent-platform-checkpoint")),
    ).toEqual(["checkpoint.git"]);
    // Out of the tree's way: nothing new to commit or capture.
    expect(await git("status", "--porcelain")).toBe(
      " M CLAUDE.md\n M README.md\n",
    );
  });

  test("refuses bytes that fail the store's checksum as damage, like a digest mismatch (94S-345)", async () => {
    const from = await published();
    await replaceWorkspaceWithLeftovers();
    const get = from.objects.get.bind(from.objects);
    from.objects.get = async (key, version) => {
      if (key === from.ref.manifest_ref) {
        throw new ObjectIntegrityError(key, {
          cause: new Error(
            'Checksum mismatch: expected "lngI3g==" but received "mONkBA==" in response header "x-amz-checksum-crc32".',
          ),
        });
      }
      return get(key, version);
    };
    const h = restoring(from);

    const refused = h.port.restorePlan(
      await claimOf(h.gateway),
      neverStopped(),
    );

    await expect(refused).rejects.toBeInstanceOf(RestoreRefused);
    await expect(refused).rejects.toMatchObject({
      code: "CHECKPOINT_UNAVAILABLE",
    });
    expect(await readFile(join(workspace, "left-behind.txt"), "utf8")).toBe(
      "stale\n",
    );
    expect(h.errors.map(({ event }) => event)).toEqual([
      "worker.checkpoint.restore_refused",
    ]);
  });

  test("holds the manifest to this worker's runtime even when the gateway plans it", async () => {
    const from = await published();
    await replaceWorkspaceWithLeftovers();
    const h = restoring(from, {
      fingerprint: { ...runtime, profileSha256: "c".repeat(64) },
    });

    await expect(
      h.port.restorePlan(await claimOf(h.gateway), neverStopped()),
    ).rejects.toMatchObject({ code: "INCOMPATIBLE_CHECKPOINT" });
    expect(existsSync(join(workspace, "left-behind.txt"))).toBe(true);
  });

  test("refuses a manifest other than the one the claim pinned", async () => {
    const from = await published();
    await replaceWorkspaceWithLeftovers();
    const h = restoring(from, { claimed: { manifest_sha256: "f".repeat(64) } });

    await expect(
      h.port.restorePlan(await claimOf(h.gateway), neverStopped()),
    ).rejects.toThrow("not the one the claim pinned");
    expect(existsSync(join(workspace, "left-behind.txt"))).toBe(true);
  });

  test("refuses a plan for a revision the claim does not name", async () => {
    const from = await published();
    await replaceWorkspaceWithLeftovers();
    const h = restoring(from, {
      answer: () => {
        const plan = planOf(from.ref, from.manifest);
        if (plan.status !== "ready") throw new Error("unreachable");
        return {
          ...plan,
          plan: { ...plan.plan, revision: from.ref.revision + 1 },
        };
      },
    });

    await expect(
      h.port.restorePlan(await claimOf(h.gateway), neverStopped()),
    ).rejects.toThrow("not the claim's");
    expect(existsSync(join(workspace, "left-behind.txt"))).toBe(true);
  });

  test("refuses a bundle whose bytes are not the ones the manifest pinned", async () => {
    const from = await published();
    await from.objects.put(
      from.manifest.workspace.bundle.key,
      new TextEncoder().encode("overwritten"),
    );
    await replaceWorkspaceWithLeftovers();
    const h = restoring(from);

    await expect(
      h.port.restorePlan(await claimOf(h.gateway), neverStopped()),
    ).rejects.toThrow("not the bytes the manifest pinned");
    // Cleared before the download, which then needs no room beside it; the
    // spool goes with the failure.
    expect(await readdir(workspace)).toEqual([]);
  });

  test("refuses a transcript part that is gone, before touching the workspace", async () => {
    const from = await published();
    const part = from.manifest.transcripts.root.parts[0];
    if (part === undefined) throw new Error("part missing");
    from.objects.remove(part.key);
    await replaceWorkspaceWithLeftovers();
    const h = restoring(from);

    await expect(
      h.port.restorePlan(await claimOf(h.gateway), neverStopped()),
    ).rejects.toThrow();
    expect(existsSync(join(workspace, "left-behind.txt"))).toBe(true);
  });

  test("refuses a manifest whose cwd is not this workspace", async () => {
    const from = await published();
    const elsewhere = join(scratch, "elsewhere");
    await mkdir(elsewhere);
    const h = restoring(from);
    const moved = new SessionCheckpoints({
      fingerprint: () => runtime,
      gateway: h.gateway,
      logger: h.logger,
      objectPrefix: `sessions/${SESSION}/`,
      objects: from.objects,
      workspaceRoot: elsewhere,
    });

    await expect(
      moved.restorePlan(await claimOf(h.gateway), neverStopped()),
    ).rejects.toBeInstanceOf(RestoreRefused);
  });

  test("never replaces the workspace once stopped", async () => {
    const from = await published();
    await replaceWorkspaceWithLeftovers();
    const stop = new AbortController();
    const h = restoring(from, {
      answer: () => {
        // Stopped while the plan was on its way back.
        stop.abort(new Error("stopped"));
        return planOf(from.ref, from.manifest);
      },
    });

    await expect(
      h.port.restorePlan(await claimOf(h.gateway), stop.signal),
    ).rejects.toThrow("stopped");
    expect(await readFile(join(workspace, "left-behind.txt"), "utf8")).toBe(
      "stale\n",
    );
    expect(h.port.mirror()).toBeUndefined();
  });
});

describe("a long session's transcript (94S-314, 94S-296)", () => {
  const context = (claim: BootstrapClaimResponse) => ({
    scope: scopeOf(claim),
    recheck: async () => ready,
  });

  test("publishes a mirror of 25,000 parts under the manifest's object limit", async () => {
    const h = harness();
    const { claim, mirror } = await opened(h);
    const expected = [];
    for (let index = 0; index < 25_000; index += 1) {
      const entry = { type: "user", uuid: `u${index}`, message: `m${index}` };
      expected.push(entry);
      await mirror.append(root, [entry]);
    }

    const ref = await h.port.capture(ready, context(claim));

    expect(h.warnings).toEqual([]);
    if (ref === null) throw new Error("nothing published");
    const bytes = await h.objects.get(ref.manifest_ref);
    if (bytes === undefined) throw new Error("manifest missing");
    const manifest = claudeCheckpointCodec.decode(bytes);
    const referenced =
      1 +
      manifest.workspace.untracked.length +
      manifest.transcripts.root.parts.length;
    expect(referenced).toBeLessThan(20_000);
    expect(manifest.transcripts.root.parts.length).toBeLessThan(10);
    expect(manifest.transcripts.root.entryCount).toBe(25_000);
    expect(await mirror.load(root)).toEqual(expected);
  }, 60_000);

  test("a merged part that fails to upload is publish_failed, and the next capture merges it", async () => {
    const objects = createMemoryCheckpointObjectStore();
    const putImmutable = objects.putImmutable.bind(objects);
    let refuse = true;
    objects.putImmutable = async (key, bytes) => {
      if (refuse && key.includes("/merged-")) {
        throw new Error("store unavailable");
      }
      return putImmutable(key, bytes);
    };
    const h = harness({ objects });
    const { claim, mirror } = await opened(h);
    for (let index = 0; index < 600; index += 1) {
      await mirror.append(root, [{ type: "user", uuid: `u${index}` }]);
    }

    expect(await h.port.capture(ready, context(claim))).toBeNull();

    expect(
      h.gateway.checkpointRequests
        .map((request) => request.preparation)
        .filter((preparation) => preparation.status === "rejected"),
    ).toEqual([
      {
        status: "rejected",
        reason: "publish_failed",
        detail: "publish: store unavailable",
      },
    ]);
    // Nothing a finalize could commit: the last checkpoint stays the one
    // the session resumes from.
    expect(objects.keys().some((key) => key.endsWith("/manifest.json"))).toBe(
      false,
    );

    refuse = false;
    const ref = await h.port.capture(ready, context(claim));
    if (ref === null) throw new Error("nothing published");
    const bytes = await objects.get(ref.manifest_ref);
    if (bytes === undefined) throw new Error("manifest missing");
    const parts = claudeCheckpointCodec.decode(bytes).transcripts.root.parts;
    expect(parts).toHaveLength(1);
    expect(parts[0]?.key).toContain("/merged-");
  });

  test("a transcript part over the size limit is publish_failed at the transcript stage", async () => {
    const h = harness();
    const { claim, mirror } = await opened(h);
    // Enough parts that a capture within the limit would merge them.
    for (let index = 0; index < 600; index += 1) {
      await mirror.append(root, [{ type: "user", uuid: `u${index}` }]);
    }
    await mirror.append(root, [
      {
        type: "user",
        uuid: "big",
        message: "x".repeat(MAX_TRANSCRIPT_PART_BYTES),
      },
    ]);

    expect(await h.port.capture(ready, context(claim))).toBeNull();

    expect(h.warnings[0]).toMatchObject({
      event: "worker.checkpoint.failed",
      fields: { stage: "transcript" },
    });
    expect(
      h.gateway.checkpointRequests.map((request) => request.preparation),
    ).toContainEqual({
      status: "rejected",
      reason: "publish_failed",
      detail: expect.stringMatching(
        /^transcript: .*over the \d+-byte part limit$/,
      ),
    });
    // Refused before anything was merged, let alone committed.
    expect(
      h.objects
        .keys()
        .some(
          (key) => key.endsWith("/manifest.json") || key.includes("/merged-"),
        ),
    ).toBe(false);
  });
});

describe("restoring a transcript over the size limit (94S-296)", () => {
  test("is refused before any transcript part is fetched", async () => {
    const from = await published();
    // A real revision of one part just over the limit, pinned where nothing
    // is ever read from.
    const elsewhere = new ClaudeSessionStore({
      generation: 1,
      objects: createMemoryCheckpointObjectStore(),
      prefix: `sessions/${SESSION}/transcripts`,
    });
    await elsewhere.append(root, [
      {
        type: "user",
        uuid: "big",
        message: "x".repeat(MAX_TRANSCRIPT_PART_BYTES),
      },
    ]);
    const revision = await elsewhere.captureRevision(root);
    if (revision === null) throw new Error("expected a revision");
    const oversized: CheckpointManifest = {
      ...from.manifest,
      transcripts: { ...from.manifest.transcripts, root: revision },
    };
    const encoded = claudeCheckpointCodec.encode(oversized);
    await from.objects.put(from.ref.manifest_ref, encoded.bytes);
    const ref = { ...from.ref, manifest_sha256: encoded.sha256 };
    await replaceWorkspaceWithLeftovers();
    const h = restoring({ manifest: oversized, objects: from.objects, ref });
    from.objects.resetReads();

    const refused = h.port.restorePlan(
      await claimOf(h.gateway),
      neverStopped(),
    );

    await expect(refused).rejects.toBeInstanceOf(RestoreRefused);
    await expect(refused).rejects.toThrow(/over the \d+-byte part limit/);
    expect(from.objects.reads()).toEqual([from.ref.manifest_ref]);
    expect(existsSync(join(workspace, "left-behind.txt"))).toBe(true);
  });
});
