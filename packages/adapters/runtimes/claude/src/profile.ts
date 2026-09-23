import { tmpdir } from "node:os";
import { z } from "zod";

import { describeComponents } from "./component-identity.ts";
import type { ClaudeRuntimeConfig, RuntimeProfile } from "./config.ts";

const principalSchema = z.object({ ownerScope: z.string().min(1) }).strict();
const profileSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("anthropic"),
      endpoint: z.string().url(),
      auth: z
        .object({ kind: z.literal("api_key"), value: z.string().min(1) })
        .strict(),
      principal: principalSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("litellm"),
      endpoint: z.string().url(),
      principal: principalSchema,
      auth: z.discriminatedUnion("kind", [
        z
          .object({ kind: z.literal("api_key"), value: z.string().min(1) })
          .strict(),
        z
          .object({ kind: z.literal("bearer"), value: z.string().min(1) })
          .strict(),
      ]),
    })
    .strict(),
]);

export type RuntimePolicy = {
  endpoints: string[];
  models: string[];
};

export function validateRuntimeConfig(
  config: ClaudeRuntimeConfig,
  policy: RuntimePolicy,
): ClaudeRuntimeConfig {
  const profile = profileSchema.parse(config.profile);
  const endpoint = normalizeEndpoint(profile.endpoint);
  const approvedEndpoints = new Set(policy.endpoints.map(normalizeEndpoint));
  if (!approvedEndpoints.has(endpoint)) {
    throw new Error("Runtime endpoint is not approved");
  }
  if (!policy.models.includes(config.model)) {
    throw new Error("Runtime model is not approved");
  }
  // A component the fingerprint cannot name makes every checkpoint of this
  // run unverifiable, and a resume unmatchable. Refusing here, for new and
  // resumed runs alike, is what turns that into a start-time error with a
  // reason instead of a checkpoint that quietly never commits.
  describeComponents(config);
  if (
    config.repositoryClaudeMd === true &&
    (config.settingSources ?? ["project"]).length > 0
  ) {
    throw new Error(
      "repositoryClaudeMd reads CLAUDE.md without the project settings; it needs settingSources: []",
    );
  }
  if (
    config.mode === "resume" &&
    config.localTranscriptResume !== true &&
    config.sessionStore?.revisionScoped !== true
  ) {
    // Two ways to get this wrong, and they look identical from here: handing
    // over the live mirror, which holds whatever was written after the
    // checkpoint being resumed, or handing over nothing at all, which leaves
    // the engine replaying the container's local disk. Either is a different
    // conversation than the one that was committed. A store bound to a
    // restore plan declares `revisionScoped` (94S-203); a genuinely local
    // resume has to say so out loud.
    throw new Error("Resume needs a revision-scoped transcript mirror");
  }
  if (config.permissionMode === undefined) return config;
  if (config.permissionMode === "default") return config;
  if (["acceptEdits", "dontAsk", "plan"].includes(config.permissionMode)) {
    return config;
  }
  throw new Error("Unsupported permission mode");
}

/**
 * The only host variables the engine inherits verbatim. On the worker
 * network the egress proxy is the sole route to the Messages endpoint and
 * the container learns it through these (94S-199); the SDK replaces the
 * child's environment rather than merging it, so they have to be carried
 * across by hand. Each is forwarded only when the host sets it: an uppercase
 * twin the host never had would change which value the engine prefers.
 *
 * Deliberately not here: `NODE_EXTRA_CA_CERTS`. A CA bundle changes who may
 * impersonate the Messages endpoint, so it comes from `trustedCaBundle` on
 * the config, never from whatever the host happens to trust.
 */
const HOST_PROXY_VARIABLES = [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
] as const;

export function runtimeEnvironment(
  config: Pick<
    ClaudeRuntimeConfig,
    "claudeConfigDir" | "home" | "profile" | "trustedCaBundle"
  >,
  host: NodeJS.ProcessEnv = process.env,
): Record<string, string | undefined> {
  const environment: Record<string, string | undefined> = {
    ANTHROPIC_BASE_URL: normalizeEndpoint(config.profile.endpoint),
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    CLAUDE_CONFIG_DIR: config.claudeConfigDir,
    HOME: config.home,
    LANG: host.LANG ?? "en_US.UTF-8",
    PATH: host.PATH,
    TMPDIR: host.TMPDIR ?? tmpdir(),
  };
  for (const name of HOST_PROXY_VARIABLES) {
    const value = host[name];
    if (value !== undefined) environment[name] = value;
  }
  if (config.trustedCaBundle !== undefined) {
    environment.NODE_EXTRA_CA_CERTS = config.trustedCaBundle;
  }
  if (config.profile.auth.kind === "bearer") {
    environment.ANTHROPIC_AUTH_TOKEN = config.profile.auth.value;
  } else {
    environment.ANTHROPIC_API_KEY = config.profile.auth.value;
  }
  return environment;
}

/**
 * The profile with the credential left behind and the principal kept: what
 * may be hashed, logged or compared without leaking a secret.
 */
export function publicProfile(profile: RuntimeProfile): {
  auth_kind: RuntimeProfile["auth"]["kind"];
  endpoint: string;
  kind: RuntimeProfile["kind"];
  principal: { ownerScope: string };
} {
  return {
    kind: profile.kind,
    endpoint: normalizeEndpoint(profile.endpoint),
    auth_kind: profile.auth.kind,
    principal: { ownerScope: profile.principal.ownerScope },
  };
}

function normalizeEndpoint(endpoint: string): string {
  const url = new URL(endpoint);
  url.hash = "";
  url.search = "";
  return url.toString().replace(/\/$/, "");
}
