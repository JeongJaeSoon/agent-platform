import { DEFAULT_CREDENTIAL_PORT } from "./credential.ts";
import { type ProxyLogLevel, resolveProxyLogLevel } from "./logger.ts";
import { type EgressDestination, parseDestinations } from "./policy.ts";
import { DEFAULT_PROXY_PORT } from "./proxy.ts";

export type EgressProxyEnvironment = {
  /** The API's authorizer, which the credential routes ask per request. */
  EGRESS_AUTHORIZER_TOKEN?: string | undefined;
  EGRESS_AUTHORIZER_URL?: string | undefined;
  EGRESS_CREDENTIAL_PORT?: string | undefined;
  /** Public destinations, `host:port`, comma separated. */
  EGRESS_ALLOWLIST?: string | undefined;
  /** Destinations deliberately inside the private plane. */
  EGRESS_PRIVATE_ALLOWLIST?: string | undefined;
  EGRESS_PROXY_HOST?: string | undefined;
  EGRESS_PROXY_PORT?: string | undefined;
  LOG_LEVEL?: string | undefined;
  [key: string]: string | undefined;
};

export type EgressProxyConfig = {
  allow: EgressDestination[];
  allowPrivate: EgressDestination[];
  /** The credential routes (94S-252), or null when this proxy has none. */
  credential: EgressCredentialConfig | null;
  hostname: string;
  logLevel: ProxyLogLevel;
  port: number;
};

export type EgressCredentialConfig = {
  authorizerToken: string;
  authorizerUrl: string;
  port: number;
};

export function egressProxyConfigFromEnv(
  environment: EgressProxyEnvironment,
): EgressProxyConfig {
  const allow = parseDestinations(
    environment.EGRESS_ALLOWLIST ?? "",
    "EGRESS_ALLOWLIST",
  );
  const allowPrivate = parseDestinations(
    environment.EGRESS_PRIVATE_ALLOWLIST ?? "",
    "EGRESS_PRIVATE_ALLOWLIST",
  );
  // A proxy that allows nothing is almost always a missing variable rather
  // than a deliberate lockdown, and it would fail every worker silently.
  if (allow.length === 0 && allowPrivate.length === 0) {
    throw new Error(
      "EGRESS_ALLOWLIST or EGRESS_PRIVATE_ALLOWLIST must name at least one destination",
    );
  }
  return {
    allow,
    allowPrivate,
    credential: credentialConfig(environment),
    hostname: environment.EGRESS_PROXY_HOST ?? "0.0.0.0",
    logLevel: resolveProxyLogLevel(environment.LOG_LEVEL),
    port: port(
      environment.EGRESS_PROXY_PORT,
      DEFAULT_PROXY_PORT,
      "EGRESS_PROXY_PORT",
    ),
  };
}

const CREDENTIAL_VARIABLES = [
  "EGRESS_AUTHORIZER_URL",
  "EGRESS_AUTHORIZER_TOKEN",
] as const;

/**
 * All or nothing: a proxy with the routes but no authorizer would refuse
 * every worker's provider call, and that should stop it at start.
 */
function credentialConfig(
  environment: EgressProxyEnvironment,
): EgressCredentialConfig | null {
  const set = CREDENTIAL_VARIABLES.filter(
    (name) => (environment[name] ?? "") !== "",
  );
  if (set.length === 0) return null;
  if (set.length !== CREDENTIAL_VARIABLES.length) {
    throw new Error(
      `${CREDENTIAL_VARIABLES.join(" and ")} must be set together`,
    );
  }
  const url = environment.EGRESS_AUTHORIZER_URL ?? "";
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("EGRESS_AUTHORIZER_URL is not a URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("EGRESS_AUTHORIZER_URL must be http or https");
  }
  const token = environment.EGRESS_AUTHORIZER_TOKEN ?? "";
  if (token.length < 32) {
    throw new Error("EGRESS_AUTHORIZER_TOKEN must be at least 32 characters");
  }
  return {
    authorizerToken: token,
    authorizerUrl: parsed.href,
    port: port(
      environment.EGRESS_CREDENTIAL_PORT,
      DEFAULT_CREDENTIAL_PORT,
      "EGRESS_CREDENTIAL_PORT",
    ),
  };
}

function port(
  value: string | undefined,
  fallback: number,
  name: string,
): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) {
    throw new Error(`${name} ${value} is not a port`);
  }
  return parsed;
}
