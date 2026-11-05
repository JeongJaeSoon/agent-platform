import { describe, expect, test } from "bun:test";
import type { InstallationProfileRecord } from "../ports/installation-profile-store.ts";
import {
  type CatalogProfile,
  type CatalogProfileConfig,
  type CredentialRef,
  catalogProfileConfigSchema,
  catalogProviderSchema,
  profileFingerprint,
  resolveSessionCatalog,
} from "./catalog.ts";
import {
  type Connections,
  catalogImports,
  installationProfileSnapshot,
  type SnapshotSources,
} from "./profile-registry.ts";

const AT = new Date("2026-11-06T00:00:00.000Z");

// Parsed as the settings read parses a row, defaults filled in.
const provider = (auth: Record<string, string>) =>
  catalogProviderSchema.parse({
    kind: "anthropic",
    endpoint: "https://api.anthropic.com",
    auth: { kind: "api_key", ...auth },
  });

const made = (auth: Record<string, string>): CatalogProfileConfig =>
  catalogProfileConfigSchema.parse({
    runtime_kind: "claude_agent_sdk",
    runtime_version: "0.3.270",
    model: "claude-sonnet-5",
    tools: ["Read"],
    permission_mode: "default",
    provider: provider(auth),
  });

function rowOf(id: string, definition: CatalogProfileConfig) {
  const [entry] = catalogImports({ [id]: definition });
  if (!entry) throw new Error("no entry");
  return {
    id,
    name: null,
    version: 1,
    origin: "catalog",
    definition: JSON.parse(JSON.stringify(definition)),
    permission_mode: definition.permission_mode,
    fingerprint: entry.fingerprint,
    repository_ids: [],
    github_app_repositories: "listed",
    previous_id: null,
    created_by: null,
    created_at: AT,
    retired_at: null,
    retired_by: null,
    blocked_at: null,
    blocked_by: null,
  } satisfies InstallationProfileRecord;
}

/** What the settings read hands the registry: values by reference. */
function sourcesOver(
  connections: Connections,
  aliases: Connections,
  values: Record<string, string>,
): SnapshotSources<CatalogProfile> {
  const lookup = (ref: CredentialRef) =>
    values[
      "value_env" in ref
        ? `env:${ref.value_env}`
        : "stored" in ref
          ? ref.stored
          : `secret:${ref.secret_id}`
    ];
  return {
    connections,
    connection_aliases: aliases,
    lookup,
    allowUnattended: false,
    runtimeSupported: () => true,
    materialize: (
      id: string,
      definition: CatalogProfileConfig,
      through?: (ref: CredentialRef) => string | undefined,
    ) => {
      const profile = resolveSessionCatalog(
        { profiles: { [id]: definition }, repositories: {} },
        through ?? lookup,
      ).profiles[id];
      if (!profile) throw new Error(`no ${id}`);
      return profile;
    },
  };
}

const keyOf = (
  snapshot: ReturnType<typeof installationProfileSnapshot>,
  id: string,
) => {
  const auth = snapshot.profiles[id]?.provider.auth;
  return auth && "value" in auth ? auth.value : undefined;
};

describe("a connection moved from an env reference to a stored value", () => {
  const before = made({ value_env: "ANTHROPIC_API_KEY" });
  const STORED = "connection:anthropic";
  const moved = provider({ stored: STORED });
  const former = provider({ value_env: "ANTHROPIC_API_KEY" });

  test("a ceiling made before the move still runs, on the stored value", () => {
    const sources = sourcesOver(
      { anthropic: moved },
      { anthropic: former },
      { [STORED]: "sealed-key-value" },
    );
    const snapshot = installationProfileSnapshot(sources, [
      rowOf("coding", before),
    ]);
    expect(snapshot.installation.get("coding")?.state).toBe("usable");
    expect(snapshot.installation.get("coding")?.connection_id).toBe(
      "anthropic",
    );
    expect(keyOf(snapshot, "coding")).toBe("sealed-key-value");
  });

  test("the env value is not what it reads once moved", () => {
    const sources = sourcesOver(
      { anthropic: moved },
      { anthropic: former },
      {
        [STORED]: "sealed-key-value",
        "env:ANTHROPIC_API_KEY": "env-key-value",
      },
    );
    const snapshot = installationProfileSnapshot(sources, [
      rowOf("coding", before),
    ]);
    expect(keyOf(snapshot, "coding")).toBe("sealed-key-value");
  });

  test("the fingerprint is the same before and after the move", () => {
    const row = rowOf("coding", before);
    const sources = sourcesOver(
      { anthropic: moved },
      { anthropic: former },
      { [STORED]: "sealed-key-value" },
    );
    const after = installationProfileSnapshot(sources, [row]).profiles.coding;
    const earlier = installationProfileSnapshot(
      sourcesOver(
        { anthropic: former },
        {},
        { "env:ANTHROPIC_API_KEY": "env-key-value" },
      ),
      [row],
    ).profiles.coding;
    if (!after || !earlier) throw new Error("a ceiling did not run");
    expect(profileFingerprint(after)).toBe(profileFingerprint(earlier));
    expect(profileFingerprint(after)).toBe(row.fingerprint);
  });

  test("a ceiling made over the stored connection after the move matches it exactly", () => {
    const after = made({ stored: STORED });
    const snapshot = installationProfileSnapshot(
      sourcesOver(
        { anthropic: moved },
        { anthropic: former },
        { [STORED]: "sealed-key-value" },
      ),
      [rowOf("later", after)],
    );
    expect(snapshot.installation.get("later")?.state).toBe("usable");
    expect(keyOf(snapshot, "later")).toBe("sealed-key-value");
  });

  test("two keys on one endpoint are never mixed up", () => {
    // Connection `a` was moved from key A; connection `b` still names key B.
    const keyA = made({ value_env: "KEY_A" });
    const keyB = made({ value_env: "KEY_B" });
    const snapshot = installationProfileSnapshot(
      sourcesOver(
        {
          a: provider({ stored: "connection:a" }),
          b: provider({ value_env: "KEY_B" }),
        },
        { a: provider({ value_env: "KEY_A" }) },
        {
          "connection:a": "sealed-key-a",
          "env:KEY_A": "env-key-a",
          "env:KEY_B": "env-key-b",
        },
      ),
      [rowOf("over-a", keyA), rowOf("over-b", keyB)],
    );
    expect(snapshot.installation.get("over-a")?.connection_id).toBe("a");
    expect(snapshot.installation.get("over-b")?.connection_id).toBe("b");
    expect(keyOf(snapshot, "over-a")).toBe("sealed-key-a");
    expect(keyOf(snapshot, "over-b")).toBe("env-key-b");
  });

  test("a former provider another connection holds today is that connection's", () => {
    // `b` is now exactly what `a` was before its move: `b` wins, `a` gets
    // nothing, so no ceiling is handed a key it did not name.
    const snapshot = installationProfileSnapshot(
      sourcesOver(
        {
          a: provider({ stored: "connection:a" }),
          b: provider({ value_env: "KEY_A" }),
        },
        { a: provider({ value_env: "KEY_A" }) },
        { "connection:a": "sealed-key-a", "env:KEY_A": "env-key-a" },
      ),
      [rowOf("over-a", made({ value_env: "KEY_A" }))],
    );
    expect(snapshot.installation.get("over-a")?.connection_id).toBe("b");
    expect(keyOf(snapshot, "over-a")).toBe("env-key-a");
  });

  test("a different endpoint is still no connection", () => {
    const other = catalogProfileConfigSchema.parse({
      ...before,
      provider: {
        ...provider({ value_env: "ANTHROPIC_API_KEY" }),
        endpoint: "https://elsewhere.invalid",
      },
    });
    const snapshot = installationProfileSnapshot(
      sourcesOver(
        { anthropic: moved },
        { anthropic: former },
        { [STORED]: "sealed-key-value" },
      ),
      [rowOf("elsewhere", other)],
    );
    expect(snapshot.installation.get("elsewhere")?.state).toBe(
      "connection_missing",
    );
  });
});
