import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { readCatalogConfig } from "./catalog-config.ts";
import {
  DEMO_SESSIONS,
  DemoClient,
  demoDataRefusal,
  finished,
  signOutAll,
} from "./demo-data.ts";

const local = {
  DEMO_ACCOUNTS: "local",
  DATABASE_URL: "postgresql://postgres:dev@postgres:5432/sessions",
};
const configRoot = join(import.meta.dir, "../../../../config");

describe("demoDataRefusal", () => {
  test("allows the local stack on the fake-model catalog", async () => {
    const catalog = await readCatalogConfig(join(configRoot, "fake-model"));
    expect(demoDataRefusal(local, catalog)).toBeNull();
  });

  test("refuses the real-model catalog", async () => {
    const catalog = await readCatalogConfig(configRoot);
    expect(demoDataRefusal(local, catalog)).toContain(
      "does not call the fake model",
    );
  });

  test("refuses a fake profile pointed at another endpoint", async () => {
    const catalog = await readCatalogConfig(join(configRoot, "fake-model"));
    const general = catalog.profiles.general;
    if (!general?.provider) throw new Error("fake catalog lost general");
    const moved = {
      profiles: {
        ...catalog.profiles,
        general: {
          ...general,
          provider: {
            ...general.provider,
            endpoint: "https://api.anthropic.com",
          },
        },
      },
    };
    expect(demoDataRefusal(local, moved)).toContain(
      "profile general does not call the fake model",
    );
  });

  test("refuses whatever the demo accounts refuse", async () => {
    const catalog = await readCatalogConfig(join(configRoot, "fake-model"));
    expect(
      demoDataRefusal(
        { ...local, KUBERNETES_SERVICE_HOST: "10.0.0.1" },
        catalog,
      ),
    ).toContain("Kubernetes installation");
    expect(
      demoDataRefusal({ ...local, DEMO_ACCOUNTS: undefined }, catalog),
    ).toContain("DEMO_ACCOUNTS=local is not set");
  });

  test("the CLI refuses before it reads a catalog or calls the api", () => {
    const result = Bun.spawnSync(
      ["bun", "run", join(import.meta.dir, "demo-data.ts")],
      {
        env: {
          PATH: process.env.PATH ?? "",
          DATABASE_URL: "postgresql://postgres:dev@203.0.113.1:5432/sessions",
          DEMO_ACCOUNTS: "local",
          // Unreachable: a refusal that still called it would hang or fail.
          PORT: "9",
        },
        stderr: "pipe",
        stdout: "pipe",
      },
    );
    expect(result.exitCode).toBe(2);
    expect(result.stderr.toString()).toContain(
      "demo data refused: DATABASE_URL points at 203.0.113.1",
    );
    expect(result.stdout.toString()).toBe("");
  });

  test("the CLI refuses the real-model catalog", () => {
    const result = Bun.spawnSync(
      ["bun", "run", join(import.meta.dir, "demo-data.ts")],
      {
        env: {
          PATH: process.env.PATH ?? "",
          ...local,
          PLATFORM_CONFIG_DIR: configRoot,
          PORT: "9",
        },
        stderr: "pipe",
        stdout: "pipe",
      },
    );
    expect(result.exitCode).toBe(2);
    expect(result.stderr.toString()).toContain(
      "demo data refused: profile claude-coding-local does not call the fake model",
    );
  });
});

describe("DEMO_SESSIONS", () => {
  // Titles are how a later run finds what an earlier one made.
  test("titles do not repeat and exactly one session has none", () => {
    const titles = DEMO_SESSIONS.flatMap((session) =>
      session.title === null ? [] : [session.title],
    );
    expect(new Set(titles).size).toBe(titles.length);
    expect(DEMO_SESSIONS.length - titles.length).toBe(1);
  });
});

describe("signOutAll", () => {
  test(
    "signs every client out through a retryable failure and an unreachable api",
    async () => {
      const logouts: string[] = [];
      let failures = 1;
      const server = Bun.serve({
        port: 0,
        fetch(request) {
          const cookie = request.headers.get("cookie") ?? "";
          logouts.push(cookie);
          if (failures-- > 0) {
            return Response.json(
              { error: { code: "BACKEND_UNAVAILABLE", retryable: true } },
              { status: 503 },
            );
          }
          return new Response(null, { status: 204 });
        },
      });
      try {
        const reachable = new DemoClient(
          `http://127.0.0.1:${server.port}`,
          "__Host-ap_session=owner",
        );
        // Port 9 (discard) refuses: every attempt throws.
        const unreachable = new DemoClient(
          "http://127.0.0.1:9",
          "__Host-ap_session=member",
        );
        await expect(signOutAll([unreachable, reachable])).rejects.toThrow(
          "signing out failed",
        );
        expect(logouts).toEqual([
          "__Host-ap_session=owner",
          "__Host-ap_session=owner",
        ]);
        // Signed out: a second pass sends nothing more.
        await signOutAll([reachable]);
        expect(logouts).toHaveLength(2);
      } finally {
        server.stop(true);
      }
    },
    { timeout: 15_000 },
  );
});

describe("finished", () => {
  const spec = (outcome: string, isPrivate = false) => {
    const found = DEMO_SESSIONS.find(
      (session) => session.outcome === outcome && session.private === isPrivate,
    );
    if (!found) throw new Error(`no demo session ${outcome}`);
    return found;
  };

  test.each([
    [409, "CHECKPOINT_UNAVAILABLE", true],
    [409, "CONFLICT", false],
    [500, "CHECKPOINT_UNAVAILABLE", false],
    [401, "UNAUTHORIZED", false],
  ] as const)(
    "outputs %p %p skips recovery only: %p",
    async (status, code, skips) => {
      const server = Bun.serve({
        port: 0,
        fetch: () => Response.json({ error: { code } }, { status }),
      });
      try {
        const client = new DemoClient(`http://127.0.0.1:${server.port}`, "c=1");
        const result = finished(client, "s", spec("approve-then-idle"));
        if (skips) {
          expect(await result).toBe(true);
        } else {
          await expect(result).rejects.toThrow(
            `answered ${status}, expected 200`,
          );
        }
      } finally {
        server.stop(true);
      }
    },
  );

  test.each([
    ["stopped", false, { status: "stopped" }, true],
    ["stopped", false, { status: "idle" }, false],
    ["approve-then-idle", false, { outputs: 1 }, true],
    ["approve-then-idle", false, { outputs: 0 }, false],
    ["permission", true, { scope: "private" }, true],
    ["permission", true, { scope: "workspace" }, false],
    // Changes on its own once seeded, so a rerun does not judge it.
    ["question", false, { status: "failed" }, true],
  ] as const)(
    "%p (private %p) with %p is finished: %p",
    async (outcome, isPrivate, state, expected) => {
      const server = Bun.serve({
        port: 0,
        fetch(request) {
          const path = new URL(request.url).pathname;
          if (path.endsWith("/share")) {
            return Response.json({
              scope: "scope" in state ? state.scope : "workspace",
            });
          }
          if (path.endsWith("/outputs")) {
            const count = "outputs" in state ? state.outputs : 0;
            return Response.json({
              items: Array.from({ length: count }, () => ({})),
            });
          }
          return Response.json({
            status: "status" in state ? state.status : "idle",
          });
        },
      });
      try {
        const client = new DemoClient(`http://127.0.0.1:${server.port}`, "c=1");
        expect(await finished(client, "s", spec(outcome, isPrivate))).toBe(
          expected,
        );
      } finally {
        server.stop(true);
      }
    },
  );
});
