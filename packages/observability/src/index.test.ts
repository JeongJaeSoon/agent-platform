import { describe, expect, test } from "bun:test";

import {
  createLogger,
  createObservability,
  InMemoryMetrics,
  InMemoryTracer,
  MemoryLogSink,
  NoopMetrics,
  resolveLogLevel,
} from "./index.ts";

describe("structured logging", () => {
  test.each([false, true])(
    "redacts sensitive text in log messages with includeMessageBodies=%s",
    (includeMessageBodies) => {
      const sink = new MemoryLogSink();
      const logger = createLogger({ sinks: [sink], includeMessageBodies });
      const canary = "SYNTHETIC_LOG_CANARY";
      const keys = [
        "password",
        "api_key",
        "access-key",
        "authorization",
        "token",
        "credential",
        "request_body",
        "prompt",
      ];

      for (const key of keys) {
        logger.error(`operation failed: ${key}=${canary}`);
        logger.warn(`operation failed: ${key}: ${canary}`);
      }

      expect(sink.records).toHaveLength(keys.length * 2);
      expect(
        sink.records.every((record) => record.message === "[REDACTED]"),
      ).toBe(true);
      expect(JSON.stringify(sink.records).includes(canary)).toBe(false);

      logger.info("checkpoint.completed");
      expect(sink.records.at(-1)?.message).toBe("checkpoint.completed");
    },
  );

  test("redacts credentials, omits message bodies, and tolerates broken sinks", () => {
    const sink = new MemoryLogSink();
    const logger = createLogger({
      sinks: [sink, { write: () => Promise.reject(new Error("unavailable")) }],
    });

    logger.info("turn.received", {
      authorization: "Bearer secret-value",
      GIT_TOKEN: "ghp_secret",
      ANTHROPIC_API_KEY: "sk-secret",
      AWS_SECRET_ACCESS_KEY: "secret",
      nested: { access_token: "secret" },
      message: "also omitted",
      request_body: { message: "do not retain this" },
      content: "also omitted",
      safe: "visible",
    });
    logger.info("Bearer token-value");

    expect(sink.records).toHaveLength(2);
    expect(sink.records[0]?.fields).toEqual({
      authorization: "[REDACTED]",
      GIT_TOKEN: "[REDACTED]",
      ANTHROPIC_API_KEY: "[REDACTED]",
      AWS_SECRET_ACCESS_KEY: "[REDACTED]",
      nested: { access_token: "[REDACTED]" },
      safe: "visible",
    });
    expect(sink.records[1]?.message).toBe("[REDACTED]");
  });

  test("does not propagate logging preparation failures", () => {
    const logger = createLogger({
      sinks: [new MemoryLogSink()],
      now: () => {
        throw new Error("clock unavailable");
      },
    });

    expect(() => logger.info("ignored")).not.toThrow();
  });

  test("uses LOG_LEVEL compatible values and filters lower records", () => {
    const sink = new MemoryLogSink();
    const logger = createLogger({ level: "warn", sinks: [sink] });
    logger.info("not-emitted");
    logger.warn("emitted");

    expect(resolveLogLevel("DEBUG")).toBe("debug");
    expect(resolveLogLevel("not-a-level")).toBe("info");
    expect(sink.records.map((record) => record.message)).toEqual(["emitted"]);
  });
});

describe("M0 async flow simulation", () => {
  test("propagates API context through claim, turn, and checkpoint", async () => {
    const sink = new MemoryLogSink();
    const metrics = new InMemoryMetrics();
    const tracer = new InMemoryTracer();
    const observability = createObservability(
      createLogger({ sinks: [sink] }),
      metrics,
      tracer,
    );

    await observability.logger.withContext(
      { session_id: "session-1", pod_id: "worker-1" },
      async () => {
        observability.logger.info("api.accepted", { route: "/sessions" });
        await Promise.resolve();
        await observability.withSpan("session.claim", async () => {
          observability.logger.info("worker.claimed");
          metrics.counter("session_claim_total", 1, { outcome: "success" });
          await observability.logger.withContext({ turn_id: 7 }, async () => {
            observability.logger.info("turn.started", {
              body: "private prompt",
            });
            metrics.histogram("turn_duration_ms", 12, { outcome: "success" });
            await Promise.resolve();
            observability.logger.info("checkpoint.stored");
          });
        });
      },
    );

    expect(sink.records.map((record) => record.message)).toEqual([
      "api.accepted",
      "worker.claimed",
      "turn.started",
      "checkpoint.stored",
    ]);
    expect(sink.records.map((record) => record.session_id)).toEqual([
      "session-1",
      "session-1",
      "session-1",
      "session-1",
    ]);
    expect(sink.records.slice(2).map((record) => record.turn_id)).toEqual([
      7, 7,
    ]);
    expect(sink.records.slice(1).map((record) => record.trace_id)).toEqual([
      expect.any(String),
      sink.records[1]?.trace_id,
      sink.records[1]?.trace_id,
    ]);
    expect(sink.records[2]?.fields).toBeUndefined();
    expect(metrics.counters.values().next().value).toMatchObject({
      name: "session_claim_total",
      value: 1,
    });
    expect(metrics.histograms).toHaveLength(1);
    expect(tracer.spans[0]).toMatchObject({
      name: "session.claim",
      endedAt: expect.any(String),
    });
  });

  test("redacts credential and message-body exception text before tracing", () => {
    const tracer = new InMemoryTracer();
    const span = tracer.startSpan("turn.failed");

    span.recordException(
      new Error("Authorization: Bearer ghp_not_for_a_trace"),
    );
    span.recordException(new Error("request body: private user instruction"));

    expect(tracer.spans[0]?.exceptions).toEqual(["[REDACTED]", "[REDACTED]"]);
    expect(JSON.stringify(tracer.spans)).not.toContain(
      "private user instruction",
    );
    expect(JSON.stringify(tracer.spans)).not.toContain("ghp_not_for_a_trace");
  });

  test("offers a usable no-op metric implementation", () => {
    const metrics = new NoopMetrics();
    expect(() => {
      metrics.counter("ignored");
      metrics.gauge("ignored", 1);
      metrics.histogram("ignored", 1);
    }).not.toThrow();
  });
});
