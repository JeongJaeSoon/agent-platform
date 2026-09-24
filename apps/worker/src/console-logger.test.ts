import { describe, expect, test } from "bun:test";

import { SecretScrubber, scrubbingLogger } from "./secret-scrubber.ts";
import { createConsoleLogger } from "./worker-host.ts";

const NOW = new Date("2026-09-25T00:00:00.000Z");

function recorded() {
  const lines: Array<Record<string, unknown>> = [];
  const logger = createConsoleLogger({
    now: () => NOW,
    write: (line) => {
      lines.push(JSON.parse(line));
    },
  });
  return { lines, logger };
}

describe("the worker's console log (94S-386)", () => {
  test("masks sensitive keys, bearer values and the login in a URL", () => {
    const { lines, logger } = recorded();

    logger.warn("worker.probe", {
      reason: "fetch https://agent:tok123@gitea:3000/a.git failed",
      authorization: "Bearer abc123",
      nested: { detail: "sent Bearer abc123" },
    });

    const text = JSON.stringify(lines);
    expect(text).not.toContain("abc123");
    expect(text).not.toContain("tok123");
    expect(lines[0]).toMatchObject({
      reason: "fetch https://[REDACTED]@gitea:3000/a.git failed",
      authorization: "[REDACTED]",
      nested: { detail: "[REDACTED]" },
    });
  });

  test("scrubs the values the process holds: egress token, nonce, catalog key", () => {
    const { lines, logger } = recorded();
    const held = ["wep_egress-token-one", "wln_nonce-one", "catalog-key-one"];
    const scrubbed = scrubbingLogger(logger, () => new SecretScrubber(held));

    scrubbed.error("worker.failed", {
      reason: `refused ${held[0]} for ${held[1]} with ${held[2]}`,
    });

    const text = JSON.stringify(lines);
    for (const value of held) expect(text).not.toContain(value);
    expect(lines[0]?.reason).toBe(
      "refused <redacted> for <redacted> with <redacted>",
    );
  });

  test("stamps every line with the time, and keeps what is not secret", () => {
    const { lines, logger } = recorded();

    logger.info("worker.turn.started", { turn_id: "t-1", input_id: "i-1" });

    expect(lines).toEqual([
      {
        timestamp: NOW.toISOString(),
        level: "info",
        event: "worker.turn.started",
        turn_id: "t-1",
        input_id: "i-1",
      },
    ]);
  });

  test("a field cannot replace the record's own keys", () => {
    const { lines, logger } = recorded();

    logger.warn("worker.probe", {
      level: "debug",
      event: "other",
      timestamp: "never",
      kind: "kept",
    });

    expect(lines[0]).toEqual({
      timestamp: NOW.toISOString(),
      level: "warn",
      event: "worker.probe",
      kind: "kept",
    });
  });

  test("LOG_LEVEL=warn leaves info out", () => {
    const before = process.env.LOG_LEVEL;
    process.env.LOG_LEVEL = "warn";
    let built: ReturnType<typeof recorded>;
    try {
      built = recorded();
    } finally {
      if (before === undefined) delete process.env.LOG_LEVEL;
      else process.env.LOG_LEVEL = before;
    }
    const { lines, logger } = built;

    logger.info("worker.claimed");
    logger.warn("worker.stopping");
    logger.error("worker.failed");

    expect(lines.map((line) => line.event)).toEqual([
      "worker.stopping",
      "worker.failed",
    ]);
  });
});
