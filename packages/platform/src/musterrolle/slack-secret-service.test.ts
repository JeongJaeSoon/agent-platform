import { describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { scopesForRole, type WorkspaceRole } from "@werft-ai/contracts";
import {
  type SecretSlot,
  type SecretStore,
  type SecretSummary,
  secretOwnerRef,
} from "../ports/secret-store.ts";
import { lastFour } from "../secrets/secret-cipher.ts";
import { SessionServiceError } from "../sessions/session-service.ts";
import {
  type AgentAuthority,
  type Caller,
  callerFor,
  createAuthorizationPolicy,
} from "./policy.ts";
import {
  createSlackSecretService,
  type SlackAppKind,
} from "./slack-secret-service.ts";

const WORKSPACE = "019a0000-0000-7000-8000-0000000000f1";
const OTHER_WORKSPACE = "019a0000-0000-7000-8000-0000000000f2";
const OWNER = "019a0000-0000-7000-8000-0000000000a1";
const KEY = "019a0000-0000-7000-8000-0000000000e1";
const APP = "019a0000-0000-7000-8000-00000000a991";
// Made per run: a fixed token-shaped string has no place in a file.
const VALUE = `xoxe-1-${randomBytes(24).toString("hex")}`;
const LAST4 = VALUE.slice(-4);
const READ = async () => VALUE;
const UNREAD = async (): Promise<string> => {
  throw new Error("the body was read for a refused caller");
};

const agents: AgentAuthority = {
  agentOf: async () => null,
  isAdmin: async () => false,
};

function user(
  role: WorkspaceRole,
  surface: "web" | "api" = "web",
  workspace = WORKSPACE,
): Caller {
  return callerFor(
    {
      kind: "user",
      id: OWNER,
      workspace_id: workspace,
      role,
      scopes: [...scopesForRole(role)],
    },
    { kind: surface },
    crypto.randomUUID(),
  );
}

const key = callerFor(
  {
    kind: "api_key",
    id: KEY,
    owner_id: WORKSPACE,
    workspace_id: WORKSPACE,
    scopes: ["sessions:read", "sessions:write"],
  },
  { kind: "api" },
  crypto.randomUUID(),
  { creatorId: OWNER },
);

function memoryStore() {
  const values = new Map<string, { value: string; summary: SecretSummary }>();
  const receipts: string[] = [];
  const slotKey = (slot: SecretSlot) =>
    `${slot.workspaceId}|${secretOwnerRef(slot.owner)}|${slot.purpose}`;
  const store: SecretStore = {
    describe: async (slot) => values.get(slotKey(slot))?.summary ?? null,
    get: async (slot) => values.get(slotKey(slot))?.value ?? null,
    put: async (slot, value, options) => {
      const previous = values.get(slotKey(slot));
      const summary: SecretSummary = {
        last4: lastFour(value),
        secretVersion: (previous?.summary.secretVersion ?? 0) + 1,
        updatedAt: new Date("2026-10-23T00:00:00.000Z"),
        updatedBy: { userId: OWNER, displayName: "Owner" },
      };
      values.set(slotKey(slot), { value, summary });
      if (options?.audit) receipts.push(options.audit.receiptId);
      return { outcome: "stored", summary };
    },
    rotate: async () => null,
    delete: async (slot, options) => {
      const previous = values.get(slotKey(slot));
      if (!previous) return { outcome: "not_found" };
      values.delete(slotKey(slot));
      if (options?.audit) receipts.push(options.audit.receiptId);
      return { outcome: "deleted", last4: previous.summary.last4 };
    },
  };
  return { store, values, receipts };
}

function serviceWith(
  options: { store?: SecretStore | null; appKind?: SlackAppKind | null } = {},
) {
  const memory = memoryStore();
  const service = createSlackSecretService({
    authorization: createAuthorizationPolicy({ agents }),
    store: options.store === undefined ? memory.store : options.store,
    ...(options.appKind === undefined
      ? {}
      : { appKind: async () => options.appKind ?? null }),
  });
  return { service, memory };
}

async function refusal(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    if (error instanceof SessionServiceError) {
      expect(error.message).not.toContain(VALUE);
      return { code: error.code, details: error.details };
    }
    throw error;
  }
  throw new Error("expected a refusal");
}

describe("Slack secret service", () => {
  test.each(["owner", "admin"] as const)(
    "an %s in a console session sets, reads back the last four and deletes",
    async (role) => {
      const { service, memory } = serviceWith();
      const caller = user(role);
      const set = await service.setConfigToken(caller, WORKSPACE, READ);
      expect(set).toMatchObject({ configured: true, last4: LAST4 });
      expect(JSON.stringify(set)).not.toContain(VALUE);
      const read = await service.describeConfigToken(caller, WORKSPACE);
      expect(read).toEqual({
        configured: true,
        last4: LAST4,
        updated_at: "2026-10-23T00:00:00.000Z",
        updated_by: { user_id: OWNER, display_name: "Owner" },
      });
      const deleted = await service.deleteConfigToken(caller, WORKSPACE);
      expect(memory.receipts).toEqual([set.receipt_id, deleted.receipt_id]);
      expect(await service.describeConfigToken(caller, WORKSPACE)).toEqual({
        configured: false,
        last4: null,
        updated_at: null,
        updated_by: null,
      });
    },
  );

  test("a member is refused before anything is read or written", async () => {
    const { service, memory } = serviceWith();
    for (const attempt of [
      service.setConfigToken(user("member"), WORKSPACE, UNREAD),
      service.describeConfigToken(user("member"), WORKSPACE),
      service.deleteConfigToken(user("member"), WORKSPACE),
    ]) {
      expect((await refusal(attempt)).code).toBe("FORBIDDEN");
    }
    expect(memory.values.size).toBe(0);
  });

  test("an API key, or an owner calling on a key's surface, is refused", async () => {
    const { service, memory } = serviceWith();
    expect(
      (await refusal(service.setConfigToken(key, WORKSPACE, UNREAD))).code,
    ).toBe("FORBIDDEN");
    expect(
      await refusal(
        service.setConfigToken(user("owner", "api"), WORKSPACE, READ),
      ),
    ).toEqual({
      code: "FORBIDDEN",
      details: { reason_code: "web_session_required" },
    });
    expect(memory.values.size).toBe(0);
  });

  test("an owner of another workspace finds nothing", async () => {
    const { service } = serviceWith();
    const caller = user("owner", "web", OTHER_WORKSPACE);
    expect(
      (await refusal(service.setConfigToken(caller, WORKSPACE, READ))).code,
    ).toBe("NOT_FOUND");
  });

  test("without a master key the API answers unavailable", async () => {
    const { service } = serviceWith({ store: null });
    expect(
      (await refusal(service.describeConfigToken(user("owner"), WORKSPACE)))
        .code,
    ).toBe("BACKEND_UNAVAILABLE");
  });

  test("deleting what was never set is not found", async () => {
    const { service } = serviceWith();
    expect(
      (await refusal(service.deleteConfigToken(user("owner"), WORKSPACE))).code,
    ).toBe("NOT_FOUND");
  });

  test.each(["agent", "link"] as const)(
    "a person cannot write the secrets of an app the platform created (%s)",
    async (kind) => {
      const { service, memory } = serviceWith({ appKind: kind });
      expect(
        await refusal(
          service.setAppSecret(
            user("owner"),
            WORKSPACE,
            APP,
            "slack_signing_secret",
            UNREAD,
          ),
        ),
      ).toEqual({
        code: "FORBIDDEN",
        details: { reason_code: "server_managed_secret" },
      });
      expect(memory.values.size).toBe(0);
    },
  );

  test("a manual app's secret is set on that app alone", async () => {
    const { service, memory } = serviceWith({ appKind: "manual" });
    await service.setAppSecret(
      user("owner"),
      WORKSPACE,
      APP,
      "slack_signing_secret",
      READ,
    );
    expect([...memory.values.keys()]).toEqual([
      `${WORKSPACE}|slack_app:${APP}|slack_signing_secret`,
    ]);
  });

  test("an unknown app, or no app registry yet, is not found", async () => {
    for (const options of [{ appKind: null }, {}]) {
      const { service } = serviceWith(options);
      const attempt = service.setAppSecret(
        user("owner"),
        WORKSPACE,
        APP,
        "slack_bot_token",
        READ,
      );
      expect((await refusal(attempt)).code).toBe("NOT_FOUND");
    }
  });
});
