import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { sanitizeFields } from "@werft-ai/observability";
import { ForgeCredentialError } from "@werft-ai/platform";
import { type FakeGitHub, startFakeGitHub } from "@werft-ai/testkit";
import { createGitHubConnection, RATE_LIMIT_RETRIES } from "./forge-github.ts";

const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
const privateKey = keys.privateKey
  .export({ type: "pkcs1", format: "pem" })
  .toString();
const publicKey = keys.publicKey
  .export({ type: "spki", format: "pem" })
  .toString();
const repo = { owner: "acme", name: "app" };
const head = "agent/0b9a2f3e-5c4d-4e6f-8a7b-9c0d1e2f3a4b";
const PULLS = { contents: "read", pull_requests: "write" } as const;

let github: FakeGitHub;
beforeAll(async () => {
  github = await startFakeGitHub({ appId: 101, publicKey });
  await github.createRepository("acme", "app", { "README.md": "hello\n" });
  await github.writeUnrelatedCommit("acme", "app", head);
});
afterAll(async () => {
  await github.stop();
});

async function appForge() {
  const warnings: Array<Record<string, unknown>> = [];
  const connection = createGitHubConnection({
    apiBase: github.origin,
    credentials: { kind: "app", appId: 101, installationId: 202, privateKey },
    logger: {
      warn: (message: string, fields?: Record<string, unknown>) =>
        warnings.push({ message, ...fields }),
    },
    retryAfterBaseMs: 1,
    paced: false,
  });
  const { credential } = await connection.credential(repo, PULLS);
  return { forge: connection.api(repo, credential), connection, warnings };
}

/** A PAT connection's API against a stub server on `port`. */
async function patForge(port: number | undefined) {
  const connection = createGitHubConnection({
    apiBase: `http://127.0.0.1:${port}`,
    credentials: { kind: "token", username: "x", password: "pat-test" },
    retryAfterBaseMs: 1,
    paced: false,
  });
  const { credential } = await connection.credential(repo, PULLS);
  return connection.api(repo, credential);
}

describe("GitHub pull requests", () => {
  test("opens a pull request with a token for that one repository and pull_requests:write, and finds it again", async () => {
    const tokensBefore = github.tokenRequests.length;
    const { forge } = await appForge();
    const opened = await forge.createPullRequest({
      head,
      base: "main",
      title: "Agent result",
      body: "What the session did.",
    });
    expect(opened).toMatchObject({
      number: 1,
      state: "open",
      head,
      base: "main",
    });
    expect(opened.url).toBe(`${github.origin}/acme/app/pull/1`);
    expect(github.tokenRequests.slice(tokensBefore)).toEqual([
      expect.objectContaining({
        status: 201,
        body: {
          repositories: ["app"],
          permissions: { contents: "read", pull_requests: "write" },
        },
      }),
    ]);
    expect(github.pullRequests("acme", "app")).toEqual([
      expect.objectContaining({
        head,
        base: "main",
        title: "Agent result",
        body: "What the session did.",
      }),
    ]);

    expect(await forge.findPullRequestForBranch(head)).toEqual(opened);
    expect(await forge.findPullRequestForBranch("agent/none")).toBeNull();
    expect(
      await forge.createPullRequest({
        head,
        base: "main",
        title: "again",
        body: "",
      }),
    ).toEqual(opened);
    expect(github.pullRequests("acme", "app")).toHaveLength(1);
    expect(github.tokenRequests.length - tokensBefore).toBe(1);
  });

  test("a refused create logs GitHub's reason, not only its status", async () => {
    const { forge, warnings } = await appForge();
    const error = await forge
      .createPullRequest({
        head: "agent/missing",
        base: "main",
        title: "nowhere",
        body: "",
      })
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect(error).toBeInstanceOf(ForgeCredentialError);
    const fields = {
      request: "pull request create",
      status: 422,
      error: "HttpError",
      github_reason: "Validation Failed",
      github_errors: ["head"],
    };
    expect(warnings).toEqual([{ message: "GitHub request failed", ...fields }]);
    // The production logger drops message-like keys; these survive it.
    expect(sanitizeFields(fields)).toEqual(fields);
  });

  test("an open pull request is found even when a newer one for the branch is closed", async () => {
    const { forge } = await appForge();
    const pulls = github.pullRequests("acme", "app");
    pulls.push({
      number: 99,
      head,
      base: "release",
      title: "closed later",
      body: "",
      state: "closed",
      html_url: `${github.origin}/acme/app/pull/99`,
    });
    try {
      expect(await forge.findPullRequestForBranch(head)).toMatchObject({
        number: 1,
        state: "open",
      });
    } finally {
      pulls.pop();
    }
  });

  test("a pull request token is not the contents token, and neither is reused for the other", async () => {
    const fresh = createGitHubConnection({
      apiBase: github.origin,
      credentials: { kind: "app", appId: 101, installationId: 202, privateKey },
      retryAfterBaseMs: 1,
      paced: false,
    });
    const before = github.tokenRequests.length;
    await fresh.credential(repo, { contents: "write" });
    const { credential } = await fresh.credential(repo, PULLS);
    await fresh.api(repo, credential).findPullRequestForBranch(head);
    await fresh.credential(repo, { contents: "write" });
    expect(
      github.tokenRequests.slice(before).map((asked) => asked.body),
    ).toEqual([
      { repositories: ["app"], permissions: { contents: "write" } },
      {
        repositories: ["app"],
        permissions: { contents: "read", pull_requests: "write" },
      },
    ]);
  });

  test("upserts one comment per marker", async () => {
    const { forge } = await appForge();
    const marker = "<!-- agent-platform:s:status -->";
    const first = await forge.upsertComment(1, marker, "Running.");
    expect(first.created).toBe(true);
    const other = await forge.upsertComment(
      1,
      "<!-- agent-platform:s:other -->",
      "Elsewhere.",
    );
    const second = await forge.upsertComment(1, marker, "Done.");
    expect(second).toEqual({ id: first.id, url: first.url, created: false });
    expect(github.comments("acme", "app", 1)).toEqual([
      expect.objectContaining({ id: first.id, body: `Done.\n\n${marker}` }),
      expect.objectContaining({ id: other.id }),
    ]);
  });

  test("two first comments for one marker at once leave one comment", async () => {
    const { forge } = await appForge();
    const marker = "<!-- agent-platform:s:racing -->";
    const [a, b] = await Promise.all([
      forge.upsertComment(1, marker, "One."),
      forge.upsertComment(1, marker, "Two."),
    ]);
    expect([a.created, b.created]).toEqual([true, false]);
    expect(
      github
        .comments("acme", "app", 1)
        .filter((comment) => comment.body.includes(marker)),
    ).toEqual([
      expect.objectContaining({ id: a.id, body: `Two.\n\n${marker}` }),
    ]);
  });

  test("a marker someone else pasted is left alone", async () => {
    const { forge } = await appForge();
    const marker = "<!-- agent-platform:s:pasted -->";
    const pasted = github.addComment("acme", "app", 1, `Copied ${marker}`);
    const ours = await forge.upsertComment(1, marker, "Running.");
    expect(ours.created).toBe(true);
    expect(await forge.upsertComment(1, marker, "Done.")).toEqual({
      ...ours,
      created: false,
    });
    const thread = github.comments("acme", "app", 1);
    expect(thread.find((comment) => comment.id === pasted.id)?.body).toBe(
      `Copied ${marker}`,
    );
    expect(thread.find((comment) => comment.id === ours.id)?.body).toBe(
      `Done.\n\n${marker}`,
    );
  });

  test("past the comments it can read, it fails rather than post a second marked one", async () => {
    const seen: string[] = [];
    const page = Array.from({ length: 100 }, (_, index) => ({
      id: index,
      body: "noise",
      html_url: `h/${index}`,
      user: { id: 7 },
    }));
    const stub = Bun.serve({
      port: 0,
      fetch(request) {
        seen.push(request.method);
        return Response.json(page);
      },
    });
    try {
      const forge = await patForge(stub.port);
      await expect(
        forge.upsertComment(1, "<!-- agent-platform:s:x -->", "Hi"),
      ).rejects.toBeInstanceOf(ForgeCredentialError);
      expect(seen).toEqual(Array(10).fill("GET"));
    } finally {
      await stub.stop(true);
    }
  });

  test("a new comment the forge answered 5xx is not posted again", async () => {
    const seen: string[] = [];
    const stub = Bun.serve({
      port: 0,
      fetch(request) {
        seen.push(request.method);
        return request.method === "GET"
          ? Response.json([])
          : Response.json({ message: "Bad Gateway" }, { status: 502 });
      },
    });
    try {
      const forge = await patForge(stub.port);
      await expect(
        forge.upsertComment(1, "<!-- agent-platform:s:y -->", "Hi"),
      ).rejects.toBeInstanceOf(ForgeCredentialError);
      expect(seen).toEqual(["GET", "POST"]);
    } finally {
      await stub.stop(true);
    }
  });

  test("with a PAT, the platform's comment is the token owner's", async () => {
    const marker = "<!-- agent-platform:s:status -->";
    const thread = [
      { id: 1, body: `Mine? ${marker}`, html_url: "h/1", user: { id: 7 } },
      { id: 2, body: `Ours ${marker}`, html_url: "h/2", user: { id: 42 } },
    ];
    const seen: string[] = [];
    const stub = Bun.serve({
      port: 0,
      async fetch(request) {
        const { pathname } = new URL(request.url);
        seen.push(`${request.method} ${pathname}`);
        if (pathname === "/user") return Response.json({ id: 42 });
        if (request.method === "GET") return Response.json(thread);
        const { body } = (await request.json()) as { body: string };
        return Response.json({ id: 2, body, html_url: "h/2" });
      },
    });
    try {
      const forge = await patForge(stub.port);
      expect(await forge.upsertComment(1, marker, "Done.")).toEqual({
        id: 2,
        url: "h/2",
        created: false,
      });
      expect(seen).toEqual([
        "GET /repos/acme/app/issues/1/comments",
        "GET /user",
        "PATCH /repos/acme/app/issues/comments/2",
      ]);
    } finally {
      await stub.stop(true);
    }
  });

  test("waits out a secondary rate limit by retry-after and a primary one by x-ratelimit-reset", async () => {
    const { forge, warnings } = await appForge();
    await forge.findPullRequestForBranch(head);
    const before = github.apiRequests.length;
    github.rateLimitNext(1, "secondary", 1);
    expect(await forge.findPullRequestForBranch(head)).not.toBeNull();
    github.rateLimitNext(1, "primary", 1);
    expect(await forge.findPullRequestForBranch(head)).not.toBeNull();
    expect(github.apiRequests.slice(before).map((r) => r.status)).toEqual([
      403, 200, 429, 200,
    ]);
    expect(warnings).toEqual([
      expect.objectContaining({
        message: "GitHub rate limit",
        limit: "secondary",
        request: "GET /repos/{owner}/{repo}/pulls",
        retry_after_seconds: 1,
        retrying: true,
      }),
      expect.objectContaining({ limit: "primary", retrying: true }),
    ]);
  });

  test("gives up after a bounded number of rate-limited retries, and a long wait is not taken", async () => {
    const { forge, warnings } = await appForge();
    await forge.findPullRequestForBranch(head);
    const before = github.apiRequests.length;
    github.rateLimitNext(10, "secondary", 1);
    const error = await forge
      .findPullRequestForBranch(head)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ForgeCredentialError);
    expect((error as Error).message).toBe(
      "GitHub pull request lookup failed (403)",
    );
    expect(github.apiRequests.length - before).toBe(RATE_LIMIT_RETRIES + 1);

    github.rateLimitNext(1, "secondary", 3600);
    const waited = await forge
      .findPullRequestForBranch(head)
      .catch((e: unknown) => e);
    expect(waited).toBeInstanceOf(ForgeCredentialError);
    expect(warnings.at(-2)).toMatchObject({
      retry_after_seconds: 3600,
      retrying: false,
    });
    github.rateLimitNext(0, "secondary");
    expect(JSON.stringify(warnings)).not.toMatch(/ghs_|token [a-z0-9]/i);
  });
});
