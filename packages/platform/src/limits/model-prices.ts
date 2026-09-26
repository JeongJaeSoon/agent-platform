/**
 * What the platform charges a session for one Messages call (94S-409): the
 * provider's list price per million tokens, by the model the answer names.
 * The platform owns this table and updates it with its releases, when a
 * model is added or a price changes; checked against Anthropic's pricing
 * on 2026-09-26.
 *
 * Fast mode has its own rates (94S-451), and each web search adds its
 * per-search fee. An estimate, not a bill: long-context premiums, the US
 * inference_geo premium and code execution container time are not priced.
 */

type ModelPrice = {
  inputUsdPerMtok: number;
  outputUsdPerMtok: number;
  cacheReadUsdPerMtok: number;
};

// Cache writes cost a multiple of the input rate: 1.25x held five minutes,
// 2x held an hour.
const CACHE_WRITE_5M = 1.25;
const CACHE_WRITE_1H = 2;

function price(input: number, output: number, cacheRead: number): ModelPrice {
  return {
    inputUsdPerMtok: input,
    outputUsdPerMtok: output,
    cacheReadUsdPerMtok: cacheRead,
  };
}

const FABLE_5_1 = price(10, 50, 0.25);
const FABLE_5 = price(10, 50, 1);
const OPUS_5_5 = price(4, 20, 0.2);
const OPUS_5 = price(5, 25, 0.5);
const OPUS_4 = price(15, 75, 1.5);
const SONNET_5 = price(2, 10, 0.2);
const SONNET_4 = price(3, 15, 0.3);
const HAIKU_4_5 = price(1, 5, 0.1);

/** Exact model ids as an answer names them, aliases and dated ids both. */
export const MODEL_PRICES: Readonly<Record<string, ModelPrice>> = {
  "claude-fable-5-1": FABLE_5_1,
  "claude-mythos-5-1": FABLE_5_1,
  "claude-fable-5": FABLE_5,
  "claude-mythos-5": FABLE_5,
  "claude-opus-5-5": OPUS_5_5,
  "claude-opus-5": OPUS_5,
  "claude-opus-4-8": OPUS_5,
  "claude-opus-4-7": OPUS_5,
  "claude-opus-4-6": OPUS_5,
  "claude-opus-4-5": OPUS_5,
  "claude-opus-4-5-20251101": OPUS_5,
  "claude-opus-4-0": OPUS_4,
  "claude-opus-4-20250514": OPUS_4,
  "claude-sonnet-5": SONNET_5,
  "claude-sonnet-4-6": SONNET_4,
  "claude-sonnet-4-5": SONNET_4,
  "claude-sonnet-4-5-20250929": SONNET_4,
  "claude-sonnet-4-0": SONNET_4,
  "claude-sonnet-4-20250514": SONNET_4,
  "claude-haiku-4-5": HAIKU_4_5,
  "claude-haiku-4-5-20251001": HAIKU_4_5,
};

/** `speed: "fast"` rates, twice the standard ones for the models offering it. */
export const FAST_MODEL_PRICES: Readonly<Record<string, ModelPrice>> = {
  "claude-opus-5-5": price(8, 40, 0.4),
  "claude-opus-5": price(10, 50, 1),
  "claude-opus-4-8": price(10, 50, 1),
};

/**
 * $10 per 1,000 searches, in millionths of a dollar like a token count
 * times its per-million rate. Web fetch has no fee beyond its tokens.
 */
const WEB_SEARCH_MICRO_USD = 10_000;

/**
 * A model the table does not know, at a speed it does not know, is charged
 * every part at the highest rate either table has: a budget errs on counting
 * too much, never too little.
 */
const FALLBACK_PRICE: ModelPrice = (() => {
  const prices = [
    ...Object.values(MODEL_PRICES),
    ...Object.values(FAST_MODEL_PRICES),
  ];
  return price(
    Math.max(...prices.map((known) => known.inputUsdPerMtok)),
    Math.max(...prices.map((known) => known.outputUsdPerMtok)),
    Math.max(...prices.map((known) => known.cacheReadUsdPerMtok)),
  );
})();

export type ProviderUsage = {
  model: string;
  inputTokens: number;
  outputTokens: number;
  /** Every cache write, the hour-long ones included. */
  cacheCreationInputTokens: number;
  cacheCreation1hInputTokens: number;
  cacheReadInputTokens: number;
  /** `standard`, `fast`, or whatever else the call named, which is priced high. */
  speed: string;
  webSearchRequests: number;
  webFetchRequests: number;
  /** Billed by container time, which the answer does not say: not priced. */
  codeExecutionRequests: number;
  /** The proxy estimated some of it high; the answer did not say. */
  estimated: boolean;
};

export function priceProviderUsage(usage: ProviderUsage): {
  costUsd: number;
  pricedBy: "table" | "fallback";
} {
  const table: Readonly<Record<string, ModelPrice>> =
    usage.speed === "standard"
      ? MODEL_PRICES
      : usage.speed === "fast"
        ? FAST_MODEL_PRICES
        : {};
  const known = Object.hasOwn(table, usage.model)
    ? table[usage.model]
    : undefined;
  const rates = known ?? FALLBACK_PRICE;
  const oneHour = Math.min(
    usage.cacheCreation1hInputTokens,
    usage.cacheCreationInputTokens,
  );
  const perMtok =
    usage.inputTokens * rates.inputUsdPerMtok +
    (usage.cacheCreationInputTokens - oneHour) *
      rates.inputUsdPerMtok *
      CACHE_WRITE_5M +
    oneHour * rates.inputUsdPerMtok * CACHE_WRITE_1H +
    usage.cacheReadInputTokens * rates.cacheReadUsdPerMtok +
    usage.outputTokens * rates.outputUsdPerMtok;
  return {
    costUsd:
      (perMtok + usage.webSearchRequests * WEB_SEARCH_MICRO_USD) / 1_000_000,
    pricedBy: known === undefined ? "fallback" : "table",
  };
}
