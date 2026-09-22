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

export const DEFAULT_DOCKER_REQUEST_TIMEOUT_MS = 30_000;

/** The daemon accepted the connection but did not answer within the deadline. */
export class DockerTimeoutError extends Error {
  constructor(
    readonly method: string,
    readonly path: string,
    readonly timeoutMs: number,
  ) {
    super(`Docker API ${method} ${path} did not answer within ${timeoutMs}ms`);
    this.name = "DockerTimeoutError";
  }
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
    ExtraHosts?: string[];
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

/**
 * Splits an image reference the way `/images/create` wants it: registry
 * ports (`host:5000/x`) belong to the name, a digest (`@sha256:…`) or the
 * last `:` after the final `/` is the tag.
 */
export function parseImageReference(image: string): {
  name: string;
  tag: string;
} {
  const at = image.indexOf("@");
  if (at >= 0) {
    return { name: image.slice(0, at), tag: image.slice(at + 1) };
  }
  const slash = image.lastIndexOf("/");
  const colon = image.lastIndexOf(":");
  if (colon > slash) {
    return { name: image.slice(0, colon), tag: image.slice(colon + 1) };
  }
  return { name: image, tag: "latest" };
}

export class DockerClient {
  private readonly endpoint: DockerEndpoint;
  private readonly prefix: string;
  private readonly timeoutMs: number;

  constructor(
    host: string = DEFAULT_DOCKER_HOST,
    apiVersion: string = DEFAULT_DOCKER_API_VERSION,
    options: { timeoutMs?: number } = {},
  ) {
    this.endpoint = parseDockerHost(host);
    this.prefix = `/${apiVersion.replace(/^\//, "")}`;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_DOCKER_REQUEST_TIMEOUT_MS;
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs <= 0) {
      throw new Error("Docker request timeout must be a positive number");
    }
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

  /**
   * Pulls `image` if the daemon does not have it. The backend never calls
   * this (the worker image is provisioned out of band); tests do, so a fresh
   * daemon can run them.
   */
  async pullImage(image: string): Promise<void> {
    const { name, tag } = parseImageReference(image);
    const response = await this.request(
      "POST",
      `/images/create?fromImage=${encodeURIComponent(name)}&tag=${encodeURIComponent(tag)}`,
    );
    // The pull streams progress JSON until it is done; drain it.
    await response.text();
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
      // Every call is bounded: a stalled daemon must fail the pass, not hang
      // the one-shot scheduler and every launch queued behind it.
      signal: AbortSignal.timeout(this.timeoutMs),
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
    let response: Response;
    try {
      response = await fetch(url, init);
    } catch (error) {
      if (error instanceof Error && error.name === "TimeoutError") {
        throw new DockerTimeoutError(method, path, this.timeoutMs);
      }
      throw error;
    }
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
