import { describe, expect, test } from "bun:test";
import { usageSummaryQuerySchema } from "./usage.ts";

describe("usageSummaryQuerySchema", () => {
  const bounds = (query: Record<string, string>) => {
    const parsed = usageSummaryQuerySchema.parse({ scope: "me", ...query });
    return [parsed.since.toISOString(), parsed.until?.toISOString()];
  };

  test("a date is that day's 00:00 UTC and an offset moves to UTC", () => {
    expect(bounds({ since: "2026-10-01", until: "2026-11-01" })).toEqual([
      "2026-10-01T00:00:00.000Z",
      "2026-11-01T00:00:00.000Z",
    ]);
    expect(
      bounds({
        since: "2026-10-01T09:00:00+09:00",
        until: "2026-10-31T19:00:00-05:00",
      }),
    ).toEqual(["2026-10-01T00:00:00.000Z", "2026-11-01T00:00:00.000Z"]);
    expect(bounds({ since: "2026-10-01T00:00:00Z" })).toEqual([
      "2026-10-01T00:00:00.000Z",
      undefined,
    ]);
  });

  test("refuses a missing since, a local time, an impossible day and an empty period", () => {
    for (const query of [
      {},
      { since: "2026-10-01T00:00:00" },
      { since: "2026-02-30" },
      { since: "yesterday" },
      { since: "2026-10-01", until: "2026-10-01" },
      { since: "2026-10-02", until: "2026-10-01" },
      // Without until the period ends now, so a future since is empty.
      { since: "2099-01-01" },
    ]) {
      expect(
        usageSummaryQuerySchema.safeParse({ scope: "me", ...query }).success,
        JSON.stringify(query),
      ).toBe(false);
    }
    expect(
      usageSummaryQuerySchema.safeParse({ scope: "team", since: "2026-10-01" })
        .success,
    ).toBe(false);
  });
});
