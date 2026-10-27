import { describe, expect, test } from "bun:test";
import {
  checkComplete,
  checkIgnores,
  describeFinding,
  FIXTURES_PATH,
  scanFixtures,
  withFixtureIgnores,
} from "./demo-scan.ts";

const scan = (json: unknown) =>
  scanFixtures({ responses: { "/v1/x": { status: 200, json } } }).map(
    (finding) => finding.rule,
  );

describe("demo fixture scan", () => {
  test("demo addresses and ordinary values are clean", () => {
    expect(
      scan({
        email: "demo-owner@example.test",
        id: "0b6f2a7e-1c2d-4e5f-8a9b-0c1d2e3f4a5b",
        digest: "a".repeat(64),
        title: "배포 전 체크리스트 정리",
      }),
    ).toEqual([]);
  });

  test("outside addresses, tailnet hosts and home paths are caught", () => {
    expect(
      scan({
        email: "someone@gmail.com",
        url: "https://box.tail015a0d.ts.net:4620/",
        api: "http://127.0.0.1:4611",
        path: "/Users/someone/work",
      }),
    ).toEqual([
      "email outside example.test",
      "tailnet host",
      "private address",
      "home path",
    ]);
  });

  test("the fixture key itself is scanned", () => {
    expect(
      scanFixtures({
        responses: { "/v1/x?email=a@corp.example.com": { status: 200 } },
      }).map((finding) => finding.rule),
    ).toEqual(["email outside example.test"]);
  });

  test("the key is also scanned decoded, as fixtureKey() writes it", () => {
    expect(
      scanFixtures({
        responses: { "/v1/members?q=a%40corp.example.com": { status: 200 } },
      }).map((finding) => finding.rule),
    ).toEqual(["email outside example.test"]);
  });

  test("tailnet, IPv6 loopback and unique local addresses are caught", () => {
    expect(
      scan({ a: "100.101.102.103", b: "[::1]:4611", c: "fd7a:115c:a1e0::53" }),
    ).toEqual(["private address", "private address", "private address"]);
    expect(
      scan({
        a: "::0001",
        b: "0:0:0:0:0:0:0:1",
        c: "line\n::1",
        d: "col\tFD00::1",
        e: "http://[::ffff:7f00:1]/",
        f: "https://x.example.test/?host=fd00%3A%3A1",
      }),
    ).toEqual(Array(6).fill("private address"));
    expect(
      scan({
        a: "100.200.1.1",
        b: "12:30:45",
        c: "a::b",
        d: "fd00:1:2",
        e: "fd00:::1",
        f: "2026-10-27T12:30:45.000Z",
      }),
    ).toEqual([]);
  });

  test("values hidden behind escapes and encodings are revealed", () => {
    expect(
      scan({
        a: "line\n10.1.2.3",
        b: "nul\u0000fd00::1",
        c: "https://x.example.test/?q=host%3Dfd00%253A%253A1",
        sse: 'data: {"host":"fd00\\u003a\\u003a1"}\n\n',
        d: "http://LocalHost:8000/",
      }),
    ).toEqual(Array(5).fill("private address"));
  });

  test("a decoding step cannot hide what the raw text shows", () => {
    expect(
      scan({
        a: "\\fd00::1",
        b: "fd00::1%2567",
        b2: "fd00\\u003a\\u003a1%67",
        c: "https://x.example.test/?h=fd00%5Cu003a%5Cu003a1",
      }),
    ).toEqual(Array(4).fill("private address"));
  });

  test("text still changing at the decoding cap fails", () => {
    let settled = "hello world";
    for (let i = 0; i < 8; i += 1) settled = encodeURIComponent(settled);
    expect(scan({ settled })).toEqual([]);
    let deep = "a@corp.example.com";
    for (let i = 0; i < 9; i += 1) deep = encodeURIComponent(deep);
    expect(scan({ deep })).toEqual(["still encoded after the decoding cap"]);
    let five = "a@corp.example.com";
    for (let i = 0; i < 5; i += 1) five = encodeURIComponent(five);
    expect(scan({ five })).toEqual(["email outside example.test"]);
  });

  test("deep nesting does not end the scan", () => {
    let nested: unknown = "fd00::1";
    for (let i = 0; i < 20_000; i += 1) nested = [nested];
    expect(scan(nested)).toEqual(["private address"]);
  });

  test("demo addresses pass in any case", () => {
    expect(scan({ email: "Demo-Owner@EXAMPLE.TEST" })).toEqual([]);
  });

  test("a long run of letters scans in linear time", () => {
    const started = performance.now();
    expect(scan({ log: "a".repeat(200_000) })).toEqual([]);
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  test("a description carries no part of the value", () => {
    const [finding] = scanFixtures({
      responses: { "/v1/x?email=someone%40corp.example.com": {} },
    });
    expect(finding && describeFinding(finding)).toBe(
      "email outside example.test: 24 chars (answer 0)",
    );
  });

  test("findings name the answer by position, not by key", () => {
    expect(
      scanFixtures({
        responses: { "/v1/a": {}, "/v1/b?email=x@corp.example.com": {} },
      }).map((finding) => finding.answer),
    ).toEqual([1]);
  });

  test("a fixture without a signed-in session answer is incomplete", () => {
    const me = (answer: unknown) =>
      checkComplete({ responses: { "/v1/auth/me": answer } }).length;
    expect(checkComplete({ responses: {} }).length).toBe(1);
    expect(me({})).toBe(1);
    expect(me({ status: 401, json: { error: { code: "UNAUTHORIZED" } } })).toBe(
      1,
    );
    expect(me({ status: 200, json: {} })).toBe(1);
    expect(me({ status: 200, json: [1] })).toBe(1);
    expect(me({ status: 200, json: { id: "u1" } })).toBe(0);
  });
});

describe("gitleaks ignores for the fixture file", () => {
  const AGENT_ID = "0b6f2a7e-1c2d-4e5f-8a9b-0c1d2e3f4a5b";
  const STRANGER = "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d";
  const text = JSON.stringify(
    {
      recorded_at: "2026-10-27T00:00:00.000Z",
      responses: {
        "/v1/agents?include=summary&limit=100": {
          status: 200,
          json: { items: [{ id: AGENT_ID }] },
        },
        "/v1/usage/breakdown?by=agent": {
          status: 200,
          json: { items: [{ key: AGENT_ID }, { key: STRANGER }, { key: "x" }] },
        },
        "/v1/sessions": { status: 200, json: { items: [{ key: AGENT_ID }] } },
      },
    },
    null,
    2,
  );
  const lines = text.split("\n");
  const lineOf = (value: string, after: string) => {
    const start = lines.findIndex((line) => line.includes(after));
    return lines.findIndex((line, i) => i > start && line.includes(value)) + 1;
  };
  const entry = (line: number, rule = "generic-api-key") =>
    `${FIXTURES_PATH}:${rule}:${line}`;
  const check = (ignores: string) =>
    checkIgnores(text, ignores).map((finding) => finding.rule);
  const breakdownAgent = lineOf(AGENT_ID, "/v1/usage/breakdown");

  test("a recorded agent id in a usage breakdown may be ignored", () => {
    expect(check(entry(breakdownAgent))).toEqual([]);
  });

  test("entries for other files are left alone", () => {
    expect(check("docs/x.md:generic-api-key:3")).toEqual([]);
  });

  test("a commit-scoped entry for the fixture is refused", () => {
    expect(check(`abc123:${entry(breakdownAgent)}`)).toEqual([
      "gitleaks ignore in another form",
    ]);
  });

  test("anything else is refused", () => {
    expect(
      check(
        [
          entry(breakdownAgent, "aws-access-token"),
          entry(lineOf(STRANGER, "/v1/usage/breakdown")),
          entry(lineOf('"x"', "/v1/usage/breakdown")),
          entry(lineOf(AGENT_ID, "/v1/sessions")),
          entry(lineOf(AGENT_ID, "/v1/agents")),
        ].join("\n"),
      ),
    ).toEqual([
      "gitleaks ignore for another rule",
      "gitleaks ignore on a UUID that is no recorded agent",
      "gitleaks ignore on a value that is not a UUID",
      "gitleaks ignore outside a usage breakdown",
      "gitleaks ignore not on a breakdown key line",
    ]);
  });

  test("an entry left from an earlier recording no longer matches", () => {
    expect(check(entry(breakdownAgent + 1))).toEqual([
      "gitleaks ignore not on a breakdown key line",
    ]);
  });

  test("writing replaces only the fixture's entries", () => {
    expect(
      withFixtureIgnores(`docs/x.md:generic-api-key:3\n${entry(9)}\n`, [
        entry(12),
        entry(10),
      ]),
    ).toBe(`docs/x.md:generic-api-key:3\n${entry(10)}\n${entry(12)}\n`);
  });
});
