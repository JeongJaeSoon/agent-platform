import {
  permissionModeSchema,
  runtimeConfigSchema,
} from "@agent-platform/contracts";
import { z } from "zod";

// Operator-registered profile/repository allowlist. Loaded from config until
// 94S-132 adds a registration API. The provider credential is not in the
// JSON: the entry names the environment variable that holds it, and the
// value is resolved once at load. Rotation therefore means changing the
// variable and restarting the API; a claim already answered keeps the key it
// was given. A live resolver is the upgrade when rotation has to be faster.
//
// Only Claude profiles exist: the config block below is the Claude engine's
// shape, and a profile that names another runtime kind with it would run
// nothing. Other kinds get their own block when an adapter for them lands.
const credentialRefSchema = z.object({ value_env: z.string().min(1) }).strict();
const catalogProviderSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("anthropic"),
      endpoint: z.url(),
      auth: credentialRefSchema.extend({ kind: z.literal("api_key") }).strict(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("litellm"),
      endpoint: z.url(),
      auth: credentialRefSchema
        .extend({ kind: z.enum(["api_key", "bearer"]) })
        .strict(),
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
  })
  .strict();
export const sessionCatalogConfigSchema = z
  .object({
    profiles: z.record(z.string().min(1), catalogProfileConfigSchema),
    repositories: z.record(
      z.string().min(1),
      z.object({ url: z.string().min(1), branch: z.string().min(1) }),
    ),
  })
  .strict();

// What the services hold: the same catalog with every credential resolved.
export const catalogProfileSchema = runtimeConfigSchema
  .extend({
    runtime_kind: z.literal("claude_agent_sdk"),
    runtime_version: z.string().min(1),
  })
  .strict();
export const sessionCatalogSchema = sessionCatalogConfigSchema.extend({
  profiles: z.record(z.string().min(1), catalogProfileSchema),
});

export type SessionCatalogConfig = z.infer<typeof sessionCatalogConfigSchema>;
export type SessionCatalog = z.infer<typeof sessionCatalogSchema>;
export type CatalogProfile = z.infer<typeof catalogProfileSchema>;

export class CatalogCredentialError extends Error {
  constructor(
    readonly profileId: string,
    readonly variable: string,
  ) {
    super(
      `profiles.${profileId}.provider.auth.value_env: ${variable} is not set`,
    );
  }
}

export function resolveSessionCatalog(
  config: SessionCatalogConfig,
  env: Record<string, string | undefined>,
): SessionCatalog {
  const profiles: Record<string, CatalogProfile> = {};
  for (const [id, profile] of Object.entries(config.profiles)) {
    const value = env[profile.provider.auth.value_env];
    if (!value) {
      throw new CatalogCredentialError(id, profile.provider.auth.value_env);
    }
    const { value_env: _ref, ...auth } = profile.provider.auth;
    profiles[id] = catalogProfileSchema.parse({
      ...profile,
      provider: { ...profile.provider, auth: { ...auth, value } },
    });
  }
  return { profiles, repositories: config.repositories };
}

export function parseSessionCatalog(
  json: string | undefined,
  env: Record<string, string | undefined> = process.env,
): SessionCatalog {
  return resolveSessionCatalog(
    sessionCatalogConfigSchema.parse(
      JSON.parse(json ?? '{"profiles":{},"repositories":{}}'),
    ),
    env,
  );
}

// Names the env var in the failure so an operator can tell which setting is
// wrong without reading a stack trace. A missing credential names the
// profile and the variable, never a value.
export function parseSessionCatalogEnv(
  name: string,
  value: string | undefined,
  env: Record<string, string | undefined> = process.env,
): SessionCatalog {
  try {
    return parseSessionCatalog(value, env);
  } catch (error) {
    const detail =
      error instanceof z.ZodError
        ? error.issues
            .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
            .join("; ")
        : error instanceof Error
          ? error.message
          : String(error);
    throw new Error(`${name} is invalid: ${detail}`, { cause: error });
  }
}

export function isCatalogEmpty(catalog: SessionCatalog): boolean {
  return (
    Object.keys(catalog.profiles).length === 0 ||
    Object.keys(catalog.repositories).length === 0
  );
}
