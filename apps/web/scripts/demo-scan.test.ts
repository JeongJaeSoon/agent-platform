import { describe, expect, test } from "bun:test";
import { scanFixtures } from "./demo-scan.ts";

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
