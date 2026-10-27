import { createHash, createPrivateKey } from "node:crypto";
import { isIP } from "node:net";
import {
  canonicalJson,
  credentialRefSchema,
  MCP_TOOL_PREFIX,
  mcpServerIdSchema,
  narrowOnlyPolicy,
  type ProfileDerivationPolicy,
  permissionModeSchema,
  projectSettingsSchema,
  type RepositoryMode,
  type RuntimeConfig,
  repositoryModeSchema,
  type runtimeConfigSchema,
  WORKSPACE_PROFILE_POLICY,
  type WorkspaceProfileState,
} from "@werft-ai/contracts";
import { z } from "zod";
import { type GitCredential, repoRefOf } from "../ports/forge.ts";

// Operator-registered profiles and repositories. The operator
// writes `config/profiles.yaml` and `config/repositories.yaml`; the API reads
// them once at startup (`apps/control-host/src/api/catalog-config.ts`) and refuses to
// start on anything this file rejects. A provider credential is never in the
// files: the entry names where it lives — an environment variable or a
// Secrets Manager secret — and the value is resolved once at load. Rotation
// therefore means changing the secret and restarting the API; a claim
// already answered keeps the key it was given.
//
// Only Claude profiles exist: the config block below is the Claude engine's
// shape, and a profile that names another runtime kind with it would run
// nothing. Other kinds get their own block when an adapter for them lands.

function hasControlCharacter(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

const credentialRefFields = {
  value_env: z.string().min(1).optional(),
  secret_id: z.string().min(1).optional(),
};
function credentialRef<K extends z.ZodType<string>>(kind: K) {
  return z
    .object({ kind, ...credentialRefFields })
    .strict()
    .refine(
      (auth) =>
        (auth.value_env === undefined) !== (auth.secret_id === undefined),
      { message: "name exactly one of value_env or secret_id" },
    );
}

// A credential in a URL would ride every fingerprint, snapshot and claim
// that repeats the URL; it has to come through a reference instead.
function carriesCredential(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    // scp-style `git@host:path`: the part before `@` is a login name, and a
    // password cannot be spelled in that form.
    return false;
  }
  if (url.password !== "") return true;
  const web = url.protocol === "http:" || url.protocol === "https:";
  return web && (url.username !== "" || url.search !== "");
}
const credentialFreeUrl = z
  .string()
  .min(1)
  .refine((value) => !carriesCredential(value), {
    message: "must not carry a credential (userinfo or query string)",
  });

// A worker's only way out is the HTTP(S) egress proxy, so an ssh
// git or file remote, or a non-web endpoint, would pass here and fail only
// after a session took a slot. Other transports need a route first.
function isWebUrl(value: string): boolean {
  try {
    const { protocol } = new URL(value);
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}
// The egress proxy refuses an upstream with a fragment, so one
// here would pass startup and fail every call through the route.
const webUrl = credentialFreeUrl
  .refine(isWebUrl, { message: "must be an http:// or https:// URL" })
  .refine((value) => !isWebUrl(value) || new URL(value).hash === "", {
    message: "must not carry a fragment",
  })
  // The egress proxy checks an https upstream's certificate for a name, so
  // one addressed by IP would pass here and fail every call.
  .refine(
    (value) =>
      !isWebUrl(value) ||
      new URL(value).protocol !== "https:" ||
      isIP(new URL(value).hostname.replace(/^\[|\]$/g, "")) === 0,
    { message: "https must name its host, not an address" },
  );

// `none` is the operator's word that this endpoint does not bill per token
// (a model served on their own hardware): its usage is recorded at no cost
// and no dollar limit applies to its sessions. Absent means `per_token`.
const billingSchema = z.enum(["per_token", "none"]).optional();

const catalogProviderSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("anthropic"),
      endpoint: webUrl,
      auth: credentialRef(z.literal("api_key")),
      billing: billingSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("litellm"),
      endpoint: webUrl,
      auth: credentialRef(z.enum(["api_key", "bearer"])),
      billing: billingSchema,
    })
    .strict(),
]);

const PRIVATE_NAME_SUFFIXES = [
  ".internal",
  ".local",
  ".localhost",
  ".lan",
  ".home.arpa",
];

function privateIpv4(address: string): boolean {
  const [a = 0, b = 0] = address.split(".").map(Number);
  return (
    a === 10 ||
    a === 127 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254) ||
    (a === 100 && b >= 64 && b <= 127)
  );
}

/**
 * Whether a host can only be reached inside the operator's network: a
 * private address, or a name public DNS does not serve (a compose service,
 * `*.internal`). Necessary for `billing: none`, not sufficient: a private
 * gateway may still front a paid API, which is the operator's to rule out.
 */
export function isPrivateEndpointHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  switch (isIP(host)) {
    case 4:
      return privateIpv4(host);
    // fc00::/7 and fe80::/10, written out to a full first group.
    case 6:
      return (
        host === "::1" || /^(f[cd][0-9a-f]{2}|fe[89ab][0-9a-f]):/.test(host)
      );
  }
  const name = host.replace(/\.$/, "");
  return (
    !name.includes(".") ||
    PRIVATE_NAME_SUFFIXES.some((suffix) => name.endsWith(suffix))
  );
}
export const catalogProfileConfigSchema = z
  .object({
    runtime_kind: z.literal("claude_agent_sdk"),
    runtime_version: z.string().min(1),
    model: z.string().min(1),
    // Other models a session may name at create; `model` is the default.
    // Not part of what a session is pinned to, so adding one stops nothing.
    models: z.array(z.string().min(1)).min(1).optional(),
    // The model that names a session after its first turn; the session's own
    // when absent. Not pinned either: it never runs the session.
    title_model: z.string().min(1).optional(),
    tools: z.array(z.string().min(1)),
    permission_mode: permissionModeSchema,
    provider: catalogProviderSchema,
    // Off unless the operator turns it on: a profile written before this
    // field existed keeps the run it was reviewed for.
    project_settings: projectSettingsSchema.default({ claude_md: false }),
    repository: repositoryModeSchema.default("required"),
  })
  .strict()
  .refine(
    (profile) =>
      profile.repository !== "none" || !profile.project_settings.claude_md,
    {
      message:
        "a profile with repository none has no repository CLAUDE.md to read",
      path: ["project_settings", "claude_md"],
    },
  )
  .refine(
    (profile) =>
      profile.provider.billing !== "none" ||
      !isWebUrl(profile.provider.endpoint) ||
      isPrivateEndpointHost(new URL(profile.provider.endpoint).hostname),
    {
      message:
        "billing none needs an endpoint on a private address or a name public DNS does not serve",
      path: ["provider", "billing"],
    },
  );

// How the egress proxy logs in to the repository host for this
// repository's read-only route. `basic` carries a login (Gitea and
// GitHub take a token as the password; a GitHub PAT goes under the username
// `x-access-token`); `bearer` carries none. The value is
// never handed to a worker: what a worker holds is an attempt-scoped token
// for the proxy's route. Give it a read-only, non-admin account.
const staticRepositoryAuthSchema = z
  .object({
    kind: z.enum(["basic", "bearer"]),
    // Joined as `username:value` for basic auth, so no colon of its own.
    username: z
      .string()
      .min(1)
      .refine((name) => !name.includes(":") && !hasControlCharacter(name), {
        message: "must not hold a colon or a control character",
      })
      .optional(),
    ...credentialRefFields,
  })
  .strict()
  .refine(
    (auth) => (auth.value_env === undefined) !== (auth.secret_id === undefined),
    { message: "name exactly one of value_env or secret_id" },
  )
  .refine((auth) => (auth.kind === "basic") === (auth.username !== undefined), {
    message: "basic needs a username and bearer takes none",
    path: ["username"],
  });

// A GitHub App installation: the API signs a JWT with the App's private key
// (the referenced value, a PEM) and trades it for an installation token
// scoped to this one repository and the access a route needs.
export const GITHUB_API_BASE = "https://api.github.com";
const githubAppAuthSchema = z
  .object({
    kind: z.literal("github_app"),
    app_id: z.number().int().positive(),
    installation_id: z.number().int().positive(),
    ...credentialRefFields,
    // GHES: `https://<host>/api/v3`. The JWT and the token cross it, so
    // plain http only to a host inside the operator's network.
    api_base: webUrl
      .refine(
        (value) =>
          !isWebUrl(value) ||
          new URL(value).protocol === "https:" ||
          isPrivateEndpointHost(new URL(value).hostname),
        { message: "must be https unless the host is private" },
      )
      .default(GITHUB_API_BASE),
  })
  .strict()
  .refine(
    (auth) => (auth.value_env === undefined) !== (auth.secret_id === undefined),
    { message: "name exactly one of value_env or secret_id" },
  );

const catalogRepositoryAuthSchema = z.discriminatedUnion("kind", [
  staticRepositoryAuthSchema,
  githubAppAuthSchema,
]);

// A repository lists the profiles allowed to run against it. The pair is
// the unit of trust: a profile that lets the repository's
// CLAUDE.md into the system prompt must not carry that trust to a
// repository whose authors it was never granted for. Checked at create and
// again at claim.
export const catalogRepositorySchema = z
  .object({
    url: webUrl,
    branch: z.string().min(1),
    profiles: z.array(z.string().min(1)).min(1),
    // Absent for a repository anyone may read.
    auth: catalogRepositoryAuthSchema.optional(),
  })
  .strict()
  .refine(
    (repository) =>
      repository.auth?.kind !== "github_app" ||
      repoRefOf(repository.url) !== null,
    {
      message: "github_app needs a URL of the form <host>/<owner>/<name>",
      path: ["url"],
    },
  );

// A remote MCP server an agent card may name. The operator fixes the
// pairing of server, credential and workspaces here: a card names only the
// server, so it cannot point one server's credential at another URL, and
// an admin elsewhere who binds the same credential name gets nothing. The
// value reaches only the egress proxy, as a bearer on the session's MCP
// route. Workspaces are named by slug, which never changes.
export const catalogMcpServerSchema = z
  .object({
    url: webUrl.refine(
      (value) => !isWebUrl(value) || new URL(value).search === "",
      { message: "must not carry a query" },
    ),
    credential_ref: credentialRefSchema,
    auth: credentialRef(z.literal("bearer")),
    workspaces: z
      .array(z.string().min(1))
      .min(1)
      .refine((slugs) => new Set(slugs).size === slugs.length, {
        message: "must not repeat a workspace",
      }),
  })
  .strict();

export const WORKSPACE_PROFILE_PREFIX = "ws_";

function nonEmpty<T extends z.ZodType>(record: T, what: string) {
  return record.refine(
    (value) => Object.keys(value as object).length > 0,
    `at least one ${what} is required`,
  );
}

export const sessionCatalogConfigSchema = z
  .object({
    profiles: nonEmpty(
      z.record(z.string().min(1), catalogProfileConfigSchema),
      "profile",
    ),
    repositories: z.record(z.string().min(1), catalogRepositorySchema),
    mcp_servers: z.record(mcpServerIdSchema, catalogMcpServerSchema).optional(),
  })
  .strict()
  .superRefine((config, ctx) => {
    for (const id of Object.keys(config.profiles)) {
      if (id.startsWith(WORKSPACE_PROFILE_PREFIX)) {
        ctx.addIssue({
          code: "custom",
          path: ["profiles", id],
          message: `profile ids starting with ${WORKSPACE_PROFILE_PREFIX} are the workspace profiles' own`,
        });
      }
    }
    if (
      Object.keys(config.repositories).length === 0 &&
      Object.values(config.profiles).every(
        (profile) => profile.repository === "required",
      )
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["repositories"],
        message:
          "at least one repository is required unless a profile's repository is optional or none",
      });
    }
    for (const [id, repository] of Object.entries(config.repositories)) {
      repository.profiles.forEach((profileId, index) => {
        if (!Object.hasOwn(config.profiles, profileId)) {
          ctx.addIssue({
            code: "custom",
            path: ["repositories", id, "profiles", index],
            message: `names profile ${profileId}, which is not in profiles`,
          });
        } else if (config.profiles[profileId]?.repository === "none") {
          ctx.addIssue({
            code: "custom",
            path: ["repositories", id, "profiles", index],
            message: `names profile ${profileId}, whose repository is none`,
          });
        }
      });
    }
  });

export type SessionCatalogConfig = z.infer<typeof sessionCatalogConfigSchema>;
export type CatalogProfileConfig = z.infer<typeof catalogProfileConfigSchema>;
export type CatalogRepositoryConfig = z.infer<typeof catalogRepositorySchema>;
export type RepositoryCredential =
  | { kind: "basic"; username: string; value: string; ref: CredentialRef }
  | { kind: "bearer"; value: string; ref: CredentialRef }
  | {
      kind: "github_app";
      app_id: number;
      installation_id: number;
      api_base: string;
      /** The App's private key, PEM. */
      value: string;
      ref: CredentialRef;
    };
export type CatalogRepository = Omit<CatalogRepositoryConfig, "auth"> & {
  auth?: RepositoryCredential | undefined;
};
export type CredentialRef = { value_env: string } | { secret_id: string };

// What the services hold: each credential resolved, its reference kept so
// the fingerprint can name where it came from without the value.
export type CatalogProfile = {
  runtime_kind: "claude_agent_sdk";
  runtime_version: string;
  model: string;
  models?: string[] | undefined;
  title_model?: string | undefined;
  tools: string[];
  permission_mode: z.infer<typeof permissionModeSchema>;
  project_settings?: z.infer<typeof projectSettingsSchema> | undefined;
  // Absent is `required`, never spelled out: see `repositoryModeOf`.
  repository?: Exclude<RepositoryMode, "required"> | undefined;
  provider:
    | {
        kind: "anthropic";
        endpoint: string;
        auth: { kind: "api_key"; value: string; ref: CredentialRef };
        billing?: "none" | undefined;
      }
    | {
        kind: "litellm";
        endpoint: string;
        billing?: "none" | undefined;
        auth: {
          kind: "api_key" | "bearer";
          value: string;
          ref: CredentialRef;
        };
      };
};

export type CatalogMcpServer = Omit<
  z.infer<typeof catalogMcpServerSchema>,
  "auth"
> & { auth: { kind: "bearer"; value: string; ref: CredentialRef } };

export type SessionCatalog = {
  profiles: Record<string, CatalogProfile>;
  repositories: Record<string, CatalogRepository>;
  mcp_servers?: Record<string, CatalogMcpServer>;
  workspace_profiles?: WorkspaceProfiles;
};

/**
 * A version of a workspace profile as stored: an operator profile narrowed
 * by an owner or admin. Nothing in it changes but `retired_at`.
 */
export type WorkspaceProfileRecord = {
  id: string;
  workspace_id: string;
  name: string;
  version: number;
  base_profile_id: string;
  // `profileFingerprint` of the base when the version was made: a version
  // runs only while its base still hashes to this.
  base_fingerprint: string;
  model: string;
  models: string[];
  tools: string[];
  permission_mode: z.infer<typeof permissionModeSchema>;
  // The base as it was, for listing a version whose base the operator removed.
  base_runtime_version: string;
  base_billing: "metered" | "none";
  base_repository_mode: RepositoryMode;
  created_at: Date;
  retired_at: Date | null;
};

/**
 * The workspace profiles this process has read. The database holds them, so
 * a version another replica made shows here only after `refresh`.
 */
export interface WorkspaceProfiles {
  readonly records: ReadonlyMap<string, WorkspaceProfileRecord>;
  /** How its versions may differ from their bases; `WORKSPACE_PROFILE_POLICY` when unset. */
  readonly policy?: ProfileDerivationPolicy;
  /** Reads them again unless the last read began within `maxAgeMs`. */
  refresh(maxAgeMs?: number): Promise<void>;
}

type ProviderView<P> = P extends { auth: infer A }
  ? Omit<P, "auth"> & { auth: Omit<A, "value"> }
  : never;

/**
 * A profile as session admission reads it: every setting and where its
 * credential comes from, never the credential. A `CatalogProfile` is one.
 */
export type CatalogProfileView = Omit<CatalogProfile, "provider"> & {
  provider: ProviderView<CatalogProfile["provider"]>;
};
export type CatalogRepositoryView = Omit<CatalogRepository, "auth">;

/**
 * The catalog without credential values: what creating a session and
 * appending to one read. A `SessionCatalog` is one; `sessionCatalogView`
 * builds one from the config for a process that holds no provider key.
 */
export type SessionCatalogView = {
  profiles: Record<string, CatalogProfileView>;
  repositories: Record<string, CatalogRepositoryView>;
  workspace_profiles?: WorkspaceProfiles;
};

/** A remote MCP server the session's agent release names, as claimed. */
export type SessionMcp = {
  releaseId: string;
  server: string;
  /** The release's `mcp__<server>__*` tools pinned `allow`. */
  tools: string[];
};

/**
 * What an MCP egress token is held to: the release, and the server's URL
 * and credential name as the catalog had them at the claim. A catalog edit
 * since refuses the route, and the checkpoint fingerprint names this in
 * place of the token, so a server or credential renamed makes another
 * digest.
 */
export function mcpBinding(
  releaseId: string,
  serverId: string,
  server: Pick<CatalogMcpServer, "url" | "credential_ref">,
): string {
  return sha256({
    release_id: releaseId,
    server_id: serverId,
    url: server.url,
    credential_ref: server.credential_ref,
  });
}

/** Where the MCP route goes and the service account it calls as. */
export function mcpUpstreamOf(server: CatalogMcpServer): EgressUpstream {
  return {
    url: server.url,
    headers: [["authorization", `Bearer ${server.auth.value}`]],
  };
}

/** The release's MCP tools a session runs: its `allow` pins for the server. */
export function pinnedMcpTools(
  serverId: string,
  perTool: Readonly<Record<string, string>>,
): string[] {
  const prefix = `${MCP_TOOL_PREFIX}${serverId}__`;
  return Object.entries(perTool)
    .filter(
      ([tool, policy]) =>
        tool.startsWith(prefix) &&
        tool.length > prefix.length &&
        policy === "allow",
    )
    .map(([tool]) => tool)
    .sort();
}

/**
 * The runtime config a claim hands over, with the session's MCP server when
 * its release names one: the current config and every restore config go
 * through here, so a checkpoint made with the server is restorable on the
 * same terms.
 */
export function runtimeConfigWithMcp(
  config: RuntimeConfig,
  mcp: { name: string; endpoint: string; binding: string; tools: string[] },
  token: string,
): RuntimeConfig {
  return {
    ...config,
    tools: [...config.tools, ...mcp.tools],
    mcp_servers: [
      {
        name: mcp.name,
        endpoint: mcp.endpoint,
        binding: mcp.binding,
        access: { kind: "egress_token", token },
      },
    ],
  };
}

/**
 * The provider as the worker protocol carries it: where the proxy
 * will send the engine's requests, and the attempt's token for that route.
 * The credential stays here; `providerUpstreamOf` is what the proxy gets.
 */
export function runtimeProviderOf(
  profile: CatalogProfile,
  token: string,
): z.infer<typeof runtimeConfigSchema.shape.provider> {
  return {
    kind: profile.provider.kind,
    endpoint: profile.provider.endpoint,
    auth: { kind: "egress_token", token },
  };
}

/**
 * The profile as a claim hands it to the worker, which hashes it into the
 * checkpoint fingerprint; `scripts/lib/checkpoint-pins.ts` rebuilds it to ask
 * a target image for that digest. A session without a repository has no
 * CLAUDE.md to read, whatever an `optional` profile says.
 */
export function runtimeConfigOf(
  profile: CatalogProfile,
  providerToken: string,
  hasRepository: boolean,
): RuntimeConfig {
  return {
    model: profile.model,
    tools: profile.tools,
    permission_mode: profile.permission_mode,
    provider: runtimeProviderOf(profile, providerToken),
    ...(hasRepository && profile.project_settings?.claude_md === true
      ? { project_settings: profile.project_settings }
      : {}),
  };
}

/** One request the egress proxy makes on a worker's behalf. */
export type EgressUpstream = {
  /** The base the route's path is appended to. */
  url: string;
  /** Set on the upstream request, replacing whatever the worker sent. */
  headers: Array<[string, string]>;
};

export function repositoryModeOf(profile: CatalogProfileView): RepositoryMode {
  return profile.repository ?? "required";
}

/** Where a profile id is looked up: the operator's, then the workspaces'. */
export type ProfileLookup<P extends CatalogProfileView> = {
  profiles: Readonly<Record<string, P>>;
  workspace_profiles?: WorkspaceProfiles | undefined;
};

export type ProfileNarrowing = Pick<
  WorkspaceProfileRecord,
  "model" | "models" | "tools" | "permission_mode"
>;

export function derivationPolicyOf(catalog: {
  workspace_profiles?: WorkspaceProfiles | undefined;
}): ProfileDerivationPolicy {
  return catalog.workspace_profiles?.policy ?? WORKSPACE_PROFILE_POLICY;
}

/**
 * Why `narrowing` would widen `base`, naming the request field, or null when
 * every value is the base's or narrower.
 */
export function narrowingRefusal(
  base: CatalogProfileView,
  narrowing: ProfileNarrowing,
): { field: keyof ProfileNarrowing; message: string } | null {
  return narrowOnlyPolicy.refusal(base, narrowing);
}

/** Whether a workspace profile version takes new releases and sessions. */
export function workspaceProfileState(
  catalog: ProfileLookup<CatalogProfileView>,
  record: WorkspaceProfileRecord,
): WorkspaceProfileState {
  if (record.retired_at !== null) return "retired";
  const base = Object.hasOwn(catalog.profiles, record.base_profile_id)
    ? catalog.profiles[record.base_profile_id]
    : undefined;
  if (!base) return "base_missing";
  return baseHolds(derivationPolicyOf(catalog), base, record)
    ? "usable"
    : "base_changed";
}

function baseHolds(
  policy: ProfileDerivationPolicy,
  base: CatalogProfileView,
  record: WorkspaceProfileRecord,
): boolean {
  return (
    profileFingerprint(base) === record.base_fingerprint &&
    policy.refusal(base, record) === null
  );
}

/**
 * The profile an id runs: the operator's entry, or a workspace version over
 * its base. A version whose base changed since it was made runs nothing, as
 * an operator profile edited in place does; a retired one still runs what
 * already uses it.
 */
export function catalogProfile<P extends CatalogProfileView>(
  catalog: ProfileLookup<P>,
  profileId: string,
): P | undefined {
  if (Object.hasOwn(catalog.profiles, profileId)) {
    return catalog.profiles[profileId];
  }
  const record = catalog.workspace_profiles?.records.get(profileId);
  if (!record) return undefined;
  const base = Object.hasOwn(catalog.profiles, record.base_profile_id)
    ? catalog.profiles[record.base_profile_id]
    : undefined;
  const policy = derivationPolicyOf(catalog);
  return base && baseHolds(policy, base, record)
    ? policy.apply(base, record)
    : undefined;
}

/** Every workspace version that runs now, with the operator profile it narrows. */
export function workspaceCatalogProfiles<P extends CatalogProfileView>(
  catalog: ProfileLookup<P>,
): Array<{ id: string; baseId: string; profile: P }> {
  return [...(catalog.workspace_profiles?.records.values() ?? [])].flatMap(
    (record) => {
      const profile = catalogProfile(catalog, record.id);
      return profile
        ? [{ id: record.id, baseId: record.base_profile_id, profile }]
        : [];
    },
  );
}

/**
 * Why `workspaceId` may not name `profileId` for a new release or session,
 * or null when it may. Another workspace's version reads as unknown.
 * `retiredAllowed`: a session of a release already made on a retired
 * version still starts.
 */
export function workspaceProfileRefusal(
  catalog: ProfileLookup<CatalogProfileView>,
  workspaceId: string,
  profileId: string,
  options: { retiredAllowed?: boolean } = {},
): { state: WorkspaceProfileState | "unknown"; message: string } | null {
  if (!profileId.startsWith(WORKSPACE_PROFILE_PREFIX)) return null;
  const record = catalog.workspace_profiles?.records.get(profileId);
  if (!record || record.workspace_id !== workspaceId) {
    return { state: "unknown", message: `Unknown profile ${profileId}` };
  }
  const state = workspaceProfileState(catalog, record);
  if (state === "usable" || (state === "retired" && options.retiredAllowed)) {
    return null;
  }
  return {
    state,
    message:
      state === "retired"
        ? `Profile ${profileId} is retired: pick a newer version`
        : `The operator changed or removed the base of profile ${profileId}: make a new version`,
  };
}

const WORKSPACE_PROFILE_KNOWN_MAX_AGE_MS = 1000;

/**
 * Brings the workspace versions among `profileIds` up to date enough to
 * resolve them. A failed read keeps what was read before: an operator
 * profile never waits on the database. `strict` throws it instead, for a
 * new use of a version, which a retirement elsewhere must stop.
 */
export async function refreshWorkspaceProfilesFor(
  catalog: Pick<ProfileLookup<CatalogProfileView>, "workspace_profiles">,
  profileIds: ReadonlyArray<string | null | undefined>,
  options: { strict?: boolean } = {},
): Promise<void> {
  const registry = catalog.workspace_profiles;
  const named = profileIds.filter(
    (id): id is string => id?.startsWith(WORKSPACE_PROFILE_PREFIX) === true,
  );
  if (!registry || named.length === 0) return;
  const unread = named.some((id) => !registry.records.has(id));
  const read = registry.refresh(
    unread ? 0 : WORKSPACE_PROFILE_KNOWN_MAX_AGE_MS,
  );
  await (options.strict ? read : read.catch(() => undefined));
}

function trustedProfileId(
  catalog: ProfileLookup<CatalogProfileView>,
  profileId: string,
): string {
  return (
    catalog.workspace_profiles?.records.get(profileId)?.base_profile_id ??
    profileId
  );
}

/** Whether every session of the profile names a repository; false for an unknown profile. */
export function profileNeedsRepository(
  catalog: ProfileLookup<CatalogProfileView>,
  profileId: string,
): boolean {
  const profile = catalogProfile(catalog, profileId);
  return profile !== undefined && repositoryModeOf(profile) === "required";
}

/** Whether the profile declared `billing: none`: no cost, no dollar limit. */
export function isUnmetered(profile: CatalogProfileView): boolean {
  return profile.provider.billing === "none";
}

/** Where a provider route goes and how it authenticates there. */
export function providerUpstreamOf(profile: CatalogProfile): EgressUpstream {
  const { auth, endpoint } = profile.provider;
  return {
    url: endpoint,
    headers:
      auth.kind === "bearer"
        ? [["authorization", `Bearer ${auth.value}`]]
        : [["x-api-key", auth.value]],
  };
}

/**
 * Where a repository route goes and how it authenticates there. A forge
 * repository's credential is issued per request (`ForgeAdapter.gitCredential`)
 * and passed in; the others are the catalog's own.
 */
export function repositoryUpstreamOf(
  repository: CatalogRepository,
  issued?: GitCredential,
): EgressUpstream {
  const { auth, url } = repository;
  if (issued !== undefined) {
    return { url, headers: [["authorization", basicAuthorization(issued)]] };
  }
  if (auth === undefined) return { url, headers: [] };
  if (auth.kind === "github_app") {
    throw new Error("a github_app repository needs an issued credential");
  }
  return {
    url,
    headers: [
      [
        "authorization",
        auth.kind === "basic"
          ? basicAuthorization({
              username: auth.username,
              password: auth.value,
            })
          : `Bearer ${auth.value}`,
      ],
    ],
  };
}

function basicAuthorization(login: { username: string; password: string }) {
  return `Basic ${Buffer.from(`${login.username}:${login.password}`, "utf8").toString("base64")}`;
}

function withoutRepositorySecret(repository: CatalogRepository) {
  if (repository.auth === undefined) return repository;
  const { value: _value, ...auth } = repository.auth;
  return { ...repository, auth };
}

function withoutSecret(profile: CatalogProfileView) {
  const {
    value: _value,
    ...auth
  }: CatalogProfileView["provider"]["auth"] & { value?: unknown } =
    profile.provider.auth;
  return { ...profile, provider: { ...profile.provider, auth } };
}

function sha256(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalJson(value), "utf8").digest("hex")}`;
}

// Bumped when the hashed shape changes, so an old value can never equal a
// new one by accident.
const BINDING_FINGERPRINT_VERSION = 1;

// 2: the model and the repository mode left the hash; they live in the
// row's `model` and `repository_mode`.
const PROFILE_FINGERPRINT_VERSION = 2;

/**
 * Identifies what a profile runs apart from which of its models: every
 * setting and where its credential comes from, never the credential. Two ids
 * with the same settings share one. This is not the checkpoint fingerprint
 * (which also covers the owner, the model and the engine's components); a
 * session snapshots this one together with its model.
 */
export function profileFingerprint(profile: CatalogProfileView): string {
  const {
    models: _models,
    model: _model,
    repository: _repository,
    title_model: _titleModel,
    ...runs
  } = withoutSecret(profile);
  return sha256({
    fingerprint_version: PROFILE_FINGERPRINT_VERSION,
    profile: runs,
  });
}

function profileFingerprintV1(profile: CatalogProfileView): string {
  const {
    models: _models,
    title_model: _titleModel,
    ...runs
  } = withoutSecret(profile);
  return sha256({ fingerprint_version: 1, profile: runs });
}

/** The models a session of this profile may name, the default first. */
export function profileModels(profile: CatalogProfileView): string[] {
  return [...new Set([profile.model, ...(profile.models ?? [])])];
}

/**
 * The profile as a session that named `model` runs it, or null when the
 * profile does not offer that model. Everything downstream — fingerprint,
 * runtime config, egress route — takes this, never the catalog entry.
 */
export function profileWithModel<P extends CatalogProfileView>(
  profile: P,
  model: string = profile.model,
): P | null {
  if (!profileModels(profile).includes(model)) return null;
  const { models: _models, ...rest } = profile;
  return { ...rest, model } as unknown as P;
}

/** What a row holds a profile to: its fingerprint and the model it names. */
export type ProfilePin = {
  fingerprint: string | null;
  model: string | null;
};

// The model `fingerprint` pins this profile to: the row's for version 2, the
// one a version 1 fingerprint was taken with. Undefined when the profile no
// longer hashes to it.
function pinnedModel(
  profile: CatalogProfileView,
  pin: ProfilePin & { fingerprint: string },
): string | null | undefined {
  if (pin.fingerprint === profileFingerprint(profile)) return pin.model;
  return profileModels(profile).find((model) => {
    const runs = profileWithModel(profile, model);
    return runs !== null && profileFingerprintV1(runs) === pin.fingerprint;
  });
}

/**
 * Whether `fingerprint` still names this profile's settings, under either
 * version, whichever model it was taken with. What a release digest is held
 * to: it runs no model of its own.
 */
export function profilePinned(
  profile: CatalogProfileView,
  fingerprint: string,
): boolean {
  return pinnedModel(profile, { fingerprint, model: null }) !== undefined;
}

/**
 * The profile a row pinned to `pin` runs, or null when none does (the model
 * was taken off the list, or the profile changed). A row from before the pin
 * runs the default model, which its first claim then pins.
 */
export function sessionProfile<P extends CatalogProfileView>(
  profile: P,
  pin: ProfilePin,
): P | null {
  if (pin.fingerprint === null) return profileWithModel(profile);
  const model = pinnedModel(profile, { ...pin, fingerprint: pin.fingerprint });
  return model == null ? null : profileWithModel(profile, model);
}

/**
 * The model a row pinned to `fingerprint` under `profileId` runs, as far as
 * the fingerprint itself says: a version 1 one names it, a version 2 one
 * leaves it to the row. Null when it does not say or the catalog moved.
 */
export function fingerprintModel(
  catalog: ProfileLookup<CatalogProfileView>,
  profileId: string,
  fingerprint: string,
): string | null {
  const profile = catalogProfile(catalog, profileId);
  if (!profile) return null;
  return sessionProfile(profile, { fingerprint, model: null })?.model ?? null;
}

/**
 * Every pin a row of this profile may hold, its default model first: the
 * version 2 fingerprint once per offered model, then each model's version 1
 * fingerprint, which names its model itself (`model` null: any row model).
 */
export function profilePins(
  profile: CatalogProfileView,
): Array<{ fingerprint: string; model: string | null }> {
  const models = profileModels(profile);
  const current = profileFingerprint(profile);
  return [
    ...models.map((model) => ({ fingerprint: current, model })),
    ...models.flatMap((model) => {
      const runs = profileWithModel(profile, model);
      return runs
        ? [{ fingerprint: profileFingerprintV1(runs), model: null }]
        : [];
    }),
  ];
}

/**
 * What a repository route is authorized against: the entry's URL, branch
 * and where its credential comes from, never the credential. A token issued
 * under one binding stops working if the entry is re-pointed, while the
 * value behind the same reference may still be rotated.
 */
export function repositoryBinding(
  id: string,
  repository: CatalogRepository,
): string {
  return sha256({
    fingerprint_version: BINDING_FINGERPRINT_VERSION,
    id,
    repository: withoutRepositorySecret(repository),
  });
}

/**
 * The operator's catalog as loaded, without workspace versions, for audit
 * and logs: it moves whenever any operator profile or repository does, so it
 * is not what a session should be matched against (an unrelated edit would
 * fail every claim).
 */
export function catalogRevision(catalog: SessionCatalog): string {
  return sha256({
    fingerprint_version: BINDING_FINGERPRINT_VERSION,
    profiles: Object.fromEntries(
      Object.entries(catalog.profiles).map(([id, profile]) => [
        id,
        withoutSecret(profile),
      ]),
    ),
    repositories: Object.fromEntries(
      Object.entries(catalog.repositories).map(([id, repository]) => [
        id,
        withoutRepositorySecret(repository),
      ]),
    ),
  });
}

/** The pair a session may run as, or null when the catalog forbids it. */
export function allowedPair<
  P extends CatalogProfileView,
  R extends CatalogRepositoryView,
>(
  catalog: ProfileLookup<P> & { repositories: Record<string, R> },
  profileId: string,
  repositoryId: string,
): { profile: P; repository: R } | null {
  const profile = catalogProfile(catalog, profileId);
  const repository = Object.hasOwn(catalog.repositories, repositoryId)
    ? catalog.repositories[repositoryId]
    : undefined;
  if (
    !profile ||
    !repository ||
    !repository.profiles.includes(trustedProfileId(catalog, profileId))
  ) {
    return null;
  }
  return { profile, repository };
}

/**
 * What a session may run as: `allowedPair` for one with a repository, and
 * for one without (`repositoryId` null) the profile alone, when its
 * repository mode lets a session go without one. Null when the catalog
 * forbids it.
 */
export function allowedRun<
  P extends CatalogProfileView,
  R extends CatalogRepositoryView,
>(
  catalog: ProfileLookup<P> & { repositories: Record<string, R> },
  profileId: string,
  repositoryId: string | null,
): { profile: P; repository: R | null } | null {
  if (repositoryId !== null)
    return allowedPair(catalog, profileId, repositoryId);
  const profile = catalogProfile(catalog, profileId);
  return profile && repositoryModeOf(profile) !== "required"
    ? { profile, repository: null }
    : null;
}

export function credentialRefOf(auth: {
  value_env?: string | undefined;
  secret_id?: string | undefined;
}): CredentialRef {
  return auth.value_env !== undefined
    ? { value_env: auth.value_env }
    : { secret_id: auth.secret_id as string };
}

export class CatalogCredentialError extends Error {
  /** `path` is where the reference sits, e.g. `profiles.<id>.provider.auth`. */
  constructor(
    readonly path: string,
    readonly ref: CredentialRef,
    reason = "is not set",
  ) {
    super(
      "value_env" in ref
        ? `${path}.value_env: ${ref.value_env} ${reason}`
        : `${path}.secret_id: ${ref.secret_id} ${reason}`,
    );
  }
}

/** Every credential reference in the catalog, with where it sits. */
export function catalogCredentialRefs(
  config: SessionCatalogConfig,
): Array<{ path: string; ref: CredentialRef }> {
  const refs: Array<{ path: string; ref: CredentialRef }> = [];
  for (const [id, profile] of Object.entries(config.profiles)) {
    const { kind: _kind, ...fields } = profile.provider.auth;
    refs.push({
      path: `profiles.${id}.provider.auth`,
      ref: credentialRefOf(fields),
    });
  }
  for (const [id, repository] of Object.entries(config.repositories)) {
    if (repository.auth === undefined) continue;
    refs.push({
      path: `repositories.${id}.auth`,
      ref: credentialRefOf(repository.auth),
    });
  }
  for (const [id, server] of Object.entries(config.mcp_servers ?? {})) {
    refs.push({
      path: `mcp_servers.${id}.auth`,
      ref: credentialRefOf(server.auth),
    });
  }
  return refs;
}

/**
 * The egress proxy watches its responses for the value it injected, and a
 * streamed body is only checked for values at least this long (shorter ones
 * turn up in pack data by chance). A shorter credential would pass through
 * unchecked, so it is refused here instead.
 */
export const MIN_CREDENTIAL_BYTES = 8;

/**
 * The catalog without credential values, read from the config alone: no
 * reference is looked up, so it needs no key and fails on none.
 */
export function sessionCatalogView(
  config: SessionCatalogConfig,
): SessionCatalogView {
  const profiles: Record<string, CatalogProfileView> = {};
  for (const [id, profile] of Object.entries(config.profiles)) {
    const { kind, ...refFields } = profile.provider.auth;
    const { billing, ...provider } = profile.provider;
    const { repository, ...settings } = profile;
    profiles[id] = {
      ...settings,
      provider: {
        ...provider,
        auth: { kind, ref: credentialRefOf(refFields) },
        ...(billing === "none" ? { billing } : {}),
      },
      ...(repository === "required" ? {} : { repository }),
    } as CatalogProfileView;
  }
  const repositories: Record<string, CatalogRepositoryView> = {};
  for (const [id, repository] of Object.entries(config.repositories)) {
    const { auth: _auth, ...rest } = repository;
    repositories[id] = rest;
  }
  return { profiles, repositories };
}

/**
 * The resolved catalog. `lookup` hands back each reference's value, already
 * fetched (a Secrets Manager read is the loader's job, not this pure step);
 * an absent or empty value fails naming where the reference sits, never a
 * value.
 */
export function resolveSessionCatalog(
  config: SessionCatalogConfig,
  lookup: (ref: CredentialRef) => string | undefined,
): SessionCatalog {
  const resolved = (path: string, ref: CredentialRef): string => {
    const value = lookup(ref);
    if (!value) throw new CatalogCredentialError(path, ref);
    // It goes into a header as it is (or base64'd with the login): a
    // trailing newline from `echo` into a secret, say, would pass here and
    // be refused by the egress proxy on every call.
    if (hasControlCharacter(value) || value.trim() !== value) {
      throw new CatalogCredentialError(
        path,
        ref,
        "has a control character or surrounding whitespace",
      );
    }
    if (Buffer.byteLength(value, "utf8") < MIN_CREDENTIAL_BYTES) {
      throw new CatalogCredentialError(
        path,
        ref,
        `is shorter than ${MIN_CREDENTIAL_BYTES} bytes`,
      );
    }
    return value;
  };
  const profiles: Record<string, CatalogProfile> = {};
  for (const [id, profile] of Object.entries(
    sessionCatalogView(config).profiles,
  )) {
    const { auth } = profile.provider;
    const value = resolved(`profiles.${id}.provider.auth`, auth.ref);
    profiles[id] = {
      ...profile,
      provider: { ...profile.provider, auth: { ...auth, value } },
    } as CatalogProfile;
  }
  const repositories: Record<string, CatalogRepository> = {};
  for (const [id, repository] of Object.entries(config.repositories)) {
    const { auth, ...rest } = repository;
    if (auth === undefined) {
      repositories[id] = rest;
      continue;
    }
    const ref = credentialRefOf(auth);
    const path = `repositories.${id}.auth`;
    if (auth.kind === "github_app") {
      repositories[id] = {
        ...rest,
        auth: {
          kind: "github_app",
          app_id: auth.app_id,
          installation_id: auth.installation_id,
          api_base: auth.api_base,
          value: privateKeyPem(path, ref, lookup(ref)),
          ref,
        },
      };
      continue;
    }
    const value = resolved(path, ref);
    repositories[id] = {
      ...rest,
      auth:
        auth.kind === "basic"
          ? { kind: "basic", username: auth.username ?? "", value, ref }
          : { kind: "bearer", value, ref },
    };
  }
  if (config.mcp_servers === undefined) return { profiles, repositories };
  const mcp_servers: Record<string, CatalogMcpServer> = {};
  for (const [id, server] of Object.entries(config.mcp_servers)) {
    const ref = credentialRefOf(server.auth);
    mcp_servers[id] = {
      ...server,
      auth: {
        kind: "bearer",
        value: resolved(`mcp_servers.${id}.auth`, ref),
        ref,
      },
    };
  }
  return { profiles, repositories, mcp_servers };
}

// A PEM spans lines, which an environment variable often carries as `\n`
// escapes. Parsed here so a key that cannot sign fails startup, not the
// first clone.
function privateKeyPem(
  path: string,
  ref: CredentialRef,
  raw: string | undefined,
): string {
  if (!raw) throw new CatalogCredentialError(path, ref);
  const pem = raw.replace(/\\n/g, "\n").trim();
  try {
    if (createPrivateKey(pem).asymmetricKeyType !== "rsa") throw new Error();
  } catch {
    throw new CatalogCredentialError(
      path,
      ref,
      "is not an RSA private key PEM",
    );
  }
  return pem;
}

/** Environment-only lookup: a secret reference resolves to nothing here. */
export function environmentCredentials(
  env: Record<string, string | undefined>,
): (ref: CredentialRef) => string | undefined {
  return (ref) => ("value_env" in ref ? env[ref.value_env] : undefined);
}

/** A zod failure as one line naming each path, for a startup error. */
export function describeConfigError(error: unknown): string {
  return error instanceof z.ZodError
    ? error.issues
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join("; ")
    : error instanceof Error
      ? error.message
      : String(error);
}
