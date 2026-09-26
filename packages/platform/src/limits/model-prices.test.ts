import { describe, expect, test } from "bun:test";
import {
  FAST_MODEL_PRICES,
  MODEL_PRICES,
  priceProviderUsage,
} from "./model-prices.ts";

const nothing = {
  inputTokens: 0,
  outputTokens: 0,
  cacheCreationInputTokens: 0,
  cacheCreation1hInputTokens: 0,
  cacheReadInputTokens: 0,
  speed: "standard",
  inferenceGeo: "global",
  webSearchRequests: 0,
  webFetchRequests: 0,
  codeExecutionRequests: 0,
  estimated: false,
};

describe("priceProviderUsage (94S-409)", () => {
  test("prices every part at the model's rate, the hour-long cache writes at twice the input", () => {
    // claude-sonnet-5: $2 in, $10 out, $0.20 cache read per million.
    const { costUsd, pricedBy } = priceProviderUsage({
      ...nothing,
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

  test("a fast answer pays the fast rates, cache multipliers on top (94S-451)", () => {
    // claude-opus-5-5 fast: $8 in, $40 out, $0.40 cache read per million.
    const { costUsd, pricedBy } = priceProviderUsage({
      ...nothing,
      model: "claude-opus-5-5",
      speed: "fast",
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      cacheCreationInputTokens: 2_000_000,
      cacheCreation1hInputTokens: 1_000_000,
      cacheReadInputTokens: 1_000_000,
    });
    expect(pricedBy).toBe("table");
    // 8 + 40 + 1 × 8 × 1.25 + 1 × 8 × 2 + 0.4
    expect(costUsd).toBeCloseTo(74.4, 9);
    expect(
      priceProviderUsage({
        ...nothing,
        model: "claude-opus-5-5",
        outputTokens: 1_000_000,
      }).costUsd,
    ).toBe(20);
  });

  test("a fast answer from a model without fast rates, or an unknown speed, pays the highest rate of either table (94S-451)", () => {
    const highest = Math.max(
      ...[
        ...Object.values(MODEL_PRICES),
        ...Object.values(FAST_MODEL_PRICES),
      ].map((price) => price.outputUsdPerMtok),
    );
    for (const usage of [
      { model: "claude-sonnet-5", speed: "fast" },
      { model: "claude-opus-5", speed: "turbo" },
      { model: "claude-opus-5", speed: "unknown" },
    ]) {
      expect(
        priceProviderUsage({ ...nothing, ...usage, outputTokens: 1_000_000 }),
      ).toEqual({ costUsd: highest, pricedBy: "fallback" });
    }
  });

  test("each web search adds $0.01; web fetch and code execution add nothing (94S-451)", () => {
    expect(
      priceProviderUsage({
        ...nothing,
        model: "claude-sonnet-5",
        webSearchRequests: 3,
        webFetchRequests: 5,
        codeExecutionRequests: 7,
      }),
    ).toEqual({ costUsd: 0.03, pricedBy: "table" });
  });

  const highest = (() => {
    const prices = [
      ...Object.values(MODEL_PRICES),
      ...Object.values(FAST_MODEL_PRICES),
    ];
    return {
      input: Math.max(...prices.map((price) => price.inputUsdPerMtok)),
      output: Math.max(...prices.map((price) => price.outputUsdPerMtok)),
    };
  })();

  test("US-only inference pays 1.1x on every token rate, fast and cache ones included, but not on search fees (94S-454)", () => {
    const tokens = {
      ...nothing,
      model: "claude-opus-5-5",
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      cacheCreationInputTokens: 2_000_000,
      cacheCreation1hInputTokens: 1_000_000,
      cacheReadInputTokens: 1_000_000,
      webSearchRequests: 100,
    };
    // 4 + 20 + 1 × 4 × 1.25 + 1 × 4 × 2 + 0.2 = 37.2 in tokens, $1 in searches.
    expect(priceProviderUsage(tokens)).toEqual({
      costUsd: 38.2,
      pricedBy: "table",
    });
    const us = priceProviderUsage({ ...tokens, inferenceGeo: "us" });
    expect(us.pricedBy).toBe("table");
    expect(us.costUsd).toBeCloseTo(37.2 * 1.1 + 1, 9);
    // Fast: 74.4 in tokens (see above).
    expect(
      priceProviderUsage({ ...tokens, speed: "fast", inferenceGeo: "us" })
        .costUsd,
    ).toBeCloseTo(74.4 * 1.1 + 1, 9);
    // A whole micro-dollar figure stays whole, with nothing for the ledger's
    // ceil to round up.
    expect(
      priceProviderUsage({
        ...nothing,
        model: "claude-opus-5",
        outputTokens: 1_000,
        inferenceGeo: "us",
      }).costUsd,
    ).toBe(0.0275);
  });

  test("a geo the table does not know pays the highest rate and the highest multiplier (94S-454)", () => {
    for (const inferenceGeo of ["unknown", "eu", "US", "constructor"]) {
      expect(
        priceProviderUsage({
          ...nothing,
          model: "claude-sonnet-5",
          outputTokens: 1_000_000,
          inferenceGeo,
        }),
      ).toEqual({ costUsd: highest.output * 1.1, pricedBy: "fallback" });
    }
  });

  test("a model from before 4.6 pays standard rates whatever the geo says (94S-454)", () => {
    for (const inferenceGeo of ["us", "unknown"]) {
      expect(
        priceProviderUsage({
          ...nothing,
          model: "claude-haiku-4-5",
          outputTokens: 1_000_000,
          inferenceGeo,
        }),
      ).toEqual({ costUsd: 5, pricedBy: "table" });
    }
  });

  test("a model from before 4.6 past 200K input, cache included, pays the highest rate; 4.6 and later keep theirs (94S-454)", () => {
    const at = (model: string, input: number) =>
      priceProviderUsage({
        ...nothing,
        model,
        inputTokens: input - 150_000,
        cacheCreationInputTokens: 100_000,
        cacheReadInputTokens: 50_000,
      });
    expect(at("claude-sonnet-4-5", 200_000).pricedBy).toBe("table");
    const over = at("claude-sonnet-4-5-20250929", 200_001);
    expect(over.pricedBy).toBe("fallback");
    // 50,001 in, 100,000 written for five minutes, 50,000 read.
    expect(over.costUsd).toBeGreaterThan((50_001 * highest.input) / 1_000_000);
    expect(at("claude-sonnet-4-6", 900_000).pricedBy).toBe("table");
    expect(at("claude-opus-4-6", 900_000).pricedBy).toBe("table");
  });
});
