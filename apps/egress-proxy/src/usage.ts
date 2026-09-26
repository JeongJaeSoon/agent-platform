/**
 * What one Messages call used, read off the answer on its way to the worker
 * (94S-409). The engine's own figure is its SDK's `total_cost_usd`, which a
 * tool calling the route with the engine's token never shows up in; the
 * proxy sees every call, so it is where those are counted.
 *
 * A JSON answer carries `usage` whole. A streamed one opens with
 * `message_start`, whose message has the input side, and each
 * `message_delta` carries running totals — the output count at least, and
 * the input side again on newer API versions — so the last one wins field
 * by field.
 *
 * Whatever the answer did not say is estimated high, never left out: the
 * budget errs on counting too much. A stream cut before `message_stop`
 * charges at least a token for every character of content it delivered. A
 * JSON answer with no usable usage (cut short, too big, not JSON) is
 * charged from its request: a token for every byte sent, and all the
 * output `max_tokens` allowed.
 */

export type MessagesUsage = {
  model: string;
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  /** The part of the cache writes held for an hour, which costs more. */
  cache_creation_1h_input_tokens: number;
  /** Some of it was estimated rather than read off the answer. */
  estimated: boolean;
};

const COUNTS = [
  "input_tokens",
  "output_tokens",
  "cache_creation_input_tokens",
  "cache_read_input_tokens",
] as const;

/**
 * A JSON answer read only up to this; one with 128K output tokens is well
 * inside it. Past it the call is charged from its request instead.
 */
const MAX_JSON_BYTES = 8 * 1024 * 1024;
/** An SSE line longer than this is a content delta, never a usage event. */
const MAX_EVENT_LINE_BYTES = 256 * 1024;
/** What a request that names no model is priced as: the fallback rate. */
const UNKNOWN_MODEL = "unknown";

type Counts = Partial<Record<(typeof COUNTS)[number], number>> & {
  oneHour?: number;
};

function count(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}

function countsOf(value: unknown): Counts {
  if (typeof value !== "object" || value === null) return {};
  const counts: Counts = {};
  for (const name of COUNTS) {
    const found = count((value as Record<string, unknown>)[name]);
    if (found !== undefined) counts[name] = found;
  }
  const split = (value as Record<string, unknown>).cache_creation;
  if (typeof split === "object" && split !== null) {
    const oneHour = count(
      (split as Record<string, unknown>).ephemeral_1h_input_tokens,
    );
    if (oneHour !== undefined) counts.oneHour = oneHour;
  }
  return counts;
}

function usageOf(
  model: string,
  counts: Counts,
  estimated: boolean,
): MessagesUsage {
  return {
    model,
    input_tokens: counts.input_tokens ?? 0,
    output_tokens: counts.output_tokens ?? 0,
    cache_creation_input_tokens: counts.cache_creation_input_tokens ?? 0,
    cache_read_input_tokens: counts.cache_read_input_tokens ?? 0,
    cache_creation_1h_input_tokens: Math.min(
      counts.oneHour ?? 0,
      counts.cache_creation_input_tokens ?? 0,
    ),
    estimated,
  };
}

/** A call charged from its request alone: see the module comment. */
export function requestEstimate(request: Uint8Array | null): MessagesUsage {
  let model = UNKNOWN_MODEL;
  let maxTokens = 0;
  try {
    const body = JSON.parse(new TextDecoder().decode(request ?? undefined));
    if (typeof body?.model === "string" && body.model !== "")
      model = body.model;
    maxTokens = count(body?.max_tokens) ?? 0;
  } catch {}
  return usageOf(
    model,
    { input_tokens: request?.byteLength ?? 0, output_tokens: maxTokens },
    true,
  );
}

export type UsageMeter = {
  observe(chunk: Uint8Array): void;
  /** What the answer said it used, estimated where it said too little. */
  result(request: Uint8Array | null): MessagesUsage;
};

export function usageMeter(contentType: string | null): UsageMeter {
  const decoder = new TextDecoder();
  if ((contentType ?? "").toLowerCase().startsWith("text/event-stream")) {
    let model: string | undefined;
    let counts: Counts = {};
    let stopped = false;
    let delivered = 0;
    let line = "";
    let skipping = false;
    const event = (data: string) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(data);
      } catch {
        return;
      }
      if (typeof parsed !== "object" || parsed === null) return;
      const { type, message, usage, delta } = parsed as Record<string, unknown>;
      if (type === "message_start" && typeof message === "object") {
        const started = message as Record<string, unknown> | null;
        if (typeof started?.model === "string") model = started.model;
        counts = { ...counts, ...countsOf(started?.usage) };
      } else if (type === "message_delta") {
        counts = { ...counts, ...countsOf(usage) };
      } else if (type === "message_stop") {
        stopped = true;
      } else if (type === "content_block_delta") {
        const content = delta as Record<string, unknown> | null;
        for (const field of ["text", "partial_json", "thinking"]) {
          const part = content?.[field];
          if (typeof part === "string") delivered += part.length;
        }
      }
    };
    return {
      observe(chunk) {
        const lines = decoder.decode(chunk, { stream: true }).split("\n");
        const last = lines.pop() ?? "";
        for (const piece of lines) {
          const whole = skipping ? piece : line + piece;
          if (skipping || whole.length > MAX_EVENT_LINE_BYTES) {
            delivered += whole.length;
          } else if (whole.startsWith("data:")) {
            event(whole.slice(5).trim());
          }
          line = "";
          skipping = false;
        }
        if (skipping) {
          delivered += last.length;
          return;
        }
        line += last;
        if (line.length > MAX_EVENT_LINE_BYTES) {
          delivered += line.length;
          line = "";
          skipping = true;
        }
      },
      result(request) {
        if (model === undefined) return requestEstimate(request);
        if (stopped) return usageOf(model, counts, false);
        return usageOf(
          model,
          {
            ...counts,
            output_tokens: Math.max(counts.output_tokens ?? 0, delivered),
          },
          true,
        );
      },
    };
  }

  const chunks: Uint8Array[] = [];
  let total = 0;
  return {
    observe(chunk) {
      total += chunk.byteLength;
      if (total <= MAX_JSON_BYTES) chunks.push(chunk);
    },
    result(request) {
      if (total <= MAX_JSON_BYTES) {
        try {
          const body = JSON.parse(decoder.decode(Buffer.concat(chunks)));
          if (
            typeof body?.model === "string" &&
            typeof body.usage === "object" &&
            body.usage !== null
          ) {
            return usageOf(body.model, countsOf(body.usage), false);
          }
        } catch {}
      }
      return requestEstimate(request);
    },
  };
}
