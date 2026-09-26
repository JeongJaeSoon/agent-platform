/**
 * Numeric settings read from the environment, one rule for every process
 * (94S-413). Unset takes the caller's default, or is refused as required
 * when there is none. Set, it must parse — blank included, since a blank is
 * a value someone meant to fill in — and a wrong value is refused naming the
 * setting and what it got, never quietly replaced by the default.
 */
export type SettingsEnvironment = Readonly<Record<string, string | undefined>>;

export function integerSetting(
  environment: SettingsEnvironment,
  name: string,
  rule: { min: number; max?: number; default?: number },
): number {
  const raw = setting(environment, name, rule.default);
  const value = Number(raw);
  if (
    raw.trim() === "" ||
    !Number.isSafeInteger(value) ||
    value < rule.min ||
    (rule.max !== undefined && value > rule.max)
  ) {
    throw invalid(name, integerExpectation(rule.min, rule.max), raw);
  }
  return value;
}

export function positiveNumberSetting(
  environment: SettingsEnvironment,
  name: string,
  rule: { max?: number; default?: number } = {},
): number {
  const raw = setting(environment, name, rule.default);
  const value = Number(raw);
  if (
    raw.trim() === "" ||
    !Number.isFinite(value) ||
    value <= 0 ||
    (rule.max !== undefined && value > rule.max)
  ) {
    const expectation =
      rule.max === undefined
        ? "a positive number"
        : `a positive number up to ${rule.max}`;
    throw invalid(name, expectation, raw);
  }
  return value;
}

/** Every problem at once, so an operator fixes the file in one pass. */
export function settingProblems(): {
  problems: string[];
  read<T>(parse: () => T): T | undefined;
} {
  const problems: string[] = [];
  return {
    problems,
    read(parse) {
      try {
        return parse();
      } catch (error) {
        problems.push(error instanceof Error ? error.message : String(error));
        return undefined;
      }
    },
  };
}

function setting(
  environment: SettingsEnvironment,
  name: string,
  fallback: number | undefined,
): string {
  const raw = environment[name];
  if (raw !== undefined) return raw;
  if (fallback === undefined) throw new Error(`${name} is required`);
  return String(fallback);
}

function integerExpectation(min: number, max: number | undefined): string {
  if (max !== undefined) return `an integer from ${min} to ${max}`;
  if (min === 0) return "a non-negative integer";
  if (min === 1) return "a positive integer";
  return `an integer of at least ${min}`;
}

function invalid(name: string, expectation: string, raw: string): Error {
  return new Error(
    `${name} must be ${expectation}, got ${JSON.stringify(raw)}`,
  );
}
