import { describe, expect, test } from "bun:test";
import { scopesForRole, type WorkspaceRole } from "@werft-ai/contracts";
import { SessionServiceError } from "../sessions/session-service.ts";
import {
  createFakeSlackConfigApi,
  createMemoryConfigTokenStore,
  createMemorySecretStore,
  createMemorySlackAppStore,
} from "../testing/slack-fakes.ts";
import {
  type AgentAuthority,
  type Caller,
  callerFor,
  createAuthorizationPolicy,
} from "./policy.ts";
import {
  createSlackAppService,
  SLACK_APP_CREATE_STALE_MS,
} from "./slack-app-service.ts";
import { SLACK_HTTP_TIMEOUT_MS, SlackApiError } from "./slack-config-api.ts";
import { createSlackConfigTokens } from "./slack-config-token.ts";

test("a creation is uncertain only after the Slack call could have ended", () => {
  expect(SLACK_APP_CREATE_STALE_MS).toBeGreaterThan(SLACK_HTTP_TIMEOUT_MS);
});

const WORKSPACE = "019a0000-0000-7000-8000-0000000000f1";
const AGENT = "019a0000-0000-7000-8000-0000000000c1";
const IDLE_AGENT = "019a0000-0000-7000-8000-0000000000c2";
const AGENT_ADMIN = "019a0000-0000-7000-8000-0000000000a2";
const ORIGIN = "https://console.example.ts.net";

function user(
  role: WorkspaceRole,
  options: { surface?: "web" | "api"; id?: string } = {},
): Caller {
  return callerFor(
    {
      kind: "user",
      id: options.id ?? crypto.randomUUID(),
      workspace_id: WORKSPACE,
      role,
      scopes: [...scopesForRole(role)],
    },
    { kind: options.surface ?? "web" },
    crypto.randomUUID(),
  );
}

const agentAuthority: AgentAuthority = {
  agentOf: async (_workspace, resource) =>
    resource.kind === "agent" ? resource.id : null,
  isAdmin: async (_workspace, _agent, userId) => userId === AGENT_ADMIN,
};

async function setup(options: { consoleOrigin?: string | null } = {}) {
  let clock = new Date("2026-10-23T00:00:00.000Z");
  const secrets = createMemorySecretStore();
  const tokenStore = createMemoryConfigTokenStore(secrets);
  const slack = createFakeSlackConfigApi({ now: () => clock });
  const apps = createMemorySlackAppStore({
    secrets,
    now: () => clock,
    agents: new Map([
      [
        AGENT,
        {
          id: AGENT,
          workspaceId: WORKSPACE,
          name: "Release notes",
          slug: "release-notes",
          role: "Writes the release notes",
          active: true,
        },
      ],
      [
        IDLE_AGENT,
        {
          id: IDLE_AGENT,
          workspaceId: WORKSPACE,
          name: "Draft",
          slug: "draft",
          role: "Not released yet",
          active: false,
        },
      ],
    ]),
  });
  const tokens = createSlackConfigTokens({
    store: tokenStore.store,
    api: slack.api,
    now: () => clock,
  });
  const service = createSlackAppService({
    authorization: createAuthorizationPolicy({ agents: agentAuthority }),
    apps: apps.store,
    tokens,
    api: slack.api,
    consoleOrigin:
      options.consoleOrigin === undefined ? ORIGIN : options.consoleOrigin,
    now: () => clock,
  });
  await tokens.register(WORKSPACE, slack.issueRefresh(), {
    principal: user("owner"),
    receiptId: crypto.randomUUID(),
    roles: ["owner", "admin"],
  });
  const creates = () =>
    slack.state.calls.filter((call) => call.method === "apps.manifest.create")
      .length;
  return {
    service,
    slack,
    apps,
    secrets,
    tokenStore,
    creates,
    advance(ms: number) {
      clock = new Date(clock.getTime() + ms);
    },
  };
}

async function refusal(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    if (error instanceof SessionServiceError) {
      return { code: error.code, details: error.details };
    }
    throw error;
  }
  throw new Error("expected a refusal");
}

describe("Slack app service", () => {
  test("an agent admin creates the app and gets the authorize URL", async () => {
    const { service, slack, secrets } = await setup();
    const out = await service.createAgentApp(
      user("member", { id: AGENT_ADMIN }),
      AGENT,
      { replace_uncertain: false },
    );
    expect(out.created).toBe(true);
    expect(out.slack_app).toMatchObject({
      kind: "agent",
      agent_id: AGENT,
      state: "created",
      app_id: "A0FAKE1",
      client_id: "1000.1",
      redirect_url: `${ORIGIN}/agents/${AGENT}/slack/callback`,
      created_by_token_user: "U0ISSUER",
      secrets: {
        slack_signing_secret: { configured: true },
        slack_client_secret: { configured: true },
        slack_bot_token: { configured: false },
      },
    });
    expect(out).not.toHaveProperty("authorize_url");
    const stored = [...secrets.values.values()].map(({ value }) => value);
    expect(stored).toHaveLength(3);
    for (const value of stored) {
      expect(JSON.stringify(out)).not.toContain(value);
    }
    const manifest = slack.state.apps.get("A0FAKE1")?.manifest as {
      settings: object;
    };
    expect(Object.keys(manifest.settings)).not.toContain("event_subscriptions");
  });

  test("asking again for the same agent returns the same app without a second create", async () => {
    const { service, creates } = await setup();
    const first = await service.createAgentApp(user("owner"), AGENT, {
      replace_uncertain: false,
    });
    const again = await service.createAgentApp(user("admin"), AGENT, {
      replace_uncertain: false,
    });
    expect(again.created).toBe(false);
    expect(again.slack_app.app_id).toBe(first.slack_app.app_id);
    expect(creates()).toBe(1);
  });

  test("a lost create answer leaves the creating row and a retry asks", async () => {
    const { service, slack, apps, creates, advance } = await setup();
    slack.state.next.create = async () => {
      throw new SlackApiError("apps.manifest.create", "timeout", false);
    };
    expect(
      (
        await refusal(
          service.createAgentApp(user("owner"), AGENT, {
            replace_uncertain: false,
          }),
        )
      ).code,
    ).toBe("BACKEND_UNAVAILABLE");
    expect([...apps.rows.values()].map((row) => row.state)).toEqual([
      "creating",
    ]);
    const retry = await refusal(
      service.createAgentApp(user("owner"), AGENT, {
        replace_uncertain: false,
      }),
    );
    expect(retry).toMatchObject({
      code: "SLACK_APP_CREATING",
      details: { uncertain: false },
    });
    advance(SLACK_APP_CREATE_STALE_MS + 1);
    expect(
      await refusal(
        service.createAgentApp(user("owner"), AGENT, {
          replace_uncertain: false,
        }),
      ),
    ).toMatchObject({
      code: "SLACK_APP_CREATING",
      details: { uncertain: true },
    });
    expect(creates()).toBe(1);
    const replaced = await service.createAgentApp(user("owner"), AGENT, {
      replace_uncertain: true,
    });
    expect(replaced.created).toBe(true);
    expect([...apps.rows.values()].map((row) => row.state)).toEqual([
      "abandoned",
      "created",
    ]);
  });

  test("an answer that cannot be written leaves the row creating, never a second app", async () => {
    const { service, apps, creates } = await setup();
    apps.faults.finishCreate = 3;
    expect(
      (
        await refusal(
          service.createAgentApp(user("owner"), AGENT, {
            replace_uncertain: false,
          }),
        )
      ).code,
    ).toBe("BACKEND_UNAVAILABLE");
    expect(
      (
        await refusal(
          service.createAgentApp(user("owner"), AGENT, {
            replace_uncertain: false,
          }),
        )
      ).code,
    ).toBe("SLACK_APP_CREATING");
    expect(creates()).toBe(1);
  });

  test("Slack refusing the manifest marks the row failed so a retry can create", async () => {
    const { service, slack, apps } = await setup();
    slack.state.next.create = async () => {
      throw new SlackApiError("apps.manifest.create", "invalid_manifest", true);
    };
    expect(
      await refusal(
        service.createAgentApp(user("owner"), AGENT, {
          replace_uncertain: false,
        }),
      ),
    ).toMatchObject({
      code: "BACKEND_UNAVAILABLE",
      details: { slack_error: "invalid_manifest" },
    });
    expect([...apps.rows.values()].map((row) => row.state)).toEqual(["failed"]);
    const out = await service.createAgentApp(user("owner"), AGENT, {
      replace_uncertain: false,
    });
    expect(out.created).toBe(true);
  });

  test("an agent without an active release is refused before Slack is asked", async () => {
    const { service, creates } = await setup();
    expect(
      (
        await refusal(
          service.createAgentApp(user("owner"), IDLE_AGENT, {
            replace_uncertain: false,
          }),
        )
      ).code,
    ).toBe("AGENT_NOT_ACTIVE");
    expect(creates()).toBe(0);
  });

  test("a member who is not the agent's admin, and any API caller, are refused", async () => {
    const { service, creates } = await setup();
    expect(
      (
        await refusal(
          service.createAgentApp(user("member"), AGENT, {
            replace_uncertain: false,
          }),
        )
      ).code,
    ).toBe("FORBIDDEN");
    expect(
      await refusal(
        service.createAgentApp(user("owner", { surface: "api" }), AGENT, {
          replace_uncertain: false,
        }),
      ),
    ).toEqual({
      code: "FORBIDDEN",
      details: { reason_code: "web_session_required" },
    });
    expect(creates()).toBe(0);
  });

  test("without the console origin no app is made", async () => {
    const { service, creates } = await setup({ consoleOrigin: null });
    expect(
      (
        await refusal(
          service.createAgentApp(user("owner"), AGENT, {
            replace_uncertain: false,
          }),
        )
      ).code,
    ).toBe("BACKEND_UNAVAILABLE");
    expect(creates()).toBe(0);
  });

  test("a new issuer of the config token is warned about at creation", async () => {
    const { service, slack, tokenStore } = await setup();
    const first = await service.createAgentApp(user("owner"), AGENT, {
      replace_uncertain: false,
    });
    expect(first.warnings).toEqual([]);
    slack.state.userId = "U0SECOND";
    const meta = tokenStore.meta.get(WORKSPACE);
    if (meta) meta.accessExpiresAt = new Date(0);
    await service.deleteApp(user("owner"), WORKSPACE, first.slack_app.id);
    const out = await service.createAgentApp(user("owner"), AGENT, {
      replace_uncertain: false,
    });
    expect(out.slack_app.created_by_token_user).toBe("U0SECOND");
    expect(out.warnings).toEqual([
      {
        code: "config_token_issuer_changed",
        previous_user_id: "U0ISSUER",
        user_id: "U0SECOND",
      },
    ]);
  });

  test("delete goes to Slack only for the workspace's own app", async () => {
    const { service, slack } = await setup();
    const made = await service.createAgentApp(user("owner"), AGENT, {
      replace_uncertain: false,
    });
    expect(
      (
        await refusal(
          service.deleteApp(user("owner"), WORKSPACE, crypto.randomUUID()),
        )
      ).code,
    ).toBe("NOT_FOUND");
    expect(
      slack.state.calls.filter((c) => c.method === "apps.manifest.delete"),
    ).toEqual([]);
    const deleted = await service.deleteApp(
      user("owner"),
      WORKSPACE,
      made.slack_app.id,
    );
    expect(deleted.slack_app).toMatchObject({
      state: "deleted",
      secrets: { slack_signing_secret: { configured: false } },
    });
    expect(
      slack.state.calls.filter((c) => c.method === "apps.manifest.delete"),
    ).toEqual([{ method: "apps.manifest.delete", appId: "A0FAKE1" }]);
  });

  test("a manifest update reads the app id from the workspace's own rows", async () => {
    const { service, slack } = await setup();
    const made = await service.createAgentApp(user("owner"), AGENT, {
      replace_uncertain: false,
    });
    const input = { name: "Renamed", botName: "renamed", description: "x" };
    expect(
      (
        await refusal(
          service.updateAgentAppManifest(WORKSPACE, crypto.randomUUID(), input),
        )
      ).code,
    ).toBe("NOT_FOUND");
    expect(
      (
        await refusal(
          service.updateAgentAppManifest(
            "019a0000-0000-7000-8000-0000000000f9",
            made.slack_app.id,
            input,
          ),
        )
      ).code,
    ).toBe("NOT_FOUND");
    await service.updateAgentAppManifest(WORKSPACE, made.slack_app.id, input);
    expect(
      slack.state.calls.filter((c) => c.method === "apps.manifest.update"),
    ).toEqual([{ method: "apps.manifest.update", appId: "A0FAKE1" }]);
  });
});
