import { afterEach, describe, expect, test } from "bun:test";
import {
  type CredentialProxyServer,
  routeOf,
  startCredentialProxy,
  tokenOf,
} from "./credential.ts";
import { createProxyLogger } from "./logger.ts";
import type { EgressDestination } from "./policy.ts";

const AUTHORIZER_SECRET = "a".repeat(40);
const PACKAGES_TOKEN = "wek_packages-token-of-the-attempt";

describe("routeOf: packages", () => {
  test("routes reads under a registry name, nothing that writes", () => {
    expect(routeOf("GET", "/packages/npm/left-pad", "")).toEqual({
      purpose: "packages",
      registry: "npm",
      path: "/left-pad",
      search: "",
    });
    expect(routeOf("HEAD", "/packages/go/x/@v/list", "")?.registry).toBe("go");
    // A scoped npm package is one segment with an encoded slash.
    expect(routeOf("GET", "/packages/npm/@types%2fnode", "")?.path).toBe(
      "/@types%2fnode",
    );
    expect(routeOf("GET", "/packages/npm/", "?write=true")?.search).toBe(
      "?write=true",
    );
    for (const method of ["PUT", "POST", "DELETE", "PATCH"]) {
      expect(routeOf(method, "/packages/npm/left-pad", "")).toBeNull();
    }
    expect(routeOf("GET", "/packages/npm", "")).toBeNull();
    expect(routeOf("GET", "/packages/NPM/left-pad", "")).toBeNull();
    expect(routeOf("GET", "/packages/npm/%2e%2e/admin", "")).toBeNull();
    expect(routeOf("GET", "/packages/npm/a/%2E/b", "")).toBeNull();
    expect(routeOf("GET", "/packages/npm/%E0%A4%A", "")).toBeNull();
  });
});

describe("tokenOf: packages", () => {
  const h = (init: Record<string, string>) => new Headers(init);
  const basic = (pair: string) =>
    `Basic ${Buffer.from(pair).toString("base64")}`;

  test("takes a bearer, or a Basic password from a URL's userinfo", () => {
    expect(tokenOf(h({ authorization: "Bearer t1" }), "packages")).toBe("t1");
    expect(tokenOf(h({ authorization: basic("werft:t2") }), "packages")).toBe(
      "t2",
    );
    expect(tokenOf(h({ authorization: basic(":t3") }), "packages")).toBe("t3");
    expect(tokenOf(h({ authorization: basic("t4") }), "packages")).toBeNull();
    expect(tokenOf(h({ authorization: basic("u:") }), "packages")).toBeNull();
    expect(tokenOf(h({ "x-api-key": "t5" }), "packages")).toBeNull();
    // Basic stays a packages-only carrier.
    expect(
      tokenOf(h({ authorization: basic("werft:t6") }), "repository"),
    ).toBeNull();
  });
});

type Seen = { url: string; headers: Record<string, string>; method: string };

describe("the packages route", () => {
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
      fetch(request) {
        seen.push({
          url: request.url,
          headers: Object.fromEntries(request.headers),
          method: request.method,
        });
        return handle(request);
      },
    });
    servers.push(server);
    return { port: server.port ?? 0, seen };
  }

  // Grants the packages token for the registry's upstream, with whatever
  // headers a later registry credential would add.
  function authorizer(
    registryUrl: string,
    headers: Array<[string, string]> = [],
  ): { url: string; asked: Array<Record<string, unknown>> } {
    const asked: Array<Record<string, unknown>> = [];
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        if (
          request.headers.get("authorization") !== `Bearer ${AUTHORIZER_SECRET}`
        ) {
          return new Response("no", { status: 401 });
        }
        const body = (await request.json()) as Record<string, unknown>;
        asked.push(body);
        return body.token === PACKAGES_TOKEN && body.purpose === "packages"
          ? Response.json({
              session_id: "sess-packages",
              attempt_id: "att-packages",
              upstream: { url: registryUrl, headers },
            })
          : new Response("no", { status: 401 });
      },
    });
    servers.push(server);
    return { url: `http://127.0.0.1:${server.port}`, asked };
  }

  function proxy(
    authorizerUrl: string,
    registryPort: number,
    redirect: EgressDestination[] = [],
  ): { server: CredentialProxyServer; logged: string[] } {
    const logged: string[] = [];
    const server = startCredentialProxy({
      authorizer: { url: authorizerUrl, token: AUTHORIZER_SECRET },
      hostname: "127.0.0.1",
      logger: createProxyLogger("info", (line) => logged.push(line)),
      policy: {
        allow: [],
        allowPrivate: [{ host: "registry.test", port: registryPort }],
      },
      packagesRedirect: { allow: [], allowPrivate: redirect },
      port: 0,
      resolve: async (host) =>
        host === "registry.test" || host === "cdn.test" ? ["127.0.0.1"] : [],
    });
    servers.push(server);
    return { server, logged };
  }

  test("reads a registry with no credential and logs the session", async () => {
    const registry = upstream(() => Response.json({ name: "left-pad" }));
    const auth = authorizer(`http://registry.test:${registry.port}`);
    const { server, logged } = proxy(auth.url, registry.port);
    const response = await fetch(
      `http://127.0.0.1:${server.port}/packages/npm/left-pad`,
      { headers: { authorization: `Bearer ${PACKAGES_TOKEN}` } },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ name: "left-pad" });
    expect(auth.asked).toEqual([
      { token: PACKAGES_TOKEN, purpose: "packages", registry: "npm" },
    ]);
    expect(new URL(registry.seen[0]?.url ?? "").pathname).toBe("/left-pad");
    expect(registry.seen[0]?.headers.authorization).toBeUndefined();
    const line = logged
      .map((entry) => JSON.parse(entry))
      .find((entry) => entry.message === "Credential route");
    expect(line?.fields).toMatchObject({
      purpose: "packages",
      registry: "npm",
      session_id: "sess-packages",
      attempt_id: "att-packages",
      status: 200,
    });
  });

  test("takes the token as a Basic password, as Bundler and Go send it", async () => {
    const registry = upstream(() => new Response("v1.0.0\n"));
    const auth = authorizer(`http://registry.test:${registry.port}`);
    const { server } = proxy(auth.url, registry.port);
    const response = await fetch(
      `http://127.0.0.1:${server.port}/packages/go/example.com/m/@v/list`,
      {
        headers: {
          authorization: `Basic ${Buffer.from(`werft:${PACKAGES_TOKEN}`).toString("base64")}`,
        },
      },
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("v1.0.0\n");
  });

  test("a publish never reaches the authorizer or the registry", async () => {
    const registry = upstream(() => new Response("published"));
    const auth = authorizer(`http://registry.test:${registry.port}`);
    const { server } = proxy(auth.url, registry.port);
    for (const method of ["PUT", "POST", "DELETE"]) {
      const response = await fetch(
        `http://127.0.0.1:${server.port}/packages/npm/left-pad`,
        {
          method,
          headers: { authorization: `Bearer ${PACKAGES_TOKEN}` },
          body: method === "DELETE" ? null : "{}",
        },
      );
      expect(response.status).toBe(404);
    }
    expect(auth.asked).toHaveLength(0);
    expect(registry.seen).toHaveLength(0);
  });

  test("follows a redirect to a listed host, without what the grant added", async () => {
    const cdn = upstream(() => new Response("tarball-bytes"));
    const registry = upstream(
      () =>
        new Response(null, {
          status: 302,
          headers: {
            location: `http://cdn.test:${cdn.port}/blobs/left-pad.tgz?sig=1`,
          },
        }),
    );
    const auth = authorizer(`http://registry.test:${registry.port}`, [
      ["authorization", "Bearer registry-credential"],
    ]);
    const { server, logged } = proxy(auth.url, registry.port, [
      { host: "cdn.test", port: cdn.port },
    ]);
    const response = await fetch(
      `http://127.0.0.1:${server.port}/packages/npm/left-pad/-/left-pad-1.3.0.tgz`,
      {
        headers: {
          authorization: `Bearer ${PACKAGES_TOKEN}`,
          accept: "application/octet-stream",
        },
      },
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("tarball-bytes");
    expect(registry.seen[0]?.headers.authorization).toBe(
      "Bearer registry-credential",
    );
    const followed = cdn.seen[0];
    expect(followed?.url).toBe(
      `http://cdn.test:${cdn.port}/blobs/left-pad.tgz?sig=1`,
    );
    expect(followed?.headers.authorization).toBeUndefined();
    expect(followed?.headers.host).toBe(`cdn.test:${cdn.port}`);
    expect(followed?.headers.accept).toBe("application/octet-stream");
    expect(
      logged
        .map((entry) => JSON.parse(entry))
        .find((entry) => entry.message === "Credential route redirect followed")
        ?.fields,
    ).toMatchObject({
      session_id: "sess-packages",
      to_host: "cdn.test",
      to_port: cdn.port,
    });
  });

  test("a redirect to an unlisted host is refused and not dialled", async () => {
    const elsewhere = upstream(() => new Response("should not be read"));
    const registry = upstream(
      () =>
        new Response(null, {
          status: 307,
          headers: { location: `http://cdn.test:${elsewhere.port}/steal` },
        }),
    );
    const auth = authorizer(`http://registry.test:${registry.port}`);
    const { server } = proxy(auth.url, registry.port);
    const response = await fetch(
      `http://127.0.0.1:${server.port}/packages/rubygems/gems/rake.gem`,
      { headers: { authorization: `Bearer ${PACKAGES_TOKEN}` } },
    );
    expect(response.status).toBe(502);
    expect(response.headers.get("location")).toBeNull();
    expect(elsewhere.seen).toHaveLength(0);
  });

  test("a redirect loop ends in a refusal", async () => {
    const cdn = upstream(
      (request) =>
        new Response(null, {
          status: 302,
          headers: { location: new URL(request.url).pathname },
        }),
    );
    const registry = upstream(
      () =>
        new Response(null, {
          status: 302,
          headers: { location: `http://cdn.test:${cdn.port}/again` },
        }),
    );
    const auth = authorizer(`http://registry.test:${registry.port}`);
    const { server } = proxy(auth.url, registry.port, [
      { host: "cdn.test", port: cdn.port },
    ]);
    const response = await fetch(
      `http://127.0.0.1:${server.port}/packages/npm/left-pad`,
      { headers: { authorization: `Bearer ${PACKAGES_TOKEN}` } },
    );
    expect(response.status).toBe(502);
    expect(cdn.seen).toHaveLength(5);
  });
});
