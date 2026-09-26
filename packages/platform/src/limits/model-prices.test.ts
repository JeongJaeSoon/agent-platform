import { describe, expect, test } from "bun:test";
import { MODEL_PRICES, priceProviderUsage } from "./model-prices.ts";

const nothing = {
  inputTokens: 0,
  outputTokens: 0,
  cacheCreationInputTokens: 0,
  cacheCreation1hInputTokens: 0,
  cacheReadInputTokens: 0,
  estimated: false,
};

describe("priceProviderUsage (94S-409)", () => {
  test("prices every part at the model's rate, the hour-long cache writes at twice the input", () => {
    // claude-sonnet-5: $2 in, $10 out, $0.20 cache read per million.
    const { costUsd, pricedBy } = priceProviderUsage({
      model: "claude-sonnet-5",
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      cacheCreationInputTokens: 3_000_000,
      cacheCreation1hInputTokens: 1_000_000,
      cacheReadInputTokens: 1_000_000,
      estimated: false,
    });
    expect(pricedBy).toBe("table");
    // 2 + 10 + 2 × 2 × 1.25 + 1 × 2 × 2 + 0.2
    expect(costUsd).toBeCloseTo(21.2, 9);
  });

  test("a dated id is its own entry, and nothing else is matched by prefix", () => {
    expect(
      priceProviderUsage({
        ...nothing,
        model: "claude-sonnet-4-5-20250929",
        outputTokens: 1_000_000,
      }),
    ).toEqual({ costUsd: 15, pricedBy: "table" });
    expect(
      priceProviderUsage({
        ...nothing,
        model: "claude-sonnet-4-5-20990101",
        outputTokens: 1_000_000,
      }).pricedBy,
    ).toBe("fallback");
  });

  test("an unknown model pays the highest known rate for each part", () => {
    const highest = Math.max(
      ...Object.values(MODEL_PRICES).map((price) => price.outputUsdPerMtok),
    );
    expect(
      priceProviderUsage({
        ...nothing,
        model: "litellm-alias",
        outputTokens: 1_000_000,
      }),
    ).toEqual({ costUsd: highest, pricedBy: "fallback" });
    expect(
      priceProviderUsage({ ...nothing, model: "constructor" }).pricedBy,
    ).toBe("fallback");
  });
});
