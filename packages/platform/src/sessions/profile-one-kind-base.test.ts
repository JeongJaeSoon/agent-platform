import { describe, expect, test } from "bun:test";
import { scopesForRole } from "@werft-ai/contracts";
import { callerFor, createAuthorizationPolicy } from "../musterrolle/policy.ts";
import type { InstallationProfileRecord } from "../ports/installation-profile-store.ts";
import {
  type CatalogProfile,
  type CatalogProfileConfig,
  catalogProfileConfigSchema,
  profileFingerprint,
  repositoryModeOf,
  resolveSessionCatalog,
  sessionCatalogConfigSchema,
  usesWorkspaceCeiling,
  workspaceProfileRefusal,
} from "./catalog.ts";
import {
  catalogImports,
  createProfileRegistry,
  profileCatalog,
  type SnapshotSources,
} from "./profile-registry.ts";
import {
  createWorkspaceProfileService,
  listCatalogProfiles,
  operatorSummary,
} from "./workspace-profiles.ts";

const WORKSPACE = "019a0000-0000-7000-8000-0000000000f1";
const OTHER_WORKSPACE = "019a0000-0000-7000-8000-0000000000f2";
const OWNER = "019a0000-0000-7000-8000-0000000000b1";
const AT = new Date("2026-11-05T00:00:00.000Z");

const definition = (
  overrides: Record<string, unknown> = {},
): CatalogProfileConfig =>
  catalogProfileConfigSchema.parse({
    runtime_kind: "claude_agent_sdk",
    runtime_version: "0.3.270",
    model: "claude-sonnet-5",
    tools: ["Read"],
    permission_mode: "default",
    provider: {
      kind: "litellm",
      endpoint: "https://litellm.invalid",
      auth: { kind: "api_key", value_env: "PROVIDER_KEY" },
    },
    ...overrides,
  });

const sources = (): SnapshotSources<CatalogProfile> => ({
  connections: { main: definition().provider },
  allowUnattended: false,
  runtimeSupported: () => true,
  materialize: (id, made) => {
    const profile = resolveSessionCatalog(
      { profiles: { [id]: made }, repositories: {} },
      () => "catalog-provider-key",
    ).profiles[id];
    if (!profile) throw new Error(`no ${id}`);
    return profile;
  },
});

// A console row; `overrides` may drop the repository scope or add a source.
function row(
  id: string,
  overrides: Partial<InstallationProfileRecord> = {},
): InstallationProfileRecord {
  const made = definition();
  const [entry] = catalogImports({ [id]: made });
  if (!entry) throw new Error("no entry");
  return {
    id,
    name: id,
    version: 1,
    origin: "console",
    definition: JSON.parse(JSON.stringify(made)),
    permission_mode: made.permission_mode,
    fingerprint: entry.fingerprint,
    repository_ids: [],
    github_app_repositories: "listed",
    previous_id: null,
    created_by: OWNER,
    created_at: AT,
    retired_at: null,
    retired_by: null,
    blocked_at: null,
    blocked_by: null,
    ...overrides,
  };
}

const none = { repository_ids: null, repository_scope: null } as const;

async function catalogOf(rows: InstallationProfileRecord[]) {
  const catalog = profileCatalog(
    { repositories: {} },
    createProfileRegistry({
      workspaces: { listAll: async () => [] },
      installations: { listAll: async () => rows },
      sources: sources(),
    }),
  );
  await catalog.workspace_profiles.refresh();
  return catalog;
}

describe("a row that names no repository", () => {
  test("runs, reads as optional in memory, and keeps its fingerprint", async () => {
    const catalog = await catalogOf([
      row("op_none_v1", none),
      row("op_old_v1", { repository_scope: "profile" }),
    ]);
    expect(catalog.installation.get("op_none_v1")).toMatchObject({
      state: "usable",
      repository_scope: null,
    });
    expect(repositoryModeOf(catalog.profiles.op_none_v1 ?? {})).toBe(
      "optional",
    );
    // A row from before has no key either, and means `required` as it did.
    expect(catalog.installation.get("op_old_v1")?.state).toBe("usable");
    expect(repositoryModeOf(catalog.profiles.op_old_v1 ?? {})).toBe("required");
    expect(
      profileFingerprint(catalog.profiles.op_none_v1 as CatalogProfile),
    ).toBe(profileFingerprint(catalog.profiles.op_old_v1 as CatalogProfile));
  });

  test("the workspace's ceiling judges it, as it does a workspace-scoped one", async () => {
    const catalog = await catalogOf([
      row("op_none_v1", none),
      row("op_ws_v1", { repository_scope: "workspace" }),
      row("op_old_v1", { repository_scope: "profile" }),
    ]);
    const judged = (id: string) => usesWorkspaceCeiling(catalog, id, "release");
    expect(judged("op_none_v1")).toBe(true);
    expect(judged("op_ws_v1")).toBe(true);
    expect(judged("op_old_v1")).toBe(false);
    expect(usesWorkspaceCeiling(catalog, "op_old_v1", "agent")).toBe(true);
    expect(usesWorkspaceCeiling(catalog, null, "release")).toBe(false);
  });

  test("a keyless profile in a settings file still reads as required", () => {
    const keyless = definition();
    expect(keyless.repository).toBeUndefined();
    const refused = sessionCatalogConfigSchema.safeParse({
      profiles: { coding: keyless },
      repositories: {},
    });
    expect(refused.success).toBe(false);
    expect(
      sessionCatalogConfigSchema.safeParse({
        profiles: { coding: definition({ repository: "optional" }) },
        repositories: {},
      }).success,
    ).toBe(true);
    const named = sessionCatalogConfigSchema.safeParse({
      profiles: { coding: definition({ repository: "none" }) },
      repositories: {
        app: { url: "https://example.invalid/a.git", profiles: ["coding"] },
      },
    });
    expect(named.success).toBe(false);
  });

  test("the answer right after a save carries neither repository field", async () => {
    const saved = row("op_none_v1", {
      ...none,
      display_name: "Reviewer",
      name: "wl_0b9f",
    });
    // The snapshot has not read the row yet: the answer is built from it.
    const catalog = await catalogOf([]);
    const afterSave = operatorSummary(catalog, "op_none_v1", {
      record: saved,
      connectionId: "main",
    });
    expect(afterSave).toBeDefined();
    expect(afterSave).not.toHaveProperty("repository_mode");
    expect(afterSave).not.toHaveProperty("repository_ids");
    expect(afterSave?.installation).toMatchObject({
      name: "Reviewer",
      state: "usable",
    });

    const read = await catalogOf([saved]);
    const listed = operatorSummary(read, "op_none_v1");
    expect(listed).not.toHaveProperty("repository_mode");
    expect(listed).not.toHaveProperty("repository_ids");
  });

  test("a row from before still answers with its mode", async () => {
    const catalog = await catalogOf([row("op_old_v1")]);
    expect(operatorSummary(catalog, "op_old_v1")).toMatchObject({
      repository_mode: "required",
      repository_ids: [],
    });
  });
});

describe("a block follows derived_from", () => {
  const chain = (blocked: Partial<InstallationProfileRecord> = {}) => [
    row("op_base_v1", blocked),
    row("op_mid_v1", { derived_from: "op_base_v1" }),
    row("op_leaf_v1", { derived_from: "op_mid_v1" }),
    row("op_alone_v1"),
  ];

  test("stops every version below the blocked one, and leaves them out of what runs", async () => {
    const catalog = await catalogOf(
      chain({ blocked_at: AT, blocked_by: OWNER }),
    );
    expect(catalog.installation.get("op_base_v1")?.state).toBe("blocked");
    expect(catalog.installation.get("op_mid_v1")).toMatchObject({
      state: "blocked",
      blocked_source: "op_base_v1",
    });
    expect(catalog.installation.get("op_leaf_v1")).toMatchObject({
      state: "blocked",
      blocked_source: "op_base_v1",
    });
    expect(catalog.installation.get("op_alone_v1")?.state).toBe("usable");
    expect(Object.keys(catalog.profiles)).toEqual(["op_alone_v1"]);
    // A release's session on it is refused too, retired or not.
    for (const id of ["op_mid_v1", "op_leaf_v1"]) {
      expect(
        workspaceProfileRefusal(catalog, WORKSPACE, id, {
          retiredAllowed: true,
        }),
      ).toMatchObject({ state: "blocked" });
    }
  });

  test("unblocking the source lets them run again", async () => {
    const catalog = await catalogOf(chain());
    expect(Object.keys(catalog.profiles).sort()).toEqual([
      "op_alone_v1",
      "op_base_v1",
      "op_leaf_v1",
      "op_mid_v1",
    ]);
  });

  test("a retired source does not stop what derives from it", async () => {
    const catalog = await catalogOf(
      chain({ retired_at: AT, retired_by: OWNER }),
    );
    expect(catalog.installation.get("op_base_v1")?.state).toBe("retired");
    expect(catalog.installation.get("op_leaf_v1")?.state).toBe("usable");
  });

  test("a chain that breaks, or loops, stops as well", async () => {
    const catalog = await catalogOf([
      row("op_orphan_v1", { derived_from: "op_gone_v1" }),
      row("op_a_v1", { derived_from: "op_b_v1" }),
      row("op_b_v1", { derived_from: "op_a_v1" }),
    ]);
    expect(catalog.installation.get("op_orphan_v1")).toMatchObject({
      state: "blocked",
      blocked_source: "op_gone_v1",
    });
    expect(catalog.installation.get("op_a_v1")?.state).toBe("blocked");
    expect(catalog.installation.get("op_b_v1")?.state).toBe("blocked");
    expect(catalog.profiles).toEqual({});
  });
});

describe("a workspace's own version", () => {
  const rows = () => [
    row("op_mine_v1", { workspace_id: WORKSPACE, display_name: "Mine" }),
    row("op_theirs_v1", {
      workspace_id: OTHER_WORKSPACE,
      display_name: "Theirs",
    }),
    row("op_shared_v1"),
    row("op_theirs_retired_v1", {
      workspace_id: OTHER_WORKSPACE,
      retired_at: AT,
      retired_by: OWNER,
    }),
    row("op_theirs_blocked_v1", {
      workspace_id: OTHER_WORKSPACE,
      blocked_at: AT,
      blocked_by: OWNER,
    }),
  ];

  test("reads as unknown to another workspace", async () => {
    const catalog = await catalogOf(rows());
    expect(
      workspaceProfileRefusal(catalog, WORKSPACE, "op_mine_v1"),
    ).toBeNull();
    expect(
      workspaceProfileRefusal(catalog, WORKSPACE, "op_theirs_v1"),
    ).toMatchObject({ state: "unknown" });
    expect(
      workspaceProfileRefusal(catalog, WORKSPACE, "op_shared_v1"),
    ).toBeNull();
  });

  test("cannot be the base of another workspace's narrowing", async () => {
    const catalog = await catalogOf(rows());
    const writes: unknown[] = [];
    const versions = createWorkspaceProfileService({
      authorization: createAuthorizationPolicy(),
      store: {
        listAll: async () => [],
        async create(input) {
          writes.push(input);
          throw new Error("stop after the base is accepted");
        },
        retire: async () => ({ outcome: "not_found" }),
      },
      catalog,
    });
    const manager = callerFor(
      {
        kind: "user",
        id: OWNER,
        workspace_id: WORKSPACE,
        role: "owner",
        scopes: [...scopesForRole("owner")],
      },
      { kind: "web" },
      crypto.randomUUID(),
    );
    const narrow = (base: string) =>
      versions.create(manager, {
        name: "narrow",
        base_profile_id: base,
        model: definition().model,
        models: [definition().model],
        tools: [],
        permission_mode: "default",
      });
    // Whatever state it is in, another workspace's version is unknown.
    for (const base of [
      "op_theirs_v1",
      "op_theirs_retired_v1",
      "op_theirs_blocked_v1",
    ]) {
      const refused = await narrow(base).then(
        () => null,
        (e: { details?: unknown }) => e.details,
      );
      expect(refused).toMatchObject({ reason_code: "unknown_base" });
    }
    expect(writes).toEqual([]);
    // Its own workspace's and the installation's go through to the store.
    for (const base of ["op_mine_v1", "op_shared_v1"]) {
      await expect(narrow(base)).rejects.toThrow("stop after the base");
    }
    expect(writes).toHaveLength(2);
  });

  test("is listed only to its own workspace", async () => {
    const catalog = await catalogOf(rows());
    const idsFor = (workspaceId: string | null) =>
      listCatalogProfiles(catalog, workspaceId).items.map((item) => item.id);
    expect(idsFor(WORKSPACE)).toEqual(["op_mine_v1", "op_shared_v1"]);
    expect(idsFor(OTHER_WORKSPACE)).toEqual([
      "op_shared_v1",
      "op_theirs_blocked_v1",
      "op_theirs_retired_v1",
      "op_theirs_v1",
    ]);
    expect(idsFor(null)).toEqual(["op_shared_v1"]);
  });
});
