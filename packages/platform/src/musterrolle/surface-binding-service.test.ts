import { describe, expect, test } from "bun:test";
import type {
  AuthorizationDecision,
  SurfaceChannelKind,
} from "@werft-ai/contracts";
import { testCaller } from "@werft-ai/testkit/callers";
import type { SlackAppRecord } from "../ports/slack-app-store.ts";
import type { SurfaceBindingStore } from "../ports/surface-binding-store.ts";
import { SessionServiceError } from "../sessions/session-service.ts";
import { createSlackChannelKinds } from "./slack-bot-token.ts";
import { SlackApiError, type SlackBotApi } from "./slack-config-api.ts";
import { createSurfaceBindingService } from "./surface-binding-service.ts";

const WORKSPACE = "019a0000-0000-7000-8000-000000000001";
const AGENT = "019a0000-0000-7000-8000-000000000002";
const caller = testCaller(WORKSPACE);

function service(kindOf: (channelId: string) => Promise<SurfaceChannelKind>) {
  const asked: string[] = [];
  const stored: SurfaceChannelKind[] = [];
  const store: SurfaceBindingStore = {
    async set(input) {
      stored.push(input.channelKind);
      return {
        outcome: "set",
        receiptId: "receipt-1",
        binding: {
          id: "binding-1",
          workspaceId: input.workspaceId,
          agentId: input.agentId,
          installationId: "installation-1",
          channelId: input.channelId,
          channelKind: input.channelKind,
          mode: input.mode,
          ceiling: input.ceiling,
          home: input.home,
          memoryWritePolicy: "deny",
          status: "ready",
          muted: false,
          revision: 1,
          createdAt: new Date(0),
          revokedAt: null,
        },
      };
    },
    list: async () => [],
    resolveSlackChannel: async () => null,
    ensureDmBinding: async () => null,
  };
  const bindings = createSurfaceBindingService({
    authorization: {
      authorize: async () =>
        ({ outcome: "allow", reason_code: "ok" }) as AuthorizationDecision,
    },
    store,
    channels: {
      async kindOf(_workspaceId, _agentId, channelId) {
        asked.push(channelId);
        return kindOf(channelId);
      },
    },
  });
  return { bindings, asked, stored };
}

async function codeOf(work: Promise<unknown>) {
  try {
    await work;
  } catch (error) {
    if (error instanceof SessionServiceError) return error.code;
    throw error;
  }
  return "ok";
}

describe("a Slack binding's channel kind is Slack's answer (94S-177)", () => {
  test("the kind Slack reports is stored, whatever the request said", async () => {
    const { bindings, asked, stored } = service(async () => "private_channel");
    const put = await bindings.putSlackBinding(caller, AGENT, {
      channel_id: "C0OPS",
      channel_kind: "public_channel",
      mode: "mention",
      home: false,
    });
    expect(put.slack_binding.surface_kind).toBe("private_channel");
    expect(asked).toEqual(["C0OPS"]);
    expect(stored).toEqual(["private_channel"]);
  });

  test("the DM row asks Slack nothing; a channel Slack calls a DM is refused", async () => {
    const { bindings, asked, stored } = service(async () => "dm");
    await bindings.putSlackBinding(caller, AGENT, {
      channel_id: null,
      mode: "mention",
      home: false,
    });
    expect(asked).toEqual([]);
    expect(
      await codeOf(
        bindings.putSlackBinding(caller, AGENT, {
          channel_id: "D0SOMEONE",
          mode: "mention",
          home: false,
        }),
      ),
    ).toBe("BAD_REQUEST");
    expect(stored).toEqual(["dm"]);
  });
});

describe("channel kinds through the agent's own app", () => {
  const slackApp = { id: "slack-app-1" };
  const api = (channelKind: SlackBotApi["channelKind"]): SlackBotApi => ({
    channelKind,
    userInfo: async () => {
      throw new Error("not asked");
    },
    setStatus: async () => {},
    listChannels: async () => {
      throw new Error("not asked");
    },
  });
  const kinds = (
    slack: SlackBotApi,
    token: string | null = "bot-credential",
    apps = true,
  ) =>
    createSlackChannelKinds({
      apps: apps
        ? { findForAgent: async () => slackApp as SlackAppRecord }
        : null,
      secrets: { get: async () => token },
      slack,
    });

  test("asks conversations.info with the app's bot token", async () => {
    const seen: string[] = [];
    const answer = await kinds(
      api(async (token, channelId) => {
        seen.push(`${token}:${channelId}`);
        return "public_channel";
      }),
    ).kindOf(WORKSPACE, AGENT, "C0OPS");
    expect(answer).toBe("public_channel");
    expect(seen).toEqual(["bot-credential:C0OPS"]);
  });

  test("no master key, app or token is not installed; Slack's refusal or absence has its own code", async () => {
    const fine = api(async () => "public_channel");
    for (const [slack, token, apps, code] of [
      [fine, "bot-credential", false, "SLACK_NOT_INSTALLED"],
      [fine, null, true, "SLACK_NOT_INSTALLED"],
      [
        api(async () => {
          throw new SlackApiError(
            "conversations.info",
            "channel_not_found",
            true,
          );
        }),
        "bot-credential",
        true,
        "BAD_REQUEST",
      ],
      [
        api(async () => {
          throw new SlackApiError("conversations.info", "fetch_failed", false);
        }),
        "bot-credential",
        true,
        "BACKEND_UNAVAILABLE",
      ],
    ] as const) {
      expect(
        await codeOf(kinds(slack, token, apps).kindOf(WORKSPACE, AGENT, "C0")),
      ).toBe(code);
    }
  });
});
