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
import { withSeededInstallation } from "../sessions/profile-registry.ts";
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

const catalogOf = (profile: CatalogProfile): SessionCatalog =>
  withSeededInstallation({
    profiles: {
      coding: profile,
      scratch: { ...profile, repository: "none" },
      either: { ...profile, repository: "optional" },
    },
    repositories: {
      "sample-app": {
        url: "https://github.com/acme/sample-app",
        branch: "main",
        profiles: ["coding", "either"],
      },
      "other-app": {
        url: "https://github.com/acme/other-app",
        branch: "main",
        profiles: ["either"],
      },
    },
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
    summaries: async () => new Map(),
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
    releaseSuperseded: async () => false,
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

const release = {
  version_id: VERSION,
  runtime_profile_id: "coding",
  repository_id: "sample-app",
};
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

  test("a summary is read for the whole page only when asked for", async () => {
    const asked: (readonly string[])[] = [];
    const { store } = memoryStore();
    const summary = {
      version: {
        version_no: 1,
        role: "r",
        instructions: "i",
        mcp_servers: [],
        credential_refs: [],
      },
      runtime_profile_id: null,
      bound_credential_refs: [],
      admins: [],
      needs_input_count: 0,
      running_count: 0,
    };
    const service = serviceOver({
      ...store,
      summaries: async (_workspace, ids) => {
        asked.push(ids);
        return new Map([[AGENT, summary]]);
      },
    });
    expect((await service.listAgents(owner, PAGE)).items).toEqual([
      detail.agent,
    ]);
    expect(asked).toEqual([]);
    expect(
      (await service.listAgents(owner, { ...PAGE, include: "summary" })).items,
    ).toEqual([{ ...detail.agent, summary }]);
    expect(asked).toEqual([[AGENT]]);
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

  test("a release names the repository its sessions work on, as the profile's repository mode allows", async () => {
    const service = serviceOver(memoryStore().store);
    const refused = async (body: Record<string, unknown>) => {
      const error = await service
        .createRelease(owner, AGENT, { ...release, ...body })
        .then(
          () => null,
          (thrown: unknown) => thrown,
        );
      expect(error).toBeInstanceOf(SessionServiceError);
      return [(error as SessionServiceError).code, (error as Error).message];
    };
    expect(await refused({ repository_id: undefined })).toEqual([
      "UNSUPPORTED_CAPABILITY",
      "repository_id: Profile coding needs a repository: send repository_id",
    ]);
    expect(
      await refused({
        runtime_profile_id: "scratch",
        repository_id: "sample-app",
      }),
    ).toEqual([
      "UNSUPPORTED_CAPABILITY",
      "repository_id: Profile scratch runs without a repository: omit repository_id",
    ]);
    expect(await refused({ repository_id: "other-app" })).toEqual([
      "UNSUPPORTED_CAPABILITY",
      "repository_id: Repository other-app is not in the catalog or does not allow profile coding",
    ]);
    expect(await refused({ repository_id: "missing" })).toEqual([
      "UNSUPPORTED_CAPABILITY",
      "repository_id: Repository missing is not in the catalog or does not allow profile coding",
    ]);

    const made = await service.createRelease(owner, AGENT, release);
    expect(made.release.repository_id).toBe("sample-app");
    const none = await service.createRelease(owner, AGENT, {
      version_id: VERSION,
      runtime_profile_id: "either",
    });
    expect(none.release.repository_id).toBeNull();
    // The repository is part of what the id names.
    const elsewhere = await service.createRelease(owner, AGENT, {
      version_id: VERSION,
      runtime_profile_id: "either",
      repository_id: "other-app",
    });
    expect(elsewhere.release.id).not.toBe(none.release.id);
    expect(elsewhere.release.repository_id).toBe("other-app");
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

  test("a blocked ceiling refuses a new release and the activation of one made before by name", async () => {
    const memory = memoryStore();
    const { release: made } = await serviceOver(memory.store).createRelease(
      owner,
      AGENT,
      release,
    );
    const open = catalogOf(PROFILE);
    const coding = open.installation?.get("coding");
    if (!open.installation || !coding) throw new Error("no seeded ceiling");
    const blocked = createAgentService({
      authorization: createAuthorizationPolicy(),
      store: memory.store,
      catalog: {
        ...open,
        installation: new Map([
          ...open.installation,
          ["coding", { ...coding, state: "blocked" }],
        ]),
      },
      credentials: { unboundRefs: async () => [] },
    });
    const byName = {
      code: "PROFILE_BLOCKED",
      details: { reason_code: "blocked", profile_id: "coding" },
    };
    expect(
      await blocked
        .activateAgent(owner, AGENT, {
          release_id: made.id,
          expected_revision: -1,
        })
        .catch((error: unknown) => error),
    ).toMatchObject(byName);
    expect(
      await blocked
        .createRelease(owner, AGENT, release)
        .catch((error: unknown) => error),
    ).toMatchObject(byName);
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

  test("an activation hands the welcome its release; a refused one does not", async () => {
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
    expect(welcomed).toEqual([[WORKSPACE, AGENT, made.id]]);
  });
});
