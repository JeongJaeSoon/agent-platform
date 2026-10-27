import { describe, expect, test } from "bun:test";
import {
  checkIgnores,
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
      "tailnet host",
      "private address",
      "home path",
      "email outside example.test",
    ]);
  });

  test("the fixture key itself is scanned", () => {
    expect(
      scanFixtures({
        responses: { "/v1/x?email=a@corp.example.com": { status: 200 } },
      }).map((finding) => finding.rule),
    ).toEqual(["email outside example.test"]);
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
