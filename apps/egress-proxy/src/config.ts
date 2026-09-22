import { type ProxyLogLevel, resolveProxyLogLevel } from "./logger.ts";
import { type EgressDestination, parseDestinations } from "./policy.ts";
import { DEFAULT_PROXY_PORT } from "./proxy.ts";

export type EgressProxyEnvironment = {
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
  hostname: string;
  logLevel: ProxyLogLevel;
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
    hostname: environment.EGRESS_PROXY_HOST ?? "0.0.0.0",
    logLevel: resolveProxyLogLevel(environment.LOG_LEVEL),
    port: port(environment.EGRESS_PROXY_PORT),
  };
}

function port(value: string | undefined): number {
  if (value === undefined) return DEFAULT_PROXY_PORT;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) {
    throw new Error(`EGRESS_PROXY_PORT ${value} is not a port`);
  }
  return parsed;
}
