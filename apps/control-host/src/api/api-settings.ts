import {
  integerSetting,
  settingProblems,
} from "@agent-platform/contracts/settings";
import { type LogLevel, logLevelFromEnv } from "@agent-platform/observability";
import { DEFAULT_PENDING_TTL_MS } from "@agent-platform/platform";
import { heartbeatTtlMsFromEnv } from "./lease-config.ts";

/**
 * The API's own settings, apart from the installation limits it shares with
 * the scheduler. One parser for startup and readiness, and every value that
 * is set but wrong stops the process: a typo that quietly became a default
 * is an installation running under settings nobody chose (94S-389).
 */
export type ApiSettings = {
  leaseTtlMs: number;
  logLevel: LogLevel;
  pendingTtlMs: number;
  sse: {
    batchMaxBytes?: number;
    maxStreams?: number;
    maxStreamsPerOwner?: number;
  };
};

export class ApiSettingsError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(`Invalid API settings: ${problems.join("; ")}`);
  }
}

/** A week, as MAX_TURN_SECONDS allows at most; no turn waits longer. */
export const MAX_PENDING_REQUEST_TTL_SEC = 7 * 24 * 60 * 60;

export function apiSettingsFromEnv(
  environment: Record<string, string | undefined>,
): ApiSettings {
  const { problems, read } = settingProblems();
  // Unset keeps the platform default.
  const optionalInteger = (
    name: string,
    rule: { min: number; max?: number },
  ) =>
    environment[name] === undefined
      ? undefined
      : integerSetting(environment, name, rule);
  const leaseTtlMs = read(() =>
    heartbeatTtlMsFromEnv(environment.HEARTBEAT_TTL_SEC),
  );
  const logLevel = read(() => logLevelFromEnv(environment.LOG_LEVEL));
  const pendingTtlSec = read(() =>
    optionalInteger("PENDING_REQUEST_TTL_SEC", {
      min: 1,
      max: MAX_PENDING_REQUEST_TTL_SEC,
    }),
  );
  const sse = {
    batchMaxBytes: read(() =>
      optionalInteger("SSE_REPLAY_MAX_BYTES", { min: 1 }),
    ),
    maxStreams: read(() => optionalInteger("SSE_MAX_STREAMS", { min: 1 })),
    maxStreamsPerOwner: read(() =>
      optionalInteger("SSE_MAX_STREAMS_PER_OWNER", { min: 1 }),
    ),
  };
  // In `none` mode /v1 takes any X-Owner-Id as the caller. With the
  // authorizer on, workers run beside this API and reach it through the
  // proxy, so code inside any of them could act as any owner.
  if (
    environment.AUTH_MODE === "none" &&
    environment.EGRESS_AUTHORIZER_PORT !== undefined
  ) {
    problems.push(
      "AUTH_MODE=none cannot run with the egress authorizer on (EGRESS_AUTHORIZER_PORT): workers reach this API and would act as any owner",
    );
  }
  if (problems.length > 0) throw new ApiSettingsError(problems);
  return {
    leaseTtlMs: leaseTtlMs as number,
    logLevel: logLevel as LogLevel,
    pendingTtlMs:
      pendingTtlSec === undefined
        ? DEFAULT_PENDING_TTL_MS
        : pendingTtlSec * 1000,
    sse: {
      ...(sse.batchMaxBytes === undefined
        ? {}
        : { batchMaxBytes: sse.batchMaxBytes }),
      ...(sse.maxStreams === undefined ? {} : { maxStreams: sse.maxStreams }),
      ...(sse.maxStreamsPerOwner === undefined
        ? {}
        : { maxStreamsPerOwner: sse.maxStreamsPerOwner }),
    },
  };
}

/** Every problem at once, for readiness; empty when the settings parse. */
export function apiSettingsProblems(
  environment: Record<string, string | undefined>,
): string[] {
  try {
    apiSettingsFromEnv(environment);
    return [];
  } catch (error) {
    if (error instanceof ApiSettingsError) return [...error.problems];
    throw error;
  }
}
