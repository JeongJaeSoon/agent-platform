import { afterEach, describe, expect, test } from "bun:test";
import { SSE_SCHEMA_VERSION } from "@werft-ai/contracts";
import openapi from "../../../docs/openapi.json" with { type: "json" };
import pkg from "../package.json" with { type: "json" };
import {
  API_SPEC_VERSION,
  SDK_VERSION,
  SUPPORTED_SSE_SCHEMA_VERSIONS,
  Werft,
} from "./index.ts";
import { BASE, fakeApi, json, KEY, werft } from "./testing/fake-api.ts";

const ME = { owner_id: "o1", scopes: ["sessions:read"] };
const env = process.env;
const saved = { key: env.WERFT_API_KEY, url: env.WERFT_BASE_URL };

afterEach(() => {
  for (const [name, value] of [
    ["WERFT_API_KEY", saved.key],
    ["WERFT_BASE_URL", saved.url],
  ] as const)
    if (value === undefined) delete env[name];
    else env[name] = value;
  delete (globalThis as { window?: unknown }).window;
});

describe("construction", () => {
  test("reads WERFT_API_KEY and WERFT_BASE_URL when options leave them out", async () => {
    const api = fakeApi(() => json(200, ME));
    env.WERFT_API_KEY = KEY;
    env.WERFT_BASE_URL = "https://env.test/";
    await new Werft({ fetch: api.fetch }).auth.me();
    expect(api.seen[0]?.headers.get("authorization")).toBe(`Bearer ${KEY}`);
    expect(api.seen[0]?.url).toBe("https://env.test/v1/auth/me");
  });

  test("throws without a key or a base URL", () => {
    delete env.WERFT_API_KEY;
    delete env.WERFT_BASE_URL;
    expect(() => new Werft({ baseUrl: BASE })).toThrow(/WERFT_API_KEY/);
    expect(() => new Werft({ apiKey: KEY })).toThrow(/WERFT_BASE_URL/);
  });

  test("refuses a browser unless dangerouslyAllowBrowser", () => {
    (globalThis as { window?: unknown }).window = {};
    expect(() => new Werft({ apiKey: KEY, baseUrl: BASE })).toThrow(
      /dangerouslyAllowBrowser/,
    );
    expect(
      () =>
        new Werft({
          apiKey: KEY,
          baseUrl: BASE,
          dangerouslyAllowBrowser: true,
        }),
    ).not.toThrow();
  });

  test("refuses plain http to a remote host unless allowInsecureHttp", () => {
    expect(
      () => new Werft({ apiKey: KEY, baseUrl: "http://agents.example.com" }),
    ).toThrow(/allowInsecureHttp/);
    expect(
      () =>
        new Werft({
          apiKey: KEY,
          baseUrl: "http://agents.example.com",
          allowInsecureHttp: true,
        }),
    ).not.toThrow();
    for (const local of [
      "http://localhost:3000",
      "http://127.0.0.1:8080",
      "http://[::1]:3000",
      "http://api.localhost",
    ])
      expect(() => new Werft({ apiKey: KEY, baseUrl: local })).not.toThrow();
    expect(() => new Werft({ apiKey: KEY, baseUrl: "ftp://x.test" })).toThrow(
      /http or https/,
    );
  });

  test("headers can never set Authorization or Idempotency-Key", async () => {
    expect(() =>
      werft(fakeApi(() => json(200, ME)).fetch, {
        defaultHeaders: { Authorization: "Bearer other" },
      }),
    ).toThrow(/Authorization/);
    const client = werft(fakeApi(() => json(200, ME)).fetch);
    await expect(
      client.auth.me({ headers: { "idempotency-key": "k" } }),
    ).rejects.toThrow(/idempotency-key/);
  });

  test("the key shows in no inspect, JSON or error", async () => {
    const client = werft(fakeApi(() => json(401, {})).fetch);
    expect(Bun.inspect(client)).not.toContain(KEY);
    expect(JSON.stringify(client)).not.toContain(KEY);
    const error = await client.auth.me().catch((e: unknown) => e);
    expect(Bun.inspect(error)).not.toContain(KEY);
  });

  test("an API key request sends no CSRF header", async () => {
    const api = fakeApi(() => json(200, ME));
    await werft(api.fetch).auth.me();
    expect(api.seen[0]?.headers.has("x-requested-with")).toBe(false);
  });

  test("withOptions keeps the rest and swaps what it is given", async () => {
    const api = fakeApi(() => json(200, ME));
    const approver = werft(api.fetch).withOptions({ apiKey: "approve-key" });
    await approver.auth.me();
    expect(api.seen[0]?.headers.get("authorization")).toBe(
      "Bearer approve-key",
    );
  });
});

describe("versions", () => {
  test("follow the package, the spec and the SSE contract", () => {
    expect(SDK_VERSION).toBe(pkg.version);
    expect(SDK_VERSION.startsWith("0.")).toBe(true);
    expect(API_SPEC_VERSION).toBe(openapi.info.version);
    expect(SUPPORTED_SSE_SCHEMA_VERSIONS).toEqual([SSE_SCHEMA_VERSION]);
    expect(pkg.private).toBe(true);
  });
});
