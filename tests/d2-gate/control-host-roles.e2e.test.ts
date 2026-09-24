import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Pool } from "pg";
import {
  database,
  gateEnv,
  Messages,
  PublicApi,
  prompt,
  run,
  Workers,
  waitFor,
  write,
} from "./harness.ts";

/**
 * 94S-117: the control host's three roles, as the compose stack runs them,
 * on the D2 gate stack (the product topology with the gate's scripted
 * Messages API):
 *
 * H1. api, scheduler and reconciler run one image, each as its own role,
 *     and the Docker socket is mounted into the scheduler alone;
 * H2. restarting the scheduler mid-turn ends no worker and launches none
 *     twice: the turn completes on the one execution it started on;
 * H3. the api and reconciler come back healthy from a restart and the
 *     session they served takes its next turn;
 * H4. with PostgreSQL stopped the loops fail their passes instead of
 *     looking healthy, and once it is back they recover on their own;
 * H5. a scheduler that cannot reach Docker fails its passes before it
 *     reserves anything, and the real one, started again, launches the
 *     waiting session once.
 *
 * Run against a stack run.sh keeps up:
 *   D2_GATE_UP_ONLY=1 scripts/d2-gate/run.sh
 *   . <out>/vars.sh && bun test tests/d2-gate/control-host-roles.e2e.test.ts
 * Without it (D2_GATE unset) every test skips.
 */

const env = gateEnv();
const evidence: Record<string, unknown> = {};
const TURN_MS = 300_000;
const HEALTH_MS = 240_000;

let api: PublicApi;
let db: Pool;
let messages: Messages;
let workers: Workers;

const container = (service: string) => `${env?.project}-${service}-1`;

async function inspect<T>(name: string, format: string): Promise<T> {
  const { stdout } = await run([
    "docker",
    "inspect",
    "--format",
    `{{json ${format}}}`,
    name,
  ]);
  return JSON.parse(stdout) as T;
}

async function health(service: string): Promise<string> {
  return inspect<string>(container(service), ".State.Health.Status");
}

async function healthy(service: string): Promise<void> {
  await waitFor(
    `${service} to be healthy`,
    async () => (await health(service)) === "healthy",
    HEALTH_MS,
  );
}

/** The loop's status file, read from inside its container. */
async function passStatus(service: "scheduler" | "reconciler") {
  const { stdout } = await run([
    "docker",
    "exec",
    container(service),
    "cat",
    `/tmp/${service}-status.json`,
  ]);
  return JSON.parse(stdout) as {
    consecutiveFailures: number;
    lastFailureAt: string | null;
    lastFailureReason: string | null;
    lastSuccessAt: string | null;
    loopStartedAt: string;
    passes: number;
  };
}

async function logsSince(name: string, since: Date): Promise<string> {
  const { stdout, stderr } = await run(
    ["docker", "logs", "--since", since.toISOString(), name],
    { allowFail: true },
  );
  return `${stdout}${stderr}`;
}

async function executions(sessionId: string) {
  return (
    await db.query(
      "SELECT id, generation, desired_state FROM executions WHERE session_id = $1 ORDER BY generation",
      [sessionId],
    )
  ).rows as { desired_state: string; generation: number; id: string }[];
}

describe.skipIf(env === null)("control host roles (94S-117)", () => {
  beforeAll(async () => {
    if (!env) return;
    api = new PublicApi(env.apiUrl, env.apiKey);
    db = database(env.databaseUrl);
    messages = new Messages(env.messagesUrl);
    workers = new Workers(env.installation, env.out);
    workers.watch();
    for (const service of ["api", "scheduler", "reconciler"]) {
      await healthy(service);
    }
  });

  afterAll(async () => {
    if (!env) return;
    await writeFile(
      join(env.out, "control-host-roles.json"),
      `${JSON.stringify(evidence, null, 2)}\n`,
    );
    workers?.stop();
    await db?.end();
  });

  test("H1: one image runs the three roles and only the scheduler holds the Docker socket", async () => {
    const roles: Record<string, unknown> = {};
    const images = new Set<string>();
    for (const service of ["api", "scheduler", "reconciler"]) {
      const name = container(service);
      const image = await inspect<string>(name, ".Image");
      const cmd = await inspect<string[]>(name, ".Config.Cmd");
      const mounts = await inspect<{ Destination: string; Source: string }[]>(
        name,
        ".Mounts",
      );
      const vars = await inspect<string[]>(name, ".Config.Env");
      images.add(image);
      roles[service] = {
        cmd,
        docker_host: vars.filter((v) => v.startsWith("DOCKER_HOST=")),
        health: await health(service),
        image,
        socket_mounts: mounts.filter(
          (m) =>
            m.Destination.endsWith("docker.sock") ||
            m.Source.endsWith("docker.sock"),
        ),
      };
      expect(cmd.slice(0, 4)).toEqual([
        "bun",
        "run",
        "apps/control-host/src/main.ts",
        service,
      ]);
    }
    evidence.h1_roles = roles;
    expect(images.size).toBe(1);
    const sockets = Object.fromEntries(
      Object.entries(roles).map(([service, role]) => [
        service,
        (role as { socket_mounts: unknown[] }).socket_mounts.length,
      ]),
    );
    expect(sockets).toEqual({ api: 0, scheduler: 1, reconciler: 0 });
    // The egress proxy is outside the control host and has no socket either.
    const proxy = await inspect<{ Destination: string }[]>(
      container("egress-proxy"),
      ".Mounts",
    );
    expect(proxy.filter((m) => m.Destination.endsWith("docker.sock"))).toEqual(
      [],
    );
  }, 300_000);

  let sessionId = "";

  test("H2: a scheduler restarted mid-turn ends no worker and launches none twice", async () => {
    const spec = {
      id: `H2-${crypto.randomUUID().slice(0, 8)}`,
      // Open long enough to restart the scheduler under it.
      steps: [{ ...write("/workspace/h2.txt", "h2\n"), delayMs: 60_000 }],
      final: "H2 DONE",
    };
    const created = await api.createSession(prompt("Turn one.", spec));
    sessionId = created.session_id;
    evidence.h2_session = sessionId;
    await waitFor(
      "the model call of H2",
      async () => (await messages.requests(spec.id)).length > 0,
      TURN_MS,
      250,
    );
    const worker = await workers.running(sessionId, 10_000);
    const before = await executions(sessionId);
    const restartedAt = new Date();
    await run(["docker", "restart", container("scheduler")]);
    const stillRunning = await inspect<string>(worker.name, ".State.Status");
    await healthy("scheduler");
    const turn = await api.settle(sessionId, created.turn_id, TURN_MS);
    const after = await executions(sessionId);
    const log = await logsSince(container("scheduler"), restartedAt);
    Object.assign(evidence, {
      h2_worker: worker.name,
      h2_worker_after_restart: stillRunning,
      h2_executions_before: before,
      h2_executions_after: after,
      h2_turn: { status: turn.status, reason: turn.terminal_reason },
      h2_scheduler_stop: log
        .split("\n")
        .filter((line) => line.includes("stopping the scheduler loop")),
    });
    expect(stillRunning).toBe("running");
    expect(log).toContain("SIGTERM received; stopping the scheduler loop");
    expect(turn.status).toBe("completed");
    expect(before).toHaveLength(1);
    expect(after.map((e) => e.id)).toEqual(before.map((e) => e.id));
  }, 900_000);

  test("H3: the api and reconciler come back from a restart and the session takes its next turn", async () => {
    expect(sessionId).not.toBe("");
    const restartedAt = new Date();
    await run(["docker", "restart", container("reconciler")]);
    await run(["docker", "restart", container("api")]);
    await healthy("api");
    await healthy("reconciler");
    const spec = {
      id: `H3-${crypto.randomUUID().slice(0, 8)}`,
      steps: [{ ...write("/workspace/h3.txt", "h3\n") }],
      final: "H3 DONE",
    };
    const turnId = await api.message(sessionId, prompt("Turn two.", spec));
    const turn = await api.settle(sessionId, turnId, TURN_MS);
    const reconciler = await passStatus("reconciler");
    Object.assign(evidence, {
      h3_turn: { status: turn.status, reason: turn.terminal_reason },
      h3_reconciler_status: reconciler,
      h3_executions: await executions(sessionId),
    });
    expect(turn.status).toBe("completed");
    expect(new Date(reconciler.loopStartedAt).getTime()).toBeGreaterThan(
      restartedAt.getTime(),
    );
    expect(reconciler.lastSuccessAt).not.toBeNull();
  }, 900_000);

  test("H4: with PostgreSQL down the loops fail their passes, and recover once it is back", async () => {
    const stoppedAt = new Date();
    await run(["docker", "stop", container("postgres")]);
    let during: Record<string, unknown> = {};
    try {
      // Long enough for each loop to fail a pass: the scheduler's DB wait is
      // bounded near 45s (docs/operations.md), the reconciler's the same.
      during = await waitFor(
        "both loops to report a failed pass",
        async () => {
          const found: Record<string, string> = {};
          for (const service of ["scheduler", "reconciler"] as const) {
            const log = await logsSince(container(service), stoppedAt);
            const name = service === "scheduler" ? "Scheduler" : "Reconciler";
            if (!log.includes(`${name} pass failed`)) return null;
            found[service] = await health(service).catch(
              (error) => `unreadable: ${String(error)}`,
            );
          }
          return found;
        },
        240_000,
        2000,
      );
    } finally {
      await run(["docker", "start", container("postgres")]);
    }
    const startedAt = new Date();
    await healthy("postgres");
    await healthy("api");
    const recovered: Record<string, unknown> = {};
    for (const service of ["scheduler", "reconciler"] as const) {
      recovered[service] = await waitFor(
        `${service} to succeed a pass after PostgreSQL is back`,
        async () => {
          const status = await passStatus(service).catch(() => null);
          return status?.lastSuccessAt &&
            new Date(status.lastSuccessAt) > startedAt &&
            (await health(service)) === "healthy"
            ? status
            : null;
        },
        HEALTH_MS,
        2000,
      );
    }
    const spec = {
      id: `H4-${crypto.randomUUID().slice(0, 8)}`,
      steps: [{ ...write("/workspace/h4.txt", "h4\n") }],
      final: "H4 DONE",
    };
    const created = await api.createSession(prompt("After the outage.", spec));
    const turn = await api.settle(created.session_id, created.turn_id, TURN_MS);
    Object.assign(evidence, {
      h4_during: during,
      h4_recovered: recovered,
      h4_restart_counts: {
        scheduler: await inspect<number>(
          container("scheduler"),
          ".RestartCount",
        ),
        reconciler: await inspect<number>(
          container("reconciler"),
          ".RestartCount",
        ),
      },
      h4_session: created.session_id,
      h4_turn: { status: turn.status, reason: turn.terminal_reason },
    });
    expect(turn.status).toBe("completed");
  }, 900_000);

  test("H5: a scheduler without Docker reserves nothing, and the real one launches the waiting session once", async () => {
    if (!env) return;
    const scheduler = container("scheduler");
    const vars = (await inspect<string[]>(scheduler, ".Config.Env")).map((v) =>
      v.startsWith("DOCKER_HOST=")
        ? "DOCKER_HOST=unix:///var/run/no-docker.sock"
        : v,
    );
    const substitute = `${env.project}-scheduler-nodocker`;
    await run(["docker", "stop", scheduler]);
    let sessionWaiting = "";
    try {
      await run([
        "docker",
        "run",
        "-d",
        "--name",
        substitute,
        "--network",
        env.network,
        "--user",
        "0:0",
        ...vars.flatMap((v) => ["-e", v]),
        env.apiImage,
        "bun",
        "run",
        "apps/control-host/src/main.ts",
        "scheduler",
      ]);
      const spec = {
        id: `H5-${crypto.randomUUID().slice(0, 8)}`,
        steps: [{ ...write("/workspace/h5.txt", "h5\n") }],
        final: "H5 DONE",
      };
      const created = await api.createSession(prompt("Turn one.", spec));
      sessionWaiting = created.session_id;
      evidence.h5_session = sessionWaiting;
      const failed = await waitFor(
        "the Docker-less scheduler to fail a pass",
        async () => {
          const { stdout, stderr } = await run(["docker", "logs", substitute], {
            allowFail: true,
          });
          const lines = `${stdout}${stderr}`
            .split("\n")
            .filter((line) => line.includes("Scheduler pass failed"));
          return lines.length > 0 ? lines : null;
        },
        120_000,
        1000,
      );
      evidence.h5_failed_passes = failed.slice(0, 3);
      expect(await executions(sessionWaiting)).toEqual([]);
      await run(["docker", "rm", "-f", substitute]);
      await run(["docker", "start", scheduler]);
      await healthy("scheduler");
      const turn = await api.settle(sessionWaiting, created.turn_id, TURN_MS);
      const launched = await executions(sessionWaiting);
      Object.assign(evidence, {
        h5_executions: launched,
        h5_turn: { status: turn.status, reason: turn.terminal_reason },
      });
      expect(turn.status).toBe("completed");
      expect(launched).toHaveLength(1);
    } finally {
      await run(["docker", "rm", "-f", substitute], { allowFail: true });
      await run(["docker", "start", scheduler], { allowFail: true });
    }
  }, 900_000);
});
