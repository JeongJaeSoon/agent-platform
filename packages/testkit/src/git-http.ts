import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type GitHttpRequest = {
  authorization: string | null;
  method: string;
  path: string;
};

export type GitHttpServer = {
  /** `http://127.0.0.1:<port>`; repositories are served under it by name. */
  readonly origin: string;
  readonly port: number;
  /** Every request, in arrival order, including refused ones. */
  readonly requests: GitHttpRequest[];
  /** The bare repositories' parent directory. */
  readonly root: string;
  stop(): Promise<void>;
};

export type GitHttpServerOptions = {
  /**
   * The one `Authorization` value the server accepts; anything else gets a
   * 401 with a Basic challenge. Absent, every request is served.
   */
  authorization?: string;
};

/**
 * git's smart HTTP, served by `git http-backend` as a CGI behind Bun.serve,
 * for tests that clone over http the way a worker does (94S-252). Read-only:
 * receive-pack is off, as http-backend leaves it for unauthenticated users.
 */
export async function startGitHttpServer(
  options: GitHttpServerOptions = {},
): Promise<GitHttpServer> {
  const root = await mkdtemp(join(tmpdir(), "testkit-git-http-"));
  const requests: GitHttpRequest[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const authorization = request.headers.get("authorization");
      requests.push({
        authorization,
        method: request.method,
        path: `${url.pathname}${url.search}`,
      });
      if (
        options.authorization !== undefined &&
        authorization !== options.authorization
      ) {
        return new Response("authentication required\n", {
          status: 401,
          headers: { "www-authenticate": 'Basic realm="git"' },
        });
      }
      return await cgi(root, request, url);
    },
  });
  return {
    origin: `http://127.0.0.1:${server.port}`,
    port: server.port ?? 0,
    requests,
    root,
    async stop() {
      server.stop(true);
      await rm(root, { force: true, recursive: true });
    },
  };
}

/** A bare repository `<name>.git` under the server's root with one commit on `branch`. */
export async function createServedRepository(
  server: Pick<GitHttpServer, "root">,
  name: string,
  files: Record<string, string>,
  branch = "main",
): Promise<string> {
  const work = await mkdtemp(join(tmpdir(), "testkit-git-work-"));
  try {
    await git(["init", "--quiet", "--initial-branch", branch], work);
    for (const [path, contents] of Object.entries(files)) {
      await Bun.write(join(work, path), contents);
    }
    await git(["add", "--all"], work);
    await git(
      [
        "-c",
        "user.name=testkit",
        "-c",
        "user.email=testkit@example.test",
        "commit",
        "--quiet",
        "-m",
        "initial",
      ],
      work,
    );
    const bare = join(server.root, `${name}.git`);
    await git(["clone", "--quiet", "--bare", work, bare], server.root);
    return bare;
  } finally {
    await rm(work, { force: true, recursive: true });
  }
}

async function cgi(
  root: string,
  request: Request,
  url: URL,
): Promise<Response> {
  const body = new Uint8Array(await request.arrayBuffer());
  const child = Bun.spawn(["git", "http-backend"], {
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      GIT_PROJECT_ROOT: root,
      GIT_HTTP_EXPORT_ALL: "1",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      REQUEST_METHOD: request.method,
      PATH_INFO: decodeURIComponent(url.pathname),
      QUERY_STRING: url.search.replace(/^\?/, ""),
      CONTENT_TYPE: request.headers.get("content-type") ?? "",
      CONTENT_LENGTH: String(body.byteLength),
      HTTP_CONTENT_ENCODING: request.headers.get("content-encoding") ?? "",
      HTTP_GIT_PROTOCOL: request.headers.get("git-protocol") ?? "",
      REMOTE_ADDR: "127.0.0.1",
    },
    stdin: body,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [output, stderr, code] = await Promise.all([
    new Response(child.stdout).arrayBuffer(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) {
    return new Response(`http-backend exited ${code}: ${stderr}`, {
      status: 500,
    });
  }
  const bytes = new Uint8Array(output);
  const split = indexOfBlankLine(bytes);
  const head = new TextDecoder().decode(bytes.subarray(0, split.at));
  const headers = new Headers();
  let status = 200;
  for (const line of head.split(/\r?\n/)) {
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    const name = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trim();
    if (name.toLowerCase() === "status") status = Number.parseInt(value, 10);
    else headers.append(name, value);
  }
  return new Response(bytes.subarray(split.at + split.length), {
    status,
    headers,
  });
}

function indexOfBlankLine(bytes: Uint8Array): { at: number; length: number } {
  for (let i = 0; i < bytes.length - 1; i++) {
    if (bytes[i] === 10 && bytes[i + 1] === 10) return { at: i, length: 2 };
    if (
      bytes[i] === 13 &&
      bytes[i + 1] === 10 &&
      bytes[i + 2] === 13 &&
      bytes[i + 3] === 10
    ) {
      return { at: i, length: 4 };
    }
  }
  return { at: bytes.length, length: 0 };
}

async function git(args: string[], cwd: string): Promise<void> {
  const child = Bun.spawn(["git", ...args], {
    cwd,
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: cwd,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
    },
    stderr: "pipe",
    stdout: "ignore",
  });
  if ((await child.exited) !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed: ${await new Response(child.stderr).text()}`,
    );
  }
}
