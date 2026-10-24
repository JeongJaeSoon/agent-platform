import { describe, expect, test } from "bun:test";

import {
  BASH_PER_DAY,
  TOOLS,
} from "../domain/operations/operations-fixtures.ts";
import {
  breakdown,
  series,
  summaryOf,
  toolDetail,
} from "./operations-fixtures.ts";

// The screens show the same period three ways; a fixture whose parts do not
// add up would put two different totals on one screen.
describe("operations fixtures", () => {
  for (const days of [7, 30, 90]) {
    test(`${days} days: by model and by agent add up to the summary`, () => {
      const summary = summaryOf(series(days));
      const { model, agent } = breakdown(summary);
      for (const by of [model, agent]) {
        expect(by.totals.session_count).toBe(summary.session_count);
        expect(by.totals.token_count).toBe(summary.token_count);
        expect(by.totals.cost_usd).toBe(summary.cost_usd);
        expect(by.rows.reduce((sum, row) => sum + row.token_count, 0)).toBe(
          summary.token_count,
        );
      }
    });
  }

  test("every tool's rail follows its own figures", () => {
    for (const tool of TOOLS.tools) {
      const { calls, perDay } = toolDetail(tool);
      expect(perDay).toHaveLength(14);
      if (tool.failed === 0) {
        expect(calls.some((c) => c.outcome === "failed")).toBe(false);
      }
    }
    const bash = TOOLS.tools.find((t) => t.name === "Bash");
    expect(bash && toolDetail(bash).perDay.map((d) => d.calls)).toEqual(
      BASH_PER_DAY.map((d) => d.calls),
    );
  });

  test("the 30-day run marks the design's partial days", () => {
    const partial = series(30)
      .buckets.filter((b) => !b.cost_complete)
      .map((b) => b.date);
    expect(partial).toEqual(["2026-10-06", "2026-10-23"]);
  });
});
