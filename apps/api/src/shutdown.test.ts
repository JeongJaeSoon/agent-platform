import { describe, expect, test } from "bun:test";
import { createShutdown, type Listener, type Resource } from "./shutdown.ts";

function recorder() {
  const steps: string[] = [];
  const logger = {
    info: (message: string) => steps.push(`info: ${message}`),
    warn: (message: string) => steps.push(`warn: ${message}`),
    error: (message: string) => steps.push(`error: ${message}`),
  };
  const exits: number[] = [];
  return { steps, logger, exits, exit: (code: number) => exits.push(code) };
}

// A listener whose in-flight work finishes when the test says so.
function listener(steps: string[]) {
  let finish: () => void = () => {};
  const drained = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const fake: Listener & { finish(): void } = {
    pendingRequests: 1,
    stop(force) {
      steps.push(force ? "listener: close connections" : "listener: stop");
      if (force) finish();
      return force ? Promise.resolve() : drained;
    },
    finish() {
      steps.push("listener: drained");
      finish();
    },
  };
  return fake;
}

function resource(steps: string[], name: string, fail = false): Resource {
  return {
    name,
    async close() {
      steps.push(`close: ${name}`);
      if (fail) throw new Error("close failed");
    },
  };
}

const ready = async () => ({ ready: true }) as const;

describe("createShutdown", () => {
  test("withdraws readiness, stops accepting, drains, then closes resources in order", async () => {
    const { steps, logger, exits, exit } = recorder();
    const shutdown = createShutdown({ logger, exit, drainMs: 60_000 });
    const probe = shutdown.readiness(ready);
    const server = listener(steps);
    expect(await probe()).toEqual({ ready: true });

    const done = shutdown.run(
      "SIGTERM",
      [server],
      [resource(steps, "event-listener"), resource(steps, "pool")],
    );
    expect(await probe()).toMatchObject({ ready: false, check: "shutdown" });
    // Nothing is closed while a request is still in flight.
    await Bun.sleep(5);
    expect(steps).not.toContain("close: pool");
    server.finish();
    await done;

    expect(steps).toEqual([
      "info: Shutdown started; readiness withdrawn",
      "listener: stop",
      "info: Stopped accepting connections",
      "listener: drained",
      "info: In-flight requests drained",
      "close: event-listener",
      "close: pool",
      "info: Connections closed; exiting",
    ]);
    expect(exits).toEqual([0]);
  });

  test("closes connections still open at the drain deadline, then the resources", async () => {
    const { steps, logger, exits, exit } = recorder();
    const shutdown = createShutdown({ logger, exit, drainMs: 10 });
    await shutdown.run("SIGTERM", [listener(steps)], [resource(steps, "pool")]);

    expect(steps).toEqual([
      "info: Shutdown started; readiness withdrawn",
      "listener: stop",
      "info: Stopped accepting connections",
      "warn: Drain deadline passed; closing open connections",
      "listener: close connections",
      "close: pool",
      "info: Connections closed; exiting",
    ]);
    expect(exits).toEqual([0]);
  });

  test("exits non-zero when closing runs past its budget", async () => {
    const { steps, logger, exits, exit } = recorder();
    const shutdown = createShutdown({
      logger,
      exit,
      drainMs: 60_000,
      closeMs: 20,
    });
    const stuck: Resource = {
      name: "pool",
      close: () => new Promise(() => {}),
    };
    await shutdown.run(
      "SIGTERM",
      [],
      [resource(steps, "event-listener"), stuck],
    );
    expect(steps).toEqual([
      "info: Shutdown started; readiness withdrawn",
      "info: Stopped accepting connections",
      "info: In-flight requests drained",
      "close: event-listener",
      "error: Closing resources ran out of time; exiting anyway",
    ]);
    expect(exits).toEqual([1]);
  });

  test("keeps closing after one resource fails and exits non-zero", async () => {
    const { steps, logger, exits, exit } = recorder();
    const shutdown = createShutdown({ logger, exit, drainMs: 60_000 });
    await shutdown.run(
      "SIGTERM",
      [],
      [resource(steps, "event-listener", true), resource(steps, "pool")],
    );
    expect(steps).toContain("error: Closing a resource failed during shutdown");
    expect(steps).toContain("close: pool");
    expect(exits).toEqual([1]);
  });

  test("a second signal exits at once without waiting for the drain", async () => {
    const { steps, logger, exits, exit } = recorder();
    const shutdown = createShutdown({ logger, exit, drainMs: 60_000 });
    const server = listener(steps);
    const first = shutdown.run("SIGINT", [server], [resource(steps, "pool")]);
    await shutdown.run("SIGINT", [server], [resource(steps, "pool")]);
    expect(exits).toEqual([1]);
    expect(steps).not.toContain("close: pool");
    server.finish();
    await first;
  });
});
