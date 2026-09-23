/**
 * The limits an installation runs under (94S-131). Every control process
 * reads them with this one parser, so the API that admits input, the gateway
 * that dispatches it and the scheduler that launches workers cannot disagree
 * about them. There are no defaults here on purpose: a missing value stops
 * the process, and the documented defaults live in `infra/docker-compose.yml`.
 */
export type InstallationLimits = {
  /** Worker containers that may hold a slot at once. */
  executionSlotLimit: number;
  /** `queued` turns one session may hold; the next input answers 429. */
  queuedInputLimitPerSession: number;
  /**
   * Retained content the installation may hold, in bytes. What counts is
   * listed at `STORAGE_ACCOUNTED_CONTENT`; the next input past it answers 413.
   */
  storageLimitBytes: number;
  /** Wall-clock budget of one turn, handed to the worker. */
  maxTurnSeconds: number;
  /** A session that has spent this much is dispatched nothing further. */
  sessionCostLimitUsd: number;
  /** Retries of a failed Messages request before the turn fails. */
  providerMaxRetries: number;
};

export type InstallationLimitsEnvironment = {
  EXECUTION_SLOT_LIMIT?: string | undefined;
  MAX_TURN_SECONDS?: string | undefined;
  PROVIDER_MAX_RETRIES?: string | undefined;
  QUEUED_INPUT_LIMIT_PER_SESSION?: string | undefined;
  SESSION_COST_LIMIT_USD?: string | undefined;
  STORAGE_LIMIT_BYTES?: string | undefined;
  [name: string]: string | undefined;
};

/**
 * What the storage limit counts today: the UTF-8 bytes of every input
 * message a session was given. Events, checkpoint objects and worker disks
 * are not in it — refusing an event batch would strand the turn that wrote
 * it, and a worker's disk has its own quota (94S-215).
 */
export const STORAGE_ACCOUNTED_CONTENT = ["input_messages"] as const;

export const DEFAULT_PROVIDER_MAX_RETRIES = 2;
/** Past this the engine clamps it anyway, and each retry backs off longer. */
const MAX_PROVIDER_RETRIES = 10;
/** Well inside what `sessions.cost_usd` can hold, so the limit is reachable. */
const MAX_SESSION_COST_LIMIT_USD = 1_000_000;
/** setTimeout overflows past 2^31-1 ms; a week is far inside that. */
const MAX_TURN_SECONDS_CEILING = 7 * 24 * 60 * 60;

export class InstallationConfigError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(`Invalid installation limits: ${problems.join("; ")}`);
  }
}

type Parsed = { value: number } | { problem: string };

function integer(
  environment: InstallationLimitsEnvironment,
  name: keyof InstallationLimitsEnvironment,
  bounds: { min: number; max: number },
  fallback?: number,
): Parsed {
  const raw = environment[name];
  if (raw === undefined || raw.trim() === "") {
    return fallback === undefined
      ? { problem: `${name} is required` }
      : { value: fallback };
  }
  const value = Number(raw);
  if (
    !Number.isSafeInteger(value) ||
    value < bounds.min ||
    value > bounds.max
  ) {
    return {
      problem: `${name} must be an integer from ${bounds.min} to ${bounds.max}`,
    };
  }
  return { value };
}

function positiveAmount(
  environment: InstallationLimitsEnvironment,
  name: keyof InstallationLimitsEnvironment,
  max: number,
): Parsed {
  const raw = environment[name];
  if (raw === undefined || raw.trim() === "") {
    return { problem: `${name} is required` };
  }
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0 || value > max) {
    return { problem: `${name} must be a positive number up to ${max}` };
  }
  return { value };
}

/** Every problem at once, so an operator fixes the file in one pass. */
export function installationLimitProblems(
  environment: InstallationLimitsEnvironment,
): string[] {
  return Object.values(parseAll(environment)).flatMap((parsed) =>
    "problem" in parsed ? [parsed.problem] : [],
  );
}

export function installationLimitsFromEnv(
  environment: InstallationLimitsEnvironment,
): InstallationLimits {
  const parsed = parseAll(environment);
  const problems = Object.values(parsed).flatMap((entry) =>
    "problem" in entry ? [entry.problem] : [],
  );
  if (problems.length > 0) throw new InstallationConfigError(problems);
  const value = (key: keyof InstallationLimits) =>
    (parsed[key] as { value: number }).value;
  return {
    executionSlotLimit: value("executionSlotLimit"),
    queuedInputLimitPerSession: value("queuedInputLimitPerSession"),
    storageLimitBytes: value("storageLimitBytes"),
    maxTurnSeconds: value("maxTurnSeconds"),
    sessionCostLimitUsd: value("sessionCostLimitUsd"),
    providerMaxRetries: value("providerMaxRetries"),
  };
}

function parseAll(
  environment: InstallationLimitsEnvironment,
): Record<keyof InstallationLimits, Parsed> {
  return {
    // Zero is a real setting: admit and queue everything, launch nothing.
    executionSlotLimit: integer(environment, "EXECUTION_SLOT_LIMIT", {
      min: 0,
      max: 10_000,
    }),
    // Creating a session queues its first turn, so fewer than one would
    // refuse every session.
    queuedInputLimitPerSession: integer(
      environment,
      "QUEUED_INPUT_LIMIT_PER_SESSION",
      { min: 1, max: 100_000 },
    ),
    storageLimitBytes: integer(environment, "STORAGE_LIMIT_BYTES", {
      min: 1,
      max: Number.MAX_SAFE_INTEGER,
    }),
    maxTurnSeconds: integer(environment, "MAX_TURN_SECONDS", {
      min: 1,
      max: MAX_TURN_SECONDS_CEILING,
    }),
    sessionCostLimitUsd: positiveAmount(
      environment,
      "SESSION_COST_LIMIT_USD",
      MAX_SESSION_COST_LIMIT_USD,
    ),
    providerMaxRetries: integer(
      environment,
      "PROVIDER_MAX_RETRIES",
      { min: 0, max: MAX_PROVIDER_RETRIES },
      DEFAULT_PROVIDER_MAX_RETRIES,
    ),
  };
}

/** The one budget predicate every gate uses: spent is over once it reaches the limit. */
export function budgetExceeded(costUsd: number, limitUsd: number): boolean {
  return costUsd >= limitUsd;
}
