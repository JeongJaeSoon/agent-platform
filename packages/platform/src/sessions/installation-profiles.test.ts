import { describe, expect, test } from "bun:test";
import {
  type CreateInstallationProfileRequest,
  type Principal,
  scopesForRole,
  type WorkspaceRole,
} from "@werft-ai/contracts";
import { installedDescriptors } from "@werft-ai/runtime-codecs";
import {
  type Caller,
  callerFor,
  createAuthorizationPolicy,
} from "../musterrolle/policy.ts";
import type {
  CreateInstallationProfileInput,
  InstallationProfileRecord,
  InstallationProfileStore,
} from "../ports/installation-profile-store.ts";
import {
  type CatalogProfile,
  type CatalogProfileConfig,
  resolveSessionCatalog,
} from "./catalog.ts";
import { ProfileFeatureGate } from "./feature-gate.ts";
import { createInstallationProfileService } from "./installation-profiles.ts";
import {
  catalogRows,
  createProfileRegistry,
  profileCatalog,
} from "./profile-registry.ts";
import { SessionServiceError } from "./session-service.ts";
import {
  createWorkspaceProfileService,
  listCatalogProfiles,
} from "./workspace-profiles.ts";

const WORKSPACE = "019a0000-0000-7000-8000-0000000000a1";
const USERS = {
  owner: "019a0000-0000-7000-8000-0000000000c1",
  admin: "019a0000-0000-7000-8000-0000000000c2",
  member: "019a0000-0000-7000-8000-0000000000c3",
} as const;

const MAIN: CatalogProfileConfig["provider"] = {
  kind: "anthropic",
  endpoint: "https://api.anthropic.invalid",
  auth: { kind: "api_key", value_env: "PROVIDER_KEY" },
};
const SEED: CatalogProfileConfig = {
  runtime_kind: "claude_agent_sdk",
  runtime_version: "0.3.270",
  model: "claude-sonnet-5",
  models: ["claude-sonnet-5", "claude-haiku-5"],
  tools: ["Read", "Edit"],
  permission_mode: "default",
  provider: MAIN,
  project_settings: { claude_md: false },
  repository: "required",
};
const REPOSITORIES = {
  app: {
    url: "https://git.example.invalid/team/app.git",
    branch: "main",
    profiles: ["seed"],
  },
  docs: {
    url: "https://git.example.invalid/team/docs.git",
    branch: "main",
    profiles: [],
  },
};

function caller(who: keyof typeof USERS): Caller {
  const role: WorkspaceRole = who;
  const principal: Principal = {
    kind: "user",
    id: USERS[who],
    workspace_id: WORKSPACE,
    role,
    scopes: [...scopesForRole(role)],
  };
  return callerFor(principal, { kind: "web" }, crypto.randomUUID());
}

/** An owner's key with every scope an owner holds. */
const apiKey = callerFor(
  {
    kind: "api_key",
    id: "key-1",
    owner_id: WORKSPACE,
    workspace_id: WORKSPACE,
    scopes: [...scopesForRole("owner")],
  } as Principal,
  { kind: "api" },
  crypto.randomUUID(),
);

/** The store as Postgres keeps it: version numbers, previous ids, id clashes. */
function memoryStore(rows: InstallationProfileRecord[]) {
  const writes: CreateInstallationProfileInput[] = [];
  const store: Pick<InstallationProfileStore, "listAll" | "create" | "retire"> =
    {
      listAll: async () => rows.map((row) => ({ ...row })),
      async create(input) {
        writes.push(input);
        const versions = rows.filter(
          (row) => row.origin === "console" && row.name === input.name,
        );
        const latest = versions.sort((a, b) => b.version - a.version)[0];
        if (latest && input.previousId !== latest.id) {
          return { outcome: "stale_previous", latestId: latest.id };
        }
        if (
          !latest &&
          input.previousId !== null &&
          !rows.some((row) => row.id === input.previousId)
        ) {
          return { outcome: "unknown_previous" };
        }
        const version = (latest?.version ?? 0) + 1;
        const id = `op_${input.name}_v${version}`;
        if (rows.some((row) => row.id === id)) {
          return { outcome: "id_taken", id };
        }
        const record: InstallationProfileRecord = {
          id,
          name: input.name,
          version,
          origin: "console",
          definition: JSON.parse(JSON.stringify(input.definition)),
          permission_mode: input.permission_mode,
          fingerprint: input.fingerprint,
          repository_ids: input.repository_ids,
          previous_id: input.previousId,
          created_by: input.actor.userId,
          created_at: new Date("2026-10-28T00:00:00Z"),
          retired_at: null,
          retired_by: null,
        };
        rows.push(record);
        return { outcome: "created", record };
      },
      async retire(input) {
        const index = rows.findIndex((row) => row.id === input.profileId);
        const row = rows[index];
        if (!row) return { outcome: "not_found" };
        if (row.retired_at !== null)
          return { outcome: "unchanged", record: row };
        const retired = {
          ...row,
          retired_at: new Date("2026-10-28T01:00:00Z"),
          retired_by: input.actor.userId,
        };
        rows[index] = retired;
        return { outcome: "retired", record: retired };
      },
    };
  return { store, writes };
}

function setup(
  options: {
    allowUnattended?: boolean;
    rows?: InstallationProfileRecord[];
  } = {},
) {
  const rows = options.rows ?? catalogRows({ seed: SEED });
  const { store, writes } = memoryStore(rows);
  const connections = { main: MAIN };
  const catalog = profileCatalog(
    { repositories: REPOSITORIES },
    createProfileRegistry({
      workspaces: { listAll: async () => [] },
      installations: store,
      sources: {
        connections,
        allowUnattended: options.allowUnattended ?? false,
        runtimeSupported: () => true,
        materialize: (id, definition) => {
          const profile = resolveSessionCatalog(
            { profiles: { [id]: definition }, repositories: {} },
            () => "a-provider-key",
          ).profiles[id];
          if (!profile) throw new Error(`no ${id}`);
          return profile as CatalogProfile;
        },
      },
    }),
  );
  const authorization = createAuthorizationPolicy({
    agents: { agentOf: async () => null, isAdmin: async () => false },
    decisions: { record: async () => {} },
  });
  const service = createInstallationProfileService({
    authorization,
    store,
    catalog,
    connections,
    allowUnattended: options.allowUnattended ?? false,
    runtimes: new ProfileFeatureGate(installedDescriptors),
    newId: () => "019a0000-0000-7000-8000-0000000000e1",
  });
  const versions = createWorkspaceProfileService({
    authorization,
    store: {
      listAll: async () => [],
      create: async () => {
        throw new Error("not reached");
      },
      retire: async () => ({ outcome: "not_found" }),
    },
    catalog,
  });
  return { service, versions, catalog, rows, writes };
}

const REQUEST: CreateInstallationProfileRequest = {
  name: "coding",
  connection_id: "main",
  runtime_kind: "claude_agent_sdk",
  runtime_version: "0.3.270",
  model: "claude-sonnet-5",
  models: ["claude-sonnet-5", "claude-opus-5"],
  title_model: "claude-haiku-5",
  tools: ["Read", "Edit", "Bash"],
  permission_mode: "acceptEdits",
  repository_ids: ["docs"],
};

async function refusal(promise: Promise<unknown>) {
  const error = await promise.then(
    () => null,
    (thrown: unknown) => thrown,
  );
  if (!(error instanceof SessionServiceError)) {
    throw new Error(`expected a refusal, got ${String(error)}`);
  }
  return {
    code: error.code,
    reason: (error.details as { reason_code?: string } | null)?.reason_code,
  };
}

describe("saving an installation ceiling", () => {
  test("the owner saves v1, the connection's provider copied in, listed with its installation fields", async () => {
    const { service, writes } = setup();
    const saved = await service.create(caller("owner"), REQUEST);
    expect(writes[0]?.definition).toMatchObject({ provider: MAIN });
    expect(writes[0]?.previousId).toBeNull();
    expect(saved.receipt_id).toBe("019a0000-0000-7000-8000-0000000000e1");
    expect(saved.profile).toMatchObject({
      id: "op_coding_v1",
      source: "operator",
      models: ["claude-sonnet-5", "claude-opus-5"],
      tools: ["Read", "Edit", "Bash"],
      repository_ids: ["docs"],
      installation: {
        name: "coding",
        version: 1,
        origin: "console",
        state: "usable",
        connection_id: "main",
        title_model: "claude-haiku-5",
        project_settings: { claude_md: false },
        previous_id: null,
        created_by: USERS.owner,
        retired_by: null,
      },
    });
    expect(JSON.stringify(saved)).not.toContain("api.anthropic.invalid");
  });

  test("the next version names the latest as previous_id; anything else is a conflict", async () => {
    const { service } = setup();
    await service.create(caller("owner"), REQUEST);
    expect(await refusal(service.create(caller("owner"), REQUEST))).toEqual({
      code: "REVISION_CONFLICT",
      reason: "stale_previous",
    });
    expect(
      await refusal(
        service.create(caller("owner"), {
          ...REQUEST,
          previous_id: "seed",
        }),
      ),
    ).toEqual({ code: "REVISION_CONFLICT", reason: "stale_previous" });
    const v2 = await service.create(caller("owner"), {
      ...REQUEST,
      previous_id: "op_coding_v1",
    });
    expect(v2.profile.id).toBe("op_coding_v2");
    expect(v2.profile.installation?.previous_id).toBe("op_coding_v1");
  });

  test("a first version may replace an imported ceiling, but not one that is no row", async () => {
    const { service } = setup();
    const made = await service.create(caller("owner"), {
      ...REQUEST,
      name: "remade",
      previous_id: "seed",
    });
    expect(made.profile.installation?.previous_id).toBe("seed");
    expect(
      await refusal(
        service.create(caller("owner"), {
          ...REQUEST,
          name: "other",
          previous_id: "nowhere",
        }),
      ),
    ).toEqual({ code: "BAD_REQUEST", reason: "unknown_previous" });
  });

  test("an id already an imported profile's is id_taken", async () => {
    const { service } = setup({
      rows: catalogRows({ seed: SEED, op_clash_v1: SEED }),
    });
    expect(
      await refusal(
        service.create(caller("owner"), { ...REQUEST, name: "clash" }),
      ),
    ).toEqual({ code: "REVISION_CONFLICT", reason: "id_taken" });
  });

  test("only the owner saves: an admin, a member and an API key are 403, before anything is written", async () => {
    const { service, writes } = setup();
    for (const who of [caller("admin"), caller("member"), apiKey]) {
      expect((await refusal(service.create(who, REQUEST))).code).toBe(
        "FORBIDDEN",
      );
      expect((await refusal(service.retire(who, "seed"))).code).toBe(
        "FORBIDDEN",
      );
      expect((await refusal(service.options(who))).code).toBe("FORBIDDEN");
    }
    expect(writes).toEqual([]);
  });

  test("bypassPermissions is 400 while the installation's switch is off, and saves once it is on", async () => {
    const bypass = {
      ...REQUEST,
      permission_mode: "bypassPermissions" as const,
    };
    const off = setup();
    expect(await refusal(off.service.create(caller("owner"), bypass))).toEqual({
      code: "BAD_REQUEST",
      reason: "unattended_not_allowed",
    });
    expect(off.writes).toEqual([]);
    const on = setup({ allowUnattended: true });
    const saved = await on.service.create(caller("owner"), bypass);
    expect(saved.profile.permission_mode).toBe("bypassPermissions");
    expect(saved.profile.installation?.state).toBe("usable");
  });

  test("what the installation does not have is 400 naming it", async () => {
    const { service, writes } = setup();
    const cases: Array<[Partial<CreateInstallationProfileRequest>, string]> = [
      [{ connection_id: "elsewhere" }, "unknown_connection"],
      [{ runtime_kind: "pi_coding_agent" }, "runtime_not_installed"],
      [{ repository_ids: ["nowhere"] }, "unknown_repository"],
      [{ model: "claude-haiku-5" }, "model_not_in_models"],
      [
        {
          repository_mode: "none",
          project_settings: { claude_md: true },
          repository_ids: [],
        },
        "invalid_profile",
      ],
    ];
    for (const [change, reason] of cases) {
      const refused = await refusal(
        service.create(caller("owner"), { ...REQUEST, ...change }),
      );
      expect([refused.code, refused.reason]).toEqual(["BAD_REQUEST", reason]);
    }
    expect(writes).toEqual([]);
  });
});

describe("retiring an installation ceiling", () => {
  test("retires once with a receipt, then answers null; an unknown id is 404", async () => {
    const { service } = setup();
    const retired = await service.retire(caller("owner"), "seed");
    expect(retired.receipt_id).not.toBeNull();
    expect(retired.profile.installation).toMatchObject({
      origin: "catalog",
      name: null,
      state: "retired",
      retired_by: USERS.owner,
    });
    expect((await service.retire(caller("owner"), "seed")).receipt_id).toBe(
      null,
    );
    expect((await refusal(service.retire(caller("owner"), "nope"))).code).toBe(
      "NOT_FOUND",
    );
  });

  test("a retired ceiling is no base for a new workspace version", async () => {
    const { service, versions } = setup();
    await service.retire(caller("owner"), "seed");
    expect(
      await refusal(
        versions.create(caller("admin"), {
          name: "narrow",
          base_profile_id: "seed",
          model: "claude-sonnet-5",
          models: ["claude-sonnet-5"],
          tools: ["Read"],
          permission_mode: "default",
        }),
      ),
    ).toEqual({ code: "BAD_REQUEST", reason: "retired" });
  });
});

describe("the options and the list", () => {
  test("options name connections without their endpoint, the runtimes' modes and the switch", async () => {
    const { service } = setup();
    const options = await service.options(caller("owner"));
    expect(options.connections).toEqual([
      { id: "main", kind: "anthropic", billing: "metered" },
    ]);
    expect(options.repositories).toEqual([{ id: "app" }, { id: "docs" }]);
    expect(options.unattended_allowed).toBe(false);
    expect(
      options.runtimes.find((r) => r.runtime_kind === "claude_agent_sdk")
        ?.permission_modes,
    ).toContain("auto");
    expect(JSON.stringify(options)).not.toContain("api.anthropic.invalid");
    expect(JSON.stringify(options)).not.toContain("PROVIDER_KEY");
  });

  test("a ceiling that does not run here is listed with why, from its stored definition", async () => {
    const elsewhere = {
      ...SEED,
      provider: { ...MAIN, endpoint: "https://elsewhere.invalid" },
    };
    const { catalog } = setup({
      rows: catalogRows({ seed: SEED, gone: elsewhere }),
    });
    await catalog.workspace_profiles.refresh();
    const listed = listCatalogProfiles(catalog, WORKSPACE).items;
    expect(
      listed.map((item) => [
        item.id,
        item.installation?.state,
        item.installation?.connection_id,
      ]),
    ).toEqual([
      ["gone", "connection_missing", null],
      ["seed", "usable", "main"],
    ]);
  });
});
