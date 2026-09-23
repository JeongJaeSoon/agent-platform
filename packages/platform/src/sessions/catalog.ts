import { createHash } from "node:crypto";
import {
  canonicalJson,
  permissionModeSchema,
  projectSettingsSchema,
  type runtimeConfigSchema,
} from "@agent-platform/contracts";
import { z } from "zod";

// Operator-registered profiles and repositories (94S-132). The operator
// writes `config/profiles.yaml` and `config/repositories.yaml`; the API reads
// them once at startup (`apps/api/src/catalog-config.ts`) and refuses to
// start on anything this file rejects. A provider credential is never in the
// files: the entry names where it lives — an environment variable or a
// Secrets Manager secret — and the value is resolved once at load. Rotation
// therefore means changing the secret and restarting the API; a claim
// already answered keeps the key it was given.
//
// Only Claude profiles exist: the config block below is the Claude engine's
// shape, and a profile that names another runtime kind with it would run
// nothing. Other kinds get their own block when an adapter for them lands.

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

// A worker's only way out is the HTTP(S) egress proxy (94S-216), so an ssh,
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
const webUrl = credentialFreeUrl.refine(isWebUrl, {
  message: "must be an http:// or https:// URL",
});

const catalogProviderSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("anthropic"),
      endpoint: webUrl,
      auth: credentialRef(z.literal("api_key")),
    })
    .strict(),
  z
    .object({
      kind: z.literal("litellm"),
      endpoint: webUrl,
      auth: credentialRef(z.enum(["api_key", "bearer"])),
    })
    .strict(),
]);
export const catalogProfileConfigSchema = z
  .object({
    runtime_kind: z.literal("claude_agent_sdk"),
    runtime_version: z.string().min(1),
    model: z.string().min(1),
    tools: z.array(z.string().min(1)),
    permission_mode: permissionModeSchema,
    provider: catalogProviderSchema,
    // Off unless the operator turns it on: a profile written before this
    // field existed keeps the run it was reviewed for.
    project_settings: projectSettingsSchema.default({ claude_md: false }),
  })
  .strict();

// A repository lists the profiles allowed to run against it. The pair is
// the unit of trust (94S-258): a profile that lets the repository's
// CLAUDE.md into the system prompt must not carry that trust to a
// repository whose authors it was never granted for. Checked at create and
// again at claim.
export const catalogRepositorySchema = z
  .object({
    url: webUrl,
    branch: z.string().min(1),
    profiles: z.array(z.string().min(1)).min(1),
  })
  .strict();

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
    repositories: nonEmpty(
      z.record(z.string().min(1), catalogRepositorySchema),
      "repository",
    ),
  })
  .strict()
  .superRefine((config, ctx) => {
    for (const [id, repository] of Object.entries(config.repositories)) {
      repository.profiles.forEach((profileId, index) => {
        if (!Object.hasOwn(config.profiles, profileId)) {
          ctx.addIssue({
            code: "custom",
            path: ["repositories", id, "profiles", index],
            message: `names profile ${profileId}, which is not in profiles`,
          });
        }
      });
    }
  });

export type SessionCatalogConfig = z.infer<typeof sessionCatalogConfigSchema>;
export type CatalogProfileConfig = z.infer<typeof catalogProfileConfigSchema>;
export type CatalogRepository = z.infer<typeof catalogRepositorySchema>;
export type CredentialRef = { value_env: string } | { secret_id: string };

// What the services hold: each credential resolved, its reference kept so
// the fingerprint can name where it came from without the value.
export type CatalogProfile = {
  runtime_kind: "claude_agent_sdk";
  runtime_version: string;
  model: string;
  tools: string[];
  permission_mode: z.infer<typeof permissionModeSchema>;
  project_settings?: z.infer<typeof projectSettingsSchema> | undefined;
  provider:
    | {
        kind: "anthropic";
        endpoint: string;
        auth: { kind: "api_key"; value: string; ref: CredentialRef };
      }
    | {
        kind: "litellm";
        endpoint: string;
        auth: {
          kind: "api_key" | "bearer";
          value: string;
          ref: CredentialRef;
        };
      };
};

export type SessionCatalog = {
  profiles: Record<string, CatalogProfile>;
  repositories: Record<string, CatalogRepository>;
};

/** The provider exactly as the worker protocol carries it: no reference. */
export function runtimeProviderOf(profile: CatalogProfile) {
  const { ref: _ref, ...auth } = profile.provider.auth;
  return { ...profile.provider, auth } as z.infer<
    typeof runtimeConfigSchema.shape.provider
  >;
}

function withoutSecret(profile: CatalogProfile) {
  const { value: _value, ...auth } = profile.provider.auth;
  return { ...profile, provider: { ...profile.provider, auth } };
}

function sha256(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalJson(value), "utf8").digest("hex")}`;
}

// Bumped when the hashed shape changes, so an old fingerprint can never
// equal a new one by accident.
const FINGERPRINT_VERSION = 1;

/**
 * Identifies what a profile runs: every setting and where its credential
 * comes from, never the credential. Two ids with the same settings share
 * one. This is not the checkpoint fingerprint (which also covers the owner
 * and the engine's components); 94S-253 snapshots and compares this one.
 */
export function profileFingerprint(profile: CatalogProfile): string {
  return sha256({
    fingerprint_version: FINGERPRINT_VERSION,
    profile: withoutSecret(profile),
  });
}

/**
 * The whole catalog as loaded, for audit and logs: it moves whenever any
 * profile or repository does, so it is not what a session should be matched
 * against (an unrelated edit would fail every claim).
 */
export function catalogRevision(catalog: SessionCatalog): string {
  return sha256({
    fingerprint_version: FINGERPRINT_VERSION,
    profiles: Object.fromEntries(
      Object.entries(catalog.profiles).map(([id, profile]) => [
        id,
        withoutSecret(profile),
      ]),
    ),
    repositories: catalog.repositories,
  });
}

/** The pair a session may run as, or null when the catalog forbids it. */
export function allowedPair(
  catalog: SessionCatalog,
  profileId: string,
  repositoryId: string,
): { profile: CatalogProfile; repository: CatalogRepository } | null {
  const profile = Object.hasOwn(catalog.profiles, profileId)
    ? catalog.profiles[profileId]
    : undefined;
  const repository = Object.hasOwn(catalog.repositories, repositoryId)
    ? catalog.repositories[repositoryId]
    : undefined;
  if (!profile || !repository || !repository.profiles.includes(profileId)) {
    return null;
  }
  return { profile, repository };
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
  constructor(
    readonly profileId: string,
    readonly ref: CredentialRef,
    reason = "is not set",
  ) {
    super(
      "value_env" in ref
        ? `profiles.${profileId}.provider.auth.value_env: ${ref.value_env} ${reason}`
        : `profiles.${profileId}.provider.auth.secret_id: ${ref.secret_id} ${reason}`,
    );
  }
}

/**
 * The resolved catalog. `lookup` hands back each reference's value, already
 * fetched (a Secrets Manager read is the loader's job, not this pure step);
 * an absent or empty value fails naming the profile and the reference,
 * never a value.
 */
export function resolveSessionCatalog(
  config: SessionCatalogConfig,
  lookup: (ref: CredentialRef) => string | undefined,
): SessionCatalog {
  const profiles: Record<string, CatalogProfile> = {};
  for (const [id, profile] of Object.entries(config.profiles)) {
    const { kind, ...refFields } = profile.provider.auth;
    const ref = credentialRefOf(refFields);
    const value = lookup(ref);
    if (!value) {
      throw new CatalogCredentialError(id, ref);
    }
    profiles[id] = {
      ...profile,
      provider: { ...profile.provider, auth: { kind, value, ref } },
    } as CatalogProfile;
  }
  return { profiles, repositories: config.repositories };
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
