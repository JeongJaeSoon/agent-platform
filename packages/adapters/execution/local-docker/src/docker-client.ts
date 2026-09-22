/**
 * The slice of the Docker Engine API this backend uses, spoken directly over
 * the daemon socket with Bun's `fetch`. No SDK: the surface is five calls and
 * the request bodies are the audit trail for what a worker container gets.
 */

export const DEFAULT_DOCKER_HOST = "unix:///var/run/docker.sock";
export const DEFAULT_DOCKER_API_VERSION = "v1.44";

export type DockerEndpoint =
  | { kind: "unix"; socketPath: string }
  | { kind: "http"; baseUrl: string };

/** Accepts the `DOCKER_HOST` forms: `unix://`, `tcp://`, `http(s)://`. */
export function parseDockerHost(host: string): DockerEndpoint {
  if (host.startsWith("unix://")) {
    const socketPath = host.slice("unix://".length);
    if (socketPath.length === 0) {
      throw new Error(`DOCKER_HOST ${host} has no socket path`);
    }
    return { kind: "unix", socketPath };
  }
  if (host.startsWith("tcp://")) {
    return { kind: "http", baseUrl: `http://${host.slice("tcp://".length)}` };
  }
  if (host.startsWith("http://") || host.startsWith("https://")) {
    return { kind: "http", baseUrl: host };
  }
  throw new Error(
    `DOCKER_HOST ${host} must start with unix://, tcp://, http:// or https://`,
  );
}

export class DockerApiError extends Error {
  constructor(
    readonly status: number,
    readonly method: string,
    readonly path: string,
    readonly body: string,
  ) {
    super(`Docker API ${method} ${path} failed with ${status}: ${body}`);
    this.name = "DockerApiError";
  }
}

export type ContainerCreateBody = {
  Cmd?: string[];
  Env: string[];
  HostConfig: {
    CapDrop: string[];
    Memory: number;
    Mounts: Array<{
      ReadOnly?: boolean;
      Source: string;
      Target: string;
      Type: "volume" | "tmpfs";
    }>;
    NanoCpus: number;
    NetworkMode: string;
    PidsLimit: number;
    ReadonlyRootfs: boolean;
    RestartPolicy: { Name: "no" };
    SecurityOpt: string[];
    Tmpfs: Record<string, string>;
  };
  Image: string;
  Labels: Record<string, string>;
  User: string;
};

export type ContainerInspect = {
  Config: {
    Env: string[] | null;
    Labels: Record<string, string> | null;
    User: string;
  };
  HostConfig: Record<string, unknown>;
  Id: string;
  Name: string;
  State: {
    ExitCode: number;
    Running: boolean;
    Status: string;
  };
};

export type ContainerSummary = {
  Id: string;
  Labels: Record<string, string> | null;
  Names: string[];
  State: string;
};

export class DockerClient {
  private readonly endpoint: DockerEndpoint;
  private readonly prefix: string;

  constructor(
    host: string = DEFAULT_DOCKER_HOST,
    apiVersion: string = DEFAULT_DOCKER_API_VERSION,
  ) {
    this.endpoint = parseDockerHost(host);
    this.prefix = `/${apiVersion.replace(/^\//, "")}`;
  }

  async version(): Promise<{ ApiVersion: string; Version: string }> {
    return (await this.request("GET", "/version")).json();
  }

  /** 201 with the new id, or throws a `DockerApiError` (409 on a name clash). */
  async createContainer(
    name: string,
    body: ContainerCreateBody,
  ): Promise<{ Id: string }> {
    const response = await this.request(
      "POST",
      `/containers/create?name=${encodeURIComponent(name)}`,
      body,
    );
    return response.json();
  }

  /** Idempotent: 304 (already started) is success. */
  async startContainer(idOrName: string): Promise<void> {
    await this.request(
      "POST",
      `/containers/${encodeURIComponent(idOrName)}/start`,
      undefined,
      [204, 304],
    );
  }

  /** null when the container does not exist. */
  async inspectContainer(idOrName: string): Promise<ContainerInspect | null> {
    const response = await this.request(
      "GET",
      `/containers/${encodeURIComponent(idOrName)}/json`,
      undefined,
      [200, 404],
    );
    if (response.status === 404) return null;
    return response.json();
  }

  async listContainers(labels: string[]): Promise<ContainerSummary[]> {
    const filters = encodeURIComponent(JSON.stringify({ label: labels }));
    const response = await this.request(
      "GET",
      `/containers/json?all=true&filters=${filters}`,
    );
    return response.json();
  }

  /** Stops (SIGTERM, then SIGKILL after `timeoutSeconds`) and removes. */
  async stopAndRemoveContainer(
    idOrName: string,
    timeoutSeconds: number,
  ): Promise<void> {
    const encoded = encodeURIComponent(idOrName);
    await this.request(
      "POST",
      `/containers/${encoded}/stop?t=${timeoutSeconds}`,
      undefined,
      [204, 304, 404],
    );
    await this.request(
      "DELETE",
      `/containers/${encoded}?force=true`,
      undefined,
      [204, 404],
    );
  }

  private async request(
    method: string,
    path: string,
    body?: unknown,
    accept: number[] = [200, 201, 204],
  ): Promise<Response> {
    const url =
      this.endpoint.kind === "unix"
        ? `http://docker${this.prefix}${path}`
        : `${this.endpoint.baseUrl}${this.prefix}${path}`;
    const init: RequestInit & { unix?: string } = {
      method,
      ...(body === undefined
        ? {}
        : {
            body: JSON.stringify(body),
            headers: { "content-type": "application/json" },
          }),
      ...(this.endpoint.kind === "unix"
        ? { unix: this.endpoint.socketPath }
        : {}),
    };
    const response = await fetch(url, init);
    if (!accept.includes(response.status)) {
      throw new DockerApiError(
        response.status,
        method,
        path,
        await response.text(),
      );
    }
    return response;
  }
}
