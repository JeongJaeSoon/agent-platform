import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { readCatalogConfig } from "./catalog-config.ts";
import {
  DEMO_SESSIONS,
  DemoClient,
  demoDataRefusal,
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
