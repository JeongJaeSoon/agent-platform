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
 * charges at least a token for every character of content it delivered,
 * and a web search for every search result it delivered. A
 * JSON answer with no usable usage (cut short, too big, not JSON) is
 * charged from its request: a token for every byte sent, and all the
 * output `max_tokens` allowed.
 *
 * The speed is priced too (94S-451): the answer's `usage.speed`, or the
 * request's `speed` when the answer does not say. So are the server tools
 * the answer counted in `usage.server_tool_use`.
 */

export type MessagesUsage = {
  model: string;
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  /** The part of the cache writes held for an hour, which costs more. */
  cache_creation_1h_input_tokens: number;
  /** `standard`, `fast`, or `unknown` for a value that is not a name. */
  speed: string;
  web_search_requests: number;
  web_fetch_requests: number;
  code_execution_requests: number;
  /** Some of it was estimated rather than read off the answer. */
  estimated: boolean;
};

const COUNTS = [
  "input_tokens",
  "output_tokens",
  "cache_creation_input_tokens",
  "cache_read_input_tokens",
] as const;

const TOOL_COUNTS = [
  "web_search_requests",
  "web_fetch_requests",
  "code_execution_requests",
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
/** Longer than any speed's name; what the API's report schema accepts. */
const MAX_SPEED_LENGTH = 64;

type Counts = Partial<
  Record<(typeof COUNTS)[number] | (typeof TOOL_COUNTS)[number], number>
> & {
  oneHour?: number;
  speed?: string;
};

/** Absent or null says nothing; anything but a name is priced high. */
function speedOf(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  return typeof value === "string" &&
    value !== "" &&
    value.length <= MAX_SPEED_LENGTH
    ? value
    : "unknown";
}

function requested(request: Uint8Array | null): {
  model: string;
  maxTokens: number;
  speed: string;
} {
  try {
    const body = JSON.parse(new TextDecoder().decode(request ?? undefined));
    return {
      model:
        typeof body?.model === "string" && body.model !== ""
          ? body.model
          : UNKNOWN_MODEL,
      maxTokens: count(body?.max_tokens) ?? 0,
      speed: speedOf(body?.speed) ?? "standard",
    };
  } catch {
    return { model: UNKNOWN_MODEL, maxTokens: 0, speed: "standard" };
  }
}

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
  const tools = (value as Record<string, unknown>).server_tool_use;
  if (typeof tools === "object" && tools !== null) {
    for (const name of TOOL_COUNTS) {
      const found = count((tools as Record<string, unknown>)[name]);
      if (found !== undefined) counts[name] = found;
    }
  }
  const speed = speedOf((value as Record<string, unknown>).speed);
  if (speed !== undefined) counts.speed = speed;
  return counts;
}

function usageOf(
  model: string,
  counts: Counts,
  estimated: boolean,
  request: Uint8Array | null,
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
    speed: counts.speed ?? requested(request).speed,
    web_search_requests: counts.web_search_requests ?? 0,
    web_fetch_requests: counts.web_fetch_requests ?? 0,
    code_execution_requests: counts.code_execution_requests ?? 0,
    estimated,
  };
}

/** A call charged from its request alone: see the module comment. */
export function requestEstimate(request: Uint8Array | null): MessagesUsage {
  const { model, maxTokens, speed } = requested(request);
  return usageOf(
    model,
    {
      input_tokens: request?.byteLength ?? 0,
      output_tokens: maxTokens,
      speed,
    },
    true,
    request,
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
    let searched = 0;
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
      } else if (type === "content_block_start") {
        // A failed search is not billed, and its content is an error object.
        const block = (parsed as Record<string, unknown>).content_block as
          | Record<string, unknown>
          | undefined;
        if (
          block?.type === "web_search_tool_result" &&
          Array.isArray(block.content)
        ) {
          searched += 1;
        }
      } else if (type === "content_block_delta") {
        const content = delta as Record<string, unknown> | null;
        for (const field of ["text", "partial_json", "thinking"]) {
          const part = content?.[field];
          if (typeof part === "string") delivered += part.length;
        }
      }
    };
    // A line too long to parse is counted from its head: a search result can
    // outgrow the limit, and only a successful one does, an error being a
    // few bytes. Its type fields lead the event.
    const skipped = (head: string) => {
      const start = head.slice(0, 512);
      if (
        start.startsWith("data:") &&
        start.includes('"content_block_start"') &&
        start.includes('"web_search_tool_result"')
      ) {
        searched += 1;
      }
    };
    return {
      observe(chunk) {
        const lines = decoder.decode(chunk, { stream: true }).split("\n");
        const last = lines.pop() ?? "";
        for (const piece of lines) {
          const whole = skipping ? piece : line + piece;
          if (skipping || whole.length > MAX_EVENT_LINE_BYTES) {
            if (!skipping) skipped(whole);
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
          skipped(line);
          delivered += line.length;
          line = "";
          skipping = true;
        }
      },
      result(request) {
        if (model === undefined) return requestEstimate(request);
        if (stopped) return usageOf(model, counts, false, request);
        return usageOf(
          model,
          {
            ...counts,
            output_tokens: Math.max(counts.output_tokens ?? 0, delivered),
            web_search_requests: Math.max(
              counts.web_search_requests ?? 0,
              searched,
            ),
          },
          true,
          request,
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
            return usageOf(body.model, countsOf(body.usage), false, request);
          }
        } catch {}
      }
      return requestEstimate(request);
    },
  };
}
