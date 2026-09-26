import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  bodyReservation,
  type CredentialProxyServer,
  type EgressGrant,
  parseGrant,
  responseHeaders,
  routeOf,
  secretGuard,
  secretsOf,
  startCredentialProxy,
  tokenOf,
  upstreamRequestHeaders,
} from "./credential.ts";
import { createProxyLogger } from "./logger.ts";
import type { EgressPolicy } from "./policy.ts";

const AUTHORIZER_TOKEN = "authorizer-token-for-tests-0123456789";
const WORKER_TOKEN = "wep_worker-egress-token";
const PROVIDER_KEY = "sk-provider-key-kept-from-the-worker";
const silent = createProxyLogger("error", () => {});

describe("routeOf", () => {
  test("routes the Messages API and git's read half, nothing else", () => {
    expect(routeOf("POST", "/provider/v1/messages", "")).toEqual({
      purpose: "provider",
      path: "/v1/messages",
      search: "",
    });
    expect(
      routeOf("POST", "/provider/v1/messages", "?beta=true"),
    ).toMatchObject({ purpose: "provider", search: "?beta=true" });
    expect(
      routeOf("POST", "/provider/v1/messages/count_tokens", ""),
    ).toMatchObject({ path: "/v1/messages/count_tokens" });
    expect(
      routeOf("GET", "/repository/info/refs", "?service=git-upload-pack"),
    ).toEqual({
      purpose: "repository",
      path: "/info/refs",
      search: "?service=git-upload-pack",
    });
    expect(routeOf("POST", "/repository/git-upload-pack", "")).toMatchObject({
      path: "/git-upload-pack",
    });
    for (const [method, path, search] of [
      ["GET", "/provider/v1/messages", ""],
      ["POST", "/provider/v1/models", ""],
      ["POST", "/provider/v1/messages/batches", ""],
      ["POST", "/provider/v1/messages", "?beta=true&x=1"],
      ["POST", "/provider/v1/messages/", ""],
      ["POST", "/provider/../v1/messages", ""],
      ["GET", "/repository/info/refs", "?service=git-receive-pack"],
      ["POST", "/repository/git-receive-pack", ""],
      ["POST", "/repository/git-upload-pack", "?x=1"],
      ["GET", "/", ""],
    ] as const) {
      expect(routeOf(method, path, search)).toBeNull();
    }
  });
});

describe("bodyReservation", () => {
  const headers = (entries: Record<string, string>) => new Headers(entries);
  test("reserves the declared length, or the cap for a chunked body", () => {
    expect(bodyReservation(headers({}), "repository")).toEqual({ bytes: 0 });
    expect(
      bodyReservation(headers({ "content-length": "13" }), "provider"),
    ).toEqual({ bytes: 13 });
    expect(
      bodyReservation(headers({ "transfer-encoding": "chunked" }), "provider"),
    ).toEqual({ bytes: 32 * 1024 * 1024 });
  });

  test("refuses what could never fit, and an object body with no length", () => {
    expect(
      bodyReservation(
        headers({ "content-length": String(32 * 1024 * 1024 + 1) }),
        "provider",
      ),
    ).toEqual({ refused: 413 });
    expect(
      bodyReservation(
        headers({ "content-length": String(32 * 1024 * 1024 + 1) }),
        "object_store",
      ),
    ).toEqual({ bytes: 32 * 1024 * 1024 + 1 });
    expect(
      bodyReservation(
        headers({ "transfer-encoding": "chunked" }),
        "object_store",
      ),
    ).toEqual({ refused: 411 });
  });
});

describe("tokenOf", () => {
  test("takes exactly one carrier", () => {
    const h = (init: Record<string, string>) => new Headers(init);
    expect(tokenOf(h({ "x-api-key": "t1" }), "provider")).toBe("t1");
    expect(tokenOf(h({ authorization: "Bearer t2" }), "provider")).toBe("t2");
    expect(tokenOf(h({ authorization: "Bearer t3" }), "repository")).toBe("t3");
    // git has no x-api-key; a repository call carries a bearer or nothing.
    expect(tokenOf(h({ "x-api-key": "t1" }), "repository")).toBeNull();
    expect(
      tokenOf(h({ "x-api-key": "t", authorization: "Bearer t" }), "provider"),
    ).toBeNull();
    expect(
      tokenOf(h({ authorization: "Basic dTpw" }), "repository"),
    ).toBeNull();
    expect(tokenOf(h({ authorization: "Bearer " }), "provider")).toBeNull();
    expect(tokenOf(h({}), "provider")).toBeNull();
  });
});

describe("parseGrant", () => {
  const good = {
    session_id: "s",
    attempt_id: "a",
    upstream: { url: "https://api.test", headers: [["X-Api-Key", "k"]] },
  };

  test("accepts the authorizer's shape and lowercases header names", () => {
    expect(parseGrant(good)).toEqual({
      sessionId: "s",
      attemptId: "a",
      upstream: new URL("https://api.test"),
      headers: [["x-api-key", "k"]],
      target: null,
    });
    // The object store route's signed request line comes back verbatim.
    expect(
      parseGrant({
        ...good,
        upstream: { ...good.upstream, target: "/b/sessions/s1/x?versionId=v" },
      })?.target,
    ).toBe("/b/sessions/s1/x?versionId=v");
    for (const target of ["b/x", "/b/x y", "/b/x\r\nhost: evil", 7]) {
      expect(
        parseGrant({ ...good, upstream: { ...good.upstream, target } }),
      ).toBeNull();
    }
  });

  test("refuses anything it would have to guess about", () => {
    for (const bad of [
      null,
      "x",
      { ...good, session_id: 1 },
      { ...good, upstream: { ...good.upstream, url: "ftp://api.test" } },
      { ...good, upstream: { ...good.upstream, url: "https://u:p@api.test" } },
      { ...good, upstream: { ...good.upstream, url: "https://api.test/?q" } },
      { ...good, upstream: { ...good.upstream, url: "not a url" } },
      { ...good, upstream: { ...good.upstream, headers: [["bad name", "v"]] } },
      {
        ...good,
        upstream: { ...good.upstream, headers: [["x-api-key", "a\r\nb: c"]] },
      },
      { ...good, upstream: { ...good.upstream, headers: [["x"]] } },
      { ...good, upstream: { ...good.upstream, headers: {} } },
    ]) {
      expect(parseGrant(bad)).toBeNull();
    }
  });
});

describe("upstreamRequestHeaders", () => {
  test("drops the worker's token, hop headers and what Connection names", () => {
    const grant = parseGrant({
      session_id: "s",
      attempt_id: "a",
      upstream: {
        url: "https://api.test/base",
        headers: [["x-api-key", PROVIDER_KEY]],
      },
    }) as EgressGrant;
    const out = upstreamRequestHeaders(
      new Headers({
        authorization: `Bearer ${WORKER_TOKEN}`,
        connection: "keep-alive, x-secret-hop",
        "x-secret-hop": "1",
        "accept-encoding": "gzip",
        "anthropic-version": "2023-06-01",
        cookie: "a=b",
        host: "proxy.internal",
        "proxy-authorization": "Basic x",
      }),
      grant,
    );
    expect(Object.fromEntries(out)).toEqual({
      "accept-encoding": "identity",
      "anthropic-version": "2023-06-01",
      host: "api.test",
      "x-api-key": PROVIDER_KEY,
    });
  });
});

describe("secretGuard", () => {
  async function through(chunks: string[], values: string[]) {
    const matched: string[] = [];
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) {
          controller.enqueue(new TextEncoder().encode(chunk));
        }
        controller.close();
      },
    }).pipeThrough(secretGuard(values, () => matched.push("match")));
    const reader = stream.getReader();
    let out = "";
    try {
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        out += new TextDecoder().decode(next.value);
      }
      return { out, broken: false, matched };
    } catch {
      return { out, broken: true, matched };
    }
  }

  test("passes a clean body through whole, across chunk boundaries", async () => {
    expect(await through(["abc", "def", "ghi"], ["value-12345678"])).toEqual({
      out: "abcdefghi",
      broken: false,
      matched: [],
    });
  });

  test("breaks before any byte of a value, even one split over chunks", async () => {
    const result = await through(
      ["head value-1", "2345678 tail"],
      ["value-12345678"],
    );
    expect(result.broken).toBe(true);
    expect(result.matched).toEqual(["match"]);
    expect(result.out).not.toContain("value-1");
  });

  test("does not look for values too short to tell from chance", async () => {
    expect((await through(["pass word"], ["pass"])).broken).toBe(false);
  });
});

describe("responseHeaders", () => {
  test("drops a header whose value or name echoes a value (Codex R3)", () => {
    const out = responseHeaders(
      new Headers({
        "content-type": "application/json",
        "x-echo": `key=${PROVIDER_KEY}`,
        [`x-${PROVIDER_KEY}`]: "1",
      }),
      [PROVIDER_KEY],
    );
    expect(Object.fromEntries(out)).toEqual({
      "content-type": "application/json",
    });
  });
});

describe("secretsOf", () => {
  test("covers the header value, its token and a basic password", () => {
    const basic = Buffer.from("reader:repo-password").toString("base64");
    const grant = parseGrant({
      session_id: "s",
      attempt_id: "a",
      upstream: {
        url: "https://git.test",
        headers: [["authorization", `Basic ${basic}`]],
      },
    }) as EgressGrant;
    expect(secretsOf(grant)).toEqual(
      expect.arrayContaining([
        `Basic ${basic}`,
        basic,
        "reader:repo-password",
        "repo-password",
      ]),
    );
  });
});

type UsageReport = {
  exchange_id: string;
  session_id: string;
  attempt_id: string;
  usage: Record<string, unknown>;
};

async function until(done: () => boolean, ms = 3_000): Promise<void> {
  const by = performance.now() + ms;
  while (!done()) {
    if (performance.now() > by) throw new Error("timed out waiting");
    await Bun.sleep(10);
  }
}

function sseBody(events: Array<Record<string, unknown>>): string {
  return events
    .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
    .join("");
}

type Seen = { url: string; headers: Record<string, string>; body: string };

describe("startCredentialProxy", () => {
  let directory: string;
  let certificate: { cert: string; key: string };
  const servers: Array<{ stop(force?: boolean): void }> = [];

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "credential-proxy-"));
    certificate = await mintCertificate(directory, "upstream.test");
  });

  afterAll(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  afterEach(() => {
    for (const server of servers.splice(0)) server.stop(true);
  });

  function upstream(
    handle: (request: Request, seen: Seen[]) => Response | Promise<Response>,
    tls?: { cert: string; key: string },
  ): { port: number; seen: Seen[] } {
    const seen: Seen[] = [];
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      ...(tls === undefined ? {} : { tls }),
      async fetch(request) {
        const body = await request.text();
        seen.push({
          url: request.url,
          headers: Object.fromEntries(request.headers),
          body,
        });
        return handle(request, seen);
      },
    });
    servers.push(server);
    return { port: server.port ?? 0, seen };
  }

  function authorizer(
    answer: (body: { token: string; purpose: string }) => Response,
    usageAnswer: () => Response = () => Response.json({}),
  ): {
    url: string;
    asked: Array<{ token: string; purpose: string }>;
    reported: UsageReport[];
  } {
    const asked: Array<{ token: string; purpose: string }> = [];
    const reported: UsageReport[] = [];
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        if (
          request.headers.get("authorization") !== `Bearer ${AUTHORIZER_TOKEN}`
        ) {
          return new Response("no", { status: 401 });
        }
        if (new URL(request.url).pathname === "/usage") {
          reported.push((await request.json()) as UsageReport);
          return usageAnswer();
        }
        const body = (await request.json()) as {
          token: string;
          purpose: string;
        };
        asked.push(body);
        return answer(body);
      },
    });
    servers.push(server);
    return { url: `http://127.0.0.1:${server.port}`, asked, reported };
  }

  function granting(url: string, headers: Array<[string, string]>) {
    return (body: { token: string }) =>
      body.token === WORKER_TOKEN
        ? Response.json({
            session_id: "sess-1",
            attempt_id: "att-1",
            upstream: { url, headers },
          })
        : new Response("unknown", { status: 401 });
  }

  function proxy(
    authorizerUrl: string,
    upstreamPort: number,
    options: Partial<Parameters<typeof startCredentialProxy>[0]> = {},
  ): CredentialProxyServer {
    const policy: EgressPolicy = {
      allow: [],
      allowPrivate: [{ host: "upstream.test", port: upstreamPort }],
    };
    const server = startCredentialProxy({
      authorizer: { url: authorizerUrl, token: AUTHORIZER_TOKEN },
      hostname: "127.0.0.1",
      logger: silent,
      policy,
      port: 0,
      resolve: async (host) => (host === "upstream.test" ? ["127.0.0.1"] : []),
      ...options,
    });
    servers.push(server);
    return server;
  }

  function messages(
    port: number,
    init: {
      headers?: Record<string, string>;
      body?: string;
      path?: string;
    } = {},
  ) {
    return fetch(
      `http://127.0.0.1:${port}${init.path ?? "/provider/v1/messages?beta=true"}`,
      {
        method: "POST",
        headers: init.headers ?? { "x-api-key": WORKER_TOKEN },
        body: init.body ?? '{"model":"m"}',
      },
    );
  }

  test("injects the provider key and passes the exchange through", async () => {
    const up = upstream(() => Response.json({ id: "msg_1" }));
    const withPort = authorizer(
      granting(`http://upstream.test:${up.port}/base`, [
        ["x-api-key", PROVIDER_KEY],
      ]),
    );
    const server = proxy(withPort.url, up.port);
    const response = await messages(server.port, {
      headers: {
        "x-api-key": WORKER_TOKEN,
        "anthropic-version": "2023-06-01",
      },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ id: "msg_1" });
    expect(withPort.asked).toEqual([
      { token: WORKER_TOKEN, purpose: "provider" },
    ]);
    const [seen] = up.seen;
    expect(new URL(seen?.url ?? "").pathname).toBe("/base/v1/messages");
    expect(new URL(seen?.url ?? "").search).toBe("?beta=true");
    expect(seen?.headers["x-api-key"]).toBe(PROVIDER_KEY);
    expect(seen?.headers.host).toBe(`upstream.test:${up.port}`);
    expect(seen?.headers["anthropic-version"]).toBe("2023-06-01");
    expect(seen?.body).toBe('{"model":"m"}');
    expect(JSON.stringify(seen)).not.toContain(WORKER_TOKEN);
  });

  test("streams a response body as it arrives", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const up = upstream(
      () =>
        new Response(
          new ReadableStream({
            async start(controller) {
              controller.enqueue(new TextEncoder().encode("event: one\n\n"));
              await gate;
              controller.enqueue(new TextEncoder().encode("event: two\n\n"));
              controller.close();
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        ),
    );
    const auth = authorizer(
      granting(`http://upstream.test:${up.port}`, [
        ["x-api-key", PROVIDER_KEY],
      ]),
    );
    const server = proxy(auth.url, up.port);
    const response = await messages(server.port);
    const reader = response.body?.getReader();
    const first = await reader?.read();
    expect(new TextDecoder().decode(first?.value)).toBe("event: one\n\n");
    release();
    let rest = "";
    for (;;) {
      const next = await reader?.read();
      if (next === undefined || next.done) break;
      rest += new TextDecoder().decode(next.value);
    }
    expect(rest).toBe("event: two\n\n");
  });

  describe("usage metering (94S-409)", () => {
    const provider = (up: { port: number }) =>
      granting(`http://upstream.test:${up.port}`, [
        ["x-api-key", PROVIDER_KEY],
      ]);

    test("reports a JSON answer's usage with the grant's ids", async () => {
      const up = upstream(() =>
        Response.json({
          type: "message",
          model: "claude-sonnet-4-5",
          usage: {
            input_tokens: 10,
            output_tokens: 20,
            cache_creation_input_tokens: 3,
            cache_read_input_tokens: 4,
            cache_creation: {
              ephemeral_5m_input_tokens: 1,
              ephemeral_1h_input_tokens: 2,
            },
          },
        }),
      );
      const auth = authorizer(provider(up));
      const server = proxy(auth.url, up.port);
      const response = await messages(server.port);
      expect(response.status).toBe(200);
      await response.json();
      await until(() => auth.reported.length === 1);
      const [report] = auth.reported;
      expect(report?.exchange_id).toMatch(/^[0-9a-f-]{36}$/);
      expect(report).toMatchObject({
        session_id: "sess-1",
        attempt_id: "att-1",
        usage: {
          model: "claude-sonnet-4-5",
          input_tokens: 10,
          output_tokens: 20,
          cache_creation_input_tokens: 3,
          cache_creation_1h_input_tokens: 2,
          cache_read_input_tokens: 4,
        },
      });
    });

    test("reports a streamed answer's message_start input and last message_delta output", async () => {
      const up = upstream(
        () =>
          new Response(
            sseBody([
              {
                type: "message_start",
                message: {
                  model: "claude-sonnet-4-5",
                  usage: { input_tokens: 50, output_tokens: 1 },
                },
              },
              { type: "message_delta", usage: { output_tokens: 7 } },
              { type: "message_delta", usage: { output_tokens: 30 } },
              { type: "message_stop" },
            ]),
            { headers: { "content-type": "text/event-stream" } },
          ),
      );
      const auth = authorizer(provider(up));
      const server = proxy(auth.url, up.port);
      await (await messages(server.port)).text();
      await until(() => auth.reported.length === 1);
      expect(auth.reported[0]?.usage).toMatchObject({
        model: "claude-sonnet-4-5",
        input_tokens: 50,
        output_tokens: 30,
      });
    });

    test("a worker that hangs up mid-stream is still charged for what was started", async () => {
      const up = upstream(
        () =>
          new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(
                  new TextEncoder().encode(
                    sseBody([
                      {
                        type: "message_start",
                        message: { model: "m", usage: { input_tokens: 9 } },
                      },
                    ]),
                  ),
                );
              },
            }),
            { headers: { "content-type": "text/event-stream" } },
          ),
      );
      const auth = authorizer(provider(up));
      const server = proxy(auth.url, up.port);
      const held = await rawRequest(
        server.port,
        `POST /provider/v1/messages HTTP/1.1\r\nhost: proxy\r\nx-api-key: ${WORKER_TOKEN}\r\ncontent-length: 2`,
        "{}",
      );
      expect(await held.answered()).toContain("message_start");
      held.socket.end();
      await until(() => auth.reported.length === 1);
      expect(auth.reported[0]?.usage).toMatchObject({
        model: "m",
        input_tokens: 9,
      });
    });

    test("count_tokens and an error answer report nothing; a success without usage is charged from its request (Codex R1)", async () => {
      const up = upstream((request) =>
        new URL(request.url).pathname.endsWith("/count_tokens")
          ? Response.json({ input_tokens: 12 })
          : request.headers.get("x-case") === "error"
            ? Response.json(
                { type: "error", usage: { input_tokens: 1 } },
                { status: 400 },
              )
            : Response.json({ id: "msg_1" }),
      );
      const auth = authorizer(provider(up));
      const server = proxy(auth.url, up.port);
      await (
        await messages(server.port, {
          path: "/provider/v1/messages/count_tokens",
        })
      ).text();
      await (
        await messages(server.port, {
          headers: { "x-api-key": WORKER_TOKEN, "x-case": "error" },
        })
      ).text();
      await Bun.sleep(100);
      expect(auth.reported).toEqual([]);
      const body = '{"model":"claude-sonnet-4-5","max_tokens":64}';
      await (await messages(server.port, { body })).text();
      await until(() => auth.reported.length === 1);
      expect(auth.reported[0]?.usage).toMatchObject({
        model: "claude-sonnet-4-5",
        input_tokens: body.length,
        output_tokens: 64,
        estimated: true,
      });
    });

    test("a report the authorizer could not take is sent again under the same id; a refused one is not", async () => {
      const up = upstream(() =>
        Response.json({ model: "m", usage: { input_tokens: 1 } }),
      );
      const answers = [503, 200];
      const auth = authorizer(
        provider(up),
        () => new Response(null, { status: answers.shift() ?? 400 }),
      );
      const server = proxy(auth.url, up.port, {
        usageReportBackoffMs: [10, 10],
      });
      await (await messages(server.port)).text();
      await until(() => auth.reported.length === 2);
      expect(auth.reported[1]?.exchange_id).toBe(auth.reported[0]?.exchange_id);

      await (await messages(server.port)).text();
      await until(() => auth.reported.length === 3);
      await Bun.sleep(100);
      expect(auth.reported).toHaveLength(3);
    });
  });

  test("the authorizer's refusal reaches the worker, and nothing is sent upstream", async () => {
    const up = upstream(() => new Response("ok"));
    const auth = authorizer(
      granting(`http://upstream.test:${up.port}`, [
        ["x-api-key", PROVIDER_KEY],
      ]),
    );
    const server = proxy(auth.url, up.port);
    expect(
      (await messages(server.port, { headers: { "x-api-key": "wep_other" } }))
        .status,
    ).toBe(401);
    expect((await messages(server.port, { headers: {} })).status).toBe(401);
    expect(up.seen).toEqual([]);
  });

  test("an authorizer that is down, errs or answers junk fails closed", async () => {
    const up = upstream(() => new Response("ok"));
    for (const answer of [
      () => new Response("boom", { status: 500 }),
      () => Response.json({ session_id: "s" }),
      () => new Response("not json"),
    ]) {
      const auth = authorizer(answer);
      const server = proxy(auth.url, up.port);
      expect((await messages(server.port)).status).toBe(503);
    }
    const nowhere = proxy("http://127.0.0.1:1", up.port);
    expect((await messages(nowhere.port)).status).toBe(503);
    expect(up.seen).toEqual([]);
  });

  test("the authorizer's 409 and 403 pass through", async () => {
    const up = upstream(() => new Response("ok"));
    for (const status of [403, 409]) {
      const auth = authorizer(() => new Response("x", { status }));
      const server = proxy(auth.url, up.port);
      expect((await messages(server.port)).status).toBe(status);
    }
  });

  test("an unrouted operation never reaches the authorizer", async () => {
    const up = upstream(() => new Response("ok"));
    const auth = authorizer(
      granting(`http://upstream.test:${up.port}`, [
        ["x-api-key", PROVIDER_KEY],
      ]),
    );
    const server = proxy(auth.url, up.port);
    expect(
      (await messages(server.port, { path: "/provider/v1/models" })).status,
    ).toBe(404);
    expect(
      (
        await messages(server.port, {
          path: "/repository/git-receive-pack",
          headers: { authorization: `Bearer ${WORKER_TOKEN}` },
        })
      ).status,
    ).toBe(404);
    expect(auth.asked).toEqual([]);
    expect(
      (await fetch(`http://127.0.0.1:${server.port}/healthz`)).status,
    ).toBe(200);
  });

  test("an upstream outside the policy is refused even when the authorizer names it", async () => {
    const up = upstream(() => new Response("ok"));
    const auth = authorizer(
      granting(`http://elsewhere.test:${up.port}`, [
        ["x-api-key", PROVIDER_KEY],
      ]),
    );
    const server = proxy(auth.url, up.port, {
      resolve: async () => ["127.0.0.1"],
    });
    expect((await messages(server.port)).status).toBe(403);
    expect(up.seen).toEqual([]);
  });

  test("a redirect is not followed and not relayed", async () => {
    const up = upstream(
      () =>
        new Response(null, {
          status: 307,
          headers: { location: "http://attacker.test/steal" },
        }),
    );
    const auth = authorizer(
      granting(`http://upstream.test:${up.port}`, [
        ["x-api-key", PROVIDER_KEY],
      ]),
    );
    const server = proxy(auth.url, up.port);
    const response = await messages(server.port);
    expect(response.status).toBe(502);
    expect(response.headers.get("location")).toBeNull();
    expect(up.seen).toHaveLength(1);
  });

  test("an error body that echoes the credential is withheld", async () => {
    const up = upstream(
      (request) =>
        new Response(
          `invalid key ${request.headers.get("x-api-key")}; set-cookie`,
          { status: 401, headers: { "set-cookie": "s=1" } },
        ),
    );
    const auth = authorizer(
      granting(`http://upstream.test:${up.port}`, [
        ["x-api-key", PROVIDER_KEY],
      ]),
    );
    const server = proxy(auth.url, up.port);
    const response = await messages(server.port);
    expect(response.status).toBe(401);
    expect(response.headers.get("set-cookie")).toBeNull();
    const text = await response.text();
    expect(text).not.toContain(PROVIDER_KEY);
    expect(text).toContain("withheld");
  });

  test("an ordinary error body is relayed, and an encoded one is not", async () => {
    let encoded = false;
    const up = upstream(() =>
      encoded
        ? new Response("\x1f\x8b....", {
            status: 400,
            headers: { "content-encoding": "gzip" },
          })
        : Response.json(
            { type: "error", error: { type: "invalid_request_error" } },
            { status: 400 },
          ),
    );
    const auth = authorizer(
      granting(`http://upstream.test:${up.port}`, [
        ["x-api-key", PROVIDER_KEY],
      ]),
    );
    const server = proxy(auth.url, up.port);
    const plain = await messages(server.port);
    expect(plain.status).toBe(400);
    expect(await plain.json()).toEqual({
      type: "error",
      error: { type: "invalid_request_error" },
    });
    encoded = true;
    const hidden = await messages(server.port);
    expect(hidden.status).toBe(400);
    expect(hidden.headers.get("content-encoding")).toBeNull();
    expect(await hidden.text()).toContain("withheld");
  });

  test("dials https by the judged address and checks the catalog's name", async () => {
    const up = upstream(() => Response.json({ ok: true }), certificate);
    const auth = authorizer(
      granting(`https://upstream.test:${up.port}`, [
        ["x-api-key", PROVIDER_KEY],
      ]),
    );
    // Kept so a failed dial says why instead of just 502.
    const lines: string[] = [];
    const server = proxy(auth.url, up.port, {
      upstreamCa: certificate.cert,
      logger: createProxyLogger("warn", (line) => lines.push(line)),
    });
    const right = await messages(server.port);
    if (right.status !== 200) {
      throw new Error(`expected 200, got ${right.status}: ${lines.join("\n")}`);
    }
    expect(up.seen).toHaveLength(1);

    // Same address, a name the certificate does not carry: nothing is sent.
    const other = authorizer(
      granting(`https://other.test:${up.port}`, [["x-api-key", PROVIDER_KEY]]),
    );
    const wrong = proxy(other.url, up.port, {
      upstreamCa: certificate.cert,
      policy: {
        allow: [],
        allowPrivate: [{ host: "other.test", port: up.port }],
      },
      resolve: async () => ["127.0.0.1"],
    });
    expect((await messages(wrong.port)).status).toBe(502);
    expect(up.seen).toHaveLength(1);

    // And a certificate from no trusted root is refused too.
    const untrusted = proxy(auth.url, up.port);
    expect((await messages(untrusted.port)).status).toBe(502);
    expect(up.seen).toHaveLength(1);

    // An https upstream by address has no name to check: refused, unsent.
    const byAddress = authorizer(
      granting(`https://127.0.0.1:${up.port}`, [["x-api-key", PROVIDER_KEY]]),
    );
    const literal = proxy(byAddress.url, up.port, {
      upstreamCa: certificate.cert,
      policy: {
        allow: [],
        allowPrivate: [{ host: "127.0.0.1", port: up.port }],
      },
      resolve: async (host) => [host],
    });
    expect((await messages(literal.port)).status).toBe(502);
    expect(up.seen).toHaveLength(1);
  });

  test("routes git's read half with the repository credential", async () => {
    const basic = `Basic ${Buffer.from("reader:repo-pass").toString("base64")}`;
    const up = upstream(
      () =>
        new Response("001e# service=git-upload-pack\n0000", {
          headers: {
            "content-type": "application/x-git-upload-pack-advertisement",
          },
        }),
    );
    const auth = authorizer((body) =>
      body.purpose === "repository" && body.token === WORKER_TOKEN
        ? Response.json({
            session_id: "s",
            attempt_id: "a",
            upstream: {
              url: `http://upstream.test:${up.port}/agent/app.git`,
              headers: [["authorization", basic]],
            },
          })
        : new Response("no", { status: 401 }),
    );
    const server = proxy(auth.url, up.port);
    const response = await fetch(
      `http://127.0.0.1:${server.port}/repository/info/refs?service=git-upload-pack`,
      { headers: { authorization: `Bearer ${WORKER_TOKEN}` } },
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("git-upload-pack");
    expect(new URL(up.seen[0]?.url ?? "").pathname).toBe(
      "/agent/app.git/info/refs",
    );
    expect(up.seen[0]?.headers.authorization).toBe(basic);
  });

  test("a success that echoes the credential is cut off before the value (Codex R1)", async () => {
    let mode: "header" | "body" | "split" | "encoded" = "header";
    const up = upstream((request) => {
      const echoed = request.headers.get("x-api-key") ?? "";
      if (mode === "header") {
        return Response.json(
          { id: "msg_1" },
          { headers: { "x-debug": echoed } },
        );
      }
      if (mode === "encoded") {
        return new Response("\x1f\x8b....", {
          headers: { "content-encoding": "gzip" },
        });
      }
      const text = `data: {"debug":"${echoed}"}\n\n`;
      const at = text.indexOf(echoed) + 5;
      return new Response(
        new ReadableStream({
          start(controller) {
            const bytes = new TextEncoder().encode(text);
            if (mode === "split") {
              // The value straddles two chunks.
              controller.enqueue(bytes.subarray(0, at));
              controller.enqueue(bytes.subarray(at));
            } else {
              controller.enqueue(bytes);
            }
            controller.close();
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      );
    });
    const auth = authorizer(
      granting(`http://upstream.test:${up.port}`, [
        ["x-api-key", PROVIDER_KEY],
      ]),
    );
    const server = proxy(auth.url, up.port);

    const header = await messages(server.port);
    expect(header.status).toBe(200);
    expect(header.headers.get("x-debug")).toBeNull();
    expect(await header.json()).toEqual({ id: "msg_1" });

    for (const shape of ["body", "split"] as const) {
      mode = shape;
      const response = await messages(server.port);
      expect(response.status).toBe(200);
      const received = await response.text().catch(() => "<broken>");
      expect(received).not.toContain(PROVIDER_KEY);
    }

    mode = "encoded";
    expect((await messages(server.port)).status).toBe(502);
  });

  test("a request body trickled past the deadline ends the exchange and frees its slot (Codex R5)", async () => {
    const up = upstream(() => Response.json({ ok: true }));
    const auth = authorizer(
      granting(`http://upstream.test:${up.port}`, [
        ["x-api-key", PROVIDER_KEY],
      ]),
    );
    const server = proxy(auth.url, up.port, {
      exchangeTimeoutMs: 300,
      maxExchangesPerClient: 1,
    });
    // Promises 100 bytes, sends 2, then goes quiet.
    const socket = await Bun.connect({
      hostname: "127.0.0.1",
      port: server.port,
      socket: { data() {} },
    });
    socket.write(
      `POST /provider/v1/messages HTTP/1.1\r\nhost: proxy\r\nx-api-key: ${WORKER_TOKEN}\r\ncontent-length: 100\r\n\r\n{}`,
    );
    const started = performance.now();
    let next = await messages(server.port);
    while (next.status === 503 && performance.now() - started < 5_000) {
      await next.text();
      await Bun.sleep(50);
      next = await messages(server.port);
    }
    expect(next.status).toBe(200);
    expect(performance.now() - started).toBeLessThan(5_000);
    // The trickled request never reached the upstream.
    expect(up.seen).toHaveLength(1);
    socket.end();
  });

  test("caps open exchanges per client, and frees the slot when one ends", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const up = upstream(
      () =>
        new Response(
          new ReadableStream({
            async start(controller) {
              controller.enqueue(new TextEncoder().encode("a"));
              await gate;
              controller.close();
            },
          }),
        ),
    );
    const auth = authorizer(
      granting(`http://upstream.test:${up.port}`, [
        ["x-api-key", PROVIDER_KEY],
      ]),
    );
    const server = proxy(auth.url, up.port, { maxExchangesPerClient: 1 });
    const held = await messages(server.port);
    expect(held.status).toBe(200);
    expect((await messages(server.port)).status).toBe(503);
    release();
    await held.text();
    // The slot frees as the body ends; give the stream a tick to close.
    await Bun.sleep(20);
    const next = await messages(server.port);
    expect(next.status).toBe(200);
    await next.text();
  });

  /** A raw request whose body is sent only as far as `sent`. */
  async function rawRequest(port: number, head: string, sent = "") {
    let answer = "";
    const socket = await Bun.connect({
      hostname: "127.0.0.1",
      port,
      socket: {
        data(_, bytes) {
          answer += new TextDecoder().decode(bytes);
        },
      },
    });
    socket.write(`${head}\r\n\r\n${sent}`);
    return {
      socket,
      answered: async () => {
        const started = performance.now();
        while (answer === "" && performance.now() - started < 5_000) {
          await Bun.sleep(10);
        }
        return answer;
      },
    };
  }

  test("a body over the route's cap is refused before the authorizer hears of it (94S-388)", async () => {
    const up = upstream(() => Response.json({ ok: true }));
    const auth = authorizer(
      granting(`http://upstream.test:${up.port}`, [
        ["x-api-key", PROVIDER_KEY],
      ]),
    );
    const server = proxy(auth.url, up.port);
    const declared = await rawRequest(
      server.port,
      `POST /provider/v1/messages HTTP/1.1\r\nhost: proxy\r\nx-api-key: ${WORKER_TOKEN}\r\ncontent-length: ${32 * 1024 * 1024 + 1}`,
    );
    expect(await declared.answered()).toStartWith("HTTP/1.1 413");
    declared.socket.end();
    // Sent chunked, it is read only as far as the cap.
    const big = new Uint8Array(1024 * 1024);
    let chunks = 0;
    const chunked = await fetch(
      `http://127.0.0.1:${server.port}/provider/v1/messages`,
      {
        method: "POST",
        headers: { "x-api-key": WORKER_TOKEN },
        body: new ReadableStream({
          pull(controller) {
            chunks += 1;
            if (chunks > 40) controller.close();
            else controller.enqueue(big);
          },
        }),
      },
    );
    expect(chunked.status).toBe(413);
    expect(chunks).toBeLessThan(40);
    expect(up.seen).toEqual([]);
  });

  test("a chunked body goes upstream whole, with its length", async () => {
    const up = upstream(() => Response.json({ ok: true }));
    const auth = authorizer(
      granting(`http://upstream.test:${up.port}`, [
        ["x-api-key", PROVIDER_KEY],
      ]),
    );
    const server = proxy(auth.url, up.port);
    const parts = ['{"model":', '"m"}'];
    const response = await fetch(
      `http://127.0.0.1:${server.port}/provider/v1/messages`,
      {
        method: "POST",
        headers: { "x-api-key": WORKER_TOKEN },
        body: new ReadableStream({
          pull(controller) {
            const part = parts.shift();
            if (part === undefined) controller.close();
            else controller.enqueue(new TextEncoder().encode(part));
          },
        }),
      },
    );
    expect(response.status).toBe(200);
    expect(up.seen[0]?.body).toBe('{"model":"m"}');
    expect(up.seen[0]?.headers["content-length"]).toBe("13");
  });

  test("holds request bodies to one budget across exchanges, and frees it as each goes upstream (94S-388)", async () => {
    const up = upstream(() => Response.json({ ok: true }));
    const auth = authorizer(
      granting(`http://upstream.test:${up.port}`, [
        ["x-api-key", PROVIDER_KEY],
      ]),
    );
    const server = proxy(auth.url, up.port, { maxBodyBytesInFlight: 100 });
    const body = `{"model":"${"m".repeat(68)}"}`;
    expect(body).toHaveLength(80);
    // Admitted with 80 bytes declared and 2 sent, so they stay reserved.
    const held = await rawRequest(
      server.port,
      `POST /provider/v1/messages HTTP/1.1\r\nhost: proxy\r\nx-api-key: ${WORKER_TOKEN}\r\ncontent-length: 80`,
      body.slice(0, 2),
    );
    await Bun.sleep(50);
    const over = await messages(server.port, {
      body: `{"model":"${"m".repeat(18)}"}`,
    });
    expect(over.status).toBe(503);
    expect(await over.text()).toBe("too many request bytes in flight\n");
    // Nothing of it reached the authorizer: only the held one was asked.
    expect(auth.asked).toHaveLength(1);
    held.socket.write(body.slice(2));
    expect(await held.answered()).toStartWith("HTTP/1.1 200");
    held.socket.end();
    // Its reservation goes with the exchange, once the answer has ended.
    await Bun.sleep(50);
    const next = await messages(server.port, {
      body: `{"model":"${"m".repeat(18)}"}`,
    });
    expect(next.status).toBe(200);
    expect(up.seen.map((seen) => seen.body.length)).toEqual([80, 30]);
  });

  test("an upstream that answers before the body is out keeps the reservation until the exchange ends (94S-388, Codex R1)", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    // Answers from the head and never reads the body.
    const early = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () =>
        new Response(
          new ReadableStream({
            async start(controller) {
              controller.enqueue(new TextEncoder().encode("a"));
              await gate;
              controller.close();
            },
          }),
        ),
    });
    servers.push(early);
    const port = early.port ?? 0;
    const auth = authorizer(
      granting(`http://upstream.test:${port}`, [["x-api-key", PROVIDER_KEY]]),
    );
    const server = proxy(auth.url, port, { maxBodyBytesInFlight: 100 });
    const held = await messages(server.port, {
      body: `{"model":"${"m".repeat(68)}"}`,
    });
    expect(held.status).toBe(200);
    const over = await messages(server.port, {
      body: `{"model":"${"m".repeat(18)}"}`,
    });
    expect(over.status).toBe(503);
    release();
    await held.text();
    await Bun.sleep(50);
    const next = await messages(server.port);
    expect(next.status).toBe(200);
    await next.text();
  });

  describe("an exchange that never finishes still frees its slot (94S-366)", () => {
    // An upstream that sends one event and then holds the stream open, the
    // way a slow model call does while the worker is interrupted; or, once
    // `hold()` is called, holds its next call without even a head, the way
    // the soak's model held the call it interrupted.
    function holding() {
      const aborted: Promise<void>[] = [];
      let holdNext = false;
      const up = upstream(async (request) => {
        const hungUp = new Promise<void>((resolve) =>
          request.signal.addEventListener("abort", () => resolve(), {
            once: true,
          }),
        );
        aborted.push(hungUp);
        if (holdNext) {
          holdNext = false;
          await hungUp;
          return new Response("gone", { status: 500 });
        }
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode("event: one\n\n"));
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        );
      });
      let answer: "grant" | "gone" = "grant";
      const grant = granting(`http://upstream.test:${up.port}`, [
        ["x-api-key", PROVIDER_KEY],
      ]);
      const auth = authorizer((body) =>
        answer === "grant" ? grant(body) : new Response("x", { status: 409 }),
      );
      return {
        up,
        auth,
        hold: () => {
          holdNext = true;
        },
        /** The upstream saw the proxy hang up on the latest exchange. */
        hungUp: () => aborted.at(-1) ?? Promise.resolve(),
        end: () => {
          answer = "gone";
        },
        renew: () => {
          answer = "grant";
        },
      };
    }

    /** A worker's call, streaming unless the upstream holds its head. */
    async function opened(h: ReturnType<typeof holding>, port: number) {
      const worker = new AbortController();
      const seen = h.up.seen.length;
      const answered = fetch(`http://127.0.0.1:${port}/provider/v1/messages`, {
        method: "POST",
        headers: { "x-api-key": WORKER_TOKEN },
        body: '{"model":"m"}',
        signal: worker.signal,
      });
      let settled = false;
      answered.then(
        () => {
          settled = true;
        },
        () => {},
      );
      // Past the cap, a refusal comes back without reaching the upstream.
      while (h.up.seen.length === seen && !settled) await Bun.sleep(5);
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
      const read = async () => {
        reader ??= (await answered).body?.getReader();
        return reader?.read();
      };
      return {
        hangUp: () => worker.abort(),
        streaming: async () => {
          expect((await answered).status).toBe(200);
          expect((await read())?.done).toBe(false);
        },
        /** Whatever the worker is still sent, to its end. */
        drain: async () => {
          try {
            while (!(await read())?.done) {}
          } catch {}
        },
      };
    }

    /** A call is let in, then hung up on and its slot given back. */
    async function admitted(h: ReturnType<typeof holding>, port: number) {
      const call = await opened(h, port);
      await call.streaming();
      call.hangUp();
      await h.hungUp();
    }

    function capped(h: ReturnType<typeof holding>, cap: number) {
      return proxy(h.auth.url, h.up.port, {
        maxExchanges: cap,
        regrantIntervalMs: 20,
      });
    }

    test("a grant cut frees the slot, whether or not the worker still reads", async () => {
      const h = holding();
      const server = capped(h, 1);
      // Mid-stream, the worker reading to the cut.
      const reading = await opened(h, server.port);
      await reading.streaming();
      h.end();
      await reading.drain();
      await h.hungUp();
      h.renew();
      await admitted(h, server.port);
      // Mid-stream, the worker already gone.
      const gone = await opened(h, server.port);
      await gone.streaming();
      gone.hangUp();
      h.end();
      await h.hungUp();
      await Bun.sleep(60);
      h.renew();
      await admitted(h, server.port);
      // Before the upstream's head, the worker reading the refusal.
      h.hold();
      const waiting = await opened(h, server.port);
      h.end();
      await waiting.drain();
      await h.hungUp();
      h.renew();
      await admitted(h, server.port);
    });

    // The soak's leak: the worker is interrupted while the model still holds
    // its call, so the proxy's 502 answers a connection already gone, and
    // Bun pulls such a body once and then neither reads nor cancels it.
    test("a worker that hangs up frees the slot, grant or not", async () => {
      const h = holding();
      const server = proxy(h.auth.url, h.up.port, {
        maxExchanges: 1,
        regrantIntervalMs: 60_000,
      });
      const streaming = await opened(h, server.port);
      await streaming.streaming();
      streaming.hangUp();
      await h.hungUp();
      await Bun.sleep(60);
      await admitted(h, server.port);
      h.hold();
      const waiting = await opened(h, server.port);
      waiting.hangUp();
      await h.hungUp();
      await Bun.sleep(60);
      await admitted(h, server.port);
    });

    test("a worker hanging up while the upstream name is resolving frees the slot (Codex R2)", async () => {
      const h = holding();
      let lookups = 0;
      const server = proxy(h.auth.url, h.up.port, {
        maxExchanges: 1,
        // The first lookup never answers.
        resolve: (host) => {
          lookups += 1;
          return lookups === 1
            ? new Promise<string[]>(() => {})
            : Promise.resolve(host === "upstream.test" ? ["127.0.0.1"] : []);
        },
      });
      const worker = new AbortController();
      const stuck = fetch(
        `http://127.0.0.1:${server.port}/provider/v1/messages`,
        {
          method: "POST",
          headers: { "x-api-key": WORKER_TOKEN },
          body: '{"model":"m"}',
          signal: worker.signal,
        },
      ).catch(() => null);
      while (lookups === 0) await Bun.sleep(5);
      worker.abort();
      await stuck;
      await Bun.sleep(60);
      await admitted(h, server.port);
    });

    test("cut and hung-up exchanges never run the cap out", async () => {
      const h = holding();
      const server = capped(h, 2);
      const rounds = [
        { head: "sent", cut: true, hangUp: false },
        { head: "sent", cut: false, hangUp: true },
        { head: "sent", cut: true, hangUp: true },
        { head: "held", cut: true, hangUp: false },
        { head: "held", cut: false, hangUp: true },
        { head: "held", cut: true, hangUp: true },
      ] as const;
      for (const round of [...rounds, ...rounds]) {
        if (round.head === "held") h.hold();
        const call = await opened(h, server.port);
        if (round.head === "sent") await call.streaming();
        if (round.hangUp) call.hangUp();
        if (round.cut) h.end();
        if (!round.hangUp) await call.drain();
        await h.hungUp();
        await Bun.sleep(60);
        h.renew();
      }
      await admitted(h, server.port);
    });
  });

  test("an open exchange is cut once its grant ends, not when the authorizer blips (Codex R2)", async () => {
    // The first exchange's gate opens; the later ones' never do.
    let release: () => void = () => {};
    const gates = [
      new Promise<void>((resolve) => {
        release = resolve;
      }),
      new Promise<void>(() => {}),
      new Promise<void>(() => {}),
    ];
    let upstreamAborted = false;
    const up = upstream(
      (request) =>
        new Response(
          new ReadableStream({
            async start(controller) {
              request.signal.addEventListener("abort", () => {
                upstreamAborted = true;
              });
              controller.enqueue(new TextEncoder().encode("a"));
              await gates.shift();
              controller.enqueue(new TextEncoder().encode("b"));
              controller.close();
            },
          }),
        ),
    );
    let answer: "grant" | "down" | "gone" = "grant";
    const grant = granting(`http://upstream.test:${up.port}`, [
      ["x-api-key", PROVIDER_KEY],
    ]);
    const auth = authorizer((body) =>
      answer === "grant"
        ? grant(body)
        : new Response("x", { status: answer === "down" ? 500 : 409 }),
    );
    const server = proxy(auth.url, up.port, {
      regrantIntervalMs: 20,
      regrantGraceMs: 60_000,
    });

    // The authorizer failing is not the grant ending: the stream goes on.
    const kept = await messages(server.port);
    const keptReader = kept.body?.getReader();
    expect(new TextDecoder().decode((await keptReader?.read())?.value)).toBe(
      "a",
    );
    answer = "down";
    const asked = auth.asked.length;
    while (auth.asked.length < asked + 3) await Bun.sleep(10);
    answer = "grant";
    release();
    expect(new TextDecoder().decode((await keptReader?.read())?.value)).toBe(
      "b",
    );
    expect((await keptReader?.read())?.done).toBe(true);

    // A refusal while the upstream is still streaming ends the exchange.
    const cut = await messages(server.port);
    const cutReader = cut.body?.getReader();
    expect((await cutReader?.read())?.done).toBe(false);
    answer = "gone";
    // Bun ends the relayed body rather than resetting the connection, so
    // the worker sees a cut-short stream (no `b`, never an SSE stop or a
    // pack's trailer) where the upstream would have waited forever.
    let rest = "";
    try {
      for (;;) {
        const next = await cutReader?.read();
        if (next === undefined || next.done) break;
        rest += new TextDecoder().decode(next.value);
      }
    } catch {}
    expect(rest).toBe("");
    await Bun.sleep(20);
    expect(upstreamAborted).toBe(true);

    // An authorizer that stays down past the grace ends it too (Codex R3).
    upstreamAborted = false;
    answer = "grant";
    const strict = proxy(auth.url, up.port, {
      regrantIntervalMs: 20,
      regrantGraceMs: 100,
    });
    const outage = await messages(strict.port);
    const outageReader = outage.body?.getReader();
    expect((await outageReader?.read())?.done).toBe(false);
    answer = "down";
    let after = "";
    try {
      for (;;) {
        const next = await outageReader?.read();
        if (next === undefined || next.done) break;
        after += new TextDecoder().decode(next.value);
      }
    } catch {}
    expect(after).toBe("");
    await Bun.sleep(20);
    expect(upstreamAborted).toBe(true);
  });

  test("a privately listed upstream that resolves publicly gets no login (Codex R3)", async () => {
    const up = upstream(() => Response.json({ id: "msg_1" }));
    const auth = authorizer(
      granting(`http://upstream.test:${up.port}`, [
        ["x-api-key", PROVIDER_KEY],
      ]),
    );
    const server = proxy(auth.url, up.port, {
      resolve: async () => ["127.0.0.1", "8.8.8.8"],
    });
    const response = await messages(server.port);
    expect(response.status).toBe(403);
    expect(up.seen).toEqual([]);
  });
});

async function mintCertificate(
  directory: string,
  name: string,
): Promise<{ cert: string; key: string }> {
  const keyPath = join(directory, `${name}.key`);
  const certPath = join(directory, `${name}.crt`);
  const generate = Bun.spawn(
    [
      "openssl",
      "req",
      "-x509",
      "-newkey",
      "ec",
      "-pkeyopt",
      "ec_paramgen_curve:prime256v1",
      "-nodes",
      "-days",
      "1",
      "-subj",
      `/CN=${name}`,
      "-addext",
      `subjectAltName=DNS:${name}`,
      "-keyout",
      keyPath,
      "-out",
      certPath,
    ],
    { stderr: "pipe", stdout: "ignore" },
  );
  if ((await generate.exited) !== 0) {
    throw new Error(
      `openssl could not mint a test certificate:\n${await new Response(generate.stderr).text()}`,
    );
  }
  return {
    cert: await Bun.file(certPath).text(),
    key: await Bun.file(keyPath).text(),
  };
}
