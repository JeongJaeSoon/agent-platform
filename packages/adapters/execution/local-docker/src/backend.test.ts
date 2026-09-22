import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { LaunchIntent } from "@agent-platform/platform";
import {
  containerNameFor,
  ENV,
  ExecutionConflictError,
  LABELS,
  LocalDockerBackend,
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

/**
 * Just enough of the Engine API to exercise the backend: create/start/
 * inspect/list/stop/delete with Docker's status codes, including the 409 a
 * name clash returns.
 */
class FakeDocker {
  readonly containers = new Map<string, FakeContainer>();
  readonly requests: Array<{ method: string; path: string }> = [];
  private nextId = 1;
  private server: ReturnType<typeof Bun.serve> | undefined;
  /** When set, the next create returns 409 without creating anything. */
  conflictNextCreate = false;

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
      if (this.conflictNextCreate && !this.containers.has(name)) {
        // The other launcher won the race: its container exists by the time
        // this create is rejected, exactly what Docker reports with 409.
        this.conflictNextCreate = false;
        this.add(name, (await request.json()) as ContainerCreateBody);
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

let docker: FakeDocker;
let backend: LocalDockerBackend;

function configFor(host: string): LocalDockerBackendConfig {
  return {
    allowedNetworks: ["ap-workers", "bridge"],
    apiVersion: "v1.44",
    dockerHost: host,
    gatewayUrl: "http://host.docker.internal:3000",
    homeDir: "/home/worker",
    installationId: "test-a",
    network: "ap-workers",
    requestTimeoutMs: 5_000,
    stopTimeoutSeconds: 3,
    tmpfsSizeBytes: 64 * 1024 * 1024,
    user: "1000:1000",
    workspaceDir: "/workspace",
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
    // Exactly the two variables the ticket allows, nothing else leaks in.
    expect(body.Env.sort()).toEqual([
      `${ENV.bootstrapNonce}=nonce-abc`,
      `${ENV.executionGeneration}=1`,
      `${ENV.executionId}=${intent.executionId}`,
      `${ENV.gatewayUrl}=http://host.docker.internal:3000`,
    ]);
    expect(body.Labels).toEqual({
      [LABELS.executionId]: intent.executionId,
      [LABELS.generation]: "1",
      [LABELS.installation]: "test-a",
      [LABELS.managed]: "true",
      [LABELS.operationId]: "op-1",
      [LABELS.sessionId]: intent.sessionId,
    });
    expect(body.HostConfig).toEqual({
      CapDrop: ["ALL"],
      ExtraHosts: ["host.docker.internal:host-gateway"],
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
        "/home/worker": "rw,nosuid,nodev,size=67108864",
        "/tmp": "rw,nosuid,nodev,size=67108864",
      },
    });
    // No bind mounts at all: no Docker socket, no host HOME.
    expect(JSON.stringify(body)).not.toContain("docker.sock");
    expect("Binds" in body.HostConfig).toBe(false);
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

  test("cpus that round to zero NanoCpus are refused", async () => {
    const intent = {
      ...intentFor(),
      resources: { cpus: 1e-10, memoryBytes: 1024, pidsLimit: 8 },
    };
    await expect(backend.ensureExecution(intent)).rejects.toThrow(
      "no CPU limit",
    );
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
