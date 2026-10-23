import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { demoAccountsRefusal } from "./demo-accounts.ts";

const local = {
  DEMO_ACCOUNTS: "local",
  DATABASE_URL: "postgresql://postgres:dev@postgres:5432/sessions",
};

describe("demoAccountsRefusal", () => {
  test.each([
    "postgresql://postgres:dev@postgres:5432/sessions",
    "postgresql://postgres:dev@localhost:5432/sessions",
    "postgresql://postgres:dev@127.0.0.1:5432/sessions",
    "postgresql://postgres:dev@[::1]:5432/sessions",
  ])("allows the local stack's database %p", (url) => {
    expect(demoAccountsRefusal({ ...local, DATABASE_URL: url })).toBeNull();
  });

  test.each([
    [{ ...local, DEMO_ACCOUNTS: undefined }, "DEMO_ACCOUNTS=local is not set"],
    [{ ...local, DEMO_ACCOUNTS: "1" }, "DEMO_ACCOUNTS=local is not set"],
    [
      { ...local, KUBERNETES_SERVICE_HOST: "10.0.0.1" },
      "Kubernetes installation",
    ],
    [
      {
        ...local,
        DATABASE_URL: "postgresql://app:x@db.prod.internal:5432/sessions",
      },
      "DATABASE_URL points at db.prod.internal",
    ],
    [{ ...local, DATABASE_URL: undefined }, "DATABASE_URL is missing"],
    [
      {
        ...local,
        DATABASE_URL:
          "postgresql://postgres:dev@postgres:5432/sessions?host=db.prod.internal",
      },
      "DATABASE_URL carries query options",
    ],
    [
      {
        ...local,
        DATABASE_URL:
          "postgresql://postgres:dev@localhost/sessions?hostaddr=10.0.0.9",
      },
      "DATABASE_URL carries query options",
    ],
    [
      {
        ...local,
        DATABASE_URL:
          "postgresql://postgres@postgres/sessions?connectionString=postgresql%3A%2F%2Fpostgres%40db.prod.internal%2Fsessions",
      },
      "DATABASE_URL carries query options",
    ],
    [
      { ...local, DATABASE_URL: "socket://postgres/var/run/postgresql" },
      "not the local compose postgres",
    ],
  ])("refuses %p", (env, reason) => {
    expect(demoAccountsRefusal(env)).toContain(reason);
  });

  test("the CLI refuses before it opens a database", () => {
    const result = Bun.spawnSync(
      ["bun", "run", join(import.meta.dir, "demo-accounts.ts")],
      {
        env: {
          PATH: process.env.PATH ?? "",
          // Unreachable: a refusal that still connected would hang or fail.
          DATABASE_URL: "postgresql://postgres:dev@203.0.113.1:5432/sessions",
          DEMO_ACCOUNTS: "local",
        },
        stderr: "pipe",
        stdout: "pipe",
      },
    );
    expect(result.exitCode).toBe(2);
    expect(result.stderr.toString()).toContain(
      "demo accounts refused: DATABASE_URL points at 203.0.113.1",
    );
    expect(result.stdout.toString()).toBe("");
  });
});
