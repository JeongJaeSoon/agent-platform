import { describe, expect, test } from "bun:test";
import {
  type AgentDetail,
  type AgentRelease,
  agentCardSchema,
} from "@werft-ai/contracts";
import { callerFor, createAuthorizationPolicy } from "../musterrolle/policy.ts";
import type { AgentStore } from "../ports/agent-store.ts";
import {
  type CatalogProfile,
  profileFingerprint,
  profilePins,
  type SessionCatalog,
} from "../sessions/catalog.ts";
import { SessionServiceError } from "../sessions/session-service.ts";
import { createAgentService } from "./agent-service.ts";
import { deriveReleaseId } from "./release-ids.ts";

const WORKSPACE = "019a0000-0000-7000-8000-0000000000f1";
const OWNER = "019a0000-0000-7000-8000-0000000000b1";
const AGENT = "019a0000-0000-7000-8000-0000000000a1";
const OTHER_AGENT = "019a0000-0000-7000-8000-0000000000a9";
const VERSION = "019a0000-0000-7000-8000-0000000000a2";
const KEY = "019a0000-0000-7000-8000-0000000000e1";
const AT = "2026-10-11T00:00:00.000Z";

const PROFILE: CatalogProfile = {
  runtime_kind: "claude_agent_sdk",
  runtime_version: "0.3.270",
  model: "claude-sonnet-5",
  tools: ["Read", "Grep"],
  permission_mode: "default",
  provider: {
    kind: "litellm",
    endpoint: "https://litellm.invalid",
    auth: {
      kind: "api_key",
      value: "catalog-provider-key",
      ref: { value_env: "PROVIDER_KEY" },
    },
  },
};

const catalogOf = (profile: CatalogProfile): SessionCatalog => ({
  profiles: { coding: profile },
  repositories: {},
});

function cardWith(tools: string[]) {
  return agentCardSchema.parse({
    role: "재무 분석가",
    instructions: "분기 보고서를 읽고 이상치를 요약한다.",
    model: "claude-sonnet-5",
    capabilities: { tools, mcp: null, forbidden: [] },
  });
}

const detail: AgentDetail = {
  agent: {
    id: AGENT,
    workspace_id: WORKSPACE,
    slug: "finance",
    name: "재무 분석가",
    status: "active",
    active_release_id: null,
    activation_revision: -1,
    created_by: OWNER,
    created_at: AT,
    updated_at: AT,
  },
  versions: [],
  releases: [],
  active_release: null,
};

/** A store keeping inserted releases, as PostgreSQL returns them. */
function memoryStore(tools: string[] = ["Read"]) {
  const releases = new Map<string, AgentRelease>();
  let activations = 0;
  const store: AgentStore = {
    list: async () => ({ items: [detail.agent], next_cursor: null }),
    count: async () => ({ all: 1, administered: 0 }),
    get: async () => detail,
    findVersion: async () => ({
      id: VERSION,
      agent_id: AGENT,
      version_no: 1,
      card: cardWith(tools),
      content_sha256: "a".repeat(64),
      created_by: OWNER,
      created_at: AT,
    }),
    findRelease: async (_workspace, id) => releases.get(id) ?? null,
    create: async () => ({ outcome: "created", detail }),
    update: async () => ({ outcome: "updated", detail }),
    insertRelease: async ({ release }) => {
      const existing = releases.get(release.id);
      if (existing) return { outcome: "exists", release: existing };
      const stored = {
        ...release,
        created_at: AT,
        approved_by: null,
        approved_at: null,
      };
      releases.set(release.id, stored);
      return { outcome: "created", release: stored };
    },
    activate: async ({ expectedRevision }) => {
      activations += 1;
      return expectedRevision === -1
        ? {
            outcome: "activated",
            revision: 0,
            previousReleaseId: null,
            receiptId: crypto.randomUUID(),
          }
        : { outcome: "conflict", activeReleaseId: null, revision: 0 };
    },
  };
  return { store, releases, activations: () => activations };
}

function serviceOver(
  store: AgentStore,
  profile: CatalogProfile = PROFILE,
  unbound: Record<string, string[]> = {},
) {
  return createAgentService({
    authorization: createAuthorizationPolicy(),
    store,
    catalog: catalogOf(profile),
    credentials: {
      unboundRefs: async (_workspaceId, releaseId) => unbound[releaseId] ?? [],
    },
  });
}

const person = (role: "owner" | "member") =>
  callerFor(
    {
      kind: "user",
      id: OWNER,
      workspace_id: WORKSPACE,
      role,
      scopes: ["sessions:read", "sessions:write"],
    },
    { kind: "api" },
    crypto.randomUUID(),
  );

const owner = person("owner");

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return "resolved";
  } catch (error) {
    return (error as { code?: string }).code ?? "thrown";
  }
}

const release = { version_id: VERSION, runtime_profile_id: "coding" };
const PAGE = { limit: 50 };

describe("agent service", () => {
  test("only an owner manages agents: a member and an API key are refused before the store", async () => {
    let reached = false;
    const { store } = memoryStore();
    const service = serviceOver({
      ...store,
      list: async () => {
        reached = true;
        return { items: [], next_cursor: null };
      },
      count: async () => {
        reached = true;
        return { all: 0, administered: 0 };
      },
    });
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
    );
    expect(await codeOf(service.listAgents(person("member"), PAGE))).toBe(
      "FORBIDDEN",
    );
    expect(await codeOf(service.listAgents(key, PAGE))).toBe("FORBIDDEN");
    expect(await codeOf(service.countAgents(person("member")))).toBe(
      "FORBIDDEN",
    );
    expect(await codeOf(service.countAgents(key))).toBe("FORBIDDEN");
    expect(reached).toBe(false);
    expect((await service.listAgents(owner, PAGE)).items).toEqual([]);
  });

  test("a release is named by its content, and the same content again is the same release", async () => {
    const { store } = memoryStore();
    const service = serviceOver(store);
    const first = await service.createRelease(owner, AGENT, release);
    expect(first.created).toBe(true);
    expect(first.release.effective_tools).toEqual({ tools: ["Read"], mcp: [] });
    // The path accepts an upper-case uuid; the hash is over the stored id.
    const again = await service.createRelease(
      owner,
      AGENT.toUpperCase(),
      release,
    );
    expect(again).toEqual({ release: first.release, created: false });
  });

  test("an unknown profile or a tool the profile lacks is UNSUPPORTED_CAPABILITY", async () => {
    expect(
      await codeOf(
        serviceOver(memoryStore().store).createRelease(owner, AGENT, {
          ...release,
          runtime_profile_id: "missing",
        }),
      ),
    ).toBe("UNSUPPORTED_CAPABILITY");
    expect(
      await codeOf(
        serviceOver(memoryStore(["Read", "WebFetch"]).store).createRelease(
          owner,
          AGENT,
          release,
        ),
      ),
    ).toBe("UNSUPPORTED_CAPABILITY");
  });

  test("activation refuses a release whose profile changed, or of another agent, without reaching the store", async () => {
    const memory = memoryStore();
    const { release: made } = await serviceOver(memory.store).createRelease(
      owner,
      AGENT,
      release,
    );
    const edited = serviceOver(memory.store, {
      ...PROFILE,
      permission_mode: "acceptEdits",
    });
    expect(
      await codeOf(
        edited.activateAgent(owner, AGENT, {
          release_id: made.id,
          expected_revision: -1,
        }),
      ),
    ).toBe("PROFILE_DIGEST_MISMATCH");
    const service = serviceOver(memory.store);
    expect(
      await codeOf(
        service.activateAgent(owner, OTHER_AGENT, {
          release_id: made.id,
          expected_revision: -1,
        }),
      ),
    ).toBe("NOT_FOUND");
    expect(memory.activations()).toBe(0);
  });

  test("a release's digest leaves the models out, and one from before version 2 still activates", async () => {
    const memory = memoryStore();
    const { release: made } = await serviceOver(memory.store).createRelease(
      owner,
      AGENT,
      release,
    );
    expect(made.profile_digest).toBe(profileFingerprint(PROFILE));
    const listed = serviceOver(memory.store, {
      ...PROFILE,
      models: ["claude-opus-5-5"],
    });
    await listed.activateAgent(owner, AGENT, {
      release_id: made.id,
      expected_revision: -1,
    });
    expect(memory.activations()).toBe(1);
    const v1 = profilePins(PROFILE)[1]?.fingerprint;
    if (!v1) throw new Error("no version 1 pin");
    const legacy: AgentRelease = {
      ...made,
      profile_digest: v1,
      id: deriveReleaseId({ ...made, profile_digest: v1 }),
    };
    memory.releases.set(legacy.id, legacy);
    await listed.activateAgent(owner, AGENT, {
      release_id: legacy.id,
      expected_revision: -1,
    });
    expect(memory.activations()).toBe(2);
    expect(
      await codeOf(
        serviceOver(memory.store, {
          ...PROFILE,
          permission_mode: "acceptEdits",
        }).activateAgent(owner, AGENT, {
          release_id: legacy.id,
          expected_revision: -1,
        }),
      ),
    ).toBe("PROFILE_DIGEST_MISMATCH");
  });

  test("a release whose card model left the profile's list no longer activates", async () => {
    const memory = memoryStore();
    const offers = serviceOver(memory.store, {
      ...PROFILE,
      model: "claude-opus-5-5",
      models: ["claude-sonnet-5"],
    });
    const { release: made } = await offers.createRelease(owner, AGENT, release);
    expect(made.runtime_config_snapshot.model).toBe("claude-sonnet-5");
    await offers.activateAgent(owner, AGENT, {
      release_id: made.id,
      expected_revision: -1,
    });
    expect(memory.activations()).toBe(1);
    const dropped = { ...PROFILE, model: "claude-opus-5-5" };
    expect(profileFingerprint(dropped)).toBe(made.profile_digest);
    expect(
      await codeOf(
        serviceOver(memory.store, dropped).activateAgent(owner, AGENT, {
          release_id: made.id,
          expected_revision: -1,
        }),
      ),
    ).toBe("PROFILE_DIGEST_MISMATCH");
    expect(memory.activations()).toBe(1);
  });

  test("activation names the credentials not bound to the agent, without reaching the store", async () => {
    const memory = memoryStore();
    const { release: made } = await serviceOver(memory.store).createRelease(
      owner,
      AGENT,
      release,
    );
    const refused = await serviceOver(memory.store, PROFILE, {
      [made.id]: ["mcp-notion", "slack_bot_token"],
    })
      .activateAgent(owner, AGENT, {
        release_id: made.id,
        expected_revision: -1,
      })
      .catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(SessionServiceError);
    expect(refused).toMatchObject({
      code: "CREDENTIAL_UNBOUND",
      details: {
        reason_code: "credential_unbound",
        missing: ["mcp-notion", "slack_bot_token"],
      },
    });
    expect((refused as Error).message).toContain("mcp-notion, slack_bot_token");
    expect(memory.activations()).toBe(0);
  });

  test("a lost compare-and-swap is REVISION_CONFLICT", async () => {
    const memory = memoryStore();
    const service = serviceOver(memory.store);
    const { release: made } = await service.createRelease(
      owner,
      AGENT,
      release,
    );
    const activated = await service.activateAgent(owner, AGENT, {
      release_id: made.id,
      expected_revision: -1,
    });
    expect(activated.activation_revision).toBe(0);
    expect(
      await codeOf(
        service.activateAgent(owner, AGENT, {
          release_id: made.id,
          expected_revision: 5,
        }),
      ),
    ).toBe("REVISION_CONFLICT");
  });

  test("an activation hands the welcome its release and the one it replaced; a refused one does not", async () => {
    const memory = memoryStore();
    const welcomed: unknown[][] = [];
    const service = createAgentService({
      authorization: createAuthorizationPolicy(),
      store: memory.store,
      catalog: catalogOf(PROFILE),
      credentials: { unboundRefs: async () => [] },
      welcome: {
        activated: async (...args) => {
          welcomed.push(args);
          return null;
        },
      },
    });
    const { release: made } = await service.createRelease(
      owner,
      AGENT,
      release,
    );
    await service.activateAgent(owner, AGENT, {
      release_id: made.id,
      expected_revision: -1,
    });
    await codeOf(
      service.activateAgent(owner, AGENT, {
        release_id: made.id,
        expected_revision: 5,
      }),
    );
    expect(welcomed).toEqual([[WORKSPACE, AGENT, made, null]]);
  });
});
