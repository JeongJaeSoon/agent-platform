import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as schema from "@agent-platform/db";
import { apiKeys } from "@agent-platform/db";
import { eq } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";

const databaseUrl = process.env.QUEUE_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;

// Idle this whole test runs in ~0.4s (bun 1.3.11, 14-core M-series), but a
// loaded 4-core GitHub runner has pushed server startup past the old 5s wall
// (94S-256). 30s is the ratio 94S-241 chose: far above any observed startup,
// well below "hung". The test timeout is a separate total budget: key CLI
// spawn + DB insert before the wait, the full 30s allowance, then the
// remaining requests and teardown, each of which the same load slows.
const SERVER_START_DEADLINE_MS = 30_000;
const TEST_TIMEOUT_MS = 90_000;
const POLL_INTERVAL_MS = 100;

// Drains the server's stdout and resolves `port` from its "API listening"
// line. The server binds PORT=0 so the OS hands it a free port: a port picked
// here (it was pid-derived) can already be held on a shared runner, and the
// bind then fails (94S-328). `port` resolves undefined if stdout ends first.
function serverStdout(stream: ReadableStream<Uint8Array>): {
  text: Promise<string>;
  port: Promise<number | undefined>;
} {
  let found: (port: number | undefined) => void = () => {};
  const port = new Promise<number | undefined>((resolve) => {
    found = resolve;
  });
  const text = (async () => {
    const decoder = new TextDecoder();
    let all = "";
    let scanned = 0;
    for await (const chunk of stream) {
      all += decoder.decode(chunk, { stream: true });
      for (
        let newline = all.indexOf("\n", scanned);
        newline >= 0;
        newline = all.indexOf("\n", scanned)
      ) {
        const line = all.slice(scanned, newline);
        scanned = newline + 1;
        if (!line.includes('"API listening"')) continue;
        const record = JSON.parse(line) as { fields?: { port?: number } };
        found(record.fields?.port);
      }
    }
    found(undefined);
    return all + decoder.decode();
  })();
  return { text, port };
}

// Waits for the server to report its port, then polls `path` on it until the
// server answers, the server exits, or the deadline passes. Exit and deadline
// both fail with the server's stderr attached, so a startup error (missing
// DATABASE_URL, module failure) is readable from the assertion instead of
// surfacing as an `undefined` status. Each wait is bounded by the deadline so
// a server that never listens, or accepts the connection but never answers,
// still ends here, not at the test timeout.
async function waitForServer(
  server: Bun.Subprocess,
  stdout: { port: Promise<number | undefined> },
  stderr: Promise<string>,
  request: { path: string; headers: Record<string, string> },
): Promise<{ port: number; response: Response }> {
  const exited = server.exited.then((exitCode) => ({ exitCode }));
  const deadline = Date.now() + SERVER_START_DEADLINE_MS;
  const fail = async (reason: string): Promise<never> => {
    server.kill("SIGTERM");
    await server.exited;
    throw new Error(`${reason}\nstderr:\n${await stderr}`);
  };
  const exitedEarly = async (exitCode: number): Promise<never> => {
    throw new Error(
      `server exited with code ${exitCode} before accepting connections\nstderr:\n${await stderr}`,
    );
  };

  const listening = await Promise.race([
    stdout.port.then((port) => ({ port })),
    exited,
    Bun.sleep(SERVER_START_DEADLINE_MS).then(() => ({ timedOut: true })),
  ]);
  if ("exitCode" in listening) return exitedEarly(listening.exitCode);
  if ("timedOut" in listening || listening.port === undefined) {
    return fail(
      `server did not report a listening port within ${SERVER_START_DEADLINE_MS}ms`,
    );
  }
  const { port } = listening;

  while (true) {
    const outcome = await Promise.race([
      fetch(`http://127.0.0.1:${port}${request.path}`, {
        headers: request.headers,
        signal: AbortSignal.timeout(Math.max(deadline - Date.now(), 1)),
      }).then(
        (response) => ({ response }),
        (error: unknown) => ({ error }),
      ),
      exited,
    ]);
    if ("response" in outcome) return { port, response: outcome.response };
    if ("exitCode" in outcome) return exitedEarly(outcome.exitCode);
    if (Date.now() >= deadline) {
      return fail(
        `server did not accept connections within ${SERVER_START_DEADLINE_MS}ms (last error: ${String(outcome.error)})`,
      );
    }
    await Bun.sleep(POLL_INTERVAL_MS);
  }
}

// The provider key the catalog below references by environment variable.
// The server must start with it and never write it anywhere.
const PROVIDER_KEY = `provider-${crypto.randomUUID()}`;
const PROFILES = `profiles:
  coding:
    runtime_kind: claude_agent_sdk
    runtime_version: "0.3.270"
    model: claude-sonnet-5
    tools: [Read]
    permission_mode: default
    provider:
      kind: anthropic
      endpoint: https://api.anthropic.invalid
      auth:
        kind: api_key
        value_env: INTEGRATION_PROVIDER_KEY
`;
const REPOSITORIES = `repositories:
  app:
    url: https://git.example.invalid/team/app.git
    branch: main
    profiles: [coding]
`;

async function configDir(
  root: string,
  name: string,
  profiles = PROFILES,
): Promise<string> {
  const dir = join(root, name);
  await Bun.write(join(dir, "profiles.yaml"), profiles);
  await writeFile(join(dir, "repositories.yaml"), REPOSITORIES);
  return dir;
}

async function issueKey(
  ownerId: string,
  scopes: string,
): Promise<{ plaintext: string; keyId: string }> {
  const keyProcess = Bun.spawn(
    ["bun", "run", "src/api/keys.ts", "create", ownerId, "--scopes", scopes],
    {
      cwd: `${import.meta.dir}/../..`,
      env: { ...process.env, DATABASE_URL: databaseUrl },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [keyOutput, keyError, keyExit] = await Promise.all([
    new Response(keyProcess.stdout).text(),
    new Response(keyProcess.stderr).text(),
    keyProcess.exited,
  ]);
  expect(keyExit, keyError).toBe(0);
  expect(keyOutput.trim().split("\n")).toHaveLength(1);
  const plaintext = keyOutput.trim();
  expect(plaintext).toStartWith("csp_");
  const keyId = /^key_id (\S+)$/m.exec(keyError)?.[1];
  expect(keyId, keyError).toBeDefined();
  return { plaintext, keyId: keyId ?? "" };
}

async function grantsCli(
  ...args: string[]
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return cli("src/api/grants.ts", args);
}

async function keysCli(
  ...args: string[]
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return cli("src/api/keys.ts", args);
}

async function cli(
  script: string,
  args: string[],
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const child = Bun.spawn(["bun", "run", script, ...args], {
    cwd: `${import.meta.dir}/../..`,
    env: { ...Bun.env, DATABASE_URL: databaseUrl },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { exitCode, stdout, stderr };
}

// Runs the server to exit and hands back what it said; for configurations
// that must stop it before it ever listens.
async function refusedStart(
  env: Record<string, string>,
): Promise<{ exitCode: number; stderr: string }> {
  const server = Bun.spawn(["bun", "run", "src/main.ts", "api"], {
    cwd: `${import.meta.dir}/../..`,
    env: {
      ...process.env,
      AUTH_MODE: "api-key",
      CHECKPOINT_OBJECT_STORE: "disabled",
      DATABASE_URL: databaseUrl,
      EXECUTION_SLOT_LIMIT: "10",
      MAX_TURN_SECONDS: "3600",
      PROVIDER_MAX_RETRIES: "2",
      QUEUED_INPUT_LIMIT_PER_SESSION: "20",
      SESSION_COST_LIMIT_USD: "25",
      STORAGE_LIMIT_BYTES: "1073741824",
      PORT: "0",
      INTEGRATION_PROVIDER_KEY: PROVIDER_KEY,
      ...env,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const timer = setTimeout(
    () => server.kill("SIGKILL"),
    SERVER_START_DEADLINE_MS,
  );
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(server.stdout).text(),
    new Response(server.stderr).text(),
    server.exited,
  ]);
  clearTimeout(timer);
  return { exitCode, stderr: `${stdout}${stderr}` };
}

integration("API server on PostgreSQL", () => {
  let db: NodePgDatabase<typeof schema>;
  let pool: Pool;
  let root: string;
  const ownerId = `integration-owner-${crypto.randomUUID()}`;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "server-integration-"));
    pool = new Pool({ connectionString: databaseUrl, max: 2 });
    db = drizzle(pool, { schema });
    const state = await pool.query<{ sessions: string | null }>(
      "SELECT to_regclass('public.sessions') AS sessions",
    );
    if (state.rows[0]?.sessions === null) {
      await migrate(db, {
        migrationsFolder: `${import.meta.dir}/../../../../packages/db/migrations`,
      });
    }
  }, 60_000);

  afterAll(async () => {
    await db.delete(apiKeys).where(eq(apiKeys.ownerId, ownerId));
    await pool.end();
    await rm(root, { recursive: true, force: true });
  }, 60_000);

  test(
    "issues scoped keys that store a digest, and serves the catalog and scopes over HTTP",
    async () => {
      const { plaintext } = await issueKey(
        ownerId,
        "sessions:read,sessions:write",
      );
      const { plaintext: readOnly, keyId: readOnlyId } = await issueKey(
        ownerId,
        "sessions:read",
      );
      const { plaintext: owner } = await issueKey(
        ownerId,
        "sessions:read,sessions:write,sessions:approve,sessions:control,sessions:recover",
      );

      const stored = await db
        .select({ keyHash: apiKeys.keyHash, scopes: apiKeys.scopes })
        .from(apiKeys)
        .where(eq(apiKeys.ownerId, ownerId));
      expect(stored.map((row) => row.scopes)).toContainEqual([
        "sessions:read",
        "sessions:write",
      ]);
      for (const row of stored) {
        expect(row.keyHash).toHaveLength(32);
        for (const key of [plaintext, readOnly, owner]) {
          expect(new TextDecoder().decode(row.keyHash)).not.toContain(key);
        }
      }

      const server = Bun.spawn(["bun", "run", "src/main.ts", "api"], {
        cwd: `${import.meta.dir}/../..`,
        env: {
          ...process.env,
          AUTH_MODE: "api-key",
          // The process refuses to start without an object store unless told
          // there is none; this test is about the HTTP process, not S3.
          CHECKPOINT_OBJECT_STORE:
            process.env.CHECKPOINT_OBJECT_STORE ?? "disabled",
          DATABASE_URL: databaseUrl,
          EXECUTION_SLOT_LIMIT: "10",
          MAX_TURN_SECONDS: "3600",
          PROVIDER_MAX_RETRIES: "2",
          QUEUED_INPUT_LIMIT_PER_SESSION: "20",
          SESSION_COST_LIMIT_USD: "25",
          STORAGE_LIMIT_BYTES: "1073741824",
          PORT: "0",
          PLATFORM_CONFIG_DIR: await configDir(root, "valid"),
          INTEGRATION_PROVIDER_KEY: PROVIDER_KEY,
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      // Drain both pipes from the start so a chatty server never blocks on a
      // full pipe, and so the same text serves the failure message and the
      // leak assertion below.
      const stdout = serverStdout(server.stdout);
      const serverStderr = new Response(server.stderr).text();
      let exitCode: number | undefined;

      try {
        const { port, response: accepted } = await waitForServer(
          server,
          stdout,
          serverStderr,
          {
            path: "/v1",
            headers: { Authorization: `Bearer ${plaintext}` },
          },
        );
        expect(accepted.status).toBe(200);
        expect(await accepted.json()).toEqual({
          status: "ok",
          owner_id: ownerId,
        });

        const rejected = await fetch(`http://127.0.0.1:${port}/v1`, {
          headers: { Authorization: "Bearer wrong" },
        });
        expect(rejected.status).toBe(401);
        const forged = await fetch(`http://127.0.0.1:${port}/v1`, {
          headers: { "X-Owner-Id": "forged-owner" },
        });
        expect(forged.status).toBe(401);

        const call = (
          key: string,
          method: string,
          path: string,
          body?: unknown,
        ) =>
          fetch(`http://127.0.0.1:${port}/v1${path}`, {
            method,
            headers: {
              Authorization: `Bearer ${key}`,
              "Content-Type": "application/json",
              "Idempotency-Key": crypto.randomUUID(),
            },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          });

        // The catalog is what the file says: an id it does not register is
        // 422, and a registered pair is accepted.
        for (const body of [
          { profile_id: "missing", repository_id: "app", message: "hi" },
          { profile_id: "coding", repository_id: "missing", message: "hi" },
        ]) {
          const unknown = await call(plaintext, "POST", "/sessions", body);
          expect(unknown.status, JSON.stringify(body)).toBe(422);
        }
        const created = await call(plaintext, "POST", "/sessions", {
          profile_id: "coding",
          repository_id: "app",
          message: "hi",
        });
        expect(created.status).toBe(201);
        const { session_id: sessionId } = (await created.json()) as {
          session_id: string;
        };

        // A key without the scope is refused before anything is read or
        // changed (94S-140): sessions:recover is its own scope, which
        // sessions:write does not include.
        const before = await (
          await call(readOnly, "GET", `/sessions/${sessionId}`)
        ).json();
        const decision = {
          decision: "close",
          reason: "integration",
        };
        for (const key of [readOnly, plaintext]) {
          const refused = await call(
            key,
            "POST",
            `/sessions/${sessionId}/recovery-decisions`,
            decision,
          );
          expect(refused.status).toBe(403);
          expect(await refused.json()).toMatchObject({
            error: { code: "FORBIDDEN" },
          });
        }
        const writeWithoutScope = await call(readOnly, "POST", "/sessions", {
          profile_id: "coding",
          repository_id: "app",
          message: "hi",
        });
        expect(writeWithoutScope.status).toBe(403);
        expect(
          await (await call(readOnly, "GET", `/sessions/${sessionId}`)).json(),
        ).toEqual(before);
        // The same request with the scope gets past the policy to the
        // service, which judges the session itself.
        const admitted = await call(
          owner,
          "POST",
          `/sessions/${sessionId}/recovery-decisions`,
          decision,
        );
        expect(admitted.status).not.toBe(403);
        expect(admitted.status).toBeLessThan(500);

        // 94S-321: the operator command revokes one key; the server has no
        // key cache, so the very next request with it is 401 and the other
        // keys of the same owner keep working.
        const revoked = await keysCli("revoke", readOnlyId);
        expect(revoked.exitCode, revoked.stderr).toBe(0);
        expect(revoked.stdout).toStartWith(`revoked ${readOnlyId} `);
        expect(
          (await call(readOnly, "GET", `/sessions/${sessionId}`)).status,
        ).toBe(401);
        expect(
          (await call(plaintext, "GET", `/sessions/${sessionId}`)).status,
        ).toBe(200);
        const again = await keysCli("revoke", readOnlyId);
        expect(again.exitCode, again.stderr).toBe(0);
        expect(again.stdout).toStartWith(`already_revoked ${readOnlyId} `);
        const missing = await keysCli("revoke", crypto.randomUUID());
        expect(missing.exitCode).toBe(1);
        expect(missing.stderr).toContain("not found");

        // The operator's execution revocation: the session stops, and its
        // owner, whose key still works, cannot bring it back.
        const grant = await grantsCli(
          "revoke",
          sessionId,
          "--reason",
          "integration",
        );
        expect(grant.exitCode, grant.stderr).toBe(0);
        expect(grant.stdout).toStartWith(`revoked ${sessionId} `);
        expect(grant.stdout).toContain("receipt_status=succeeded");
        const stopped = (await (
          await call(owner, "GET", `/sessions/${sessionId}`)
        ).json()) as { admission_state: string; revision: number };
        expect(stopped.admission_state).toBe("stopped");
        const resumed = await call(
          owner,
          "POST",
          `/sessions/${sessionId}/resume`,
          { expected_revision: stopped.revision },
        );
        expect(resumed.status).toBe(403);
        expect(await resumed.json()).toMatchObject({
          error: { code: "FORBIDDEN" },
        });
        const restored = await grantsCli(
          "restore",
          sessionId,
          "--reason",
          "integration",
        );
        expect(restored.exitCode, restored.stderr).toBe(0);
        expect(restored.stdout).toStartWith(`restored ${sessionId} `);
      } finally {
        server.kill("SIGTERM");
        exitCode = await server.exited;
      }

      const logs = `${await stdout.text}${await serverStderr}`;
      // SIGTERM is a clean stop: readiness first, pools last (shutdown.ts).
      expect(exitCode, logs).toBe(0);
      const order = [
        "Shutdown started; readiness withdrawn",
        "Stopped accepting connections",
        "In-flight requests drained",
        "Connections closed; exiting",
      ].map((message) => logs.indexOf(message));
      expect(
        order.every((at) => at >= 0),
        logs,
      ).toBe(true);
      expect(order).toEqual([...order].sort((a, b) => a - b));
      expect(logs).not.toContain(plaintext);
      expect(logs).not.toContain("Authorization");
      expect(logs).not.toContain(PROVIDER_KEY);
      expect(logs).toContain("Session catalog loaded");
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "an invalid profile, an unresolved credential or a bad HEARTBEAT_TTL_SEC stops the server",
    async () => {
      const invalid = await refusedStart({
        PLATFORM_CONFIG_DIR: await configDir(
          root,
          "invalid",
          PROFILES.replace("permission_mode: default", "permission_mode: yolo"),
        ),
      });
      expect(invalid.exitCode).not.toBe(0);
      expect(invalid.stderr).toContain("profiles.coding.permission_mode");

      const unresolved = await refusedStart({
        PLATFORM_CONFIG_DIR: await configDir(root, "unresolved"),
        INTEGRATION_PROVIDER_KEY: "",
      });
      expect(unresolved.exitCode).not.toBe(0);
      expect(unresolved.stderr).toContain(
        "profiles.coding.provider.auth.value_env: INTEGRATION_PROVIDER_KEY is not set",
      );

      const ttl = await refusedStart({
        PLATFORM_CONFIG_DIR: await configDir(root, "ttl"),
        HEARTBEAT_TTL_SEC: "30s",
      });
      expect(ttl.exitCode).not.toBe(0);
      expect(ttl.stderr).toContain(
        "HEARTBEAT_TTL_SEC must be a number of seconds above 20",
      );
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "refuses to start on API settings that used to become defaults, naming each (94S-389)",
    async () => {
      const refused = await refusedStart({
        PLATFORM_CONFIG_DIR: await configDir(root, "settings"),
        AUTH_MODE: "none",
        EGRESS_AUTHORIZER_PORT: "0",
        EGRESS_AUTHORIZER_TOKEN: "t".repeat(32),
        HEARTBEAT_TTL_SEC: "10",
        LOG_LEVEL: "inf0",
        PENDING_REQUEST_TTL_SEC: "0",
        SSE_MAX_STREAMS: "25O",
      });
      expect(refused.exitCode, refused.stderr).not.toBe(0);
      expect(refused.stderr).toContain(
        "Refusing to start: API settings are invalid",
      );
      for (const name of [
        "AUTH_MODE=none",
        "HEARTBEAT_TTL_SEC",
        "LOG_LEVEL",
        "PENDING_REQUEST_TTL_SEC",
        "SSE_MAX_STREAMS",
      ]) {
        expect(refused.stderr).toContain(name);
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "refuses to start on missing or malformed installation limits, naming each (94S-131)",
    async () => {
      const server = Bun.spawn(["bun", "run", "src/main.ts", "api"], {
        cwd: `${import.meta.dir}/../..`,
        env: {
          ...process.env,
          AUTH_MODE: "api-key",
          DATABASE_URL: databaseUrl,
          EXECUTION_SLOT_LIMIT: "10",
          MAX_TURN_SECONDS: "3600",
          PROVIDER_MAX_RETRIES: "",
          QUEUED_INPUT_LIMIT_PER_SESSION: "20",
          // Blank counts as missing, and overrides whatever the runner has.
          SESSION_COST_LIMIT_USD: "",
          STORAGE_LIMIT_BYTES: "-1",
          PORT: "0",
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      const output = Promise.all([
        new Response(server.stdout).text(),
        new Response(server.stderr).text(),
      ]).then((parts) => parts.join(""));
      const exitCode = await Promise.race([
        server.exited,
        Bun.sleep(SERVER_START_DEADLINE_MS).then(() => {
          server.kill("SIGKILL");
          return "timeout" as const;
        }),
      ]);
      const logs = await output;
      expect(exitCode, logs).not.toBe(0);
      expect(exitCode, logs).not.toBe("timeout");
      expect(logs).toContain(
        "Refusing to start: installation limits are invalid",
      );
      expect(logs).toContain("SESSION_COST_LIMIT_USD is required");
      expect(logs).toContain("PROVIDER_MAX_RETRIES is required");
      expect(logs).toContain("STORAGE_LIMIT_BYTES must be an integer");
    },
    TEST_TIMEOUT_MS,
  );
});
