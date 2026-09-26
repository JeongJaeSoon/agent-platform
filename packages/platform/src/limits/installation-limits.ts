import { STORAGE_ACCOUNTED_CONTENT_VALUES } from "@agent-platform/contracts";
import {
  integerSetting,
  positiveNumberSetting,
  settingProblems,
} from "@agent-platform/contracts/settings";

/**
 * The limits an installation runs under (94S-131). Every control process
 * reads them with this one parser, so the API that admits input, the gateway
 * that dispatches it and the scheduler that launches workers cannot disagree
 * about them. There are no defaults here on purpose: a missing value stops
 * the process, and the documented defaults live in `infra/compose.core.yml`.
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
export const STORAGE_ACCOUNTED_CONTENT = STORAGE_ACCOUNTED_CONTENT_VALUES;

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

/** Every problem at once, so an operator fixes the file in one pass. */
export function installationLimitProblems(
  environment: InstallationLimitsEnvironment,
): string[] {
  return parseAll(environment).problems;
}

export function installationLimitsFromEnv(
  environment: InstallationLimitsEnvironment,
): InstallationLimits {
  const { limits, problems } = parseAll(environment);
  if (problems.length > 0) throw new InstallationConfigError(problems);
  return limits as InstallationLimits;
}

function parseAll(environment: InstallationLimitsEnvironment): {
  limits: Record<keyof InstallationLimits, number | undefined>;
  problems: string[];
} {
  const { problems, read } = settingProblems();
  const limits = {
    // Zero is a real setting: admit and queue everything, launch nothing.
    executionSlotLimit: read(() =>
      integerSetting(environment, "EXECUTION_SLOT_LIMIT", {
        min: 0,
        max: 10_000,
      }),
    ),
    // Creating a session queues its first turn, so fewer than one would
    // refuse every session.
    queuedInputLimitPerSession: read(() =>
      integerSetting(environment, "QUEUED_INPUT_LIMIT_PER_SESSION", {
        min: 1,
        max: 100_000,
      }),
    ),
    storageLimitBytes: read(() =>
      integerSetting(environment, "STORAGE_LIMIT_BYTES", {
        min: 1,
        max: Number.MAX_SAFE_INTEGER,
      }),
    ),
    maxTurnSeconds: read(() =>
      integerSetting(environment, "MAX_TURN_SECONDS", {
        min: 1,
        max: MAX_TURN_SECONDS_CEILING,
      }),
    ),
    sessionCostLimitUsd: read(() =>
      positiveNumberSetting(environment, "SESSION_COST_LIMIT_USD", {
        max: MAX_SESSION_COST_LIMIT_USD,
      }),
    ),
    // Zero is a real setting: the first failed request fails the turn.
    providerMaxRetries: read(() =>
      integerSetting(environment, "PROVIDER_MAX_RETRIES", {
        min: 0,
        max: MAX_PROVIDER_RETRIES,
      }),
    ),
  };
  return { limits, problems };
}

/** The one budget predicate every gate uses: spent is over once it reaches the limit. */
export function budgetExceeded(costUsd: number, limitUsd: number): boolean {
  return costUsd >= limitUsd;
}
