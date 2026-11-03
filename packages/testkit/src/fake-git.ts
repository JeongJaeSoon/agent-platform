import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createServedRepository,
  runTestGit,
  serveGitHttp,
} from "./git-http.ts";

export type FakeGitRequest = {
  method: string;
  path: string;
  status: number;
};

export type FakeGit = {
  readonly origin: string;
  readonly port: number;
  /** Each seeded repository's `main` sha, by name. */
  readonly heads: Readonly<Record<string, string>>;
  /** The latest git requests, oldest first, at most `requestLimit`. */
  requests(): FakeGitRequest[];
  stop(): Promise<void>;
};

export type FakeGitOptions = {
  /** Served as `/<owner>/<name>.git`, each with one README commit on `main`. */
  repositories: readonly string[];
  owner?: string;
  hostname?: string;
  port?: number;
  requestLimit?: number;
};

// Fixed so that the same repository names give the same shas on every start.
const SEED_DATE = "2026-01-01T00:00:00Z";
const NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/;

/**
 * Read-only git over smart HTTP: clone and fetch work, push does not, since
 * no request is passed to http-backend as an authenticated user.
 * `/healthz` and `/requests` sit beside the repositories and are not recorded.
 */
export async function startFakeGit(options: FakeGitOptions): Promise<FakeGit> {
  const owner = options.owner ?? "agent";
  const requestLimit = options.requestLimit ?? 1000;
  for (const name of [owner, ...options.repositories]) {
    if (!NAME.test(name) || name.endsWith(".git")) {
      throw new Error(
        `invalid repository path segment: ${JSON.stringify(name)}`,
      );
    }
  }
  if (options.repositories.length === 0) {
    throw new Error("at least one repository is required");
  }
  if (!Number.isInteger(requestLimit) || requestLimit < 1) {
    throw new Error(`requestLimit must be a positive integer: ${requestLimit}`);
  }

  const root = await mkdtemp(join(tmpdir(), "fake-git-"));
  // No prototype, so a repository named `__proto__` keeps its entry.
  const heads: Record<string, string> = Object.create(null);
  try {
    for (const name of options.repositories) {
      const bare = await createServedRepository(
        { root },
        `${owner}/${name}`,
        { "README.md": `# ${name}\n` },
        "main",
        SEED_DATE,
      );
      heads[name] = (await runTestGit(["rev-parse", "main"], bare)).trim();
    }
  } catch (error) {
    await rm(root, { force: true, recursive: true });
    throw error;
  }

  const requests: FakeGitRequest[] = [];
  const server = Bun.serve({
    hostname: options.hostname ?? "127.0.0.1",
    port: options.port ?? 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/healthz") return new Response("ok\n");
      if (url.pathname === "/requests") return Response.json(requests);
      const response = await serveGitHttp(root, request, url);
      requests.push({
        method: request.method,
        path: `${url.pathname}${url.search}`,
        status: response.status,
      });
      if (requests.length > requestLimit) {
        requests.splice(0, requests.length - requestLimit);
      }
      return response;
    },
  });
  const port = server.port ?? 0;
  return {
    origin: `http://${options.hostname ?? "127.0.0.1"}:${port}`,
    port,
    heads,
    requests: () => [...requests],
    async stop() {
      server.stop(true);
      await rm(root, { force: true, recursive: true });
    },
  };
}
