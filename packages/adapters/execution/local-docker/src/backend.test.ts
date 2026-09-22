import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type {
  ExecutionResources,
  LaunchIntent,
} from "@agent-platform/platform";
import {
  containerNameFor,
  ENV,
  ExecutionConflictError,
  IsolationContractError,
  isolationStampFor,
  LABELS,
  LocalDockerBackend,
  NO_PROXY_VALUE,
  stateOf,
  workspaceVolumeFor,
} from "./backend.ts";
import type { LocalDockerBackendConfig } from "./config.ts";
import {
  type ContainerCreateBody,
  DockerClient,
  DockerTimeoutError,
} from "./docker-client.ts";

type FakeContainer = {
  body: ContainerCreateBody;
  id: string;
  name: string;
  status: string;
  exitCode: number;
};

type FakeVolume = {
  createdAt: string;
  labels: Record<string, string>;
  name: string;
  options: Record<string, string> | null;
};

/**
 * Just enough of the Engine API to exercise the backend: create/start/
 * inspect/list/stop/delete with Docker's status codes, including the 409 a
 * name clash returns.
 */
class FakeDocker {
  readonly containers = new Map<string, FakeContainer>();
  /** name -> whether the network is `internal`. */
  readonly networks = new Map<string, boolean>([["ap-workers", true]]);
  readonly requests: Array<{ method: string; path: string }> = [];
  private nextId = 1;
  private server: ReturnType<typeof Bun.serve> | undefined;
  /** When set, the next create returns 409 without creating anything. */
  conflictNextCreate = false;
  /** Labels the race winner carries, so the winner can be a stale one. */
  raceWinnerLabels: Record<string, string> = {};
  /** Every create loses the race and leaves nothing behind. */
  conflictEveryCreate = false;
  readonly volumes = new Map<string, FakeVolume>();
  /** Off: the storage behind the `local` driver cannot carry a quota. */
  quotaSupported = true;
  /** Volumes a removal must report as still mounted, the way 409 does. */
  readonly volumesInUse = new Set<string>();

  get host(): string {
    if (!this.server) throw new Error("not started");
    return `tcp://127.0.0.1:${this.server.port}`;
  }

  start(): void {
    this.server = Bun.serve({
      fetch: (request) => this.handle(request),
      hostname: "127.0.0.1",
      port: 0,
    });
  }

  stop(): void {
    this.server?.stop(true);
  }

  add(name: string, body: ContainerCreateBody, status = "running") {
    const id = `${String(this.nextId++).padStart(4, "0")}${"a".repeat(60)}`;
    const container = { body, exitCode: 0, id, name, status };
    this.containers.set(name, container);
    return container;
  }

  addVolume(
    name: string,
    labels: Record<string, string>,
    options: Record<string, string> | null = null,
    createdAt = new Date(0).toISOString(),
  ): FakeVolume {
    const volume = { createdAt, labels, name, options };
    this.volumes.set(name, volume);
    return volume;
  }

  byIdOrName(key: string): FakeContainer | undefined {
    return (
      this.containers.get(key) ??
      [...this.containers.values()].find((c) => c.id === key)
    );
  }

  private async handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname.replace(/^\/v1\.\d+/, "");
    this.requests.push({ method: request.method, path });
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), {
        headers: { "content-type": "application/json" },
        status,
      });

    if (request.method === "POST" && path === "/containers/create") {
      const name = url.searchParams.get("name") ?? "";
      if (this.conflictEveryCreate) {
        return json({ message: "Conflict. Lost the create race" }, 409);
      }
      if (this.conflictNextCreate && !this.containers.has(name)) {
        // The other launcher won the race: its container exists by the time
        // this create is rejected, exactly what Docker reports with 409.
        this.conflictNextCreate = false;
        const winner = (await request.json()) as ContainerCreateBody;
        winner.Labels = { ...winner.Labels, ...this.raceWinnerLabels };
        this.add(name, winner);
        return json({ message: "Conflict. Lost the create race" }, 409);
      }
      if (this.containers.has(name)) {
        return json(
          {
            message: `Conflict. The container name "/${name}" is already in use`,
          },
          409,
        );
      }
      const body = (await request.json()) as ContainerCreateBody;
      const container = this.add(name, body, "created");
      return json({ Id: container.id, Warnings: [] }, 201);
    }
    if (request.method === "GET" && path === "/containers/json") {
      const filters = JSON.parse(url.searchParams.get("filters") ?? "{}") as {
        label?: string[];
      };
      const wanted = (filters.label ?? []).map(
        (l) => l.split("=") as [string, string],
      );
      const matching = [...this.containers.values()].filter((c) =>
        wanted.every(([k, v]) => c.body.Labels[k] === v),
      );
      return json(
        matching.map((c) => ({
          Id: c.id,
          Labels: c.body.Labels,
          Names: [`/${c.name}`],
          State: c.status,
        })),
      );
    }
    const asVolume = (volume: FakeVolume) => ({
      CreatedAt: volume.createdAt,
      Driver: "local",
      Labels: Object.keys(volume.labels).length === 0 ? null : volume.labels,
      Mountpoint: `/var/lib/docker/volumes/${volume.name}/_data`,
      Name: volume.name,
      Options: volume.options,
    });
    if (request.method === "POST" && path === "/volumes/create") {
      const body = (await request.json()) as {
        DriverOpts?: Record<string, string>;
        Labels?: Record<string, string>;
        Name: string;
      };
      const existing = this.volumes.get(body.Name);
      // Docker's create is not create-or-fail: an existing name comes back
      // 201 with the volume as it already is, options and labels untouched.
      if (existing) return json(asVolume(existing), 201);
      if (body.DriverOpts?.size !== undefined && !this.quotaSupported) {
        return json(
          {
            message: `create ${body.Name}: quota size requested but no quota support`,
          },
          400,
        );
      }
      return json(
        asVolume(
          this.addVolume(
            body.Name,
            body.Labels ?? {},
            body.DriverOpts ?? null,
            new Date().toISOString(),
          ),
        ),
        201,
      );
    }
    if (request.method === "GET" && path === "/volumes") {
      const filters = JSON.parse(url.searchParams.get("filters") ?? "{}") as {
        label?: string[];
      };
      const wanted = (filters.label ?? []).map(
        (l) => l.split("=") as [string, string],
      );
      const matching = [...this.volumes.values()].filter((v) =>
        wanted.every(([k, value]) => v.labels[k] === value),
      );
      return json({ Volumes: matching.map(asVolume), Warnings: null });
    }
    const volume = path.match(/^\/volumes\/([^/]+)$/);
    if (volume) {
      const name = decodeURIComponent(volume[1] ?? "");
      const found = this.volumes.get(name);
      if (!found) return json({ message: `no such volume: ${name}` }, 404);
      if (request.method === "GET") return json(asVolume(found));
      if (request.method === "DELETE") {
        if (this.volumesInUse.has(name)) {
          return json({ message: `volume ${name} is in use` }, 409);
        }
        this.volumes.delete(name);
        return new Response(null, { status: 204 });
      }
    }
    const network = path.match(/^\/networks\/([^/]+)$/);
    if (request.method === "GET" && network) {
      const name = decodeURIComponent(network[1] ?? "");
      const internal = this.networks.get(name);
      if (internal === undefined) {
        return json({ message: `network ${name} not found` }, 404);
      }
      return json({
        Containers: {},
        Driver: "bridge",
        Id: `net-${name}`,
        Internal: internal,
        Name: name,
      });
    }
    const match = path.match(/^\/containers\/([^/]+)(?:\/(start|stop|json))?$/);
    if (!match) return json({ message: "not found" }, 404);
    const key = decodeURIComponent(match[1] ?? "");
    const action = match[2];
    const container = this.byIdOrName(key);
    if (!container) return json({ message: `No such container: ${key}` }, 404);
    if (request.method === "POST" && action === "start") {
      if (container.status === "running")
        return new Response(null, { status: 304 });
      container.status = "running";
      return new Response(null, { status: 204 });
    }
    if (request.method === "POST" && action === "stop") {
      if (container.status !== "running")
        return new Response(null, { status: 304 });
      container.status = "exited";
      return new Response(null, { status: 204 });
    }
    if (request.method === "GET" && action === "json") {
      return json({
        Config: {
          Env: container.body.Env,
          Labels: container.body.Labels,
          User: container.body.User,
        },
        HostConfig: container.body.HostConfig,
        Id: container.id,
        Name: `/${container.name}`,
        State: {
          ExitCode: container.exitCode,
          Running: container.status === "running",
          Status: container.status,
        },
      });
    }
    if (request.method === "DELETE" && action === undefined) {
      this.containers.delete(container.name);
      return new Response(null, { status: 204 });
    }
    return json({ message: "unsupported" }, 405);
  }
}

const RESOURCES = { cpus: 1.5, memoryBytes: 2 * 1024 ** 3, pidsLimit: 512 };

function intentFor(overrides: Partial<LaunchIntent> = {}): LaunchIntent {
  return {
    bootstrapNonce: "nonce-abc",
    executionId: "exec-11111111-2222-3333-4444-555555555555",
    generation: 1,
    image: "worker:test",
    operationId: "op-1",
    resources: RESOURCES,
    sessionId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    ...overrides,
  };
}

const QUOTA_BYTES = 4 * 1024 * 1024 * 1024;

let docker: FakeDocker;
let backend: LocalDockerBackend;

function configFor(host: string): LocalDockerBackendConfig {
  return {
    allowedNetworks: ["ap-workers", "ap-workers-2"],
    apiVersion: "v1.44",
    dockerHost: host,
    egressProxyUrl: "http://egress-proxy:3128",
    gatewayUrl: "http://host.docker.internal:3000",
    homeDir: "/home/worker",
    installationId: "test-a",
    network: "ap-workers",
    requestTimeoutMs: 5_000,
    stopTimeoutSeconds: 3,
    tmpfsSizeBytes: 64 * 1024 * 1024,
    user: "1000:1000",
    workspaceDir: "/workspace",
    workspaceGcMinAgeMs: 0,
    workspaceQuota: { mode: "enforced", sizeBytes: QUOTA_BYTES },
  };
}

beforeEach(() => {
  docker = new FakeDocker();
  docker.start();
  backend = new LocalDockerBackend(configFor(docker.host));
});

afterEach(() => {
  docker.stop();
});

describe("LocalDockerBackend.ensureExecution", () => {
  test("creates and starts a container whose config matches the isolation contract", async () => {
    const intent = intentFor();
    const result = await backend.ensureExecution(intent);

    expect(result.created).toBe(true);
    expect(result.state).toBe("running");
    const name = containerNameFor(intent, "test-a");
    const container = docker.containers.get(name);
    expect(container).toBeDefined();
    if (!container) throw new Error("missing");
    expect(result.providerRef).toBe(container.id);

    const { body } = container;
    expect(body.Image).toBe("worker:test");
    expect(body.User).toBe("1000:1000");
    // Exactly the variables the worker contract needs, nothing else leaks in.
    expect(body.Env.sort()).toEqual(
      [
        `${ENV.home}=/home/worker`,
        `${ENV.bootstrapNonce}=nonce-abc`,
        `${ENV.executionGeneration}=1`,
        `${ENV.executionId}=${intent.executionId}`,
        `${ENV.gatewayUrl}=http://host.docker.internal:3000`,
        `${ENV.httpProxy}=http://egress-proxy:3128`,
        `${ENV.httpProxyLower}=http://egress-proxy:3128`,
        `${ENV.httpsProxy}=http://egress-proxy:3128`,
        `${ENV.httpsProxyLower}=http://egress-proxy:3128`,
        `${ENV.noProxy}=${NO_PROXY_VALUE}`,
        `${ENV.noProxyLower}=${NO_PROXY_VALUE}`,
      ].sort(),
    );
    expect(body.Labels).toEqual({
      [LABELS.executionId]: intent.executionId,
      [LABELS.generation]: "1",
      [LABELS.installation]: "test-a",
      [LABELS.isolation]: isolationStampFor(configFor(docker.host)),
      [LABELS.managed]: "true",
      [LABELS.operationId]: "op-1",
      [LABELS.sessionId]: intent.sessionId,
    });
    expect(body.HostConfig).toEqual({
      CapDrop: ["ALL"],
      Memory: RESOURCES.memoryBytes,
      Mounts: [
        {
          Source: workspaceVolumeFor(intent.sessionId, "test-a"),
          Target: "/workspace",
          Type: "volume",
        },
      ],
      NanoCpus: 1_500_000_000,
      NetworkMode: "ap-workers",
      PidsLimit: 512,
      ReadonlyRootfs: true,
      RestartPolicy: { Name: "no" },
      SecurityOpt: ["no-new-privileges"],
      Tmpfs: {
        "/home/worker": "rw,nosuid,nodev,size=67108864,uid=1000,gid=1000",
        "/tmp": "rw,nosuid,nodev,size=67108864,uid=1000,gid=1000",
      },
    });
    // No bind mounts at all: no Docker socket, no host HOME.
    expect(JSON.stringify(body)).not.toContain("docker.sock");
    expect("Binds" in body.HostConfig).toBe(false);
    // The host-gateway mapping would be a route around the proxy.
    expect(JSON.stringify(body)).not.toContain("host-gateway");
  });

  test("the same intent twice yields one container and reports created=false", async () => {
    const intent = intentFor();
    const first = await backend.ensureExecution(intent);
    const second = await backend.ensureExecution(intent);
    expect(second).toEqual({
      created: false,
      providerRef: first.providerRef,
      state: "running",
    });
    expect(docker.containers.size).toBe(1);
    expect(
      docker.requests.filter((r) => r.path === "/containers/create"),
    ).toHaveLength(1);
  });

  test("a create that loses the name race adopts the winner instead of failing", async () => {
    const intent = intentFor();
    docker.conflictNextCreate = true;
    const result = await backend.ensureExecution(intent);
    expect(result).toMatchObject({ created: false, state: "running" });
    expect(docker.containers.size).toBe(1);
    expect(
      docker.requests.filter((r) => r.path === "/containers/create"),
    ).toHaveLength(1);
  });

  test("the winner of a create race is judged by the isolation contract too", async () => {
    const intent = intentFor();
    docker.conflictNextCreate = true;
    docker.raceWinnerLabels = { [LABELS.isolation]: "1" };

    const result = await backend.ensureExecution(intent);

    // The winner was stale, so it is replaced rather than adopted.
    expect(result).toMatchObject({ created: true, state: "running" });
    expect(docker.containers.size).toBe(1);
    const fresh = docker.containers.get(containerNameFor(intent, "test-a"));
    expect(fresh?.body.Labels[LABELS.isolation]).toBe(
      isolationStampFor(configFor(docker.host)),
    );
  });

  test("a race lost to a newer contract is refused, not adopted", async () => {
    const intent = intentFor();
    docker.conflictNextCreate = true;
    docker.raceWinnerLabels = { [LABELS.isolation]: "9:0123456789abcdef" };
    await expect(backend.ensureExecution(intent)).rejects.toBeInstanceOf(
      IsolationContractError,
    );
  });

  test("a name another launcher keeps taking is a conflict, not a loop", async () => {
    const intent = intentFor();
    // Every create loses, and the winner vanishes before it can be judged.
    docker.conflictEveryCreate = true;
    await expect(backend.ensureExecution(intent)).rejects.toThrow(
      "taken by another launcher",
    );
    expect(
      docker.requests.filter((r) => r.path === "/containers/create"),
    ).toHaveLength(2);
  });

  test("a container with the same name but another operation id is a conflict, not adopted", async () => {
    const intent = intentFor();
    const body = await createBodyOf(intent);
    body.Labels[LABELS.operationId] = "someone-else";
    docker.add(containerNameFor(intent, "test-a"), body);
    await expect(backend.ensureExecution(intent)).rejects.toBeInstanceOf(
      ExecutionConflictError,
    );
    expect(docker.containers.size).toBe(1);
  });

  test("a container from an older isolation contract is replaced, not adopted", async () => {
    const intent = intentFor();
    const body = await createBodyOf(intent);
    body.Labels[LABELS.isolation] = "1";
    const stale = docker.add(containerNameFor(intent, "test-a"), body);

    const result = await backend.ensureExecution(intent);

    expect(result).toMatchObject({ created: true, state: "running" });
    expect(result.providerRef).not.toBe(stale.id);
    expect(docker.containers.size).toBe(1);
    const fresh = docker.containers.get(containerNameFor(intent, "test-a"));
    expect(fresh?.body.Labels[LABELS.isolation]).toBe(
      isolationStampFor(configFor(docker.host)),
    );
  });

  test("a container built on other isolation settings is replaced too", async () => {
    // Same contract version, but the network moved: the label has to notice.
    const intent = intentFor();
    const body = await createBodyOf(intent);
    body.Labels[LABELS.isolation] = isolationStampFor({
      ...configFor(docker.host),
      network: "ap-workers-2",
    });
    const stale = docker.add(containerNameFor(intent, "test-a"), body);

    const result = await backend.ensureExecution(intent);

    expect(result).toMatchObject({ created: true, state: "running" });
    expect(result.providerRef).not.toBe(stale.id);
  });

  test("a container from a newer contract is refused, never adopted or replaced", async () => {
    // A rollback can neither trust a boundary it cannot read nor swap it for
    // a weaker one, so it refuses and leaves the container standing.
    const intent = intentFor();
    const body = await createBodyOf(intent);
    body.Labels[LABELS.isolation] = "9:0123456789abcdef";
    const newer = docker.add(containerNameFor(intent, "test-a"), body);

    await expect(backend.ensureExecution(intent)).rejects.toBeInstanceOf(
      IsolationContractError,
    );
    await expect(backend.inspect(intent)).rejects.toBeInstanceOf(
      IsolationContractError,
    );
    expect(docker.containers.get(newer.name)?.id).toBe(newer.id);
  });

  test("an older container that is not ours is a conflict, not replaced", async () => {
    const intent = intentFor();
    for (const [label, value] of [
      [LABELS.installation, "someone-else"],
      [LABELS.operationId, "someone-else"],
    ] as const) {
      const body = await createBodyOf(intent);
      body.Labels[LABELS.isolation] = "1";
      body.Labels[label] = value;
      const name = containerNameFor(intent, "test-a");
      docker.containers.clear();
      docker.add(name, body);
      await expect(backend.ensureExecution(intent)).rejects.toBeInstanceOf(
        ExecutionConflictError,
      );
      expect(docker.containers.get(name)?.body.Labels[label]).toBe(value);
    }
  });

  test("a created-but-never-started container is started on the retry", async () => {
    const intent = intentFor();
    docker.add(
      containerNameFor(intent, "test-a"),
      await createBodyOf(intent),
      "created",
    );
    const result = await backend.ensureExecution(intent);
    expect(result).toMatchObject({ created: false, state: "running" });
  });
});

describe("LocalDockerBackend.inspect", () => {
  test("maps Docker statuses and reports a missing container as not found", async () => {
    const intent = intentFor();
    expect(await backend.inspect(intent)).toMatchObject({
      found: false,
      providerRef: null,
      state: "unknown",
    });
    const container = docker.add(
      containerNameFor(intent, "test-a"),
      await createBodyOf(intent),
    );
    expect(await backend.inspect(intent)).toMatchObject({
      found: true,
      providerRef: container.id,
      state: "running",
    });
    container.status = "exited";
    container.exitCode = 137;
    expect(await backend.inspect(intent)).toMatchObject({
      exitCode: 137,
      found: true,
      state: "terminated",
    });
  });

  test("a container from an older isolation contract is reported stale", async () => {
    const intent = intentFor();
    const body = await createBodyOf(intent);
    body.Labels[LABELS.isolation] = "1";
    docker.add(containerNameFor(intent, "test-a"), body);
    expect(await backend.inspect(intent)).toMatchObject({
      found: true,
      stale: true,
      state: "running",
    });
  });

  test("a container on the current contract is not stale", async () => {
    const intent = intentFor();
    docker.add(containerNameFor(intent, "test-a"), await createBodyOf(intent));
    expect((await backend.inspect(intent)).stale).toBeUndefined();
  });

  test("status mapping covers every Docker state", () => {
    expect(stateOf("created")).toBe("pending");
    expect(stateOf("running")).toBe("running");
    expect(stateOf("restarting")).toBe("running");
    expect(stateOf("paused")).toBe("suspended");
    expect(stateOf("removing")).toBe("terminating");
    expect(stateOf("exited")).toBe("terminated");
    expect(stateOf("dead")).toBe("terminated");
    expect(stateOf("weird")).toBe("unknown");
  });
});

describe("LocalDockerBackend.listManaged", () => {
  test("returns only containers carrying the managed label with parsable ids", async () => {
    const ours = intentFor();
    docker.add(containerNameFor(ours, "test-a"), await createBodyOf(ours));
    const foreign = await createBodyOf(
      intentFor({ executionId: "exec-foreign" }),
    );
    delete foreign.Labels[LABELS.managed];
    docker.add("someone-elses-container", foreign);
    const broken = await createBodyOf(
      intentFor({ executionId: "exec-broken" }),
    );
    broken.Labels[LABELS.generation] = "not-a-number";
    docker.add("ap-worker-broken", broken);

    expect(await backend.listManaged()).toEqual([
      {
        executionId: ours.executionId,
        generation: 1,
        providerRef: expect.any(String),
        sessionId: ours.sessionId,
        state: "running",
      },
    ]);
  });
});

describe("two installations sharing one daemon", () => {
  test("a same-named foreign container is never reported as ours", async () => {
    const intent = intentFor();
    const body = await createBodyOf(intent);
    body.Labels[LABELS.installation] = "test-b";
    docker.add(containerNameFor(intent, "test-a"), body);
    await expect(backend.inspect(intent)).rejects.toBeInstanceOf(
      ExecutionConflictError,
    );
  });

  test("resources Docker would read as unlimited are refused", async () => {
    const base = intentFor();
    const cases: Array<[ExecutionResources, string]> = [
      [{ cpus: 1e-10, memoryBytes: 1024, pidsLimit: 8 }, "no CPU limit"],
      [{ cpus: 1, memoryBytes: 0, pidsLimit: 8 }, "memoryBytes"],
      [{ cpus: 1, memoryBytes: 1024, pidsLimit: 0 }, "pidsLimit"],
      [{ cpus: 1, memoryBytes: 1024, pidsLimit: -1 }, "pidsLimit"],
    ];
    for (const [resources, message] of cases) {
      await expect(
        backend.ensureExecution({ ...base, resources }),
      ).rejects.toThrow(message);
    }
    expect(docker.containers.size).toBe(0);
  });

  test("neither lists, adopts nor terminates the other's containers", async () => {
    const intent = intentFor();
    const other = new LocalDockerBackend({
      ...configFor(docker.host),
      installationId: "test-b",
    });
    await backend.ensureExecution(intent);

    expect(await other.listManaged()).toEqual([]);
    expect((await backend.listManaged()).map((m) => m.executionId)).toEqual([
      intent.executionId,
    ]);
    // Same ids (a cloned database) land on distinct names and volumes, so
    // the other installation gets its own container instead of adopting ours.
    const theirs = await other.ensureExecution(intent);
    expect(theirs.created).toBe(true);
    expect(docker.containers.size).toBe(2);
    expect(docker.containers.has(containerNameFor(intent, "test-b"))).toBe(
      true,
    );
    const theirBody = docker.containers.get(containerNameFor(intent, "test-b"));
    expect(theirBody?.body.HostConfig.Mounts[0]?.Source).toBe(
      workspaceVolumeFor(intent.sessionId, "test-b"),
    );
    expect(await other.inspect(intent)).toMatchObject({ found: true });

    expect(await other.terminate(intent)).toMatchObject({
      outcome: "terminated",
    });
    expect(docker.containers.has(containerNameFor(intent, "test-a"))).toBe(
      true,
    );
    expect(await other.listManaged()).toEqual([]);
    expect(await backend.listManaged()).toHaveLength(1);
  });
});

describe("LocalDockerBackend.terminate", () => {
  test("stops and removes the matching generation only", async () => {
    const gen1 = intentFor({ generation: 1, operationId: "op-1" });
    const gen2 = intentFor({ generation: 2, operationId: "op-2" });
    docker.add(containerNameFor(gen1, "test-a"), await createBodyOf(gen1));
    const kept = docker.add(
      containerNameFor(gen2, "test-a"),
      await createBodyOf(gen2),
    );

    const result = await backend.terminate(gen1);
    expect(result.outcome).toBe("terminated");
    expect(docker.containers.has(containerNameFor(gen1, "test-a"))).toBe(false);
    expect(docker.containers.get(containerNameFor(gen2, "test-a"))).toBe(kept);
    expect(kept.status).toBe("running");
    expect(
      docker.requests.filter(
        (r) => r.path.endsWith("/stop") || r.method === "DELETE",
      ),
    ).toHaveLength(2);
  });

  test("reports a generation mismatch without touching the other generation", async () => {
    const live = intentFor({ generation: 3 });
    const container = docker.add(
      containerNameFor(live, "test-a"),
      await createBodyOf(live),
    );
    const result = await backend.terminate({ ...live, generation: 2 });
    expect(result).toEqual({
      foundGeneration: 3,
      outcome: "generation_mismatch",
    });
    expect(container.status).toBe("running");
    expect(docker.requests.some((r) => r.method === "DELETE")).toBe(false);
  });

  test("reports absent when nothing exists for the execution", async () => {
    expect(await backend.terminate(intentFor())).toEqual({ outcome: "absent" });
  });

  test("a label that lies about its generation is not terminated", async () => {
    const intent = intentFor({ generation: 1 });
    const body = await createBodyOf(intent);
    body.Labels[LABELS.generation] = "7";
    docker.add(containerNameFor(intent, "test-a"), body);
    expect(await backend.terminate(intent)).toEqual({
      foundGeneration: 7,
      outcome: "generation_mismatch",
    });
    expect(docker.containers.size).toBe(1);
  });
});

describe("a daemon that accepts the connection but never answers", () => {
  test("every call fails with DockerTimeoutError at the configured deadline", async () => {
    const stalled = Bun.serve({
      fetch: () => new Promise<Response>(() => undefined),
      hostname: "127.0.0.1",
      port: 0,
    });
    try {
      const client = new DockerClient(
        `tcp://127.0.0.1:${stalled.port}`,
        "v1.44",
        { timeoutMs: 100 },
      );
      const slow = new LocalDockerBackend(
        configFor(`tcp://127.0.0.1:${stalled.port}`),
        client,
      );
      const started = Date.now();
      await expect(slow.inspect(intentFor())).rejects.toBeInstanceOf(
        DockerTimeoutError,
      );
      await expect(slow.ensureExecution(intentFor())).rejects.toBeInstanceOf(
        DockerTimeoutError,
      );
      await expect(slow.listManaged()).rejects.toBeInstanceOf(
        DockerTimeoutError,
      );
      expect(Date.now() - started).toBeLessThan(2_000);
    } finally {
      stalled.stop(true);
    }
  });

  test("rejects a non-positive deadline", () => {
    expect(
      () => new DockerClient("tcp://127.0.0.1:1", "v1.44", { timeoutMs: 0 }),
    ).toThrow("timeout");
  });
});

describe("names", () => {
  test("container and volume names are deterministic and validated", () => {
    expect(
      containerNameFor({ executionId: "exec-1", generation: 2 }, "test-a"),
    ).toBe("ap-worker-test-a-exec-1-g2");
    expect(workspaceVolumeFor("s-1", "test-a")).toBe("ap-ws-test-a-s-1");
    expect(() =>
      containerNameFor({ executionId: "../x", generation: 1 }, "test-a"),
    ).toThrow();
    expect(() => workspaceVolumeFor("a b", "test-a")).toThrow();
  });
});

/** Runs a throwaway backend against a throwaway daemon to capture the body. */
async function createBodyOf(
  intent: LaunchIntent,
): Promise<ContainerCreateBody> {
  const scratch = new FakeDocker();
  scratch.start();
  try {
    await new LocalDockerBackend(configFor(scratch.host)).ensureExecution(
      intent,
    );
    const [container] = scratch.containers.values();
    if (!container) throw new Error("no container created");
    return JSON.parse(JSON.stringify(container.body));
  } finally {
    scratch.stop();
  }
}

describe("LocalDockerBackend.verifyNetworkIsolation", () => {
  test("an internal worker network passes", async () => {
    await expect(backend.verifyNetworkIsolation()).resolves.toBeUndefined();
  });

  test("a network that does not exist refuses the launch", async () => {
    docker.networks.delete("ap-workers");
    await expect(backend.verifyNetworkIsolation()).rejects.toThrow(
      "does not exist",
    );
  });

  test("a routable network refuses the launch", async () => {
    // The allowlist only vouches for the name; only the daemon knows whether
    // that network can actually reach the host.
    docker.networks.set("ap-workers", false);
    await expect(backend.verifyNetworkIsolation()).rejects.toThrow(
      "is not internal",
    );
  });
});

describe("LocalDockerBackend workspace volumes", () => {
  const volumeName = workspaceVolumeFor(intentFor().sessionId, "test-a");

  function backendWith(
    overrides: Partial<LocalDockerBackendConfig>,
  ): LocalDockerBackend {
    return new LocalDockerBackend({ ...configFor(docker.host), ...overrides });
  }

  test("the volume is created, labelled and bounded before the container", async () => {
    await backend.ensureExecution(intentFor());
    const volume = docker.volumes.get(volumeName);
    expect(volume?.options).toEqual({ size: String(QUOTA_BYTES) });
    expect(volume?.labels).toEqual({
      [LABELS.installation]: "test-a",
      [LABELS.managed]: "true",
      [LABELS.sessionId]: intentFor().sessionId,
      [LABELS.workspaceQuota]: `enforced:${QUOTA_BYTES}`,
    });
    // Naming a volume in `Mounts` is enough for Docker to conjure an
    // unlabelled, unbounded one, so the order is the whole point.
    const paths = docker.requests.map((r) => r.path);
    expect(paths.indexOf("/volumes/create")).toBeLessThan(
      paths.indexOf("/containers/create"),
    );
  });

  test("an unlabelled volume from before the quota refuses the launch", async () => {
    // Exactly what an implicit `Mounts` create leaves behind: no labels, no
    // size, and no way to put one on it now.
    docker.addVolume(volumeName, {});
    await expect(backend.ensureExecution(intentFor())).rejects.toThrow(
      "was created under quota <none>",
    );
    expect(docker.containers.size).toBe(0);
  });

  test("a volume created under another ceiling refuses the launch", async () => {
    docker.addVolume(
      volumeName,
      {
        [LABELS.installation]: "test-a",
        [LABELS.managed]: "true",
        [LABELS.sessionId]: intentFor().sessionId,
        [LABELS.workspaceQuota]: "enforced:123",
      },
      { size: "123" },
    );
    await expect(backend.ensureExecution(intentFor())).rejects.toThrow(
      "was created under quota enforced:123",
    );
  });

  test("a volume labelled ours but without the driver option refuses the launch", async () => {
    docker.addVolume(volumeName, {
      [LABELS.installation]: "test-a",
      [LABELS.managed]: "true",
      [LABELS.sessionId]: intentFor().sessionId,
      [LABELS.workspaceQuota]: `enforced:${QUOTA_BYTES}`,
    });
    await expect(backend.ensureExecution(intentFor())).rejects.toThrow(
      "driver option size=<none>",
    );
  });

  test("another installation's volume under our name refuses the launch", async () => {
    docker.addVolume(volumeName, {
      [LABELS.installation]: "test-b",
      [LABELS.managed]: "true",
      [LABELS.workspaceQuota]: `enforced:${QUOTA_BYTES}`,
    });
    await expect(backend.ensureExecution(intentFor())).rejects.toThrow(
      "belongs to installation test-b",
    );
  });

  test("the right ceiling on the wrong session's volume refuses the launch", async () => {
    // Mounting it would hand this session someone else's working tree, and
    // GC reads the same label, so the mislabelled volume would also outlive
    // the session it actually belongs to.
    docker.addVolume(
      volumeName,
      {
        [LABELS.installation]: "test-a",
        [LABELS.managed]: "true",
        [LABELS.sessionId]: "some-other-session",
        [LABELS.workspaceQuota]: `enforced:${QUOTA_BYTES}`,
      },
      { size: String(QUOTA_BYTES) },
    );
    await expect(backend.ensureExecution(intentFor())).rejects.toThrow(
      "is not this session's workspace",
    );
    expect(docker.containers.size).toBe(0);
  });

  test("a volume that is not managed refuses the launch", async () => {
    docker.addVolume(
      volumeName,
      {
        [LABELS.installation]: "test-a",
        [LABELS.sessionId]: intentFor().sessionId,
        [LABELS.workspaceQuota]: `enforced:${QUOTA_BYTES}`,
      },
      { size: String(QUOTA_BYTES) },
    );
    await expect(backend.ensureExecution(intentFor())).rejects.toThrow(
      "managed=<none>",
    );
  });

  test("with the quota off the volume is created without a size", async () => {
    const off = backendWith({ workspaceQuota: { mode: "off" } });
    await off.ensureExecution(intentFor());
    const volume = docker.volumes.get(volumeName);
    expect(volume?.options).toBeNull();
    expect(volume?.labels[LABELS.workspaceQuota]).toBe("off");
  });

  test("turning the quota on over an opted-out volume refuses the launch", async () => {
    await backendWith({ workspaceQuota: { mode: "off" } }).ensureExecution(
      intentFor(),
    );
    docker.containers.clear();
    await expect(backend.ensureExecution(intentFor())).rejects.toThrow(
      "was created under quota off",
    );
  });
});

describe("LocalDockerBackend.verifyWorkspaceQuota", () => {
  const probe = "ap-quota-probe-test-a";

  test("a quota-capable daemon passes and keeps no probe volume", async () => {
    await expect(backend.verifyWorkspaceQuota()).resolves.toBeUndefined();
    expect(docker.volumes.has(probe)).toBe(false);
  });

  test("a daemon with no quota support refuses to start, naming the opt-out", async () => {
    docker.quotaSupported = false;
    await expect(backend.verifyWorkspaceQuota()).rejects.toThrow(
      "EXECUTION_WORKSPACE_QUOTA=off",
    );
  });

  test("a probe volume left by an earlier run cannot make the probe pass", async () => {
    // Docker hands an existing name straight back, so a leftover probe would
    // otherwise look like a create that succeeded on a daemon that cannot.
    docker.quotaSupported = false;
    docker.addVolume(
      probe,
      {
        [LABELS.installation]: "test-a",
        [LABELS.quotaProbe]: "true",
      },
      { size: String(QUOTA_BYTES) },
    );
    await expect(backend.verifyWorkspaceQuota()).rejects.toThrow(
      "cannot put a size quota",
    );
  });

  test("a volume under the probe's name that is not a probe is left alone", async () => {
    // The name is not proof of ownership, and the preflight is not a licence
    // to delete a stranger's data on a shared daemon.
    docker.addVolume(probe, { "com.example.owner": "someone-else" });
    await expect(backend.verifyWorkspaceQuota()).rejects.toThrow(
      "is not this host's quota probe",
    );
    expect(docker.volumes.has(probe)).toBe(true);
  });

  test("another installation's probe is not this one's to remove", async () => {
    docker.addVolume(probe, {
      [LABELS.installation]: "test-b",
      [LABELS.quotaProbe]: "true",
    });
    await expect(backend.verifyWorkspaceQuota()).rejects.toThrow(
      "is not this host's quota probe",
    );
    expect(docker.volumes.has(probe)).toBe(true);
  });

  test("the probe volume carries no managed label for GC to trip over", async () => {
    // Nothing to assert after the fact — it is removed — so the record of
    // what was asked for is the request the daemon saw.
    await backend.verifyWorkspaceQuota();
    const created = docker.requests.filter((r) => r.path === "/volumes/create");
    expect(created).toHaveLength(1);
    expect(docker.volumes.size).toBe(0);
    // And it is invisible to the reaper, which lists by the managed label.
    expect(await backend.listWorkspaces()).toEqual([]);
  });

  test("the opt-out asks the daemon nothing", async () => {
    const off = new LocalDockerBackend({
      ...configFor(docker.host),
      workspaceQuota: { mode: "off" },
    });
    await expect(off.verifyWorkspaceQuota()).resolves.toBeUndefined();
    expect(docker.requests).toHaveLength(0);
  });
});

describe("LocalDockerBackend workspace GC", () => {
  const ours = {
    [LABELS.installation]: "test-a",
    [LABELS.managed]: "true",
    [LABELS.sessionId]: "session-1",
  };

  test("lists only this installation's managed volumes", async () => {
    docker.addVolume("ap-ws-test-a-session-1", ours);
    docker.addVolume("ap-ws-test-b-session-2", {
      ...ours,
      [LABELS.installation]: "test-b",
    });
    docker.addVolume("someone-elses", {});
    const listed = await backend.listWorkspaces();
    expect(listed.map((w) => w.id)).toEqual(["ap-ws-test-a-session-1"]);
    expect(listed[0]?.sessionId).toBe("session-1");
  });

  test("a volume younger than the minimum age is not a candidate", async () => {
    const young = new LocalDockerBackend({
      ...configFor(docker.host),
      workspaceGcMinAgeMs: 60_000,
    });
    docker.addVolume("ap-ws-test-a-old", ours);
    docker.addVolume("ap-ws-test-a-new", ours, null, new Date().toISOString());
    expect((await young.listWorkspaces()).map((w) => w.id)).toEqual([
      "ap-ws-test-a-old",
    ]);
  });

  test("a volume with no session label is reported, not judged by its name", async () => {
    docker.addVolume("ap-ws-test-a-session-9", {
      [LABELS.installation]: "test-a",
      [LABELS.managed]: "true",
    });
    expect((await backend.listWorkspaces())[0]?.sessionId).toBeNull();
  });

  test("removing reports removed, absent, in use and not ours", async () => {
    docker.addVolume("ap-ws-test-a-session-1", ours);
    expect(await backend.removeWorkspace("ap-ws-test-a-session-1")).toEqual({
      outcome: "removed",
    });
    expect(await backend.removeWorkspace("ap-ws-test-a-gone")).toEqual({
      outcome: "absent",
    });
    docker.addVolume("ap-ws-test-a-session-2", ours);
    docker.volumesInUse.add("ap-ws-test-a-session-2");
    expect(await backend.removeWorkspace("ap-ws-test-a-session-2")).toEqual({
      outcome: "in_use",
    });
    docker.addVolume("ap-ws-test-b-session-3", {
      ...ours,
      [LABELS.installation]: "test-b",
    });
    expect(await backend.removeWorkspace("ap-ws-test-b-session-3")).toEqual({
      outcome: "not_ours",
    });
    expect(docker.volumes.has("ap-ws-test-b-session-3")).toBe(true);
  });
});
