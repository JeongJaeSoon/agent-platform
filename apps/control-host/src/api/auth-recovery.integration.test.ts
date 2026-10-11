import { afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  bootstrapResponseSchema,
  issuePasswordResetResponseSchema,
  passwordResetResponseSchema,
  receiptSchema,
} from "@agent-platform/contracts";
import * as schema from "@agent-platform/db";
import {
  createPostgresSessionControl,
  createPostgresSessionReader,
  createPostgresSessionUnitOfWork,
  memberships,
  passwordResets,
  receipts,
  users,
  webSessions,
} from "@agent-platform/db";
import { MemoryLogSink, StructuredLogger } from "@agent-platform/observability";
import { allowAllPolicy, createSessionService } from "@agent-platform/platform";
import { createTempDatabase, type TempDatabase } from "@agent-platform/testkit";
import { eq, isNull } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { createApiApp } from "./app.ts";
import {
  createBootstrapGate,
  DatabaseIdentityStore,
  hashPassword,
  hashWebSessionToken,
  LoginLockout,
} from "./auth.ts";
import { registerAuthRoutes, registerPublicAuthRoutes } from "./routes/auth.ts";
import { registerReceiptRoutes } from "./routes/receipts.ts";

const integration = process.env.QUEUE_DATABASE_URL ? describe : describe.skip;

const INSTALL_TOKEN = "integration-install-token-0123456789abc";
const RECOVERY_TOKEN = "integration-recovery-token-0123456789ab";
const PASSWORD = "an adequately long password";
const NEW_PASSWORD = "a different adequately long password";
const BROWSER = { "X-Requested-With": "agent-platform-web" };

integration("account recovery on PostgreSQL", () => {
  const opened: Array<{ pool: Pool; database: TempDatabase }> = [];

  afterEach(async () => {
    for (const { pool, database } of opened.splice(0)) {
      await pool.end();
      await database.drop();
    }
  });

  async function install() {
    const database = await createTempDatabase({ prefix: "recovery" });
    const pool = new Pool({ connectionString: database.url, max: 8 });
    opened.push({ pool, database });
    const db: NodePgDatabase<typeof schema> = drizzle(pool, { schema });
    const sink = new MemoryLogSink();
    // One process per token: an operator recovers by restarting the API
    // with a new BOOTSTRAP_TOKEN.
    const start = (bootstrapToken: string) => {
      const identity = new DatabaseIdentityStore(db);
      const logger = new StructuredLogger({ sinks: [sink] });
      const auth = {
        identity,
        bootstrap: createBootstrapGate(bootstrapToken),
        recoveryLockout: new LoginLockout(),
        logger,
      };
      const app = createApiApp({
        authMode: "api-key",
        logger,
        identity,
        registerPublicRoutes: (router) =>
          registerPublicAuthRoutes(router, auth),
        registerRoutes: (router) => {
          registerAuthRoutes(router, auth);
          // Only the receipt read is exercised; the session ports are unused.
          registerReceiptRoutes(
            router,
            createSessionService({
              limits: {
                queuedInputLimitPerSession: 1,
                storageLimitBytes: 1,
                sessionCostLimitUsd: 1,
                sessionTokenLimit: null,
              },
              authorization: allowAllPolicy,
              inputs: createPostgresSessionUnitOfWork(db),
              controls: createPostgresSessionControl(db),
              reader: createPostgresSessionReader(db),
              catalog: { profiles: {}, repositories: {} },
            }),
          );
        },
      });
      const json = (path: string, body: unknown, headers: HeadersInit = {}) =>
        app.request(path, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...headers },
          body: JSON.stringify(body),
        });
      return {
        app,
        json,
        bootstrap: (email = "Owner@Example.com") =>
          json("/v1/auth/bootstrap", {
            bootstrap_token: bootstrapToken,
            email,
            password: PASSWORD,
            display_name: "Owner",
            workspace_name: "Acme",
            workspace_slug: "acme",
          }),
        login: async (email: string, password = PASSWORD) =>
          json("/v1/auth/login", { email, password }, BROWSER),
      };
    };
    const first = start(INSTALL_TOKEN);
    const created = await first.bootstrap();
    expect(created.status).toBe(201);
    const { user_id: ownerId, workspace } = bootstrapResponseSchema.parse(
      await created.json(),
    );
    const memberId = randomUUID();
    await db.insert(users).values({
      id: memberId,
      email: "member@example.com",
      passwordHash: await hashPassword(PASSWORD),
      displayName: "Member",
    });
    await db.insert(memberships).values({
      workspaceId: workspace.id,
      userId: memberId,
      role: "member",
    });
    return { db, sink, start, first, ownerId, memberId, workspace };
  }

  const cookieOf = (response: Response) =>
    (response.headers.get("Set-Cookie") ?? "").split(";")[0] ?? "";

  test("reset link: old cookie 401, new password logs in, the token works once", async () => {
    const { db, sink, first, ownerId, memberId, workspace } = await install();
    const ownerCookie = cookieOf(await first.login("owner@example.com"));
    const memberCookie = cookieOf(await first.login("member@example.com"));
    const otherMemberCookie = cookieOf(await first.login("member@example.com"));

    const issued = await first.app.request(
      `/v1/workspaces/${workspace.id}/members/${memberId}/password-reset`,
      { method: "POST", headers: { Cookie: ownerCookie, ...BROWSER } },
    );
    expect(issued.status).toBe(201);
    const { token, expires_at } = issuePasswordResetResponseSchema.parse(
      await issued.json(),
    );
    const [stored] = await db.select().from(passwordResets);
    expect(Buffer.from(stored?.tokenHash ?? []).toString("hex")).toBe(
      Buffer.from(hashWebSessionToken(token)).toString("hex"),
    );
    expect(stored?.issuedBy).toBe(ownerId);
    const ttl = (stored?.expiresAt.getTime() ?? 0) - Date.now();
    expect(ttl).toBeGreaterThan(59 * 60 * 1000);
    expect(ttl).toBeLessThanOrEqual(60 * 60 * 1000);
    expect(new Date(expires_at)).toEqual(stored?.expiresAt ?? new Date(0));

    // Both redemptions race; the row lock lets exactly one through.
    const [a, b] = await Promise.all([
      first.json("/v1/auth/password-reset", { token, password: NEW_PASSWORD }),
      first.json("/v1/auth/password-reset", {
        token,
        password: "a third adequately long password",
      }),
    ]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([200, 401]);
    const winner = a.status === 200 ? a : b;
    const winningPassword =
      a.status === 200 ? NEW_PASSWORD : "a third adequately long password";
    const body = passwordResetResponseSchema.parse(await winner.json());
    expect(body.user_id).toBe(memberId);

    for (const cookie of [memberCookie, otherMemberCookie]) {
      const me = await first.app.request("/v1/auth/me", {
        headers: { Cookie: cookie },
      });
      expect(me.status).toBe(401);
    }
    const liveMember = await db
      .select()
      .from(webSessions)
      .where(eq(webSessions.userId, memberId));
    expect(liveMember.every((row) => row.revokedAt !== null)).toBe(true);
    // Only the user's sessions end; the owner's stays.
    const ownerMe = await first.app.request("/v1/auth/me", {
      headers: { Cookie: ownerCookie },
    });
    expect(ownerMe.status).toBe(200);

    expect((await first.login("member@example.com")).status).toBe(401);
    expect(
      (await first.login("member@example.com", winningPassword)).status,
    ).toBe(200);

    const third = await first.json("/v1/auth/password-reset", {
      token,
      password: "a fourth adequately long password",
    });
    expect(third.status).toBe(401);

    const [receipt] = await db
      .select()
      .from(receipts)
      .where(eq(receipts.id, body.receipt_id));
    expect(receipt).toMatchObject({
      ownerId: workspace.id,
      operation: "reset_password",
      targetRef: { user_id: memberId, workspace_id: workspace.id },
      status: "succeeded",
      result: { issued_by: ownerId, sessions_revoked: 2 },
    });
    const read = await first.app.request(`/v1/receipts/${body.receipt_id}`, {
      headers: { Cookie: ownerCookie },
    });
    expect(read.status).toBe(200);
    expect(receiptSchema.parse(await read.json()).target_ref).toEqual({
      user_id: memberId,
      workspace_id: workspace.id,
    });
    expect(JSON.stringify(sink.records)).not.toContain(token);
  });

  for (const how of ["account", "membership"] as const) {
    test(`owner ${how} disabled: a new BOOTSTRAP_TOKEN restores the owner, ends every session, then 409`, async () => {
      const { db, start, first, ownerId, memberId, workspace } =
        await install();
      await first.login("owner@example.com");
      await first.login("member@example.com");

      // A live owner exists: done.
      const early = start(RECOVERY_TOKEN);
      expect((await early.bootstrap()).status).toBe(409);

      if (how === "account") {
        await db
          .update(users)
          .set({ disabledAt: new Date() })
          .where(eq(users.id, ownerId));
      } else {
        await db
          .update(memberships)
          .set({ disabledAt: new Date() })
          .where(eq(memberships.userId, ownerId));
      }

      // The install token is spent in the database, so a restart that
      // still carries it cannot reopen recovery.
      const stale = start(INSTALL_TOKEN);
      const refused = await stale.bootstrap();
      expect(refused.status).toBe(401);

      const recovery = start(RECOVERY_TOKEN);
      const restored = await recovery.bootstrap();
      expect(restored.status).toBe(201);
      const body = bootstrapResponseSchema.parse(await restored.json());
      expect(body.user_id).toBe(ownerId);
      expect(body.workspace.id).toBe(workspace.id);
      expect(await db.$count(schema.workspaces)).toBe(1);
      const [owner] = await db
        .select()
        .from(users)
        .where(eq(users.id, ownerId));
      expect(owner?.disabledAt).toBeNull();
      const [membership] = await db
        .select()
        .from(memberships)
        .where(eq(memberships.userId, ownerId));
      expect(membership).toMatchObject({ role: "owner", disabledAt: null });
      expect(await db.$count(webSessions, isNull(webSessions.revokedAt))).toBe(
        0,
      );

      const [receipt] = await db
        .select()
        .from(receipts)
        .where(eq(receipts.operation, "recover_owner"));
      expect(receipt).toMatchObject({
        ownerId: workspace.id,
        targetRef: {
          resource: { kind: "workspace", id: workspace.id },
          workspace_id: workspace.id,
        },
        status: "succeeded",
        result: { user_id: ownerId, existing_user: true, sessions_revoked: 2 },
      });
      expect(
        receiptSchema.shape.target_ref.safeParse(receipt?.targetRef).success,
      ).toBe(true);

      // The member was not promoted, and with a live owner again it is done.
      const [member] = await db
        .select()
        .from(memberships)
        .where(eq(memberships.userId, memberId));
      expect(member?.role).toBe("member");
      const again = start(`${RECOVERY_TOKEN}-other`);
      const done = await again.bootstrap();
      expect(done.status).toBe(409);
      expect((await done.json()).error.code).toBe("BOOTSTRAP_DONE");
      expect((await recovery.login("owner@example.com")).status).toBe(200);
    });
  }

  test("recovery with a new email adds a second owner to the existing workspace", async () => {
    const { db, start, ownerId, workspace } = await install();
    await db
      .update(users)
      .set({ disabledAt: new Date() })
      .where(eq(users.id, ownerId));
    const recovery = start(RECOVERY_TOKEN);
    const restored = await recovery.bootstrap("rescuer@example.com");
    expect(restored.status).toBe(201);
    const body = bootstrapResponseSchema.parse(await restored.json());
    expect(body.user_id).not.toBe(ownerId);
    expect(body.workspace.id).toBe(workspace.id);
    const [membership] = await db
      .select()
      .from(memberships)
      .where(eq(memberships.userId, body.user_id));
    expect(membership).toMatchObject({
      workspaceId: workspace.id,
      role: "owner",
    });
    // The disabled owner stays disabled; recovery does not resurrect it.
    const [old] = await db.select().from(users).where(eq(users.id, ownerId));
    expect(old?.disabledAt).not.toBeNull();
  });

  test("the sixth failed reset is 429 against the real store", async () => {
    const { first } = await install();
    for (let i = 0; i < 5; i += 1) {
      const guess = await first.json("/v1/auth/password-reset", {
        token: `apr_guess-${i}`,
        password: NEW_PASSWORD,
      });
      expect(guess.status).toBe(401);
    }
    const locked = await first.json("/v1/auth/password-reset", {
      token: "apr_guess-6",
      password: NEW_PASSWORD,
    });
    expect(locked.status).toBe(429);
  });
});
