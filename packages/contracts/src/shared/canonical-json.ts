/**
 * Deterministic JSON for content-addressed identity.
 *
 * Ported from Kollegium `packages/core/src/ids.ts` (Apache-2.0,
 * JeongJaeSoon/kollegium @ d711706). Two rules make a hash trustworthy:
 * object keys sort, array order is data and never sorts. Anything JSON cannot
 * represent the same way twice throws instead of serialising to `null`.
 */

function assertRepresentable(value: unknown, path: string): void {
  if (value === undefined) {
    throw new TypeError(`canonicalJson: undefined at ${path}`);
  }
  if (typeof value === "number" && !Number.isFinite(value)) {
    throw new TypeError(`canonicalJson: non-finite number at ${path}`);
  }
  if (typeof value === "bigint") {
    throw new TypeError(`canonicalJson: bigint at ${path}`);
  }
  if (typeof value === "function" || typeof value === "symbol") {
    throw new TypeError(`canonicalJson: ${typeof value} at ${path}`);
  }
  // Date, Map, Set and friends all stringify through their own rules, which
  // are not stable contract input. Only plain objects and arrays pass.
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError(
        `canonicalJson: ${value.constructor?.name ?? "non-plain object"} at ${path}`,
      );
    }
  }
}

function canonicalize(value: unknown, path: string): unknown {
  assertRepresentable(value, path);
  if (Array.isArray(value)) {
    return value.map((item, index) => canonicalize(item, `${path}[${index}]`));
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.keys(value as Record<string, unknown>)
      .sort()
      .map((key) => [
        key,
        canonicalize((value as Record<string, unknown>)[key], `${path}.${key}`),
      ]);
    return Object.fromEntries(entries);
  }
  return value;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value, "$"));
}
