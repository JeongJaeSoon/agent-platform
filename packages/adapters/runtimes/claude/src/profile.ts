import { tmpdir } from "node:os";
import { z } from "zod";

import type { ClaudeRuntimeConfig, RuntimeProfile } from "./config.ts";

const profileSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("anthropic"),
      endpoint: z.string().url(),
      auth: z
        .object({ kind: z.literal("api_key"), value: z.string().min(1) })
        .strict(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("litellm"),
      endpoint: z.string().url(),
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
  if (
    config.mode === "resume" &&
    config.sessionStore !== undefined &&
    config.sessionStore.revisionScoped !== true
  ) {
    // The live mirror holds whatever was written after the checkpoint that is
    // being resumed. Replaying that is not a degraded restore, it is a
    // different conversation, so refuse rather than approximate. A store bound
    // to a restore plan declares `revisionScoped` (94S-203).
    throw new Error("Resume needs a revision-scoped transcript mirror");
  }
  if (config.permissionMode === undefined) return config;
  if (config.permissionMode === "default") return config;
  if (["acceptEdits", "dontAsk", "plan"].includes(config.permissionMode)) {
    return config;
  }
  throw new Error("Unsupported permission mode");
}

export function runtimeEnvironment(
  config: Pick<ClaudeRuntimeConfig, "claudeConfigDir" | "home" | "profile">,
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
  if (config.profile.auth.kind === "bearer") {
    environment.ANTHROPIC_AUTH_TOKEN = config.profile.auth.value;
  } else {
    environment.ANTHROPIC_API_KEY = config.profile.auth.value;
  }
  return environment;
}

export function publicProfile(profile: RuntimeProfile): Omit<
  RuntimeProfile,
  "auth"
> & {
  auth_kind: RuntimeProfile["auth"]["kind"];
} {
  return {
    kind: profile.kind,
    endpoint: normalizeEndpoint(profile.endpoint),
    auth_kind: profile.auth.kind,
  };
}

function normalizeEndpoint(endpoint: string): string {
  const url = new URL(endpoint);
  url.hash = "";
  url.search = "";
  return url.toString().replace(/\/$/, "");
}
