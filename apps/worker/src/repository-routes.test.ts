import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkspaceDescriptor } from "@werft-ai/contracts";
import {
  goPrivateModules,
  REPOSITORY_ROUTES_FILE,
  repositoryRoutesConfig,
  writeRepositoryRoutes,
} from "./repository-routes.ts";

const ROUTE = "http://egress-proxy:3129";
const TOKEN = "wek_repository_routes";
const access = { kind: "egress_token" as const, token: TOKEN };

const workspace: WorkspaceDescriptor = {
  repository: {
    id: "app",
    url: "https://github.com/o/app.git",
    branch: "main",
    access,
  },
  additional_repositories: [
    { id: "docs", url: "https://github.com/o/docs", branch: "main", access },
    { id: "lab", url: "http://gitea:3000/o/lab.git", branch: "main", access },
    // Left out: no route token, an id Git LFS would misread, not http(s).
    { id: "plain", url: "https://github.com/o/plain.git", branch: "main" },
    {
      id: "v1.git",
      url: "https://github.com/o/v1.git",
      branch: "main",
      access,
    },
    { id: "ssh", url: "git@github.com:o/ssh.git", branch: "main", access },
  ],
};

describe("repositoryRoutesConfig", () => {
  test("maps each routed repository's .git and bare URL to its id, with the token for the route alone", () => {
    expect(repositoryRoutesConfig(ROUTE, TOKEN, workspace)).toBe(
      [
        '[url "http://egress-proxy:3129/repository/app/.git"]',
        '\tinsteadOf = "https://github.com/o/app.git"',
        '[url "http://egress-proxy:3129/repository/app/"]',
        '\tinsteadOf = "https://github.com/o/app"',
        '[url "http://egress-proxy:3129/repository/docs/.git"]',
        '\tinsteadOf = "https://github.com/o/docs.git"',
        '[url "http://egress-proxy:3129/repository/docs/"]',
        '\tinsteadOf = "https://github.com/o/docs"',
        '[url "http://egress-proxy:3129/repository/lab/.git"]',
        '\tinsteadOf = "http://gitea:3000/o/lab.git"',
        '[url "http://egress-proxy:3129/repository/lab/"]',
        '\tinsteadOf = "http://gitea:3000/o/lab"',
        '[http "http://egress-proxy:3129/repository/"]',
        `\textraHeader = "Authorization: Bearer ${TOKEN}"`,
        "",
      ].join("\n"),
    );
  });

  test("nothing to route is no configuration", () => {
    expect(
      repositoryRoutesConfig(ROUTE, TOKEN, { repository: null }),
    ).toBeNull();
    expect(repositoryRoutesConfig(ROUTE, "a\nb", workspace)).toBeNull();
  });
});

describe("goPrivateModules", () => {
  test("names the routed github.com repositories as module paths", () => {
    expect(goPrivateModules(workspace)).toEqual([
      "github.com/o/app",
      "github.com/o/docs",
    ]);
  });
});

describe("writeRepositoryRoutes", () => {
  let home: string;
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "repository-routes-"));
  });
  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  test("writes the engine's git configuration, readable by the worker alone", async () => {
    await writeRepositoryRoutes(home, ROUTE, workspace);
    const path = join(home, REPOSITORY_ROUTES_FILE);
    expect(await readFile(path, "utf8")).toContain(TOKEN);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  test("a claim with no repository token leaves no routes behind", async () => {
    await writeRepositoryRoutes(home, ROUTE, workspace);
    const { access: _, ...unrouted } = workspace.repository ?? {
      id: null,
      url: "",
      branch: "",
    };
    await writeRepositoryRoutes(home, ROUTE, {
      repository: unrouted,
      additional_repositories: workspace.additional_repositories ?? [],
    });
    expect(await Bun.file(join(home, REPOSITORY_ROUTES_FILE)).exists()).toBe(
      false,
    );
  });

  describe("with the git on this machine", () => {
    type Asked = { path: string; authorization: string | null };
    let asked: Asked[];
    let server: ReturnType<typeof Bun.serve>;

    beforeEach(async () => {
      asked = [];
      server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch(request) {
          const url = new URL(request.url);
          asked.push({
            path: `${url.pathname}${url.search}`,
            authorization: request.headers.get("authorization"),
          });
          return new Response("no such credential route\n", { status: 404 });
        },
      });
      await writeRepositoryRoutes(
        home,
        `http://127.0.0.1:${server.port}`,
        workspace,
      );
    });
    afterEach(() => {
      server.stop(true);
    });

    async function git(...args: string[]): Promise<number> {
      const run = Bun.spawn(["git", ...args], {
        cwd: home,
        env: {
          PATH: process.env.PATH ?? "",
          HOME: home,
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_TERMINAL_PROMPT: "0",
        },
        stdout: "ignore",
        stderr: "ignore",
      });
      return run.exited;
    }

    test("a fetch by either URL reaches its id's route with the token", async () => {
      expect(await git("ls-remote", "https://github.com/o/docs")).not.toBe(0);
      expect(await git("ls-remote", "https://github.com/o/app.git")).not.toBe(
        0,
      );
      expect(asked).toEqual([
        {
          path: "/repository/docs/info/refs?service=git-upload-pack",
          authorization: `Bearer ${TOKEN}`,
        },
        {
          path: "/repository/app/.git/info/refs?service=git-upload-pack",
          authorization: `Bearer ${TOKEN}`,
        },
      ]);
    });

    test("a push asks for receive-pack, which the route does not have", async () => {
      expect(await git("init", "--quiet", "local")).toBe(0);
      expect(
        await git(
          "-C",
          "local",
          "-c",
          "user.name=t",
          "-c",
          "user.email=t@t.invalid",
          "commit",
          "--quiet",
          "--allow-empty",
          "-m",
          "x",
        ),
      ).toBe(0);
      expect(
        await git(
          "-C",
          "local",
          "push",
          "https://github.com/o/app.git",
          "HEAD:refs/heads/x",
        ),
      ).not.toBe(0);
      expect(asked.map(({ path }) => path)).toEqual([
        "/repository/app/.git/info/refs?service=git-receive-pack",
      ]);
    });

    test("a URL that only starts like a routed one names no id", async () => {
      await git("ls-remote", "https://github.com/o/docs-x.git");
      expect(asked.map(({ path }) => path)).toEqual([
        "/repository/docs/-x.git/info/refs?service=git-upload-pack",
      ]);
    });
  });
});
