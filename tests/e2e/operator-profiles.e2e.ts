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
 *   bun test ./tests/e2e/operator-profiles.e2e.ts
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
const TIMEOUT = 600_000;
const CONNECTION = "claude-coding-local";
const RUN = randomBytes(3).toString("hex");
const NAME = `e2e-ceiling-${RUN}`;
const V1 = `op_${NAME}_v1`;
const V2 = `op_${NAME}_v2`;
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

const started: string[] = [];
let api: Api;
let owner: Web;
let admin: Web;
let agentId = "";
let versionId = "";
let releaseV1 = "";

async function sessionTurn(start: {
  profile_id?: string;
  agent_release_id?: string;
}) {
  const id = `ceiling-${started.length}`;
  const created = await api.expect<{ session_id: string; turn_id: string }>(
    201,
    "POST",
    "/v1/sessions",
    {
      ...start,
      repository_id: REPOSITORY_ID,
      message: scripted(id, [], `${id} done`),
    },
  );
  started.push(created.session_id);
  return (await api.settledTurn(created.session_id, created.turn_id)).status;
}

const releaseOn = (profileId: string) =>
  owner<{ release: { id: string } }>("POST", `/v1/agents/${agentId}/releases`, {
    version_id: versionId,
    runtime_profile_id: profileId,
    repository_id: REPOSITORY_ID,
  });

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
  api = new Api({ ...env, apiKey: key.body.secret });

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
  agentId = agent.body.agent.id;
  versionId = agent.body.versions[0]?.id ?? "";
}, TIMEOUT);

afterAll(async () => {
  for (const sessionId of started) {
    const { revision } = await api.session(sessionId);
    await api.control(sessionId, "terminate", {
      expected_revision: revision,
      reason: "e2e",
    });
  }
});

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
      const byAdmin = await admin("POST", "/v1/installation-profiles", CEILING);
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
      expect(saved.body.profile.id).toBe(V1);
      expect(saved.body.profile.installation.state).toBe("usable");
      const released = await releaseOn(V1);
      expect(released.status).toBe(200);
      releaseV1 = released.body.release.id;
      expect(await sessionTurn({ agent_release_id: releaseV1 })).toBe(
        "completed",
      );
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
        { ...v2, previous_id: V1 },
      );
      expect(saved.status).toBe(201);
      expect(saved.body.profile.id).toBe(V2);
      const narrowed = await admin<{ profile: { id: string } }>(
        "POST",
        "/v1/workspace-profiles",
        {
          name: `narrow-${RUN}`,
          base_profile_id: V2,
          model: "claude-sonnet-5",
          models: ["claude-sonnet-5"],
          tools: ["Read", "Edit"],
          permission_mode: "default",
        },
      );
      expect(narrowed.status).toBe(201);
      expect(await sessionTurn({ profile_id: narrowed.body.profile.id })).toBe(
        "completed",
      );
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
        base_profile_id: V2,
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
      expect(refused.map(([, status]) => status)).toEqual([400, 400, 400, 400]);
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
      }>("POST", `/v1/installation-profiles/${V1}/retire`, {});
      expect(retired.status).toBe(200);
      expect(retired.body.receipt_id).not.toBeNull();
      expect(retired.body.profile.installation.state).toBe("retired");
      const again = await owner<{ receipt_id: string | null }>(
        "POST",
        `/v1/installation-profiles/${V1}/retire`,
        {},
      );
      expect(again.body.receipt_id).toBeNull();
      const newRelease = await releaseOn(V1);
      expect(newRelease.status).toBeGreaterThanOrEqual(400);
      const bare = await api.request("POST", "/v1/sessions", {
        profile_id: V1,
        repository_id: REPOSITORY_ID,
        message: scripted("ceiling-bare", [], "ceiling-bare done"),
      });
      expect(bare.status).toBeGreaterThanOrEqual(400);
      expect(await sessionTurn({ agent_release_id: releaseV1 })).toBe(
        "completed",
      );
      console.log(
        `retire v1: ${retired.status}, receipt ${retired.body.receipt_id !== null}; again: receipt ${again.body.receipt_id}; new release on v1 ${newRelease.status} ${reasonOf(newRelease.body)}; session on v1 without a release ${bare.status} ${reasonOf(bare.body)}; v1's existing release ran a new session to completed`,
      );
    },
    TIMEOUT,
  );
});
