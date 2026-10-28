/**
 * Installation ceilings saved from the API, end to end on the fake model:
 * the owner saves and retires ceilings, an admin narrows one into a
 * workspace profile, and sessions run on what is attached.
 *
 * It bootstraps the first owner, so it runs on a stack of its own rather
 * than after the suites run.sh runs:
 *
 *   E2E_UP_ONLY=1 tests/e2e/run.sh
 *   source <out>/vars.sh
 *   E2E_OPERATOR_STATE=<file> bun test ./tests/e2e/operator-profiles.e2e.ts
 *
 * With E2E_OPERATOR_ROLLBACK=<that file> it instead checks the same stack
 * after its control-host services were swapped for an older image on the
 * same database: what ran keeps running and the retirement still holds.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import {
  Api,
  type ErrorBody,
  e2eEnv,
  REPOSITORY_ID,
  scripted,
} from "./client.ts";

const env = e2eEnv();
const bootstrapToken = process.env.E2E_BOOTSTRAP_TOKEN ?? "";
const statePath = process.env.E2E_OPERATOR_STATE ?? "";
const rollbackPath = process.env.E2E_OPERATOR_ROLLBACK ?? "";
const TIMEOUT = 600_000;
const CONNECTION = "claude-coding-local";
// Per run, so the suite runs again on the same stack.
const RUN = randomBytes(3).toString("hex");
const NAME = `e2e-ceiling-${RUN}`;
/** Derived, so a second run logs in as the people the first one made. */
const passwordOf = (who: string) =>
  createHash("sha256")
    .update(`${bootstrapToken}:${who}`)
    .digest("base64url")
    .slice(0, 24);

type Web = <T>(
  method: string,
  path: string,
  body?: unknown,
) => Promise<{ status: number; body: T; headers: Headers }>;

function webAs(cookie: string): Web {
  return async (method, path, body) => {
    const headers: Record<string, string> = {
      "x-requested-with": "agent-platform-web",
    };
    if (cookie !== "") headers.cookie = cookie;
    if (body !== undefined) headers["content-type"] = "application/json";
    if (method === "POST") headers["idempotency-key"] = crypto.randomUUID();
    const response = await fetch(`${env.apiUrl}${path}`, {
      method,
      headers,
      body: body === undefined ? null : JSON.stringify(body),
    });
    const text = await response.text();
    return {
      status: response.status,
      headers: response.headers,
      body: (text === "" ? null : JSON.parse(text)) as never,
    };
  };
}

async function login(email: string): Promise<string | null> {
  const response = await webAs("")("POST", "/v1/auth/login", {
    email,
    password: passwordOf(email),
  });
  if (response.status !== 200) return null;
  return (
    response.headers
      .getSetCookie()
      .find((value) => value.startsWith("__Host-ap_session="))
      ?.split(";")[0] ?? null
  );
}

const reasonOf = (body: unknown) =>
  (body as ErrorBody).error?.details?.reason_code ??
  (body as ErrorBody).error?.code;

type State = {
  ownerCookie: string;
  apiKey: string;
  agentId: string;
  versionId: string;
  v1: string;
  v2: string;
  releaseV1: string;
  workspaceSession: string;
};

const started: string[] = [];
let api: Api;

/** Runs one scripted turn to the end: in `start` if it is a session id, else in a new session. */
async function runTurn(
  id: string,
  start: { profile_id?: string; agent_release_id?: string } | string,
) {
  const message = scripted(id, [], `${id} done`);
  if (typeof start === "string") {
    const sent = await api.send(start, message);
    return (await api.settledTurn(start, sent.turn_id)).status;
  }
  const created = await api.expect<{ session_id: string; turn_id: string }>(
    201,
    "POST",
    "/v1/sessions",
    { ...start, repository_id: REPOSITORY_ID, message },
  );
  started.push(created.session_id);
  return (await api.settledTurn(created.session_id, created.turn_id)).status;
}

// A run that hands its state to the rollback check leaves its sessions up.
afterAll(async () => {
  if (statePath !== "") return;
  for (const sessionId of started) {
    const { revision } = await api.session(sessionId);
    await api.control(sessionId, "terminate", {
      expected_revision: revision,
      reason: "e2e",
    });
  }
});

const releaseOn = (owner: Web, state: State, profileId: string) =>
  owner<{ release: { id: string } }>(
    "POST",
    `/v1/agents/${state.agentId}/releases`,
    {
      version_id: state.versionId,
      runtime_profile_id: profileId,
      repository_id: REPOSITORY_ID,
    },
  );

if (rollbackPath === "") {
  let owner: Web;
  let admin: Web;
  const state = {
    v1: `op_${NAME}_v1`,
    v2: `op_${NAME}_v2`,
  } as State;
  const CEILING = {
    name: NAME,
    connection_id: CONNECTION,
    runtime_kind: "claude_agent_sdk",
    runtime_version: "0.3.270",
    model: "claude-sonnet-5",
    models: ["claude-sonnet-5", "claude-haiku-4-5"],
    tools: ["Read", "Write", "Bash"],
    permission_mode: "default",
    project_settings: { claude_md: true },
    repository_ids: [REPOSITORY_ID],
  };

  beforeAll(async () => {
    if (!bootstrapToken) {
      throw new Error("E2E_BOOTSTRAP_TOKEN is unset: run tests/e2e/run.sh");
    }
    const ownerEmail = "ceiling-owner@example.test";
    const booted = await webAs("")("POST", "/v1/auth/bootstrap", {
      bootstrap_token: bootstrapToken,
      email: ownerEmail,
      password: passwordOf(ownerEmail),
      display_name: "Ceiling Owner",
      workspace_name: "Ceilings",
      workspace_slug: "ceilings",
    });
    expect([201, 409]).toContain(booted.status);
    const ownerCookie = await login(ownerEmail);
    if (!ownerCookie) throw new Error("the owner could not log in");
    state.ownerCookie = ownerCookie;
    owner = webAs(ownerCookie);

    const adminEmail = "ceiling-admin@example.test";
    if ((await login(adminEmail)) === null) {
      const invite = await owner<{ invite_token: string }>(
        "POST",
        "/v1/invites",
        { email: adminEmail, role: "admin" },
      );
      expect(invite.status).toBe(201);
      const accepted = await webAs("")("POST", "/v1/invites/accept", {
        token: invite.body.invite_token,
        password: passwordOf(adminEmail),
        display_name: "Ceiling Admin",
      });
      expect(accepted.status).toBe(200);
    }
    const adminCookie = await login(adminEmail);
    if (!adminCookie) throw new Error("the admin could not log in");
    admin = webAs(adminCookie);

    const key = await owner<{ secret: string }>("POST", "/v1/api-keys", {
      kind: "personal",
      scopes: [
        "sessions:read",
        "sessions:write",
        "sessions:approve",
        "sessions:control",
      ],
    });
    expect(key.status).toBe(201);
    state.apiKey = key.body.secret;
    api = new Api({ ...env, apiKey: state.apiKey });

    const agent = await owner<{
      agent: { id: string };
      versions: { id: string }[];
    }>("POST", "/v1/agents", {
      slug: `ceiling-${RUN}`,
      name: `ceiling-${RUN}`,
      card: {
        role: "ceiling probe",
        instructions: "Answer as scripted.",
        language: "en",
        model: "claude-sonnet-5",
        capabilities: { tools: ["Read"], mcp: null, forbidden: [] },
        rules: [],
      },
    });
    if (agent.status !== 201) {
      throw new Error(`POST /v1/agents: ${JSON.stringify(agent.body)}`);
    }
    state.agentId = agent.body.agent.id;
    state.versionId = agent.body.versions[0]?.id ?? "";
  }, TIMEOUT);

  describe("installation ceilings from the API", () => {
    test(
      "options name the connections without their endpoint, and only the owner sees them",
      async () => {
        const options = await owner<{
          connections: { id: string }[];
          unattended_allowed: boolean;
        }>("GET", "/v1/installation-profiles/options");
        expect(options.status).toBe(200);
        const ids = options.body.connections.map((c) => c.id);
        expect(ids).toContain(CONNECTION);
        expect(options.body.unattended_allowed).toBe(false);
        expect(JSON.stringify(options.body)).not.toContain("fake-messages");
        const denied = await admin("GET", "/v1/installation-profiles/options");
        expect(denied.status).toBe(403);
        console.log(
          `options: connections=${ids.join(",")} unattended_allowed=${options.body.unattended_allowed}; admin ${denied.status}`,
        );
      },
      TIMEOUT,
    );

    test(
      "the owner saves v1 and a release on it runs; an admin and an API key cannot save",
      async () => {
        const byAdmin = await admin(
          "POST",
          "/v1/installation-profiles",
          CEILING,
        );
        expect(byAdmin.status).toBe(403);
        const byKey = await api.request(
          "POST",
          "/v1/installation-profiles",
          CEILING,
        );
        expect(byKey.status).toBe(403);
        const saved = await owner<{
          profile: { id: string; installation: { state: string } };
        }>("POST", "/v1/installation-profiles", CEILING);
        expect(saved.status).toBe(201);
        expect(saved.body.profile.id).toBe(state.v1);
        expect(saved.body.profile.installation.state).toBe("usable");
        const released = await releaseOn(owner, state, state.v1);
        expect(released.status).toBe(200);
        state.releaseV1 = released.body.release.id;
        expect(
          await runTurn("ceiling-v1", { agent_release_id: state.releaseV1 }),
        ).toBe("completed");
        console.log(
          `save v1: admin ${byAdmin.status}, api key ${byKey.status}, owner ${saved.status} ${saved.body.profile.id}; release on v1 ${released.status}, its session completed`,
        );
      },
      TIMEOUT,
    );

    test(
      "v2 must name v1 as previous_id; an admin's workspace profile on v2 runs a session",
      async () => {
        const v2 = { ...CEILING, tools: [...CEILING.tools, "Edit"] };
        const stale = await owner("POST", "/v1/installation-profiles", v2);
        expect([stale.status, reasonOf(stale.body)]).toEqual([
          409,
          "stale_previous",
        ]);
        const saved = await owner<{ profile: { id: string } }>(
          "POST",
          "/v1/installation-profiles",
          { ...v2, previous_id: state.v1 },
        );
        expect(saved.status).toBe(201);
        expect(saved.body.profile.id).toBe(state.v2);
        const narrowed = await admin<{ profile: { id: string } }>(
          "POST",
          "/v1/workspace-profiles",
          {
            name: `narrow-${RUN}`,
            base_profile_id: state.v2,
            model: "claude-sonnet-5",
            models: ["claude-sonnet-5"],
            tools: ["Read", "Edit"],
            permission_mode: "default",
          },
        );
        expect(narrowed.status).toBe(201);
        const created = await api.expect<{
          session_id: string;
          turn_id: string;
        }>(201, "POST", "/v1/sessions", {
          profile_id: narrowed.body.profile.id,
          repository_id: REPOSITORY_ID,
          message: scripted("ceiling-ws", [], "ceiling-ws done"),
        });
        started.push(created.session_id);
        state.workspaceSession = created.session_id;
        expect(
          (await api.settledTurn(created.session_id, created.turn_id)).status,
        ).toBe("completed");
        console.log(
          `save v2: without previous_id ${stale.status} ${reasonOf(stale.body)}, with it ${saved.status} ${saved.body.profile.id}; admin's ${narrowed.body.profile.id} on v2 ran a session to completed`,
        );
      },
      TIMEOUT,
    );

    test(
      "outside the ceiling is refused: a model or tool v2 lacks, and bypass while the switch is off",
      async () => {
        const base = {
          name: `wide-${RUN}`,
          base_profile_id: state.v2,
          model: "claude-sonnet-5",
          models: ["claude-sonnet-5"],
          tools: ["Read"],
          permission_mode: "default",
        };
        const refused: Array<[string, number, unknown]> = [];
        for (const [what, change] of [
          ["model", { models: ["claude-sonnet-5", "claude-opus-5"] }],
          ["tool", { tools: ["Read", "Glob"] }],
          ["bypass", { permission_mode: "bypassPermissions" }],
        ] as const) {
          const response = await admin("POST", "/v1/workspace-profiles", {
            ...base,
            ...change,
          });
          refused.push([what, response.status, reasonOf(response.body)]);
        }
        const bypassCeiling = await owner("POST", "/v1/installation-profiles", {
          ...CEILING,
          name: `e2e-bypass-${RUN}`,
          permission_mode: "bypassPermissions",
        });
        refused.push([
          "bypass ceiling",
          bypassCeiling.status,
          reasonOf(bypassCeiling.body),
        ]);
        console.log(`refused: ${JSON.stringify(refused)}`);
        expect(refused.map(([, status]) => status)).toEqual([
          400, 400, 400, 400,
        ]);
        expect(refused[3]?.[2]).toBe("unattended_not_allowed");
      },
      TIMEOUT,
    );

    test(
      "retiring v1 refuses a new release on it, while v1's release still starts sessions",
      async () => {
        const retired = await owner<{
          profile: { installation: { state: string } };
          receipt_id: string | null;
        }>("POST", `/v1/installation-profiles/${state.v1}/retire`, {});
        expect(retired.status).toBe(200);
        expect(retired.body.receipt_id).not.toBeNull();
        expect(retired.body.profile.installation.state).toBe("retired");
        const again = await owner<{ receipt_id: string | null }>(
          "POST",
          `/v1/installation-profiles/${state.v1}/retire`,
          {},
        );
        expect(again.body.receipt_id).toBeNull();
        const newRelease = await releaseOn(owner, state, state.v1);
        expect(newRelease.status).toBeGreaterThanOrEqual(400);
        const bare = await api.request("POST", "/v1/sessions", {
          profile_id: state.v1,
          repository_id: REPOSITORY_ID,
          message: scripted("ceiling-bare", [], "ceiling-bare done"),
        });
        expect(bare.status).toBeGreaterThanOrEqual(400);
        expect(
          await runTurn("ceiling-v1-after", {
            agent_release_id: state.releaseV1,
          }),
        ).toBe("completed");
        console.log(
          `retire v1: ${retired.status}, receipt ${retired.body.receipt_id !== null}; again: receipt ${again.body.receipt_id}; new release on v1 ${newRelease.status} ${reasonOf(newRelease.body)}; session on v1 without a release ${bare.status} ${reasonOf(bare.body)}; v1's existing release ran a new session to completed`,
        );
        if (statePath !== "") {
          await Bun.write(statePath, JSON.stringify(state));
        }
      },
      TIMEOUT,
    );
  });
} else {
  let state: State;
  let owner: Web;

  beforeAll(async () => {
    state = JSON.parse(await Bun.file(rollbackPath).text()) as State;
    owner = webAs(state.ownerCookie);
    api = new Api({ ...env, apiKey: state.apiKey });
  });

  describe("the same database on the older image", () => {
    test(
      "the workspace-profile session continues, v1's release starts a session, and v1 takes no new release",
      async () => {
        expect(await runTurn("rollback-ws", state.workspaceSession)).toBe(
          "completed",
        );
        expect(
          await runTurn("rollback-v1", { agent_release_id: state.releaseV1 }),
        ).toBe("completed");
        const newRelease = await releaseOn(owner, state, state.v1);
        expect(newRelease.status).toBeGreaterThanOrEqual(400);
        const listed = await owner<{ items: { id: string }[] }>(
          "GET",
          "/v1/profiles",
        );
        expect(listed.body.items.map((item) => item.id)).toContain(state.v2);
        console.log(
          `rollback: the workspace-profile session ran another turn to completed; v1's release ran a new session to completed; new release on v1 ${newRelease.status} ${reasonOf(newRelease.body)}; /v1/profiles lists ${state.v2}`,
        );
      },
      TIMEOUT,
    );
  });
}
