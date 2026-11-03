import { beforeEach, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import {
  type PendingQuestion,
  SLACK_INTERACTION_ACTIONS,
  SLACK_QUESTION_VIEW_CALLBACK,
  scopesForRole,
  type WorkspaceRole,
} from "@werft-ai/contracts";
import type { LinkedSubject } from "../ports/linked-account-store.ts";
import { SessionServiceError } from "../sessions/session-service.ts";
import { createAuthorizationPolicy, type IdentityReader } from "./policy.ts";
import {
  createSlackInteractionService,
  type SlackInteractionDeps,
} from "./slack-interactions.ts";
import { slackPromptMessage } from "./slack-prompts.ts";

const WORKSPACE = "019a0000-0000-7000-8000-0000000000a1";
const AGENT = "019a0000-0000-7000-8000-0000000000a2";
const INSTALLATION = "019a0000-0000-7000-8000-0000000000a3";
const SESSION = "019a0000-0000-7000-8000-0000000000a5";
const SLACK_APP = "019a0000-0000-7000-8000-0000000000a9";
const APP = "A0RESEARCH";
const TEAM = "T0OPS";
const CHANNEL = "C0OPS";
const CARD_TS = "1761300000.000200";
const THREAD_TS = "1761300000.000100";
const SECRET = "interaction-signing-fixture";
const LINKED = "U0LINKED";
const STRANGER = "U0STRANGER";
const USER = "019a0000-0000-7000-8000-000000000101";
const NOW = new Date("2026-11-03T00:00:00Z");

const question: PendingQuestion = {
  question_id: "q-1",
  prompt: "Which database?",
  options: [
    { option_id: "pg", label: "Postgres" },
    { option_id: "sqlite", label: "SQLite" },
  ],
  multi_select: false,
  allow_free_text: true,
};

type Call = { method: string; args: unknown[] };

let calls: Call[];
let role: WorkspaceRole;
let answerError: Error | null;
let outcome: Awaited<ReturnType<SlackInteractionDeps["pending"]["outcome"]>>;
let listed: unknown[];
let pushState: "requested" | "approved" | "rejected" | null;
let decideError: SessionServiceError | null;
let getError: Error | null;
let deferred: Promise<void>[];
let results: string[];
let userDelayMs: number;
let viewUpdateError: Error | null;

beforeEach(() => {
  calls = [];
  role = "owner";
  answerError = null;
  viewUpdateError = null;
  outcome = { state: "open", kind: "permission" };
  listed = [];
  pushState = "requested";
  decideError = null;
  getError = null;
  deferred = [];
  results = [];
  userDelayMs = 0;
});

const record =
  (method: string, result: unknown = undefined) =>
  async (...args: unknown[]) => {
    calls.push({ method, args });
    return result;
  };
const called = (method: string) => calls.filter((c) => c.method === method);

const identity: IdentityReader = {
  async reread(subject) {
    if (subject.actor_user_id !== USER) return { status: "unlinked" };
    return {
      status: "ok",
      principal: {
        kind: "user",
        id: USER,
        workspace_id: WORKSPACE,
        role,
        scopes: [...scopesForRole(role)],
      },
    };
  },
};

function deps(): SlackInteractionDeps {
  return {
    signingSecrets: {
      async forAgent(agentId) {
        return agentId === AGENT
          ? {
              workspaceId: WORKSPACE,
              slackAppId: SLACK_APP,
              appId: APP,
              signingSecret: SECRET,
            }
          : null;
      },
    } as SlackInteractionDeps["signingSecrets"],
    authorization: createAuthorizationPolicy({
      identity,
      slackGuests: { enabled: async () => false },
      outsideAgents: { access: async () => "use" },
      credentials: { unboundRefs: async () => [] },
      sessions: {
        visibleTo: async () => true,
        originOf: async () => ({ creatorUserId: USER, creatorApiKeyId: null }),
      },
      agents: {
        agentOf: async () => AGENT,
        agentOfRelease: async () => null,
        isAdmin: async () => false,
      },
      decisions: { record: async () => {} },
    }),
    agents: {
      async resolveSlackEvent(key) {
        return key.appId === APP && key.teamId === TEAM
          ? {
              status: "resolved",
              workspaceId: WORKSPACE,
              agentId: AGENT,
              identity: { id: "identity-1", revision: 1 },
              installationId: INSTALLATION,
              botUserId: "U0BOT",
              credentialRef: "slack_bot_token",
            }
          : { status: "dropped", reason: "not_installed" };
      },
    },
    bindings: {
      async resolveSlackChannel(installationId, channelId) {
        if (installationId !== INSTALLATION || channelId !== CHANNEL) {
          return null;
        }
        return {
          id: "019a0000-0000-7000-8000-0000000000a4",
          workspaceId: WORKSPACE,
          agentId: AGENT,
          installationId: INSTALLATION,
          channelId: CHANNEL,
          channelKind: "public_channel",
          mode: "on",
          ceiling: {
            actions: [
              "session.read",
              "session.submit",
              "session.control",
              "session.approve",
            ],
            disclosure: "full",
          },
          home: false,
          memoryWritePolicy: "deny",
          status: "ready",
          membership: null,
          muted: false,
          revision: 1,
          createdAt: new Date(0),
          revokedAt: null,
        };
      },
    },
    links: {
      async resolveLinkedSubject(ref): Promise<LinkedSubject> {
        if (ref.externalUserId !== LINKED) return { status: "unlinked" };
        return {
          status: "linked",
          linkedAccount: {
            id: "019a0000-0000-7000-8000-000000000201",
            revision: 1,
          },
          userId: USER,
          workspaceId: WORKSPACE,
          role,
        };
      },
    },
    pending: {
      async answer(...args) {
        calls.push({ method: "answer", args });
        if (answerError !== null) throw answerError;
        return undefined as never;
      },
      async listPendingRequests(...args) {
        calls.push({ method: "list", args });
        return { items: listed } as never;
      },
      async outcome() {
        return outcome;
      },
    },
    pushes: {
      async get(...args) {
        calls.push({ method: "pushGet", args });
        if (getError !== null) throw getError;
        if (pushState === null)
          throw new SessionServiceError("NOT_FOUND", "gone");
        return {
          id: "push-1",
          state: pushState,
          git_commit: "a".repeat(40),
          repository_id: "repo-1",
          target_branch: "agent/x",
        } as never;
      },
      async decide(...args) {
        calls.push({ method: "decide", args });
        if (decideError !== null) throw decideError;
        return undefined as never;
      },
    },
    sessions: { appendMessage: record("append") as never },
    slack: {
      userInfo: async (_token, id) => {
        if (userDelayMs > 0)
          await new Promise((r) => setTimeout(r, userDelayMs));
        return { id, team_id: TEAM };
      },
      updateMessage: record("update") as never,
      openView: record("view", { viewId: "V1" }) as never,
      updateView: async (...args: unknown[]) => {
        calls.push({ method: "viewUpdate", args });
        if (viewUpdateError !== null) throw viewUpdateError;
      },
      postEphemeral: record("ephemeral") as never,
    },
    botToken: async () => "xoxb-fixture",
    outbox: { readerLocale: async () => "en" },
    connectUrl: "https://app.example/settings/linked-accounts",
    logger: {
      warn() {},
      info(message: string, fields?: Record<string, unknown>) {
        if (message === "Slack interaction handled") {
          results.push(String(fields?.result));
        }
      },
    },
    now: () => NOW,
    wait: async () => {},
    defer: (work) => {
      deferred.push(work());
    },
  };
}

function signed(body: string, at = Math.floor(NOW.getTime() / 1000)) {
  return {
    timestamp: String(at),
    signature: `v0=${createHmac("sha256", SECRET)
      .update(`v0:${at}:${body}`)
      .digest("hex")}`,
  };
}

function form(payload: unknown) {
  return `payload=${encodeURIComponent(JSON.stringify(payload))}`;
}

const asked = slackPromptMessage(
  {
    kind: "permission",
    sessionId: SESSION,
    requestId: "toolu_1",
    tool: "Bash",
    input: { command: "ls" },
    expiresAt: NOW.toISOString(),
  },
  { locale: "en", requesterSlackUserId: null },
).blocks;

function press(actionId: string, value: Record<string, string>, user = LINKED) {
  return form({
    type: "block_actions",
    api_app_id: APP,
    team: { id: TEAM },
    user: { id: user },
    channel: { id: CHANNEL },
    message: { ts: CARD_TS, thread_ts: THREAD_TS, blocks: asked },
    trigger_id: "trigger-1",
    actions: [{ action_id: actionId, value: JSON.stringify(value) }],
  });
}

// Work deferred by deferred work lands in the list while it runs.
async function drain() {
  for (let i = 0; i < deferred.length; i += 1) await deferred[i];
}

// What Slack is answered, with the result of the work run after it.
async function send(body: string, headers = signed(body), agentId = AGENT) {
  const outcome = await createSlackInteractionService(deps()).receive({
    agentId,
    rawBody: new TextEncoder().encode(body),
    ...headers,
  });
  await drain();
  return outcome.kind === "ok" && outcome.result === "accepted"
    ? { ...outcome, result: results.at(-1) ?? "accepted" }
    : outcome;
}

const settledText = () =>
  (called("update")[0]?.args[1] as { text: string } | undefined)?.text;

describe("Slack interactions", () => {
  test("an unsigned, stale or unknown-agent request is refused before anything runs", async () => {
    const body = press(SLACK_INTERACTION_ACTIONS.permissionAllow, {
      s: SESSION,
      r: "toolu_1",
    });
    expect(await send(body, { timestamp: "1", signature: "v0=00" })).toEqual({
      kind: "unauthorized",
    });
    expect(
      await send(body, signed(body, Math.floor(NOW.getTime() / 1000) - 600)),
    ).toEqual({ kind: "unauthorized" });
    expect(
      await send(body, signed(body), "019a0000-0000-7000-8000-0000000000ff"),
    ).toEqual({ kind: "unauthorized" });
    expect(calls).toEqual([]);
  });

  test("a signed body that is not a form payload is a bad request", async () => {
    const body = "payload=not-json";
    expect(await send(body)).toEqual({ kind: "bad_request" });
  });

  test("allow answers the request once and settles the card with who pressed", async () => {
    const outcome = await send(
      press(SLACK_INTERACTION_ACTIONS.permissionAllow, {
        s: SESSION,
        r: "toolu_1",
      }),
    );
    expect(outcome).toEqual({
      kind: "ok",
      body: { ok: true },
      result: "answered",
    });
    const [answer] = called("answer");
    expect(answer?.args[1]).toBe(SESSION);
    expect(answer?.args[2]).toEqual({
      idempotencyKey: `slack:toolu_1:${LINKED}`,
      body: { request_id: "toolu_1", kind: "permission", decision: "allow" },
    });
    const update = called("update")[0]?.args[1] as {
      ts: string;
      blocks: { type: string }[];
    };
    expect(update.ts).toBe(CARD_TS);
    expect(update.blocks.some((b) => b.type === "actions")).toBe(false);
    expect(settledText()).toContain(`<@${LINKED}>`);
  });

  test("Slack is answered before a press's work runs", async () => {
    const service = createSlackInteractionService(deps());
    const body = press(SLACK_INTERACTION_ACTIONS.permissionAllow, {
      s: SESSION,
      r: "toolu_1",
    });
    const outcome = await service.receive({
      agentId: AGENT,
      rawBody: new TextEncoder().encode(body),
      ...signed(body),
    });
    expect(outcome).toEqual({
      kind: "ok",
      body: { ok: true },
      result: "accepted",
    });
    expect(called("answer")).toEqual([]);
    await drain();
    expect(called("answer")).toHaveLength(1);
  });

  test("a follow-up turn that fails is tried again before the card is settled", async () => {
    let fails = 2;
    const base = deps();
    const service = createSlackInteractionService({
      ...base,
      sessions: {
        appendMessage: (async (...args: unknown[]) => {
          calls.push({ method: "append", args });
          if (fails-- > 0) throw new Error("queue unavailable");
        }) as never,
      },
    });
    const body = press(SLACK_INTERACTION_ACTIONS.pushApprove, {
      s: SESSION,
      r: "push-1",
    });
    await service.receive({
      agentId: AGENT,
      rawBody: new TextEncoder().encode(body),
      ...signed(body),
    });
    await drain();
    const appends = called("append");
    expect(appends).toHaveLength(3);
    expect(
      new Set(
        appends.map(
          (c) => (c.args[2] as { idempotencyKey: string }).idempotencyKey,
        ),
      ),
    ).toEqual(new Set(["slack-push:push-1"]));
    expect(calls.findIndex((c) => c.method === "update")).toBeGreaterThan(
      calls.lastIndexOf(appends[2] as Call),
    );
  });

  test("a press on a request someone already answered shows its result and answers nothing new", async () => {
    answerError = new SessionServiceError("REQUEST_STALE", "answered");
    outcome = { state: "answered", kind: "permission", decision: "deny" };
    const result = await send(
      press(SLACK_INTERACTION_ACTIONS.permissionAllow, {
        s: SESSION,
        r: "toolu_1",
      }),
    );
    expect(result).toMatchObject({ result: "already" });
    expect(called("answer")).toHaveLength(1);
    expect(settledText()).not.toContain(`<@${LINKED}>`);
    expect(settledText()).toBeTruthy();
    expect(called("ephemeral")).toEqual([]);
  });

  test("an unlinked Slack user answers nothing and is pointed at the link page", async () => {
    const result = await send(
      press(
        SLACK_INTERACTION_ACTIONS.permissionAllow,
        { s: SESSION, r: "toolu_1" },
        STRANGER,
      ),
    );
    expect(result).toMatchObject({ kind: "ok" });
    expect((result as { result: string }).result).toStartWith("refused:");
    expect(called("answer")).toEqual([]);
    expect(called("update")).toEqual([]);
    const [notice] = called("ephemeral");
    const sent = notice?.args[1] as { userId: string; text: string };
    expect(sent.userId).toBe(STRANGER);
    expect(sent.text).toContain("https://app.example/settings/linked-accounts");
  });

  test("a press the web would refuse answers nothing", async () => {
    answerError = new SessionServiceError("FORBIDDEN", "not yours");
    const result = await send(
      press(SLACK_INTERACTION_ACTIONS.permissionDeny, {
        s: SESSION,
        r: "toolu_1",
      }),
    );
    expect(result).toMatchObject({ result: "refused" });
    expect(called("update")).toEqual([]);
    expect(called("ephemeral")).toHaveLength(1);
  });

  test("an option button answers a single question with that option", async () => {
    listed = [{ request_id: "q_1", kind: "question", questions: [question] }];
    await send(
      press(`${SLACK_INTERACTION_ACTIONS.questionOption}:1`, {
        s: SESSION,
        r: "q_1",
        o: "1",
      }),
    );
    expect(called("answer")[0]?.args[2]).toEqual({
      idempotencyKey: `slack:q_1:${LINKED}`,
      body: {
        request_id: "q_1",
        kind: "question",
        answers: [{ question_id: "q-1", selected_option_ids: ["sqlite"] }],
      },
    });
  });

  test("an option index the request never offered answers nothing", async () => {
    listed = [{ request_id: "q_1", kind: "question", questions: [question] }];
    outcome = { state: "open", kind: "question" };
    const result = await send(
      press(`${SLACK_INTERACTION_ACTIONS.questionOption}:1`, {
        s: SESSION,
        r: "q_1",
        o: "7",
      }),
    );
    expect(result).toMatchObject({ result: "failed" });
    expect(called("answer")).toEqual([]);
  });

  test("answer opens a loading modal at once, then fills it with the request and the card", async () => {
    listed = [{ request_id: "q_1", kind: "question", questions: [question] }];
    const result = await send(
      press(SLACK_INTERACTION_ACTIONS.questionOpen, { s: SESSION, r: "q_1" }),
    );
    expect(result).toMatchObject({ result: "view_opened" });
    const opened = called("view")[0]?.args[1] as {
      triggerId: string;
      view: { callback_id?: string };
    };
    expect(opened.triggerId).toBe("trigger-1");
    expect(opened.view.callback_id).toBeUndefined();
    expect(JSON.stringify(opened.view)).not.toContain("Which database?");
    const filled = called("viewUpdate")[0]?.args[1] as {
      viewId: string;
      view: { callback_id: string; private_metadata: string };
    };
    expect(filled.viewId).toBe("V1");
    expect(filled.view.callback_id).toBe(SLACK_QUESTION_VIEW_CALLBACK);
    expect(JSON.parse(filled.view.private_metadata)).toEqual({
      s: SESSION,
      r: "q_1",
      c: CHANNEL,
      m: CARD_TS,
      t: THREAD_TS,
    });
  });

  test("a modal that cannot be filled or told so leaves the presser an ephemeral", async () => {
    listed = [{ request_id: "q_1", kind: "question", questions: [question] }];
    viewUpdateError = new Error("view_not_found");
    const result = await send(
      press(SLACK_INTERACTION_ACTIONS.questionOpen, { s: SESSION, r: "q_1" }),
    );
    expect(result).toMatchObject({ result: "view_opened" });
    expect(called("viewUpdate")).toHaveLength(2);
    expect(called("answer")).toEqual([]);
    const told = called("ephemeral");
    expect(told).toHaveLength(1);
    expect((told[0]?.args[1] as { userId: string }).userId).toBe(LINKED);
  });

  test("the modal opens before a slow Slack user lookup, and an unlinked presser gets no question", async () => {
    listed = [{ request_id: "q_1", kind: "question", questions: [question] }];
    userDelayMs = 30;
    const service = createSlackInteractionService(deps());
    const body = press(
      SLACK_INTERACTION_ACTIONS.questionOpen,
      { s: SESSION, r: "q_1" },
      STRANGER,
    );
    const outcome = await service.receive({
      agentId: AGENT,
      rawBody: new TextEncoder().encode(body),
      ...signed(body),
    });
    expect(outcome).toMatchObject({ result: "view_opened" });
    expect(called("view")).toHaveLength(1);
    expect(called("viewUpdate")).toEqual([]);
    await drain();
    const shown = JSON.stringify(called("viewUpdate")[0]?.args[1]);
    expect(shown).not.toContain("Which database?");
    expect(shown).not.toContain(SLACK_QUESTION_VIEW_CALLBACK);
    expect(called("ephemeral")).toHaveLength(1);
  });

  const submit = (values: Record<string, Record<string, unknown>>) =>
    form({
      type: "view_submission",
      api_app_id: APP,
      team: { id: TEAM },
      user: { id: LINKED },
      view: {
        callback_id: SLACK_QUESTION_VIEW_CALLBACK,
        private_metadata: JSON.stringify({
          s: SESSION,
          r: "q_1",
          c: CHANNEL,
          m: CARD_TS,
          t: THREAD_TS,
        }),
        state: { values },
      },
    });

  test("a submitted modal answers the question, closes and settles its card", async () => {
    listed = [{ request_id: "q_1", kind: "question", questions: [question] }];
    const result = await send(
      submit({ "q0.text": { v: { value: "  MySQL, actually  " } } }),
    );
    expect(result).toEqual({
      kind: "ok",
      body: { response_action: "clear" },
      result: "answered",
    });
    expect(called("answer")[0]?.args[2]).toEqual({
      idempotencyKey: `slack:q_1:${LINKED}`,
      body: {
        request_id: "q_1",
        kind: "question",
        answers: [
          {
            question_id: "q-1",
            selected_option_ids: [],
            free_text: "MySQL, actually",
          },
        ],
      },
    });
    expect((called("update")[0]?.args[1] as { ts: string }).ts).toBe(CARD_TS);
  });

  test("an empty or forged modal answer keeps the modal open with an error", async () => {
    listed = [{ request_id: "q_1", kind: "question", questions: [question] }];
    const empty = await send(submit({}));
    expect(empty).toMatchObject({
      body: { response_action: "errors", errors: { q0: expect.any(String) } },
    });
    const forged = await send(
      submit({ q0: { v: { selected_option: { value: "9" } } } }),
    );
    expect(forged).toMatchObject({ body: { response_action: "errors" } });
    expect(called("answer")).toEqual([]);
  });

  test("a form whose checks outrun Slack's window stays open and answers nothing", async () => {
    listed = [{ request_id: "q_1", kind: "question", questions: [question] }];
    userDelayMs = 40;
    const service = createSlackInteractionService({
      ...deps(),
      submitDeadlineMs: 5,
    });
    const body = submit({ "q0.text": { v: { value: "MySQL" } } });
    const outcome = await service.receive({
      agentId: AGENT,
      rawBody: new TextEncoder().encode(body),
      ...signed(body),
    });
    expect(outcome).toMatchObject({
      body: {
        response_action: "errors",
        errors: { "q0.text": expect.any(String) },
      },
    });
    await new Promise((r) => setTimeout(r, 80));
    await drain();
    expect(called("answer")).toEqual([]);
  });

  test("approving a push decides it with the stored commit and queues a turn telling the session", async () => {
    const result = await send(
      press(SLACK_INTERACTION_ACTIONS.pushApprove, { s: SESSION, r: "push-1" }),
    );
    expect(result).toMatchObject({ result: "approved" });
    const [decide] = called("decide");
    expect(decide?.args.slice(1, 3)).toEqual([SESSION, "push-1"]);
    const input = decide?.args[3] as {
      idempotencyKey: string;
      readBody(): Promise<unknown>;
    };
    expect(input.idempotencyKey).toBe(`slack:push-1:${LINKED}`);
    expect(await input.readBody()).toEqual({
      decision: "approve",
      git_commit: "a".repeat(40),
    });
    const [append] = called("append");
    expect(append?.args[1]).toBe(SESSION);
    expect(append?.args[2]).toMatchObject({
      idempotencyKey: "slack-push:push-1",
      body: { mode: "enqueue" },
    });
    expect(settledText()).toContain(`<@${LINKED}>`);
  });

  test("a push already decided is not decided again and queues no turn", async () => {
    pushState = "rejected";
    const result = await send(
      press(SLACK_INTERACTION_ACTIONS.pushApprove, { s: SESSION, r: "push-1" }),
    );
    expect(result).toMatchObject({ result: "already" });
    expect(called("decide")).toEqual([]);
    expect(called("append")).toEqual([]);
    expect(called("update")).toHaveLength(1);
  });

  test("a failed push lookup leaves the card's buttons, decides nothing and tells the presser", async () => {
    getError = new Error("canceling statement due to statement timeout");
    const result = await send(
      press(SLACK_INTERACTION_ACTIONS.pushApprove, { s: SESSION, r: "push-1" }),
    );
    expect(result).toMatchObject({ result: "failed" });
    expect(called("update")).toEqual([]);
    expect(called("decide")).toEqual([]);
    const [told] = called("ephemeral");
    expect((told?.args[1] as { userId: string }).userId).toBe(LINKED);
  });

  test("an answer that throws after Slack was answered tells the presser", async () => {
    answerError = new Error("connection reset");
    const result = await send(
      press(SLACK_INTERACTION_ACTIONS.permissionAllow, {
        s: SESSION,
        r: "toolu_1",
      }),
    );
    expect(result).toMatchObject({ result: "failed" });
    expect(called("update")).toEqual([]);
    expect(called("ephemeral")).toHaveLength(1);
  });

  test("a follow-up turn that never lands is told to the presser", async () => {
    const base = deps();
    const service = createSlackInteractionService({
      ...base,
      sessions: {
        appendMessage: (async () => {
          throw new Error("queue unavailable");
        }) as never,
      },
    });
    const body = press(SLACK_INTERACTION_ACTIONS.pushApprove, {
      s: SESSION,
      r: "push-1",
    });
    await service.receive({
      agentId: AGENT,
      rawBody: new TextEncoder().encode(body),
      ...signed(body),
    });
    await drain();
    const [told] = called("ephemeral");
    expect((told?.args[1] as { text: string }).text).toContain(
      "Reply in this thread",
    );
    expect(called("update")).toHaveLength(1);
  });

  test("a member the policy refuses a push for decides nothing", async () => {
    decideError = new SessionServiceError("FORBIDDEN", "no");
    const result = await send(
      press(SLACK_INTERACTION_ACTIONS.pushReject, { s: SESSION, r: "push-1" }),
    );
    expect(result).toMatchObject({ result: "failed" });
    expect(called("append")).toEqual([]);
    expect(called("update")).toEqual([]);
    expect(called("ephemeral")).toHaveLength(1);
  });

  test("another app's payload and an unknown button are acknowledged and ignored", async () => {
    const other = form({
      type: "block_actions",
      api_app_id: "A0OTHER",
      team: { id: TEAM },
      user: { id: LINKED },
      channel: { id: CHANNEL },
      message: { ts: CARD_TS },
      trigger_id: "t",
      actions: [{ action_id: "permission.allow", value: "{}" }],
    });
    expect(await send(other)).toMatchObject({ result: "app_mismatch" });
    expect(
      await send(press("something.else", { s: SESSION, r: "toolu_1" })),
    ).toMatchObject({ result: "ignored" });
    expect(called("answer")).toEqual([]);
  });
});
