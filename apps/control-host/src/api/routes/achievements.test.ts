import { beforeEach, describe, expect, test } from "bun:test";
import {
  type AchievementCategory,
  type AchievementRule,
  type AchievementType,
  type AuthorizationRequest,
  achievementJudgeSettingsSchema,
  achievementRuleChangeResponseSchema,
  achievementTypeChangeResponseSchema,
  apiErrorResponseSchema,
  CSRF_HEADER_NAME,
  CSRF_HEADER_VALUE,
  listAchievementTypesResponseSchema,
  REQUEST_BODY_MAX_BYTES,
  WEB_SESSION_COOKIE_NAME,
} from "@werft-ai/contracts";
import {
  type AchievementRuleStore,
  createAchievementRuleService,
  createAuthorizationPolicy,
  type DecisionLog,
  type IdentityStore,
  type MembershipRole,
  type ResolvedWebSession,
} from "@werft-ai/platform";
import { generateWebSessionToken, hashWebSessionToken } from "../auth.ts";
import { hashApiKey } from "../keys.ts";
import { recordRouteErrors } from "../route-error-coverage.ts";
import { registerAchievementRoutes } from "./achievements.ts";

const createApiApp = recordRouteErrors("routes/achievements.test.ts");

const WORKSPACE = "019a0000-0000-7000-8000-0000000000a1";
const OTHER_WORKSPACE = "019a0000-0000-7000-8000-0000000000b1";
const USER = "019a0000-0000-7000-8000-0000000000c1";
const ID = "019a0000-0000-7000-8000-0000000000d1";
const AT = "2026-11-02T01:00:00.000Z";

const CATEGORY: AchievementCategory = {
  id: ID,
  name: "Delivery",
  position: 0,
  created_by: USER,
  created_at: AT,
  archived_at: null,
  archived_by: null,
};
const TYPE: AchievementType = {
  id: ID,
  key: "pull_request",
  name: "GitHub PR",
  evidence_kind: "github_pull_request",
  builtin: true,
  created_by: null,
  created_at: AT,
  archived_at: null,
  archived_by: null,
};
const RULE: AchievementRule = {
  id: ID,
  family_id: ID,
  version: 1,
  category_id: ID,
  title: "Merged PR",
  type_id: ID,
  definition: "Only a merged pull request counts.",
  judge: "luna",
  agent_ids: null,
  created_by: USER,
  created_at: AT,
  superseded_by: null,
  disabled_at: null,
  disabled_by: null,
};
const RULE_BODY = {
  category_id: ID,
  title: RULE.title,
  type_id: ID,
  definition: RULE.definition,
  judge: RULE.judge,
};

// What the store answers next, by method; anything unset succeeds.
let next: Partial<Record<keyof AchievementRuleStore, unknown>> = {};
const calls: { method: string; input: unknown }[] = [];
let storageDown = false;

function answer<T>(method: keyof AchievementRuleStore, fallback: T) {
  return async (input?: unknown): Promise<T> => {
    calls.push({ method, input });
    if (storageDown) {
      throw Object.assign(new Error("connection refused"), {
        code: "ECONNREFUSED",
      });
    }
    return method in next ? (next[method] as T) : fallback;
  };
}

const JUDGE = achievementJudgeSettingsSchema.parse({});
const store = {
  listCategories: answer("listCategories", [CATEGORY]),
  listTypes: answer("listTypes", [TYPE]),
  listRules: answer("listRules", [RULE]),
  createCategory: answer("createCategory", {
    outcome: "created",
    category: CATEGORY,
  }),
  updateCategory: answer("updateCategory", {
    outcome: "updated",
    category: CATEGORY,
  }),
  archiveCategory: answer("archiveCategory", {
    outcome: "archived",
    category: CATEGORY,
  }),
  createType: answer("createType", { outcome: "created", type: TYPE }),
  updateType: answer("updateType", { outcome: "updated", type: TYPE }),
  archiveType: answer("archiveType", { outcome: "archived", type: TYPE }),
  createRule: answer("createRule", { outcome: "created", rule: RULE }),
  createRuleVersion: answer("createRuleVersion", {
    outcome: "created",
    rule: RULE,
  }),
  setRuleDisabled: answer("setRuleDisabled", {
    outcome: "changed",
    rule: RULE,
  }),
  getJudge: answer("getJudge", JUDGE),
  setJudge: async (input: { settings: typeof JUDGE }) => {
    calls.push({ method: "setJudge", input });
    return { outcome: "set" as const, settings: input.settings };
  },
} as AchievementRuleStore;

const sessions = new Map<string, ResolvedWebSession>();
function cookieFor(role: MembershipRole, workspaceId = WORKSPACE): string {
  const token = generateWebSessionToken();
  sessions.set(Buffer.from(hashWebSessionToken(token)).toString("hex"), {
    sessionId: crypto.randomUUID(),
    userId: USER,
    email: `${role}@example.com`,
    displayName: role,
    locale: null,
    workspaceId,
    role,
    expiresAt: new Date(Date.now() + 60_000),
  });
  return `${WEB_SESSION_COOKIE_NAME}=${token}`;
}

const identity = {
  async resolveWebSession(tokenHash: Uint8Array) {
    return sessions.get(Buffer.from(tokenHash).toString("hex")) ?? null;
  },
  async renewWebSession() {
    return null;
  },
} as unknown as IdentityStore;

// An owner's personal key that reads and writes sessions, and an agent's key.
const KEY = `csp_${crypto.randomUUID()}`;
const keyHash = Buffer.from(hashApiKey(KEY));
const KEY_ID = crypto.randomUUID();
const AGENT_KEY = `csp_${crypto.randomUUID()}`;
const agentKeyHash = Buffer.from(hashApiKey(AGENT_KEY));
const AGENT_KEY_ID = crypto.randomUUID();
const AGENT_ID = crypto.randomUUID();

const recorded: AuthorizationRequest[] = [];
const decisions: DecisionLog = {
  async record({ request }) {
    recorded.push(request);
  },
};

const app = createApiApp({
  authMode: "api-key",
  identity,
  keyStore: {
    async find(candidate) {
      if (agentKeyHash.equals(Buffer.from(candidate))) {
        return {
          id: AGENT_KEY_ID,
          ownerId: WORKSPACE,
          workspaceId: WORKSPACE,
          kind: "agent" as const,
          agentId: AGENT_ID,
          createdByUserId: null,
          creatorRole: null,
          scopes: ["sessions:read", "sessions:write"],
        };
      }
      return keyHash.equals(Buffer.from(candidate))
        ? {
            id: KEY_ID,
            ownerId: WORKSPACE,
            workspaceId: WORKSPACE,
            kind: "personal" as const,
            createdByUserId: USER,
            creatorRole: "owner" as const,
            scopes: ["sessions:read", "sessions:write"],
          }
        : null;
    },
  },
  registerRoutes: (router) =>
    registerAchievementRoutes(
      router,
      createAchievementRuleService({
        authorization: createAuthorizationPolicy({
          decisions,
          // As the database reader answers: a personal key's creator, an
          // agent key's agent.
          identity: {
            async reread(subject) {
              const { principal } = subject;
              if (principal.kind !== "api_key") {
                return { status: "ok", principal };
              }
              return principal.id === AGENT_KEY_ID
                ? { status: "ok", principal, keyAgentId: AGENT_ID }
                : {
                    status: "ok",
                    principal,
                    keyCreator: { userId: USER, role: "owner" },
                  };
            },
          },
        }),
        store,
      }),
    ),
});

type Who = MembershipRole | "key" | "agent_key" | null;

function call(method: string, path: string, who: Who, body?: unknown) {
  const headers: Record<string, string> = {};
  if (who === "key") headers.Authorization = `Bearer ${KEY}`;
  else if (who === "agent_key") headers.Authorization = `Bearer ${AGENT_KEY}`;
  else if (who !== null) headers.Cookie = cookieFor(who);
  if (method !== "GET") headers[CSRF_HEADER_NAME] = CSRF_HEADER_VALUE;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  return app.request(path, {
    method,
    headers,
    ...(body === undefined
      ? {}
      : { body: typeof body === "string" ? body : JSON.stringify(body) }),
  });
}

async function refusal(response: Response) {
  return apiErrorResponseSchema.parse(await response.json()).error;
}

const WRITES: [string, string, unknown][] = [
  ["POST", "/v1/achievement-categories", { name: "Delivery" }],
  ["PATCH", `/v1/achievement-categories/${ID}`, { name: "Delivery" }],
  ["POST", `/v1/achievement-categories/${ID}/archive`, undefined],
  [
    "POST",
    "/v1/achievement-types",
    { key: "report", name: "Report", evidence_kind: "out_file" },
  ],
  ["PATCH", `/v1/achievement-types/${ID}`, { name: "Report" }],
  ["POST", `/v1/achievement-types/${ID}/archive`, undefined],
  ["POST", "/v1/achievement-rules", RULE_BODY],
  ["POST", `/v1/achievement-rules/${ID}/versions`, RULE_BODY],
  ["POST", `/v1/achievement-rules/${ID}/disable`, undefined],
  ["POST", `/v1/achievement-rules/${ID}/enable`, undefined],
  ["PUT", `/v1/workspaces/${WORKSPACE}/achievement-judge`, {}],
];

const READS = [
  "/v1/achievement-categories",
  "/v1/achievement-types",
  "/v1/achievement-rules",
  `/v1/workspaces/${WORKSPACE}/achievement-judge`,
];

beforeEach(() => {
  next = {};
  calls.length = 0;
  recorded.length = 0;
  storageDown = false;
});

describe("achievement rule management", () => {
  test("owners and admins write; each write asks for achievement_rule.manage", async () => {
    for (const role of ["owner", "admin"] as const) {
      for (const [method, path, body] of WRITES) {
        recorded.length = 0;
        const response = await call(method, path, role, body);
        expect(response.status, `${role} ${method} ${path}`).toBeLessThan(300);
        expect(recorded).toEqual([
          expect.objectContaining({
            action: "achievement_rule.manage",
            resource: {
              kind: "workspace",
              id: WORKSPACE,
              owner_scope: WORKSPACE,
            },
          }),
        ]);
      }
    }
  });

  test("a member and an API key write nothing, and nothing reaches the store", async () => {
    for (const who of ["member", "key"] as const) {
      for (const [method, path, body] of WRITES) {
        const response = await call(method, path, who, body);
        expect(response.status, `${who} ${method} ${path}`).toBe(403);
      }
    }
    expect(calls).toEqual([]);
  });

  test("anyone in the workspace and a personal key read; an agent's key does not", async () => {
    for (const who of ["member", "key"] as const) {
      for (const path of READS) {
        expect((await call("GET", path, who)).status, `${who} ${path}`).toBe(
          200,
        );
      }
    }
    expect(
      listAchievementTypesResponseSchema.parse(
        await (await call("GET", "/v1/achievement-types", "member")).json(),
      ).items,
    ).toEqual([TYPE]);
    expect((await call("GET", READS[0] ?? "", null)).status).toBe(401);
    for (const path of READS) {
      const refused = await call("GET", path, "agent_key");
      expect(refused.status, path).toBe(403);
      expect(await refused.json()).toMatchObject({
        error: { code: "FORBIDDEN", details: { reason_code: "role" } },
      });
    }
  });

  test("a type keeps its key and evidence kind: a PATCH naming either is 400", async () => {
    for (const body of [
      { name: "Report", key: "other" },
      { name: "Report", evidence_kind: "conversation" },
      { key: "other" },
    ]) {
      const response = await call(
        "PATCH",
        `/v1/achievement-types/${ID}`,
        "owner",
        body,
      );
      expect(response.status, JSON.stringify(body)).toBe(400);
    }
    expect(calls).toEqual([]);
    const renamed = await call(
      "PATCH",
      `/v1/achievement-types/${ID}`,
      "owner",
      {
        name: "Pull request",
      },
    );
    expect(
      achievementTypeChangeResponseSchema.parse(await renamed.json())
        .receipt_id,
    ).not.toBeNull();
    expect(calls).toEqual([
      {
        method: "updateType",
        input: expect.objectContaining({ typeId: ID, name: "Pull request" }),
      },
    ]);
  });

  test("a rule takes only null agent_ids, and its writes answer with a receipt", async () => {
    const perAgent = await call("POST", "/v1/achievement-rules", "owner", {
      ...RULE_BODY,
      agent_ids: [ID],
    });
    expect(perAgent.status).toBe(400);
    const created = await call("POST", "/v1/achievement-rules", "owner", {
      ...RULE_BODY,
      agent_ids: null,
    });
    expect(created.status).toBe(201);
    expect(
      achievementRuleChangeResponseSchema.parse(await created.json())
        .receipt_id,
    ).toEqual(expect.any(String));
    expect(calls.at(-1)?.input).toMatchObject({
      rule: { ...RULE_BODY, agent_ids: null },
    });
  });

  test("a store refusal answers its status and reason", async () => {
    const cases: [
      keyof AchievementRuleStore,
      unknown,
      [string, string, unknown],
      number,
      string,
      string | undefined,
    ][] = [
      [
        "createCategory",
        { outcome: "name_taken" },
        WRITES[0] as never,
        409,
        "ALREADY_EXISTS",
        "name_taken",
      ],
      [
        "updateCategory",
        { outcome: "name_taken" },
        WRITES[1] as never,
        409,
        "ALREADY_EXISTS",
        "name_taken",
      ],
      [
        "updateCategory",
        { outcome: "not_found" },
        WRITES[1] as never,
        404,
        "NOT_FOUND",
        undefined,
      ],
      [
        "archiveCategory",
        { outcome: "category_in_use" },
        WRITES[2] as never,
        409,
        "REVISION_CONFLICT",
        "category_in_use",
      ],
      [
        "archiveCategory",
        { outcome: "not_found" },
        WRITES[2] as never,
        404,
        "NOT_FOUND",
        undefined,
      ],
      [
        "createType",
        { outcome: "key_taken" },
        WRITES[3] as never,
        409,
        "ALREADY_EXISTS",
        "key_taken",
      ],
      [
        "createType",
        { outcome: "limit_reached" },
        WRITES[3] as never,
        409,
        "REVISION_CONFLICT",
        "limit_reached",
      ],
      [
        "updateType",
        { outcome: "not_found" },
        WRITES[4] as never,
        404,
        "NOT_FOUND",
        undefined,
      ],
      [
        "archiveType",
        { outcome: "builtin" },
        WRITES[5] as never,
        409,
        "REVISION_CONFLICT",
        "builtin",
      ],
      [
        "archiveType",
        { outcome: "type_in_use" },
        WRITES[5] as never,
        409,
        "REVISION_CONFLICT",
        "type_in_use",
      ],
      [
        "archiveType",
        { outcome: "not_found" },
        WRITES[5] as never,
        404,
        "NOT_FOUND",
        undefined,
      ],
      [
        "createRule",
        { outcome: "type_in_use" },
        WRITES[6] as never,
        409,
        "REVISION_CONFLICT",
        "type_in_use",
      ],
      [
        "createRule",
        { outcome: "limit_reached" },
        WRITES[6] as never,
        409,
        "REVISION_CONFLICT",
        "limit_reached",
      ],
      [
        "createRule",
        { outcome: "unknown_category" },
        WRITES[6] as never,
        400,
        "BAD_REQUEST",
        "unknown_category",
      ],
      [
        "createRuleVersion",
        { outcome: "type_in_use" },
        WRITES[7] as never,
        409,
        "REVISION_CONFLICT",
        "type_in_use",
      ],
      [
        "createRuleVersion",
        { outcome: "unknown_type" },
        WRITES[7] as never,
        400,
        "BAD_REQUEST",
        "unknown_type",
      ],
      [
        "createRuleVersion",
        { outcome: "not_found" },
        WRITES[7] as never,
        404,
        "NOT_FOUND",
        undefined,
      ],
      [
        "setRuleDisabled",
        { outcome: "not_found" },
        WRITES[8] as never,
        404,
        "NOT_FOUND",
        undefined,
      ],
      [
        "setRuleDisabled",
        { outcome: "type_in_use" },
        WRITES[9] as never,
        409,
        "REVISION_CONFLICT",
        "type_in_use",
      ],
      [
        "setRuleDisabled",
        { outcome: "unknown_category" },
        WRITES[9] as never,
        400,
        "BAD_REQUEST",
        "unknown_category",
      ],
      [
        "setRuleDisabled",
        { outcome: "not_found" },
        WRITES[9] as never,
        404,
        "NOT_FOUND",
        undefined,
      ],
      [
        "createCategory",
        { outcome: "actor_inactive" },
        WRITES[0] as never,
        403,
        "FORBIDDEN",
        "role",
      ],
    ];
    for (const [
      method,
      outcome,
      [verb, path, body],
      status,
      code,
      reason,
    ] of cases) {
      next = { [method]: outcome };
      const response = await call(verb, path, "owner", body);
      const label = `${method} ${JSON.stringify(outcome)}`;
      expect(response.status, label).toBe(status);
      const error = await refusal(response);
      expect(error.code as string, label).toBe(code);
      expect(
        (error.details as { reason_code?: string } | null)?.reason_code,
        label,
      ).toBe(reason);
    }
  });

  test("an unchanged write answers a null receipt", async () => {
    next = {
      archiveCategory: { outcome: "unchanged", category: CATEGORY },
      setRuleDisabled: { outcome: "unchanged", rule: RULE },
    };
    for (const [method, path] of [
      ["POST", `/v1/achievement-categories/${ID}/archive`],
      ["POST", `/v1/achievement-rules/${ID}/disable`],
    ] as const) {
      const response = await call(method, path, "owner");
      expect(response.status).toBe(200);
      expect(
        ((await response.json()) as { receipt_id: unknown }).receipt_id,
      ).toBeNull();
    }
  });

  test("a malformed id is 404; a malformed or oversized body 400 or 413", async () => {
    for (const [method, path, body] of [
      ["PATCH", "/v1/achievement-categories/nope", { name: "x" }],
      ["POST", "/v1/achievement-categories/nope/archive", undefined],
      ["PATCH", "/v1/achievement-types/nope", { name: "x" }],
      ["POST", "/v1/achievement-types/nope/archive", undefined],
      ["POST", "/v1/achievement-rules/nope/versions", RULE_BODY],
      ["POST", "/v1/achievement-rules/nope/disable", undefined],
      ["POST", "/v1/achievement-rules/nope/enable", undefined],
      ["GET", "/v1/workspaces/nope/achievement-judge", undefined],
      ["PUT", "/v1/workspaces/nope/achievement-judge", {}],
    ] as const) {
      expect((await call(method, path, "owner", body)).status, path).toBe(404);
    }
    const huge = "a".repeat(REQUEST_BODY_MAX_BYTES);
    for (const [method, path, body] of WRITES) {
      if (body === undefined) continue;
      expect(
        (await call(method, path, "owner", { ...(body as object), title: 1 }))
          .status,
        `${method} ${path}`,
      ).toBe(400);
      expect(
        (await call(method, path, "owner", { ...(body as object), huge }))
          .status,
        `${method} ${path}`,
      ).toBe(413);
    }
    expect(calls).toEqual([]);
  });

  test("the judge settings are the caller's workspace's, saved whole with defaults", async () => {
    for (const method of ["GET", "PUT"] as const) {
      const response = await call(
        method,
        `/v1/workspaces/${OTHER_WORKSPACE}/achievement-judge`,
        "owner",
        method === "PUT" ? {} : undefined,
      );
      expect(response.status, method).toBe(404);
    }
    next = { getJudge: null };
    expect(
      (
        await call(
          "GET",
          `/v1/workspaces/${WORKSPACE}/achievement-judge`,
          "owner",
        )
      ).status,
    ).toBe(404);
    for (const body of [
      { every_n_turns: 4 },
      { threshold: 2 },
      { transcript: "all" },
      { model: "gpt-5" },
      { backend: "jev" },
    ]) {
      const response = await call(
        "PUT",
        `/v1/workspaces/${WORKSPACE}/achievement-judge`,
        "owner",
        body,
      );
      expect(response.status, JSON.stringify(body)).toBe(400);
    }
    const saved = await call(
      "PUT",
      `/v1/workspaces/${WORKSPACE}/achievement-judge`,
      "admin",
      { every_n_turns: 10, on_idle: true },
    );
    expect(saved.status).toBe(200);
    expect(await saved.json()).toEqual({
      achievement_judge: { ...JUDGE, every_n_turns: 10, on_idle: true },
      receipt_id: expect.any(String),
    });
  });

  test("a storage outage answers 503", async () => {
    storageDown = true;
    expect((await call("GET", READS[0] ?? "", "owner")).status).toBe(503);
    const [method, path, body] = WRITES[0] as [string, string, unknown];
    expect((await call(method, path, "owner", body)).status).toBe(503);
  });
});
