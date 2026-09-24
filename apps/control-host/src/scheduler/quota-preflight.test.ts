import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyWorkspaceQuotaOnce } from "./quota-preflight.ts";

const quiet = { warn: () => undefined };

async function harness() {
  const marker = join(
    await mkdtemp(join(tmpdir(), "quota-preflight-")),
    "marker",
  );
  let probes = 0;
  let refuse = false;
  const run = (settings: unknown) =>
    verifyWorkspaceQuotaOnce({
      logger: quiet,
      marker,
      settings,
      verify: async () => {
        probes += 1;
        if (refuse) throw new Error("no project quota behind this daemon");
      },
    });
  return {
    marker,
    probes: () => probes,
    refuse: (value: boolean) => {
      refuse = value;
    },
    run,
  };
}

describe("verifyWorkspaceQuotaOnce (94S-393)", () => {
  test("probes once, then not again while the settings stay the same", async () => {
    const { probes, run } = await harness();
    const settings = { quota: { mode: "enforced", sizeBytes: 1 } };
    await run(settings);
    await run(settings);
    await run({ quota: { mode: "enforced", sizeBytes: 1 } });
    expect(probes()).toBe(1);
  });

  test("probes again when any setting changes", async () => {
    const { probes, run } = await harness();
    await run({ dockerHost: "unix:///a", sizeBytes: 1 });
    await run({ dockerHost: "unix:///a", sizeBytes: 2 });
    await run({ dockerHost: "unix:///b", sizeBytes: 2 });
    expect(probes()).toBe(3);
  });

  test("a refused probe notes nothing, so every pass probes until one passes", async () => {
    const { marker, probes, refuse, run } = await harness();
    refuse(true);
    await expect(run({})).rejects.toThrow("no project quota");
    await expect(run({})).rejects.toThrow("no project quota");
    await expect(readFile(marker, "utf8")).rejects.toThrow();
    refuse(false);
    await run({});
    await run({});
    expect(probes()).toBe(3);
  });

  test("a note from other settings, or a torn one, is not trusted", async () => {
    const { marker, probes, run } = await harness();
    await writeFile(marker, "");
    await run({ sizeBytes: 1 });
    expect(probes()).toBe(1);
  });

  test("a note that cannot be written only costs another probe", async () => {
    const warnings: string[] = [];
    let probes = 0;
    const run = () =>
      verifyWorkspaceQuotaOnce({
        logger: { warn: (message) => warnings.push(message) },
        marker: join(tmpdir(), "quota-preflight-missing-dir", "x", "marker"),
        settings: {},
        verify: async () => {
          probes += 1;
        },
      });
    await run();
    await run();
    expect(probes).toBe(2);
    expect(warnings).toHaveLength(2);
  });

  test("a pass run outside the loop has no note to trust and always probes", async () => {
    let probes = 0;
    for (let pass = 0; pass < 2; pass += 1) {
      await verifyWorkspaceQuotaOnce({
        logger: quiet,
        marker: undefined,
        settings: {},
        verify: async () => {
          probes += 1;
        },
      });
    }
    expect(probes).toBe(2);
  });
});
