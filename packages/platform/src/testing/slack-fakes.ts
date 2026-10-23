/**
 * In-memory stand-ins for the Slack app stores and the App Configuration
 * API, for unit and route tests. They keep the stores' contracts (the lease,
 * `creating` before the call, secrets sealed with the record) so a test of
 * the service exercises the same outcomes the Postgres stores give.
 */
import { randomBytes } from "node:crypto";
import type { SlackAppSecretPurpose } from "@werft-ai/contracts";
import type {
  CreatedSlackApp,
  RotatedConfigToken,
  SlackConfigApi,
} from "../musterrolle/slack-config-api.ts";
import { SlackApiError } from "../musterrolle/slack-config-api.ts";
import {
  type SecretAudit,
  type SecretSlot,
  type SecretStore,
  type SecretSummary,
  secretOwnerRef,
} from "../ports/secret-store.ts";
import type {
  SlackAppAgent,
  SlackAppRecord,
  SlackAppStore,
} from "../ports/slack-app-store.ts";
import type {
  ConfigTokenSummary,
  SlackConfigTokenStore,
} from "../ports/slack-config-token-store.ts";
import { lastFour } from "../secrets/secret-cipher.ts";

/** Token-shaped values are made per run, never written into a file. */
export function fakeSlackValue(prefix: string): string {
  return `${prefix}-${randomBytes(20).toString("hex")}`;
}

const STAMP = new Date("2026-10-23T00:00:00.000Z");

export function createMemorySecretStore() {
  const values = new Map<string, { value: string; summary: SecretSummary }>();
  const receipts: { id: string; purpose: string; last4: string }[] = [];
  const slotKey = (slot: SecretSlot) =>
    `${slot.workspaceId}|${secretOwnerRef(slot.owner)}|${slot.purpose}`;
  const write = (slot: SecretSlot, value: string, audit?: SecretAudit) => {
    const previous = values.get(slotKey(slot));
    const summary: SecretSummary = {
      last4: lastFour(value),
      secretVersion: (previous?.summary.secretVersion ?? 0) + 1,
      updatedAt: STAMP,
      updatedBy: audit
        ? { userId: audit.principal.actor?.userId ?? "", displayName: "Owner" }
        : null,
    };
    values.set(slotKey(slot), { value, summary });
    if (audit) {
      receipts.push({
        id: audit.receiptId,
        purpose: slot.purpose,
        last4: summary.last4,
      });
    }
    return summary;
  };
  const store: SecretStore = {
    describe: async (slot) => values.get(slotKey(slot))?.summary ?? null,
    get: async (slot) => values.get(slotKey(slot))?.value ?? null,
    put: async (slot, value, options) => ({
      outcome: "stored",
      summary: write(slot, value, options?.audit),
    }),
    delete: async (slot, options) => {
      const previous = values.get(slotKey(slot));
      if (!previous) return { outcome: "not_found" };
      values.delete(slotKey(slot));
      if (options?.audit) {
        receipts.push({
          id: options.audit.receiptId,
          purpose: slot.purpose,
          last4: previous.summary.last4,
        });
      }
      return { outcome: "deleted", last4: previous.summary.last4 };
    },
  };
  return { store, values, receipts, write, slotKey };
}

export type MemorySecrets = ReturnType<typeof createMemorySecretStore>;

type TokenMeta = {
  state: "active" | "needs_reentry";
  accessExpiresAt: Date | null;
  issuerUserId: string | null;
  issuerTeamId: string | null;
  lease: { id: string; until: Date } | null;
};

const configSlot = (workspaceId: string): SecretSlot => ({
  workspaceId,
  owner: { kind: "workspace" },
  purpose: "slack_config_token",
});

/** Sealed as one value, as the Postgres store does. */
export const encodeConfigTokenPair = (access: string, refresh: string) =>
  `${access}\n${refresh}`;

export function createMemoryConfigTokenStore(secrets: MemorySecrets) {
  const meta = new Map<string, TokenMeta>();
  /** Throw from `complete` this many more times. */
  const faults = { complete: 0 };
  const pair = (workspaceId: string) => {
    const raw = secrets.values.get(secrets.slotKey(configSlot(workspaceId)));
    if (!raw) return null;
    const [access_token = "", refresh_token = ""] = raw.value.split("\n");
    return { access_token, refresh_token };
  };
  const summaryOf = (workspaceId: string): ConfigTokenSummary => {
    const row = meta.get(workspaceId);
    const secret =
      secrets.values.get(secrets.slotKey(configSlot(workspaceId)))?.summary ??
      null;
    if (!row || (row.issuerUserId === null && secret === null)) {
      return { state: "unset", secret: null, expiresAt: null, issuer: null };
    }
    return {
      state: row.state,
      secret,
      expiresAt: row?.state === "active" ? row.accessExpiresAt : null,
      issuer:
        row?.state === "active" && row.issuerUserId && row.issuerTeamId
          ? { userId: row.issuerUserId, teamId: row.issuerTeamId }
          : null,
    };
  };
  const invalidate = (workspaceId: string) => {
    const row = meta.get(workspaceId);
    if (row) Object.assign(row, { state: "needs_reentry", lease: null });
    secrets.values.delete(secrets.slotKey(configSlot(workspaceId)));
  };

  const store: SlackConfigTokenStore = {
    async claim(workspaceId, clock) {
      const row = meta.get(workspaceId);
      if (!row) return { outcome: "not_set" };
      if (row.state === "needs_reentry") return { outcome: "needs_reentry" };
      const current = pair(workspaceId);
      if (!current) return { outcome: "not_set" };
      if (
        row.accessExpiresAt !== null &&
        row.issuerUserId !== null &&
        row.accessExpiresAt > clock.freshUntil
      ) {
        return {
          outcome: "fresh",
          accessToken: current.access_token,
          issuerUserId: row.issuerUserId,
        };
      }
      if (row.lease !== null) {
        if (row.lease.until > clock.now) {
          return { outcome: "busy", until: row.lease.until };
        }
        invalidate(workspaceId);
        return { outcome: "needs_reentry" };
      }
      row.lease = { id: crypto.randomUUID(), until: clock.leaseUntil };
      return {
        outcome: "claimed",
        leaseId: row.lease.id,
        refreshToken: current.refresh_token,
      };
    },
    async claimForReplace(workspaceId, clock) {
      const row = meta.get(workspaceId) ?? {
        state: "needs_reentry",
        accessExpiresAt: null,
        issuerUserId: null,
        issuerTeamId: null,
        lease: null,
      };
      meta.set(workspaceId, row);
      if (row.lease !== null && row.lease.until > clock.now) {
        return { outcome: "busy", until: row.lease.until };
      }
      row.lease = { id: crypto.randomUUID(), until: clock.leaseUntil };
      return { outcome: "claimed", leaseId: row.lease.id };
    },
    async complete(workspaceId, leaseId, rotated, audit) {
      if (faults.complete > 0) {
        faults.complete -= 1;
        throw new Error("injected write failure");
      }
      const row = meta.get(workspaceId);
      if (!row || row.lease?.id !== leaseId) return { outcome: "lease_lost" };
      const previous = row.issuerUserId;
      secrets.write(
        configSlot(workspaceId),
        encodeConfigTokenPair(rotated.accessToken, rotated.refreshToken),
        audit,
      );
      Object.assign(row, {
        state: "active",
        accessExpiresAt: rotated.expiresAt,
        issuerUserId: rotated.issuerUserId,
        issuerTeamId: rotated.issuerTeamId,
        lease: null,
      });
      return {
        outcome: "stored",
        summary: summaryOf(workspaceId),
        previousIssuerUserId:
          previous !== null && previous !== rotated.issuerUserId
            ? previous
            : null,
      };
    },
    async release(workspaceId, leaseId) {
      const row = meta.get(workspaceId);
      if (row?.lease?.id === leaseId) row.lease = null;
    },
    async invalidate(workspaceId, leaseId) {
      const row = meta.get(workspaceId);
      if (leaseId !== null && row?.lease?.id !== leaseId) return;
      invalidate(workspaceId);
    },
    async expireAccess(workspaceId, now) {
      const row = meta.get(workspaceId);
      if (row) row.accessExpiresAt = now;
    },
    describe: async (workspaceId) => summaryOf(workspaceId),
    async delete(workspaceId, audit) {
      meta.delete(workspaceId);
      return secrets.store.delete(configSlot(workspaceId), { audit });
    },
  };
  return { store, meta, faults, pair };
}

export function createMemorySlackAppStore(input: {
  secrets: MemorySecrets;
  agents: Map<string, SlackAppAgent & { workspaceId: string; active: boolean }>;
  now?: () => Date;
}) {
  const clock = input.now ?? (() => new Date());
  const rows = new Map<string, Omit<SlackAppRecord, "secrets">>();
  const faults = { finishCreate: 0 };
  const LIVE = new Set(["creating", "created", "deleting"]);
  const PURPOSES: SlackAppSecretPurpose[] = [
    "slack_signing_secret",
    "slack_client_secret",
    "slack_bot_token",
  ];
  const slot = (row: { workspaceId: string; id: string }, purpose: string) =>
    ({
      workspaceId: row.workspaceId,
      owner: { kind: "slack_app", id: row.id },
      purpose,
    }) as SecretSlot;
  const record = (row: Omit<SlackAppRecord, "secrets">): SlackAppRecord => ({
    ...row,
    secrets: Object.fromEntries(
      PURPOSES.map((purpose) => [
        purpose,
        input.secrets.values.get(input.secrets.slotKey(slot(row, purpose)))
          ?.summary ?? null,
      ]),
    ) as SlackAppRecord["secrets"],
  });
  const live = (workspaceId: string, agentId: string) =>
    [...rows.values()].find(
      (row) =>
        row.workspaceId === workspaceId &&
        row.agentId === agentId &&
        LIVE.has(row.state),
    );
  const touch = (row: Omit<SlackAppRecord, "secrets">, patch: object) =>
    Object.assign(row, patch, { updatedAt: clock() });

  const store: SlackAppStore = {
    async beginAgentApp(begin) {
      const agent = input.agents.get(begin.agentId);
      if (!agent || agent.workspaceId !== begin.workspaceId) {
        return { outcome: "agent_not_found" };
      }
      const existing = live(begin.workspaceId, begin.agentId);
      if (existing?.state === "created" || existing?.state === "deleting") {
        return { outcome: "exists", app: record(existing) };
      }
      if (existing?.state === "creating") {
        const uncertain = existing.createdAt < begin.staleBefore;
        if (!(uncertain && begin.replaceUncertain)) {
          return { outcome: "creating", app: record(existing), uncertain };
        }
        touch(existing, { state: "abandoned" });
      }
      if (!agent.active) return { outcome: "agent_not_active" };
      const now = clock();
      const row = {
        id: begin.newId,
        workspaceId: begin.workspaceId,
        kind: "agent" as const,
        agentId: begin.agentId,
        state: "creating" as const,
        appId: null,
        clientId: null,
        redirectUrl: begin.redirectUrl,
        createdByTokenUser: null,
        createdAt: now,
        updatedAt: now,
      };
      rows.set(row.id, row);
      return { outcome: "begun", app: record(row), agent };
    },
    async finishCreate(finish) {
      if (faults.finishCreate > 0) {
        faults.finishCreate -= 1;
        throw new Error("injected write failure");
      }
      const row = rows.get(finish.slackAppId);
      if (!row) throw new Error("no such Slack app");
      input.secrets.write(
        slot(row, "slack_signing_secret"),
        finish.created.signingSecret,
      );
      input.secrets.write(
        slot(row, "slack_client_secret"),
        finish.created.clientSecret,
      );
      touch(row, {
        state: "created",
        appId: finish.created.appId,
        clientId: finish.created.clientId,
        createdByTokenUser: finish.tokenUserId,
      });
      return record(row);
    },
    async failCreate(_workspaceId, slackAppId) {
      const row = rows.get(slackAppId);
      if (row?.state === "creating") touch(row, { state: "failed" });
    },
    async find(workspaceId, slackAppId) {
      const row = rows.get(slackAppId);
      return row && row.workspaceId === workspaceId ? record(row) : null;
    },
    async findForAgent(workspaceId, agentId) {
      const row = live(workspaceId, agentId);
      return row ? record(row) : null;
    },
    async lastTokenUser(workspaceId) {
      const made = [...rows.values()]
        .filter((row) => row.workspaceId === workspaceId)
        .filter((row) => row.createdByTokenUser !== null)
        .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
      return made[0]?.createdByTokenUser ?? null;
    },
    async beginDelete({ workspaceId, slackAppId }) {
      const row = rows.get(slackAppId);
      if (!row || row.workspaceId !== workspaceId) {
        return { outcome: "not_found" };
      }
      if (row.state === "creating") {
        return { outcome: "creating", app: record(row) };
      }
      if (row.state !== "created" && row.state !== "deleting") {
        return { outcome: "settled", app: record(row) };
      }
      touch(row, { state: "deleting" });
      return { outcome: "begun", app: record(row) };
    },
    async finishDelete(workspaceId, slackAppId) {
      const row = rows.get(slackAppId);
      if (!row || row.workspaceId !== workspaceId) {
        throw new Error("no such Slack app");
      }
      for (const purpose of PURPOSES) {
        input.secrets.values.delete(input.secrets.slotKey(slot(row, purpose)));
      }
      touch(row, { state: "deleted" });
      return record(row);
    },
  };

  /** A row as a test needs it, e.g. a manual app. */
  function seed(row: Omit<SlackAppRecord, "secrets">) {
    rows.set(row.id, row);
  }
  return { store, rows, faults, seed };
}

type Behaviour<T> = (() => Promise<T>) | undefined;

/**
 * A Slack that answers the App Configuration API from memory. Each refresh
 * token is single-use, as Slack's are believed to be.
 */
export function createFakeSlackConfigApi(options?: {
  userId?: string;
  teamId?: string;
  now?: () => Date;
}) {
  const now = options?.now ?? (() => new Date());
  const state = {
    userId: options?.userId ?? "U0ISSUER",
    teamId: options?.teamId ?? "T0FAKE",
    /** Refresh tokens Slack will take, each once. */
    refreshTokens: new Set<string>(),
    accessTokens: new Set<string>(),
    apps: new Map<string, { manifest: object; clientId: string }>(),
    calls: [] as { method: string; appId?: string }[],
    /** Replace one call's outcome, e.g. to throw a lost answer. */
    next: {} as {
      rotate?: Behaviour<RotatedConfigToken>;
      create?: Behaviour<CreatedSlackApp>;
      delete?: Behaviour<void>;
    },
  };
  let appCounter = 0;
  const issueRefresh = () => {
    const refresh = fakeSlackValue("xoxe-1");
    state.refreshTokens.add(refresh);
    return refresh;
  };
  const requireAccess = (method: string, token: string) => {
    if (!state.accessTokens.has(token)) {
      throw new SlackApiError(method, "invalid_auth", true);
    }
  };

  const api: SlackConfigApi = {
    async rotateConfigToken(refreshToken) {
      state.calls.push({ method: "tooling.tokens.rotate" });
      const behaviour = state.next.rotate;
      if (behaviour) {
        state.next.rotate = undefined;
        return behaviour();
      }
      if (!state.refreshTokens.delete(refreshToken)) {
        throw new SlackApiError(
          "tooling.tokens.rotate",
          "invalid_refresh_token",
          true,
        );
      }
      const accessToken = fakeSlackValue("xoxe.xoxp-1");
      state.accessTokens.add(accessToken);
      return {
        accessToken,
        refreshToken: issueRefresh(),
        expiresAt: new Date(now().getTime() + 12 * 3600_000),
        issuerUserId: state.userId,
        issuerTeamId: state.teamId,
      };
    },
    async createApp(token, manifest) {
      state.calls.push({ method: "apps.manifest.create" });
      requireAccess("apps.manifest.create", token);
      const behaviour = state.next.create;
      if (behaviour) {
        state.next.create = undefined;
        return behaviour();
      }
      appCounter += 1;
      const appId = `A0FAKE${appCounter}`;
      const clientId = `1000.${appCounter}`;
      state.apps.set(appId, { manifest, clientId });
      return {
        appId,
        clientId,
        clientSecret: fakeSlackValue("client"),
        signingSecret: fakeSlackValue("signing"),
      };
    },
    async updateApp(token, appId, manifest) {
      state.calls.push({ method: "apps.manifest.update", appId });
      requireAccess("apps.manifest.update", token);
      const app = state.apps.get(appId);
      if (!app) {
        throw new SlackApiError("apps.manifest.update", "app_not_found", true);
      }
      app.manifest = manifest;
      return { permissionsUpdated: false };
    },
    async deleteApp(token, appId) {
      state.calls.push({ method: "apps.manifest.delete", appId });
      requireAccess("apps.manifest.delete", token);
      const behaviour = state.next.delete;
      if (behaviour) {
        state.next.delete = undefined;
        return behaviour();
      }
      if (!state.apps.delete(appId)) {
        throw new SlackApiError("apps.manifest.delete", "app_not_found", true);
      }
    },
  };
  return { api, state, issueRefresh };
}
