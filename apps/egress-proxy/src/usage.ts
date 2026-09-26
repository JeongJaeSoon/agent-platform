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
 * by field. A stream cut short keeps what it had: the upstream bills the
 * input as soon as it answers.
 */

export type MessagesUsage = {
  model: string;
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  /** The part of the cache writes held for an hour, which costs more. */
  cache_creation_1h_input_tokens: number;
};

const COUNTS = [
  "input_tokens",
  "output_tokens",
  "cache_creation_input_tokens",
  "cache_read_input_tokens",
] as const;

/**
 * A JSON answer read only up to this; one with 128K output tokens is well
 * inside it. Past it the call goes unmetered, and the engine's own figure is
 * all that counts it.
 */
const MAX_JSON_BYTES = 8 * 1024 * 1024;
/** An SSE line longer than this is a content delta, never a usage event. */
const MAX_EVENT_LINE_BYTES = 256 * 1024;

type Counts = Partial<Record<(typeof COUNTS)[number], number>>;

function count(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}

function countsOf(value: unknown): Counts & { oneHour?: number } {
  if (typeof value !== "object" || value === null) return {};
  const counts: Counts & { oneHour?: number } = {};
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

export type UsageMeter = {
  observe(chunk: Uint8Array): void;
  /** What was seen, or null when no usage ever came. */
  result(): MessagesUsage | null;
};

export function usageMeter(contentType: string | null): UsageMeter {
  let model: string | undefined;
  let counts: Counts & { oneHour?: number } = {};
  let seen = false;
  const take = (message: unknown, usage: unknown) => {
    if (typeof message === "object" && message !== null) {
      const named = (message as Record<string, unknown>).model;
      if (typeof named === "string") model = named;
    }
    if (typeof usage === "object" && usage !== null) {
      counts = { ...counts, ...countsOf(usage) };
      seen = true;
    }
  };
  const decoder = new TextDecoder();
  const result = (): MessagesUsage | null =>
    seen && model !== undefined
      ? {
          model,
          input_tokens: counts.input_tokens ?? 0,
          output_tokens: counts.output_tokens ?? 0,
          cache_creation_input_tokens: counts.cache_creation_input_tokens ?? 0,
          cache_read_input_tokens: counts.cache_read_input_tokens ?? 0,
          cache_creation_1h_input_tokens: Math.min(
            counts.oneHour ?? 0,
            counts.cache_creation_input_tokens ?? 0,
          ),
        }
      : null;

  if ((contentType ?? "").toLowerCase().startsWith("text/event-stream")) {
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
      const { type, message, usage } = parsed as Record<string, unknown>;
      if (type === "message_start" && typeof message === "object") {
        take(message, (message as Record<string, unknown> | null)?.usage);
      } else if (type === "message_delta") {
        take(undefined, usage);
      }
    };
    return {
      observe(chunk) {
        const lines = decoder.decode(chunk, { stream: true }).split("\n");
        const last = lines.pop() ?? "";
        for (const piece of lines) {
          const whole = skipping ? "" : line + piece;
          if (!skipping && whole.startsWith("data:")) {
            event(whole.slice(5).trim());
          }
          line = "";
          skipping = false;
        }
        if (skipping) return;
        line += last;
        if (line.length > MAX_EVENT_LINE_BYTES) {
          line = "";
          skipping = true;
        }
      },
      result,
    };
  }

  const chunks: Uint8Array[] = [];
  let total = 0;
  let parsed = false;
  return {
    observe(chunk) {
      total += chunk.byteLength;
      if (total <= MAX_JSON_BYTES) chunks.push(chunk);
    },
    result() {
      if (!parsed && total <= MAX_JSON_BYTES) {
        parsed = true;
        try {
          const body = JSON.parse(decoder.decode(Buffer.concat(chunks)));
          take(body, (body as Record<string, unknown> | null)?.usage);
        } catch {}
        chunks.length = 0;
      }
      return result();
    },
  };
}
