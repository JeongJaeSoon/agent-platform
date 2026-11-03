import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type FakeGit, startFakeGit } from "./fake-git.ts";
import { runTestGit } from "./git-http.ts";

// The README commit for `sample-app`: a change here changes every catalog's
// first sha, so it is pinned rather than only compared between starts.
const SAMPLE_APP_HEAD = "5cd179679e3a6714dde9929013d0ba1e1787babe";

const started: FakeGit[] = [];
const scratch: string[] = [];

afterEach(async () => {
  for (const git of started.splice(0)) await git.stop();
  for (const dir of scratch.splice(0)) {
    await rm(dir, { force: true, recursive: true });
  }
});

async function start(
  options: Parameters<typeof startFakeGit>[0],
): Promise<FakeGit> {
  const git = await startFakeGit(options);
  started.push(git);
  return git;
}

async function workdir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "fake-git-test-"));
  scratch.push(dir);
  return dir;
}

type Ready = { msg: string; port: number; heads: Record<string, string> };

async function withMain(
  args: string[],
  env: Record<string, string>,
  body: (ready: Ready) => Promise<void>,
): Promise<void> {
  const child = Bun.spawn(
    [
      process.execPath,
      "run",
      join(import.meta.dir, "fake-git-main.ts"),
      ...args,
    ],
    {
      env: { ...process.env, FAKE_GIT_PORT: "0", ...env },
      stdout: "pipe",
      stderr: "inherit",
    },
  );
  try {
    const reader = child.stdout.getReader();
    const { value } = await reader.read();
    reader.releaseLock();
    const ready: Ready = JSON.parse(
      new TextDecoder().decode(value).split("\n")[0] ?? "",
    );
    expect(ready.msg).toBe("Fake git listening");
    await body(ready);
  } finally {
    child.kill();
    await child.exited;
  }
}

describe("fake-git-main.ts", () => {
  test("seeds the repositories named on the command line and serves them under /agent", async () => {
    await withMain(["sample-app", "gate-app"], {}, async (ready) => {
      expect(Object.keys(ready.heads)).toEqual(["sample-app", "gate-app"]);
      expect(ready.heads["sample-app"]).toBe(SAMPLE_APP_HEAD);

      const dir = await workdir();
      for (const repo of ["sample-app", "gate-app"]) {
        await runTestGit(
          [
            "clone",
            "--quiet",
            `http://127.0.0.1:${ready.port}/agent/${repo}.git`,
            repo,
          ],
          dir,
        );
        expect(await Bun.file(join(dir, repo, "README.md")).text()).toBe(
          `# ${repo}\n`,
        );
        expect(
          (await runTestGit(["rev-parse", "HEAD"], join(dir, repo))).trim(),
        ).toBe(ready.heads[repo] ?? "missing");
      }
      const requests = await (
        await fetch(`http://127.0.0.1:${ready.port}/requests`)
      ).json();
      expect(
        requests.map((r: { path: string }) => r.path.split("/")[2]),
      ).toContain("gate-app.git");
    });
  });

  test("takes the owner and request limit from the environment", async () => {
    await withMain(
      ["solo-app"],
      { FAKE_GIT_OWNER: "team", FAKE_GIT_REQUEST_LIMIT: "2" },
      async (ready) => {
        expect(Object.keys(ready.heads)).toEqual(["solo-app"]);
        const origin = `http://127.0.0.1:${ready.port}`;
        const dir = await workdir();
        await runTestGit(
          ["clone", "--quiet", `${origin}/team/solo-app.git`, "c"],
          dir,
        );
        for (let i = 1; i <= 3; i++) {
          await fetch(`${origin}/team/missing-${i}.git/info/refs`);
        }

        const requests = await (await fetch(`${origin}/requests`)).json();
        expect(requests.map((r: { path: string }) => r.path)).toEqual([
          "/team/missing-2.git/info/refs",
          "/team/missing-3.git/info/refs",
        ]);
      },
    );
  });
});

describe("startFakeGit", () => {
  test("gives the same sha for the same repository on every start", async () => {
    const first = await start({ repositories: ["sample-app", "gate-app"] });
    const second = await start({ repositories: ["sample-app"] });

    expect(first.heads["sample-app"]).toBe(SAMPLE_APP_HEAD);
    expect(second.heads["sample-app"]).toBe(SAMPLE_APP_HEAD);
    expect(first.heads["gate-app"]).not.toBe(SAMPLE_APP_HEAD);
  });

  test("refuses a push and keeps the seeded head", async () => {
    const git = await start({ repositories: ["sample-app"] });
    const dir = await workdir();
    const url = `${git.origin}/agent/sample-app.git`;
    await runTestGit(["clone", "--quiet", url, "work"], dir);
    const work = join(dir, "work");
    await Bun.write(join(work, "change.txt"), "change\n");
    await runTestGit(["add", "change.txt"], work);
    await runTestGit(
      [
        "-c",
        "user.name=t",
        "-c",
        "user.email=t@example.test",
        "commit",
        "-qm",
        "c",
      ],
      work,
    );

    await expect(
      runTestGit(["push", "origin", "main"], work),
    ).rejects.toThrow();
    const direct = await fetch(`${url}/git-receive-pack`, {
      method: "POST",
      headers: { "content-type": "application/x-git-receive-pack-request" },
      body: "0000",
    });
    expect(direct.status).toBe(403);

    expect(
      git
        .requests()
        .some((r) => r.path.includes("git-receive-pack") && r.status === 403),
    ).toBe(true);
    expect(
      (await runTestGit(["ls-remote", url, "refs/heads/main"], dir)).split(
        "\t",
      )[0],
    ).toBe(SAMPLE_APP_HEAD);
  });

  test("keeps only the latest requestLimit requests", async () => {
    const git = await start({ repositories: ["sample-app"], requestLimit: 3 });
    for (let i = 1; i <= 5; i++) {
      await fetch(`${git.origin}/agent/missing-${i}.git/info/refs`);
    }

    expect(git.requests().map((r) => r.path)).toEqual([
      "/agent/missing-3.git/info/refs",
      "/agent/missing-4.git/info/refs",
      "/agent/missing-5.git/info/refs",
    ]);
  });

  test("takes the owner and port that keep existing repository URLs", async () => {
    const probe = Bun.serve({ port: 0, fetch: () => new Response() });
    const port = probe.port ?? 0;
    probe.stop(true);
    const git = await start({
      repositories: ["sample-app"],
      owner: "team",
      port,
    });
    const dir = await workdir();

    await runTestGit(
      ["clone", "--quiet", `http://127.0.0.1:${port}/team/sample-app.git`, "c"],
      dir,
    );
    expect(git.port).toBe(port);
  });

  test("refuses repository names that would leave the served root", async () => {
    await expect(startFakeGit({ repositories: ["../x"] })).rejects.toThrow(
      /invalid repository path segment/,
    );
    await expect(startFakeGit({ repositories: [] })).rejects.toThrow(
      /at least one repository/,
    );
  });
});
