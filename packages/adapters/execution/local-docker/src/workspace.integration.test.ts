import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { LaunchIntent } from "@agent-platform/platform";
import { LABELS, LocalDockerBackend, workspaceVolumeFor } from "./backend.ts";
import type { LocalDockerBackendConfig, WorkspaceQuota } from "./config.ts";
import { DockerApiError, DockerClient } from "./docker-client.ts";

/**
 * Workspace volumes against a real daemon: the ceiling, the labels GC reads,
 * and the reclaim. Opt in with `DOCKER_BACKEND_TEST=1`.
 *
 * The ceiling only exists where the daemon's storage can carry one — xfs with
 * `prjquota` — and neither of the two daemons this repo runs on has it.
 * Docker Desktop's LinuxKit kernel is built without XFS quota support at all
 * (`XFS (loop0): quota support not available in this kernel`), and a stock
 * Linux runner keeps its data root on ext4; both answer
 * `POST /volumes/create` with 400 `quota size requested but no quota support`.
 * So this suite probes the daemon and asserts what that daemon can prove:
 * enforcement where a quota exists, refusal to start where it does not. The
 * `workspace-quota` CI job builds a daemon that has one, which is where the
 * disk-pressure test actually runs.
 */
const enabled = process.env.DOCKER_BACKEND_TEST === "1";
const integration = enabled ? describe : describe.skip;
const IMAGE = process.env.DOCKER_BACKEND_TEST_IMAGE ?? "busybox:1.36";
const dockerHost = process.env.DOCKER_HOST ?? (await defaultDockerHost());
/** Small enough that filling it is a second of `dd`, not a minute. */
const QUOTA_BYTES = 64 * 1024 * 1024;

async function defaultDockerHost(): Promise<string> {
  const candidates = [
    "/var/run/docker.sock",
    `${process.env.HOME}/.docker/run/docker.sock`,
  ];
  for (const path of candidates) {
    if (await Bun.file(path).exists()) return `unix://${path}`;
  }
  return "unix:///var/run/docker.sock";
}

integration("workspace volumes against a real daemon", () => {
  const client = new DockerClient(dockerHost);
  const installationId = `wsit-${crypto.randomUUID().slice(0, 8)}`;
  const workerNetwork = `ap-ws-net-${crypto.randomUUID().slice(0, 8)}`;
  const sessionIds: string[] = [];
  /** Volumes made outside the backend, so cleanup knows about them too. */
  const strayVolumes: string[] = [];
  let supportsQuota = false;

  const backendConfig = (): LocalDockerBackendConfig => ({
    allowedNetworks: [workerNetwork],
    apiVersion: "v1.44",
    command: ["sleep", "600"],
    dockerHost,
    egressProxyUrl: "http://egress-proxy:3128",
    gatewayUrl: "http://host.docker.internal:3000",
    homeDir: "/home/worker",
    installationId,
    network: workerNetwork,
    requestTimeoutMs: 30_000,
    stopTimeoutSeconds: 1,
    tmpfsSizeBytes: 16 * 1024 * 1024,
    user: "1000:1000",
    workspaceDir: "/workspace",
    workspaceGcMinAgeMs: 0,
    workspaceQuota: quota(),
  });

  /** What this daemon can actually be held to. */
  function quota(): WorkspaceQuota {
    return supportsQuota
      ? { mode: "enforced", sizeBytes: QUOTA_BYTES }
      : { mode: "off" };
  }

  function intentFor(): LaunchIntent {
    const suffix = crypto.randomUUID();
    const sessionId = crypto.randomUUID();
    sessionIds.push(sessionId);
    return {
      bootstrapNonce: `nonce-${suffix}`,
      executionId: `exec-${suffix}`,
      generation: 1,
      image: IMAGE,
      operationId: `op-${suffix}`,
      resources: { cpus: 0.5, memoryBytes: 128 * 1024 * 1024, pidsLimit: 64 },
      sessionId,
    };
  }

  beforeAll(async () => {
    await client.version();
    await client.createNetwork({ Internal: true, Name: workerNetwork });
    await new DockerClient(dockerHost, "v1.44", {
      timeoutMs: 110_000,
    }).pullImage(IMAGE);
    supportsQuota = await probeQuotaSupport();
  }, 120_000);

  afterAll(async () => {
    for (const sessionId of sessionIds) {
      const name = workspaceVolumeFor(sessionId, installationId);
      for (const container of await client.listContainers([
        `${LABELS.sessionId}=${sessionId}`,
      ])) {
        await client.stopAndRemoveContainer(container.Id, 1).catch(() => {});
      }
      await client.removeVolume(name).catch(() => {});
    }
    for (const name of strayVolumes) {
      await client.removeVolume(name).catch(() => {});
    }
    await client.removeNetwork(workerNetwork).catch(() => {});
  }, 60_000);

  /** The same question the preflight asks, asked here without an opinion. */
  async function probeQuotaSupport(): Promise<boolean> {
    const name = `ap-ws-probe-${installationId}`;
    strayVolumes.push(name);
    try {
      const volume = await client.createVolume({
        Driver: "local",
        DriverOpts: { size: String(QUOTA_BYTES) },
        Labels: {},
        Name: name,
      });
      return Number(volume.Options?.size) === QUOTA_BYTES;
    } catch (error) {
      if (error instanceof DockerApiError) return false;
      throw error;
    } finally {
      await client.removeVolume(name).catch(() => {});
    }
  }

  test("the volume is labelled for GC and stamped with its ceiling", async () => {
    const backend = new LocalDockerBackend(backendConfig(), client);
    const intent = intentFor();
    await backend.ensureExecution(intent);

    const volume = await client.inspectVolume(
      workspaceVolumeFor(intent.sessionId, installationId),
    );
    expect(volume?.Labels).toMatchObject({
      [LABELS.installation]: installationId,
      [LABELS.managed]: "true",
      [LABELS.sessionId]: intent.sessionId,
      [LABELS.workspaceQuota]: supportsQuota
        ? `enforced:${QUOTA_BYTES}`
        : "off",
    });
    expect(volume?.Options?.size).toBe(
      supportsQuota ? String(QUOTA_BYTES) : undefined,
    );
  }, 60_000);

  test("preflight either proves the ceiling or refuses to start", async () => {
    const strict = new LocalDockerBackend(
      {
        ...backendConfig(),
        workspaceQuota: { mode: "enforced", sizeBytes: QUOTA_BYTES },
      },
      client,
    );
    if (supportsQuota) {
      await expect(strict.verifyWorkspaceQuota()).resolves.toBeUndefined();
    } else {
      await expect(strict.verifyWorkspaceQuota()).rejects.toThrow(
        "EXECUTION_WORKSPACE_QUOTA=off",
      );
    }
    // Either way it leaves nothing behind.
    expect(
      await client.inspectVolume(`ap-quota-probe-${installationId}`),
    ).toBeNull();
  }, 60_000);

  test("the opt-out asks the daemon for nothing", async () => {
    const off = new LocalDockerBackend(
      { ...backendConfig(), workspaceQuota: { mode: "off" } },
      client,
    );
    await expect(off.verifyWorkspaceQuota()).resolves.toBeUndefined();
  });

  test("a workspace is reclaimed once nothing mounts it", async () => {
    const backend = new LocalDockerBackend(backendConfig(), client);
    const intent = intentFor();
    await backend.ensureExecution(intent);
    const name = workspaceVolumeFor(intent.sessionId, installationId);

    const listed = await backend.listWorkspaces();
    expect(listed.map((w) => w.id)).toContain(name);
    expect(listed.find((w) => w.id === name)?.sessionId).toBe(intent.sessionId);

    // The container still holds it: Docker answers 409, and that is a
    // "leave it", not a "force it".
    expect(await backend.removeWorkspace(name)).toEqual({
      outcome: "in_use",
    });
    expect(await client.inspectVolume(name)).not.toBeNull();

    await backend.terminate(intent);
    expect(await backend.removeWorkspace(name)).toEqual({
      outcome: "removed",
    });
    expect(await client.inspectVolume(name)).toBeNull();
  }, 120_000);

  test("another installation's volume is not this one's to remove", async () => {
    const name = `ap-ws-other-${crypto.randomUUID().slice(0, 8)}`;
    strayVolumes.push(name);
    await client.createVolume({
      Driver: "local",
      Labels: {
        [LABELS.installation]: "someone-else",
        [LABELS.managed]: "true",
      },
      Name: name,
    });
    const backend = new LocalDockerBackend(backendConfig(), client);

    expect(await backend.removeWorkspace(name)).toEqual({
      outcome: "not_ours",
    });
    expect(await client.inspectVolume(name)).not.toBeNull();
    // It is not even a candidate: the listing is filtered by installation.
    expect((await backend.listWorkspaces()).map((w) => w.id)).not.toContain(
      name,
    );
  }, 60_000);
});

/**
 * The acceptance run for the ceiling itself, and the only test that needs a
 * quota-capable daemon. It runs wherever one exists; see the suite comment
 * for why that is neither a Mac nor a stock Linux runner.
 */
integration("workspace disk pressure", () => {
  const client = new DockerClient(dockerHost);
  const name = `ap-ws-quota-${crypto.randomUUID().slice(0, 8)}`;
  let capable = false;

  beforeAll(async () => {
    await new DockerClient(dockerHost, "v1.44", {
      timeoutMs: 110_000,
    }).pullImage(IMAGE);
    try {
      const volume = await client.createVolume({
        Driver: "local",
        DriverOpts: { size: String(QUOTA_BYTES) },
        Labels: {},
        Name: name,
      });
      capable = Number(volume.Options?.size) === QUOTA_BYTES;
    } catch (error) {
      if (!(error instanceof DockerApiError)) throw error;
    }
  }, 120_000);

  afterAll(async () => {
    await client.removeVolume(name).catch(() => {});
  });

  /**
   * Runs `script` against the volume and hands back its exit status. The
   * container is root and otherwise unconstrained on purpose: what is under
   * test is the volume's ceiling, not the worker's isolation, and a fresh
   * volume is root-owned until an image seeds it.
   */
  async function runAgainstVolume(script: string): Promise<number> {
    const container = `ap-ws-dd-${crypto.randomUUID().slice(0, 8)}`;
    await client.createContainer(container, {
      Cmd: ["sh", "-c", script],
      Env: [],
      HostConfig: {
        CapDrop: [],
        Memory: 256 * 1024 * 1024,
        Mounts: [{ Source: name, Target: "/workspace", Type: "volume" }],
        NanoCpus: 1_000_000_000,
        NetworkMode: "none",
        PidsLimit: 64,
        ReadonlyRootfs: false,
        RestartPolicy: { Name: "no" },
        SecurityOpt: [],
        Tmpfs: {},
      },
      Image: IMAGE,
      Labels: {},
      User: "0:0",
    });
    try {
      await client.startContainer(container);
      for (let attempt = 0; attempt < 120; attempt += 1) {
        const inspected = await client.inspectContainer(container);
        if (inspected && !inspected.State.Running) {
          return inspected.State.ExitCode;
        }
        await Bun.sleep(500);
      }
      throw new Error(`${container} never exited`);
    } finally {
      await client.stopAndRemoveContainer(container, 1).catch(() => {});
    }
  }

  test("writing past the ceiling fails while writing under it succeeds", async () => {
    if (!capable) {
      // Nothing to assert: this daemon cannot put a ceiling on a volume, and
      // the suite above is what holds it to refusing to start instead.
      expect(capable).toBe(false);
      return;
    }
    expect(
      await runAgainstVolume(
        "dd if=/dev/zero of=/workspace/under bs=1M count=16",
      ),
    ).toBe(0);
    // The pipeline's status is grep's, so exit 0 means `dd` really said it.
    expect(
      await runAgainstVolume(
        "dd if=/dev/zero of=/workspace/over bs=1M count=256 2>&1 | grep -q 'No space left on device'",
      ),
    ).toBe(0);
    // And the ceiling is the configured one, not the host's free space.
    expect(
      await runAgainstVolume(
        `test "$(df -P -k /workspace | awk 'NR==2 {print $2}')" -le ${QUOTA_BYTES / 1024}`,
      ),
    ).toBe(0);
  }, 180_000);

  test("a volume re-created under the same name still enforces its ceiling", async () => {
    // Workspace names are deterministic, so a volume removed by GC or by an
    // operator comes back under the name it had. If the daemon kept only the
    // `size` metadata and dropped the project quota behind it, `Options.size`
    // would still look right and the workspace would be unbounded. This is
    // the only place in the repo that can tell the difference.
    if (!capable) {
      expect(capable).toBe(false);
      return;
    }
    await client.removeVolume(name);
    const again = await client.createVolume({
      Driver: "local",
      DriverOpts: { size: String(QUOTA_BYTES) },
      Labels: {},
      Name: name,
    });
    expect(Number(again.Options?.size)).toBe(QUOTA_BYTES);

    expect(
      await runAgainstVolume(
        "dd if=/dev/zero of=/workspace/over bs=1M count=256 2>&1 | grep -q 'No space left on device'",
      ),
    ).toBe(0);
  }, 180_000);
});
