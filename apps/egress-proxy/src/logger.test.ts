import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { createProxyLogger } from "./logger.ts";

describe("the proxy's log (94S-386)", () => {
  test("runs the platform's masking rules, copied byte for byte", () => {
    const copy = readFileSync(join(import.meta.dir, "redaction.ts"), "utf8");
    const platform = readFileSync(
      join(import.meta.dir, "../../../packages/observability/src/redaction.ts"),
      "utf8",
    );
    expect(copy).toBe(platform);
  });

  test("masks sensitive keys, bearer values and the login in a URL", () => {
    const lines: string[] = [];
    const logger = createProxyLogger("info", (line) => lines.push(line));

    logger.warn("proxy.probe", {
      authorization: "Bearer abc123",
      url: "https://agent:tok123@gitea:3000/a.git",
      error: "upstream said: Bearer abc123",
      host: "gitea",
    });

    const text = lines.join("\n");
    expect(text).not.toContain("abc123");
    expect(text).not.toContain("tok123");
    expect(JSON.parse(lines[0] ?? "{}")).toMatchObject({
      level: "warn",
      message: "proxy.probe",
      fields: {
        authorization: "[REDACTED]",
        url: "https://[REDACTED]@gitea:3000/a.git",
        error: "[REDACTED]",
        host: "gitea",
      },
    });
  });

  test("still leaves out what is below its level", () => {
    const lines: string[] = [];
    const logger = createProxyLogger("warn", (line) => lines.push(line));

    logger.info("Egress allowed", { host: "example.test" });

    expect(lines).toEqual([]);
  });
});
