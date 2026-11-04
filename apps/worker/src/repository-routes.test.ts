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
    {
      id: "lab",
      url: "http://fake-git:3000/o/lab.git",
      branch: "main",
      access,
    },
    // An id ending in `.git` is routed like any other.
    {
      id: "v1.git",
      url: "https://github.com/o/v1.git",
      branch: "main",
      access,
    },
    // Left out: one the route cannot name, no route token, not http(s).
    {
      id: "a b",
      url: "https://github.com/o/space.git",
      branch: "main",
      access,
    },
    { id: "plain", url: "https://github.com/o/plain.git", branch: "main" },
    { id: "ssh", url: "git@github.com:o/ssh.git", branch: "main", access },
  ],
};

describe("repositoryRoutesConfig", () => {
  test("maps each routed repository's .git and bare URL to its id, with the token for the route alone", () => {
    expect(repositoryRoutesConfig(ROUTE, TOKEN, workspace)).toBe(
      [
        '[url "http://egress-proxy:3129/repository/app/.git"]',
        '\tinsteadOf = "https://github.com/o/app.git"',
        '[url "http://egress-proxy:3129/repository/app/.git/"]',
        '\tinsteadOf = "https://github.com/o/app"',
        '\tinsteadOf = "https://github.com/o/app/"',
        '[url "http://egress-proxy:3129/repository/docs/.git"]',
        '\tinsteadOf = "https://github.com/o/docs.git"',
        '[url "http://egress-proxy:3129/repository/docs/.git/"]',
        '\tinsteadOf = "https://github.com/o/docs"',
        '\tinsteadOf = "https://github.com/o/docs/"',
        '[url "http://egress-proxy:3129/repository/lab/.git"]',
        '\tinsteadOf = "http://fake-git:3000/o/lab.git"',
        '[url "http://egress-proxy:3129/repository/lab/.git/"]',
        '\tinsteadOf = "http://fake-git:3000/o/lab"',
        '\tinsteadOf = "http://fake-git:3000/o/lab/"',
        '[url "http://egress-proxy:3129/repository/v1.git/.git"]',
        '\tinsteadOf = "https://github.com/o/v1.git"',
        '[url "http://egress-proxy:3129/repository/v1.git/.git/"]',
        '\tinsteadOf = "https://github.com/o/v1"',
        '\tinsteadOf = "https://github.com/o/v1/"',
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
      "github.com/o/v1",
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
    expect(await writeRepositoryRoutes(home, ROUTE, workspace)).toBe(true);
    const path = join(home, REPOSITORY_ROUTES_FILE);
    expect(await readFile(path, "utf8")).toContain(TOKEN);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  test("a claim with no repository token leaves no routes behind", async () => {
    await writeRepositoryRoutes(home, ROUTE, workspace);
    const written = await writeRepositoryRoutes(home, ROUTE, {
      repository: {
        id: "app",
        url: "https://github.com/o/app.git",
        branch: "main",
      },
      additional_repositories: [
        { id: "docs", url: "https://github.com/o/docs", branch: "main" },
      ],
    });
    expect(written).toBe(false);
    expect(await Bun.file(join(home, REPOSITORY_ROUTES_FILE)).exists()).toBe(
      false,
    );
  });

  test("a session with no repository of its own routes what it attached", async () => {
    await writeRepositoryRoutes(home, ROUTE, {
      repository: null,
      additional_repositories: workspace.additional_repositories ?? [],
    });
    const written = await readFile(join(home, REPOSITORY_ROUTES_FILE), "utf8");
    expect(written).toContain('insteadOf = "https://github.com/o/docs"');
    expect(written).not.toContain("o/app");
    expect(written).toContain(`Bearer ${TOKEN}`);
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
      expect(await git("ls-remote", "https://github.com/o/app/")).not.toBe(0);
      expect(asked).toEqual([
        {
          path: "/repository/docs/.git/info/refs?service=git-upload-pack",
          authorization: `Bearer ${TOKEN}`,
        },
        {
          path: "/repository/app/.git/info/refs?service=git-upload-pack",
          authorization: `Bearer ${TOKEN}`,
        },
        {
          path: "/repository/app/.git/info/refs?service=git-upload-pack",
          authorization: `Bearer ${TOKEN}`,
        },
      ]);
    });

    test("the session's own `git config --global` stays out of the routes", async () => {
      const routes = await readFile(join(home, REPOSITORY_ROUTES_FILE), "utf8");
      expect(await git("config", "--global", "user.name", "Session")).toBe(0);
      expect(await readFile(join(home, ".gitconfig"), "utf8")).toContain(
        "Session",
      );
      expect(await readFile(join(home, REPOSITORY_ROUTES_FILE), "utf8")).toBe(
        routes,
      );
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
        "/repository/docs/.git/-x.git/info/refs?service=git-upload-pack",
      ]);
    });
  });
});
