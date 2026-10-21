import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createPushExecutor,
  type ForgeResolver,
  type PushJob,
  type PushOutcome,
  type PushRequestStore,
  repositoryBinding,
  type SessionCatalog,
} from "@agent-platform/platform";
import {
  DEFAULT_MAX_GIT_MEMORY_BYTES,
  defaultGitRunner,
  type GitCommandOptions,
  type GitCommandRunner,
} from "@agent-platform/storage";
import {
  createGitBundleChain,
  createServedRepository,
  type FakeGitHub,
  type GitBundleFixture,
  type GitHttpServer,
  startFakeGitHub,
  startGitHttpServer,
} from "@agent-platform/testkit";
import { forgesOf } from "./forge-github.ts";
import { createGitPusher, parseLsRemote } from "./git-push.ts";

const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
const privateKey = keys.privateKey
  .export({ type: "pkcs1", format: "pem" })
  .toString();
const publicKey = keys.publicKey
  .export({ type: "spki", format: "pem" })
  .toString();
const BASIC_LOGIN = `Basic ${Buffer.from("push-bot:pat-value-1234").toString("base64")}`;

let github: FakeGitHub;
let gitea: GitHttpServer;
let chain: { base: GitBundleFixture; tip: GitBundleFixture };
let tempRoot: string;

beforeAll(async () => {
  github = await startFakeGitHub({ appId: 101, publicKey });
  await github.createRepository("acme", "app", { "README.md": "hello\n" });
  await github.createRepository("acme", "other", { "README.md": "no\n" });
  gitea = await startGitHttpServer({ authorization: BASIC_LOGIN, push: true });
  await createServedRepository(gitea, "app", { "README.md": "gitea\n" });
  chain = await createGitBundleChain();
  tempRoot = await mkdtemp(join(tmpdir(), "push-executor-test-"));
});
afterAll(async () => {
  await github.stop();
  await gitea.stop();
  await rm(tempRoot, { force: true, recursive: true });
});

function appRepository(
  name = "app",
  url = `${github.origin}/acme/${name}.git`,
) {
  return {
    url,
    branch: "main",
    profiles: ["default"],
    auth: {
      kind: "github_app" as const,
      app_id: 101,
      installation_id: 202,
      api_base: github.origin,
      value: privateKey,
      ref: { value_env: "GITHUB_APP_PRIVATE_KEY" },
    },
  };
}

function catalogOf(
  repositories: SessionCatalog["repositories"],
): SessionCatalog {
  return { profiles: {}, repositories };
}

let sessions = 0;
function jobFor(
  catalog: SessionCatalog,
  repositoryId: string,
  overrides: Partial<PushJob> = {},
): PushJob {
  sessions += 1;
  const sessionId = `00000000-0000-4000-8000-${String(sessions).padStart(12, "0")}`;
  const entry = catalog.repositories[repositoryId];
  return {
    id: crypto.randomUUID(),
    ownerId: "owner-a",
    sessionId,
    repositoryId,
    repositoryBinding: entry ? repositoryBinding(repositoryId, entry) : null,
    checkpointRevision: 2,
    gitCommit: chain.tip.commit,
    targetBranch: `agent/${sessionId}`,
    attempt: 1,
    ...overrides,
  };
}

type Run = {
  outcome: PushOutcome | undefined;
  argv: string[][];
  gitOptions: GitCommandOptions[];
  credentialFiles: string[];
  logged: string[];
};

async function run(
  catalog: SessionCatalog,
  job: PushJob,
  options: {
    bundles?: readonly GitBundleFixture[];
    forges?: ForgeResolver;
    leaseMs?: number;
  } = {},
): Promise<Run> {
  const finished: PushOutcome[] = [];
  const store = {
    claimNextApproved: async () => job,
    finish: async (_job: PushJob, outcome: PushOutcome) => {
      finished.push(outcome);
      return true;
    },
  } as unknown as PushRequestStore;
  const argv: string[][] = [];
  const recorded: GitCommandOptions[] = [];
  const credentialFiles: string[] = [];
  const logged: string[] = [];
  const recording: GitCommandRunner = async (args, gitOptions) => {
    argv.push([...args]);
    recorded.push(gitOptions);
    if (gitOptions.cwd !== undefined) {
      credentialFiles.push(...(await credentialsUnder(gitOptions.cwd)));
    }
    return defaultGitRunner(args, gitOptions);
  };
  const executor = createPushExecutor({
    store,
    catalog,
    forges: options.forges ?? forgesOf(catalog),
    bundles: {
      async spoolPushBundles({ directory }) {
        const files: string[] = [];
        for (const [index, bundle] of (
          options.bundles ?? [chain.base, chain.tip]
        ).entries()) {
          const path = join(directory, `push-${index}.bundle`);
          await writeFile(path, bundle.bytes);
          files.push(path);
        }
        return { status: "ready", files };
      },
    },
    pusher: createGitPusher({ gitRunner: recording }),
    logger: {
      info: (message, fields) =>
        logged.push(JSON.stringify({ message, fields })),
      warn: (message, fields) =>
        logged.push(JSON.stringify({ message, fields })),
    },
    tempRoot,
    ...(options.leaseMs === undefined ? {} : { leaseMs: options.leaseMs }),
  });
  expect(await executor.runOnce()).toBe(true);
  return {
    outcome: finished[0],
    argv,
    gitOptions: recorded,
    credentialFiles,
    logged,
  };
}

async function credentialsUnder(directory: string): Promise<string[]> {
  const found: string[] = [];
  const entries = await readdir(directory, {
    recursive: true,
    withFileTypes: true,
  }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const path = join(entry.parentPath, entry.name);
    const text = (await readFile(path)).toString("latin1");
    if (/ghs_|pat-value|eC1hY2Nlc3Mt|cHVzaC1ib3Q6|extraheader/i.test(text)) {
      found.push(path);
    }
  }
  return found;
}

function expectNoCredentialIn(result: Run) {
  expect(result.credentialFiles).toEqual([]);
  for (const line of result.logged) {
    expect(line).not.toMatch(/ghs_|pat-value|authorization/i);
  }
  for (const args of result.argv) {
    expect(args.join(" ")).not.toMatch(/ghs_|pat-value|authorization/i);
  }
}

describe("the platform's push", () => {
  test("pushes the pinned commit to agent/<session-id> with a write token for that one repository", async () => {
    const catalog = catalogOf({ app: appRepository() });
    const job = jobFor(catalog, "app");
    const tokensBefore = github.tokenRequests.length;
    const result = await run(catalog, job);
    expect(result.outcome).toEqual({
      state: "pushed",
      remoteUrl: `${github.origin}/acme/app.git`,
      remoteRef: `refs/heads/${job.targetBranch}`,
      previousCommit: null,
    });
    expect(
      (await github.refs("acme", "app"))[`refs/heads/${job.targetBranch}`],
    ).toBe(chain.tip.commit);
    const writes = github.tokenRequests
      .slice(tokensBefore)
      .filter(
        (request) =>
          (request.body as { permissions?: { contents?: string } }).permissions
            ?.contents === "write",
      );
    expect(writes).toHaveLength(1);
    expect(writes[0]?.body).toEqual({
      repositories: ["app"],
      permissions: { contents: "write" },
    });
    const refs = await github.refs("acme", "app");
    expect(Object.keys(refs).sort()).toEqual(
      ["refs/heads/main", `refs/heads/${job.targetBranch}`].sort(),
    );
    expectNoCredentialIn(result);
    expect(await readdir(tempRoot)).toEqual([]);
  });

  test("the same commit already on the remote ends as pushed, and a descendant fast-forwards", async () => {
    const catalog = catalogOf({ app: appRepository() });
    const first = jobFor(catalog, "app", { gitCommit: chain.base.commit });
    expect(
      (await run(catalog, first, { bundles: [chain.base] })).outcome,
    ).toMatchObject({ state: "pushed", previousCommit: null });
    expect(
      (await run(catalog, { ...first, attempt: 2 }, { bundles: [chain.base] }))
        .outcome,
    ).toMatchObject({ state: "pushed", previousCommit: chain.base.commit });
    expect(
      (
        await run(catalog, {
          ...first,
          gitCommit: chain.tip.commit,
          attempt: 1,
        })
      ).outcome,
    ).toMatchObject({ state: "pushed", previousCommit: chain.base.commit });
  });

  test("never force-pushes: a remote branch the commit does not build on is refused", async () => {
    const catalog = catalogOf({ app: appRepository() });
    const job = jobFor(catalog, "app");
    const unrelated = await github.writeUnrelatedCommit(
      "acme",
      "app",
      job.targetBranch,
    );
    const pushesBefore = github.gitRequests.filter(
      (request) => request.push && request.method === "POST",
    ).length;
    expect((await run(catalog, job)).outcome).toEqual({
      state: "failed",
      refusal: "non_fast_forward",
      remoteUrl: `${github.origin}/acme/app.git`,
      remoteRef: `refs/heads/${job.targetBranch}`,
    });
    expect(
      (await github.refs("acme", "app"))[`refs/heads/${job.targetBranch}`],
    ).toBe(unrelated);
    expect(
      github.gitRequests.filter(
        (request) => request.push && request.method === "POST",
      ).length,
    ).toBe(pushesBefore);
  });

  test("refuses the repository's default branch, by the catalog and by the remote", async () => {
    const byCatalog = catalogOf({ app: appRepository() });
    const pinned = jobFor(byCatalog, "app");
    const catalogBranch = catalogOf({
      app: { ...appRepository(), branch: pinned.targetBranch },
    });
    expect(
      (
        await run(catalogBranch, {
          ...pinned,
          repositoryBinding: repositoryBinding(
            "app",
            catalogBranch.repositories
              .app as SessionCatalog["repositories"][string],
          ),
        })
      ).outcome,
    ).toMatchObject({ state: "failed", refusal: "default_branch" });

    const sessionId = "00000000-0000-4000-8000-0000000000ff";
    await github.createRepository(
      "acme",
      "odd",
      { "README.md": "odd\n" },
      {
        branch: `agent/${sessionId}`,
      },
    );
    const odd = catalogOf({ odd: appRepository("odd") });
    expect(
      (
        await run(
          odd,
          jobFor(odd, "odd", {
            sessionId,
            targetBranch: `agent/${sessionId}`,
          }),
        )
      ).outcome,
    ).toMatchObject({ state: "failed", refusal: "default_branch" });
    expect(
      (await github.refs("acme", "odd"))[`refs/heads/agent/${sessionId}`],
    ).not.toBe(chain.tip.commit);
  });

  test("refuses any target but agent/<session-id>", async () => {
    const catalog = catalogOf({ app: appRepository() });
    for (const targetBranch of ["main", "feature/x", "agent/someone-else"]) {
      expect(
        (await run(catalog, jobFor(catalog, "app", { targetBranch }))).outcome,
      ).toMatchObject({ state: "failed", refusal: "target_refused" });
    }
  });

  test("a catalog entry changed after the request is refused before anything reaches the forge", async () => {
    const pinned = catalogOf({ app: appRepository() });
    const job = jobFor(pinned, "app");
    const gitBefore = github.gitRequests.length;
    const tokensBefore = github.tokenRequests.length;
    for (const changed of [
      catalogOf({
        app: appRepository("app", `${github.origin}/acme/other.git`),
      }),
      catalogOf({
        app: {
          ...appRepository(),
          auth: { ...appRepository().auth, ref: { value_env: "OTHER_KEY" } },
        },
      }),
      catalogOf({ other: appRepository("other") }),
    ]) {
      expect((await run(changed, job)).outcome).toEqual({
        state: "failed",
        refusal: "catalog_changed",
      });
    }
    expect(
      (await run(pinned, { ...job, repositoryBinding: null })).outcome,
    ).toMatchObject({ refusal: "catalog_changed" });
    expect(github.gitRequests.length).toBe(gitBefore);
    expect(github.tokenRequests.length).toBe(tokensBefore);
  });

  test("a request taken up too many times is failed without pushing", async () => {
    const catalog = catalogOf({ app: appRepository() });
    const gitBefore = github.gitRequests.length;
    expect(
      (await run(catalog, jobFor(catalog, "app", { attempt: 4 }))).outcome,
    ).toEqual({ state: "failed", refusal: "lease_expired" });
    expect(github.gitRequests.length).toBe(gitBefore);
  });

  test("a token the forge would not issue fails the push and says nothing of why in the outcome", async () => {
    const catalog = catalogOf({ app: appRepository() });
    const uncachedForges = forgesOf(catalog, { retryAfterBaseMs: 1 });
    github.failTokens(true);
    try {
      const result = await run(catalog, jobFor(catalog, "app"), {
        forges: uncachedForges,
      });
      expect(result.outcome).toEqual({
        state: "failed",
        refusal: "push_failed",
      });
      expect(result.logged.some((line) => line.includes("Push failed"))).toBe(
        true,
      );
      expectNoCredentialIn(result);
    } finally {
      github.failTokens(false);
    }
  });

  test("a basic credential without a forge (Gitea, GHES with a PAT) pushes with the catalog login", async () => {
    const catalog = catalogOf({
      gitea: {
        url: `${gitea.origin}/app.git`,
        branch: "main",
        profiles: ["default"],
        auth: {
          kind: "basic",
          username: "push-bot",
          value: "pat-value-1234",
          ref: { value_env: "GITEA_TOKEN" },
        },
      },
    });
    const job = jobFor(catalog, "gitea");
    const result = await run(catalog, job);
    expect(result.outcome).toMatchObject({ state: "pushed" });
    expectNoCredentialIn(result);
    const pushes = gitea.requests.filter((request) =>
      request.path.includes("git-receive-pack"),
    );
    expect(pushes.length).toBeGreaterThan(0);
    expect(
      pushes.every((request) => request.authorization === BASIC_LOGIN),
    ).toBe(true);
  });

  test("a repository with no credential is not pushed to", async () => {
    const catalog = catalogOf({
      open: { url: `${gitea.origin}/app.git`, branch: "main", profiles: ["d"] },
    });
    expect((await run(catalog, jobFor(catalog, "open"))).outcome).toMatchObject(
      {
        state: "failed",
        refusal: "no_push_credential",
      },
    );
  });

  test("every git runs under resource limits and is cut off before the lease runs out", async () => {
    const catalog = catalogOf({ app: appRepository() });
    const leaseMs = 60_000;
    const startedAt = Date.now();
    const result = await run(catalog, jobFor(catalog, "app"), { leaseMs });
    expect(result.outcome).toMatchObject({ state: "pushed" });
    expect(result.gitOptions.length).toBeGreaterThan(0);
    const chainBytes = chain.base.bytes.length + chain.tip.bytes.length;
    for (const options of result.gitOptions) {
      expect(options.limits?.memoryBytes).toBe(DEFAULT_MAX_GIT_MEMORY_BYTES);
      expect(options.limits?.fileSizeBytes).toBeGreaterThan(chainBytes);
      expect(options.timeoutMs).toBeLessThanOrEqual(leaseMs * 0.8);
    }
    expect(Date.now() - startedAt).toBeLessThan(leaseMs * 0.8);
  });

  test("a push whose deadline has passed starts no git and fails", async () => {
    const catalog = catalogOf({ app: appRepository() });
    const gitBefore = github.gitRequests.length;
    const result = await run(catalog, jobFor(catalog, "app"), { leaseMs: 1 });
    expect(result.outcome).toEqual({ state: "failed", refusal: "push_failed" });
    expect(result.argv).toEqual([]);
    expect(github.gitRequests.length).toBe(gitBefore);
  });

  test("a bundle chain without the pinned commit fails the push", async () => {
    const catalog = catalogOf({ app: appRepository() });
    expect(
      (await run(catalog, jobFor(catalog, "app"), { bundles: [chain.base] }))
        .outcome,
    ).toMatchObject({ state: "failed", refusal: "push_failed" });
  });
});

describe("parseLsRemote", () => {
  test("reads HEAD's symref and each ref's commit", () => {
    const sha = "c".repeat(40);
    expect(
      parseLsRemote(
        `ref: refs/heads/main\tHEAD\n${sha}\tHEAD\n${sha}\trefs/heads/agent/x\n`,
      ),
    ).toEqual({
      head: "refs/heads/main",
      refs: new Map([
        ["HEAD", sha],
        ["refs/heads/agent/x", sha],
      ]),
    });
  });
});
