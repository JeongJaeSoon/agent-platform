import { afterEach, describe, expect, test } from "bun:test";
import {
  type CredentialProxyServer,
  lfsBatchForWorker,
  lfsDownloadBatch,
  lfsDownloadHref,
  routeOf,
  startCredentialProxy,
} from "./credential.ts";
import { createProxyLogger } from "./logger.ts";
import type { EgressDestination } from "./policy.ts";

const AUTHORIZER_TOKEN = "a".repeat(40);
const REPOSITORY_TOKEN = "wek_repository_lfs";
const OID = "e".repeat(64);
const OTHER_OID = "f".repeat(64);
const RECEIPT = "0b9f3c3e-1d8a-4c55-9a77-5a1e0f1e2d3c";
const encode = (value: unknown) =>
  new TextEncoder().encode(JSON.stringify(value));

describe("routeOf: Git LFS", () => {
  test("routes a download batch and the proxy's own object path under `/.git`", () => {
    for (const prefix of ["/repository/docs/.git"]) {
      expect(routeOf("POST", `${prefix}/info/lfs/objects/batch`, "")).toEqual({
        purpose: "repository",
        repository: "docs",
        lfs: "batch",
        path: "/info/lfs/objects/batch",
        search: "",
      });
      expect(
        routeOf("GET", `${prefix}/info/lfs/objects/${OID}`, "?size=12"),
      ).toEqual({
        purpose: "repository",
        repository: "docs",
        lfs: { oid: OID, size: 12 },
        path: "/info/lfs/objects/batch",
        search: "",
      });
    }
    // An id may itself end in `.git`; the route's own `/.git` is a segment.
    expect(
      routeOf("POST", "/repository/v1.2.git/.git/info/lfs/objects/batch", "")
        ?.repository,
    ).toBe("v1.2.git");
  });

  test("routes nothing that writes, and nothing it did not name", () => {
    const batch = "/repository/docs/.git/info/lfs/objects/batch";
    const object = `/repository/docs/.git/info/lfs/objects/${OID}`;
    expect(routeOf("GET", batch, "")).toBeNull();
    expect(routeOf("POST", batch, "?x=1")).toBeNull();
    expect(routeOf("PUT", object, "?size=1")).toBeNull();
    expect(routeOf("GET", object, "")).toBeNull();
    expect(routeOf("GET", object, "?size=-1")).toBeNull();
    expect(routeOf("GET", object, "?size=01")).toBeNull();
    expect(routeOf("GET", object.toUpperCase(), "?size=1")).toBeNull();
    expect(
      routeOf("POST", "/repository/docs/.git/info/lfs/locks/verify", ""),
    ).toBeNull();
    expect(
      routeOf("POST", "/repository/docs/info/lfs/objects/batch", ""),
    ).toBeNull();
    // `<id>.git` would read as another id; the worker never sends it.
    expect(
      routeOf("POST", "/repository/docs.git/info/lfs/objects/batch", ""),
    ).toBeNull();
    expect(
      routeOf("POST", "/repository/info/lfs/objects/batch", ""),
    ).toBeNull();
  });

  test("git's read half under `/.git`, and never its push", () => {
    expect(
      routeOf(
        "GET",
        "/repository/docs/.git/info/refs",
        "?service=git-upload-pack",
      ),
    ).toEqual({
      purpose: "repository",
      repository: "docs",
      path: "/info/refs",
      search: "?service=git-upload-pack",
    });
    expect(
      routeOf("POST", "/repository/docs/.git/git-upload-pack", "")?.path,
    ).toBe("/git-upload-pack");
    for (const prefix of ["/repository/docs", "/repository/docs/.git"]) {
      expect(
        routeOf("GET", `${prefix}/info/refs`, "?service=git-receive-pack"),
      ).toBeNull();
      expect(routeOf("POST", `${prefix}/git-receive-pack`, "")).toBeNull();
    }
    // What a URL that only starts like an attached one turns into.
    expect(
      routeOf(
        "GET",
        "/repository/docs/-x.git/info/refs",
        "?service=git-upload-pack",
      ),
    ).toBeNull();
  });
});

describe("lfsDownloadBatch", () => {
  test("keeps a download's objects and nothing else the worker sent", () => {
    const body = lfsDownloadBatch(
      encode({
        operation: "download",
        transfers: ["basic", "custom"],
        ref: { name: "refs/heads/main" },
        objects: [{ oid: OID, size: 5, extra: true }],
      }),
    );
    expect(JSON.parse(new TextDecoder().decode(body ?? undefined))).toEqual({
      operation: "download",
      transfers: ["basic"],
      objects: [{ oid: OID, size: 5 }],
    });
  });

  test("refuses an upload and anything it would have to guess about", () => {
    const object = { oid: OID, size: 5 };
    for (const batch of [
      { operation: "upload", objects: [object] },
      { objects: [object] },
      { operation: "download", objects: [] },
      { operation: "download", objects: [{ oid: "E".repeat(64), size: 5 }] },
      { operation: "download", objects: [{ oid: OID, size: -1 }] },
      { operation: "download", objects: [{ oid: OID, size: "5" }] },
      { operation: "download", objects: Array(101).fill(object) },
    ]) {
      expect(lfsDownloadBatch(encode(batch))).toBeNull();
    }
    expect(lfsDownloadBatch(new TextEncoder().encode("{"))).toBeNull();
  });
});

describe("lfsBatchForWorker and lfsDownloadHref", () => {
  const answer = {
    transfer: "basic",
    objects: [
      {
        oid: OID,
        size: 5,
        actions: {
          download: {
            href: "https://storage.test/alambic/e?X-Amz-Signature=s&token=t",
            header: { Authorization: "RemoteAuth secret" },
            expires_in: 3600,
          },
          upload: { href: "https://storage.test/up" },
        },
      },
      {
        oid: OTHER_OID,
        size: 1,
        error: {
          code: 404,
          message: "Not found at https://storage.test/x?t=s",
        },
      },
    ],
  };

  test("points each download at the proxy, with no location or header of the server's", () => {
    expect(
      lfsBatchForWorker(
        answer,
        "http://proxy:3129/repository/docs/.git/info/lfs/objects",
      ),
    ).toEqual({
      transfer: "basic",
      objects: [
        {
          oid: OID,
          size: 5,
          authenticated: true,
          actions: {
            download: {
              href: `http://proxy:3129/repository/docs/.git/info/lfs/objects/${OID}?size=5`,
              expires_in: 3600,
            },
          },
        },
        {
          oid: OTHER_OID,
          size: 1,
          error: { code: 404, message: "the LFS server refused this object" },
        },
      ],
    });
    expect(
      lfsBatchForWorker({ objects: [{ oid: "x" }] }, "http://p"),
    ).toBeNull();
  });

  test("reads the server's location for one object, only a plain http(s) one", () => {
    expect(lfsDownloadHref(answer, OID)?.host).toBe("storage.test");
    expect(lfsDownloadHref(answer, OTHER_OID)).toBeNull();
    const at = (href: string) => ({
      objects: [{ oid: OID, actions: { download: { href } } }],
    });
    expect(lfsDownloadHref(at("ftp://storage.test/x"), OID)).toBeNull();
    expect(lfsDownloadHref(at("https://u:p@storage.test/x"), OID)).toBeNull();
  });
});

type Seen = {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
};

describe("the LFS route", () => {
  const servers: Array<{ stop(force?: boolean): void }> = [];
  afterEach(() => {
    for (const server of servers.splice(0)) server.stop(true);
  });

  function upstream(handle: (request: Request) => Response): {
    port: number;
    seen: Seen[];
  } {
    const seen: Seen[] = [];
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        seen.push({
          url: request.url,
          method: request.method,
          headers: Object.fromEntries(request.headers),
          body: await request.text(),
        });
        return handle(request);
      },
    });
    servers.push(server);
    return { port: server.port ?? 0, seen };
  }

  // The repository the session attached is `docs`; `tools` is refused with
  // the gate's receipt, as the gateway answers for one outside the list.
  function authorizer(repositoryUrl: string): {
    url: string;
    asked: Array<Record<string, unknown>>;
  } {
    const asked: Array<Record<string, unknown>> = [];
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        if (
          request.headers.get("authorization") !== `Bearer ${AUTHORIZER_TOKEN}`
        ) {
          return new Response("no", { status: 401 });
        }
        const body = (await request.json()) as Record<string, unknown>;
        asked.push(body);
        if (body.token !== REPOSITORY_TOKEN || body.purpose !== "repository") {
          return new Response("no", { status: 401 });
        }
        if (body.repository_id !== "docs") {
          return Response.json(
            {
              code: "GITHUB_REFUSED",
              details: { reason_code: "repository_not_allowed" },
              receipt_id: RECEIPT,
            },
            { status: 403 },
          );
        }
        return Response.json({
          session_id: "sess-lfs",
          attempt_id: "att-lfs",
          upstream: {
            url: repositoryUrl,
            headers: [
              ["authorization", "Basic eC1hY2Nlc3MtdG9rZW46Z2hzX3NlY3JldA=="],
            ],
          },
        });
      },
    });
    servers.push(server);
    return { url: `http://127.0.0.1:${server.port}`, asked };
  }

  function proxy(
    authorizerUrl: string,
    githubPort: number,
    storage: EgressDestination[] = [],
  ): { server: CredentialProxyServer; logged: string[] } {
    const logged: string[] = [];
    const server = startCredentialProxy({
      authorizer: { url: authorizerUrl, token: AUTHORIZER_TOKEN },
      hostname: "127.0.0.1",
      logger: createProxyLogger("info", (line) => logged.push(line)),
      policy: {
        allow: [],
        allowPrivate: [{ host: "github.test", port: githubPort }],
      },
      packagesRedirect: { allow: [], allowPrivate: storage },
      port: 0,
      resolve: async (host) =>
        host === "github.test" || host === "storage.test" ? ["127.0.0.1"] : [],
    });
    servers.push(server);
    return { server, logged };
  }

  function github(storagePort: number) {
    return upstream((request) => {
      if (!request.url.endsWith("/o/docs.git/info/lfs/objects/batch")) {
        return new Response("not found", { status: 404 });
      }
      return Response.json(
        {
          transfer: "basic",
          objects: [
            {
              oid: OID,
              size: 5,
              authenticated: true,
              actions: {
                download: {
                  href: `http://storage.test:${storagePort}/alambic/media/${OID}?X-Amz-Signature=sig&token=presigned`,
                  expires_in: 3600,
                },
              },
            },
          ],
        },
        { headers: { "content-type": "application/vnd.git-lfs+json" } },
      );
    });
  }

  const lfsHeaders = {
    authorization: `Bearer ${REPOSITORY_TOKEN}`,
    accept: "application/vnd.git-lfs+json",
    "content-type": "application/vnd.git-lfs+json",
  };
  const downloadBatch = JSON.stringify({
    operation: "download",
    transfers: ["basic"],
    ref: { name: "refs/heads/main" },
    objects: [{ oid: OID, size: 5 }],
  });

  test("a batch goes to the repository's .git with its credential, and comes back pointing at the proxy", async () => {
    const storage = upstream(() => new Response("never"));
    const repo = github(storage.port);
    const auth = authorizer(`http://github.test:${repo.port}/o/docs`);
    const { server } = proxy(auth.url, repo.port);
    const base = `http://127.0.0.1:${server.port}/repository/docs/.git/info/lfs/objects`;
    const response = await fetch(`${base}/batch`, {
      method: "POST",
      headers: lfsHeaders,
      body: downloadBatch,
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(
      "application/vnd.git-lfs+json",
    );
    const text = await response.text();
    expect(text).not.toContain("storage.test");
    expect(text).not.toContain("presigned");
    expect(JSON.parse(text).objects[0].actions.download.href).toBe(
      `${base}/${OID}?size=5`,
    );
    expect(auth.asked).toEqual([
      { token: REPOSITORY_TOKEN, purpose: "repository", repository_id: "docs" },
    ]);
    const sent = repo.seen[0];
    expect(sent?.method).toBe("POST");
    expect(new URL(sent?.url ?? "").pathname).toBe(
      "/o/docs.git/info/lfs/objects/batch",
    );
    expect(sent?.headers.authorization).toStartWith("Basic ");
    expect(sent?.headers.accept).toBe("application/vnd.git-lfs+json");
    expect(JSON.parse(sent?.body ?? "")).toEqual({
      operation: "download",
      transfers: ["basic"],
      objects: [{ oid: OID, size: 5 }],
    });
    expect(storage.seen).toHaveLength(0);
  });

  test("an object is fetched from the batch's location on a listed host, without the credential", async () => {
    const storage = upstream(
      () =>
        new Response("bytes", {
          headers: { "x-amz-request-id": "storage-only" },
        }),
    );
    const repo = github(storage.port);
    const auth = authorizer(`http://github.test:${repo.port}/o/docs.git`);
    const { server, logged } = proxy(auth.url, repo.port, [
      { host: "storage.test", port: storage.port },
    ]);
    const response = await fetch(
      `http://127.0.0.1:${server.port}/repository/docs/.git/info/lfs/objects/${OID}?size=5`,
      { headers: { authorization: `Bearer ${REPOSITORY_TOKEN}` } },
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("x-amz-request-id")).toBeNull();
    expect(await response.text()).toBe("bytes");
    expect(JSON.parse(repo.seen[0]?.body ?? "")).toEqual({
      operation: "download",
      transfers: ["basic"],
      objects: [{ oid: OID, size: 5 }],
    });
    const fetched = storage.seen[0];
    expect(fetched?.method).toBe("GET");
    expect(fetched?.url).toBe(
      `http://storage.test:${storage.port}/alambic/media/${OID}?X-Amz-Signature=sig&token=presigned`,
    );
    expect(fetched?.headers.authorization).toBeUndefined();
    expect(
      logged
        .map((line) => JSON.parse(line))
        .find((entry) => entry.message === "Credential route LFS object")
        ?.fields,
    ).toMatchObject({
      repository_id: "docs",
      session_id: "sess-lfs",
      to_host: "storage.test",
    });
  });

  test("a storage error is not relayed, even one echoing a location it redirected to", async () => {
    const storage = upstream((request) => {
      const { search } = new URL(request.url);
      if (search.includes("X-Amz-Signature=sig")) {
        return new Response(null, {
          status: 302,
          headers: {
            location: "/alambic/again?X-Amz-Signature=fresh-signature",
          },
        });
      }
      return new Response(`SignatureDoesNotMatch for ${search}`, {
        status: 403,
        headers: { "x-echo": search },
      });
    });
    const repo = github(storage.port);
    const auth = authorizer(`http://github.test:${repo.port}/o/docs`);
    const { server } = proxy(auth.url, repo.port, [
      { host: "storage.test", port: storage.port },
    ]);
    const response = await fetch(
      `http://127.0.0.1:${server.port}/repository/docs/.git/info/lfs/objects/${OID}?size=5`,
      { headers: { authorization: `Bearer ${REPOSITORY_TOKEN}` } },
    );
    expect(response.status).toBe(502);
    expect(response.headers.get("x-echo")).toBeNull();
    const text = await response.text();
    expect(text).toContain("403");
    expect(text).not.toContain("presigned");
    expect(text).not.toContain("fresh-signature");
    expect(storage.seen).toHaveLength(2);
  });

  test("an encoded object is refused, not passed on as plain bytes", async () => {
    const storage = upstream(
      () =>
        new Response(new Uint8Array([31, 139, 8, 0]), {
          headers: { "content-encoding": "gzip" },
        }),
    );
    const repo = github(storage.port);
    const auth = authorizer(`http://github.test:${repo.port}/o/docs`);
    const { server } = proxy(auth.url, repo.port, [
      { host: "storage.test", port: storage.port },
    ]);
    const response = await fetch(
      `http://127.0.0.1:${server.port}/repository/docs/.git/info/lfs/objects/${OID}?size=5`,
      { headers: { authorization: `Bearer ${REPOSITORY_TOKEN}` } },
    );
    expect(response.status).toBe(502);
    expect(await response.text()).toContain("encoded body");
  });

  test("an object on a host off the list is refused and not dialled", async () => {
    const storage = upstream(() => new Response("bytes"));
    const repo = github(storage.port);
    const auth = authorizer(`http://github.test:${repo.port}/o/docs`);
    const { server } = proxy(auth.url, repo.port);
    const response = await fetch(
      `http://127.0.0.1:${server.port}/repository/docs/.git/info/lfs/objects/${OID}?size=5`,
      { headers: { authorization: `Bearer ${REPOSITORY_TOKEN}` } },
    );
    expect(response.status).toBe(502);
    expect(storage.seen).toHaveLength(0);
  });

  test("a repository outside the session's list is refused with its receipt, for a batch and an object alike", async () => {
    const storage = upstream(() => new Response("bytes"));
    const repo = github(storage.port);
    const auth = authorizer(`http://github.test:${repo.port}/o/docs`);
    const { server } = proxy(auth.url, repo.port, [
      { host: "storage.test", port: storage.port },
    ]);
    const base = `http://127.0.0.1:${server.port}/repository/tools/.git/info/lfs/objects`;
    const batch = await fetch(`${base}/batch`, {
      method: "POST",
      headers: lfsHeaders,
      body: downloadBatch,
    });
    const object = await fetch(`${base}/${OID}?size=5`, {
      headers: { authorization: `Bearer ${REPOSITORY_TOKEN}` },
    });
    for (const response of [batch, object]) {
      expect(response.status).toBe(403);
      expect(await response.text()).toContain(RECEIPT);
    }
    expect(auth.asked.map((question) => question.repository_id)).toEqual([
      "tools",
      "tools",
    ]);
    expect(repo.seen).toHaveLength(0);
    expect(storage.seen).toHaveLength(0);
  });

  test("an upload batch and a push are refused before the authorizer is asked", async () => {
    const repo = github(0);
    const auth = authorizer(`http://github.test:${repo.port}/o/docs`);
    const { server } = proxy(auth.url, repo.port);
    const origin = `http://127.0.0.1:${server.port}/repository/docs/.git`;
    const upload = await fetch(`${origin}/info/lfs/objects/batch`, {
      method: "POST",
      headers: lfsHeaders,
      body: JSON.stringify({
        operation: "upload",
        objects: [{ oid: OID, size: 5 }],
      }),
    });
    expect(upload.status).toBe(400);
    const advertise = await fetch(
      `${origin}/info/refs?service=git-receive-pack`,
      { headers: { authorization: `Bearer ${REPOSITORY_TOKEN}` } },
    );
    const push = await fetch(`${origin}/git-receive-pack`, {
      method: "POST",
      headers: { authorization: `Bearer ${REPOSITORY_TOKEN}` },
      body: "0000",
    });
    expect([advertise.status, push.status]).toEqual([200, 404]);
    expect(await advertise.text()).toContain("ERR git push does not reach");
    expect(auth.asked).toHaveLength(0);
    expect(repo.seen).toHaveLength(0);
  });
});
