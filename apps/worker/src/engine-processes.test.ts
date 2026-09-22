import { describe, expect, test } from "bun:test";

import { EngineProcesses } from "./engine-processes.ts";

describe("EngineProcesses", () => {
  test("reports exit only once every spawned engine is gone", async () => {
    const engines = new EngineProcesses();
    engines.onSpawn(101);
    engines.onSpawn(102);
    const waiting = engines.exited(1_000);

    engines.onExit(101);
    expect(engines.running).toEqual([102]);
    engines.onExit(102);

    expect(await waiting).toBe(true);
    expect(await engines.exited(0)).toBe(true);
  });

  test("gives up after the grace period while one is still running", async () => {
    const engines = new EngineProcesses();
    engines.onSpawn(101);

    expect(await engines.exited(10)).toBe(false);
    expect(engines.running).toEqual([101]);
  });

  test("kills a straggler for real", async () => {
    const engines = new EngineProcesses();
    const child = Bun.spawn(["sleep", "30"]);
    engines.onSpawn(child.pid);
    void child.exited.then(() => engines.onExit(child.pid));

    expect(await engines.exited(20)).toBe(false);
    engines.kill();

    expect(await engines.exited(2_000)).toBe(true);
    expect(child.signalCode).toBe("SIGKILL");
  });
});
