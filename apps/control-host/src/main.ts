// The control host's one executable (94S-117):
//
//   bun run src/main.ts api
//   bun run src/main.ts <scheduler|reconciler> [--once|--health]
//
// The role is named, never defaulted, so a container runs what its command
// says. `scheduler` and `reconciler` alone are services: a supervised loop
// running one pass per child (pass-loop/). `--once` is that one pass, and
// `--health` judges the status file the loop writes. Each role module is
// imported only when chosen: a process reads and validates only its own
// role's settings, and only the scheduler ever loads the Docker backend.
import { rm } from "node:fs/promises";
import { join } from "node:path";
import type { PassLoopRoleName } from "./pass-loop/loop.ts";

const ROLES = ["api", "scheduler", "reconciler"] as const;
const MODES = ["--once", "--health"] as const;
type Role = (typeof ROLES)[number];
type Mode = (typeof MODES)[number] | undefined;

const USAGE =
  "usage: bun run src/main.ts api | <scheduler|reconciler> [--once|--health]";

function parse(args: readonly string[]): { role: Role; mode: Mode } | string {
  const [role, mode, ...rest] = args;
  if (!(ROLES as readonly (string | undefined)[]).includes(role)) {
    return `${USAGE} (got ${role ?? "nothing"})`;
  }
  if (rest.length > 0) return `${USAGE} (got ${args.join(" ")})`;
  if (mode === undefined) return { role: role as Role, mode };
  if (role === "api" || !(MODES as readonly string[]).includes(mode)) {
    return `${USAGE} (got ${args.join(" ")})`;
  }
  return { role: role as Role, mode: mode as Mode };
}

const parsed = parse(process.argv.slice(2));
if (typeof parsed === "string") {
  console.error(parsed);
  process.exit(2);
}
const { role, mode } = parsed;

if (role === "api") {
  // Serves until a signal stops it (api/shutdown.ts).
  await import("./api/server.ts");
} else if (mode === "--health") {
  const { checkHealth } = await import("./pass-loop/health.ts");
  const { PASS_LOOP_ROLES } = await import("./pass-loop/loop.ts");
  const { healthy, reason } = await checkHealth(
    process.env,
    PASS_LOOP_ROLES[role],
  );
  (healthy ? console.log : console.error)(reason);
  process.exitCode = healthy ? 0 : 1;
} else if (mode === "--once") {
  process.exitCode = await runOnce(role);
} else {
  process.exitCode = await supervise(role);
}

async function runOnce(role: PassLoopRoleName): Promise<number> {
  if (role === "reconciler") {
    // No SIGTERM handler: every write is a transaction re-judged under row
    // locks, so ending the pass anywhere loses nothing.
    const { main } = await import("./reconciler/main.ts");
    await main();
    return 0;
  }
  const { exitCodeFor, main } = await import("./scheduler/main.ts");
  // A signal stops the pass at its next safe point, the checks it makes for
  // a lost pass lock, so no reservation starts after it; a second one is
  // the default and ends the process.
  const stop = new AbortController();
  for (const name of ["SIGTERM", "SIGINT"] as const) {
    process.once(name, () =>
      stop.abort(new Error(`${name} received; the pass stopped early`)),
    );
  }
  return exitCodeFor(await main(process.env, { stop: stop.signal }));
}

async function supervise(role: PassLoopRoleName): Promise<number> {
  const { PASS_LOOP_ROLES, passLoopConfigFromEnv, runPassLoop } = await import(
    "./pass-loop/loop.ts"
  );
  const { createLogger, logLevelFromEnv } = await import(
    "@agent-platform/observability"
  );
  const config = passLoopConfigFromEnv(process.env, PASS_LOOP_ROLES[role]);
  // Every pass child logs at this level; a typo stops the loop here, once.
  const level = logLevelFromEnv(process.env.LOG_LEVEL);
  let passEnv: Record<string, string> | undefined;
  // The passes would refuse a bad setting one by one; refuse it here, once.
  if (role === "scheduler") {
    const { assertPassOutlastsStop, schedulerConfigFromEnv } = await import(
      "./scheduler/config.ts"
    );
    const { QUOTA_PREFLIGHT_MARKER_ENV } = await import(
      "./scheduler/quota-preflight.ts"
    );
    const { docker } = schedulerConfigFromEnv(process.env);
    assertPassOutlastsStop(config.passTimeoutMs, docker);
    // The first pass of every loop probes the workspace quota afresh.
    const marker = `${config.statusFile}.quota-verified`;
    await rm(marker, { force: true });
    passEnv = { [QUOTA_PREFLIGHT_MARKER_ENV]: marker };
  } else {
    const { reconcilerDatabaseUrl } = await import("./reconciler/main.ts");
    const { reconcilerSettings } = await import("./reconciler/reconcile.ts");
    reconcilerDatabaseUrl(process.env);
    reconcilerSettings(process.env);
  }
  const logger = createLogger({ level });
  const shutdown = new AbortController();
  for (const name of ["SIGTERM", "SIGINT"] as const) {
    process.on(name, () => {
      if (!shutdown.signal.aborted) {
        logger.info(`${name} received; stopping the ${role} loop`);
      }
      shutdown.abort();
    });
  }
  const name = role === "scheduler" ? "Scheduler" : "Reconciler";
  logger.info(`${name} loop started`, {
    interval_ms: config.intervalMs,
    kill_grace_ms: config.killGraceMs,
    max_consecutive_failures: config.maxConsecutiveFailures,
    pass_timeout_ms: config.passTimeoutMs,
    status_file: config.statusFile,
  });
  return runPassLoop({
    name,
    command: [
      process.execPath,
      "run",
      join(import.meta.dir, "main.ts"),
      role,
      "--once",
    ],
    ...(passEnv === undefined ? {} : { env: passEnv }),
    config,
    logger,
    signal: shutdown.signal,
  });
}
