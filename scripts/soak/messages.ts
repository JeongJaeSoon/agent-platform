import {
  errorResponse,
  type RecordedRequest,
  startFakeAnthropicServer,
  textReply,
  toolReply,
} from "../../packages/testkit/src/fake-anthropic.ts";
import { planOf, SPEC_MARKER } from "../d2-gate/fake-messages.ts";

/**
 * The soak's Messages API (94S-135): the D2 gate's scripted model (a
 * `GATE-SPEC` in the prompt says what each step does) with two additions a
 * day-long run needs.
 *
 * - Faults armed at run time over the control port: added latency and a
 *   rate of Anthropic-style errors, so the engine's retries run for real.
 * - A summary per request instead of the whole conversation, in a bounded
 *   log. The summary names every spec id the conversation carries, which is
 *   how the soak proves a turn still saw the turns before it (no silent
 *   context reset) without keeping transcripts in memory.
 */

export type MessagesFaults = {
  /** Uniform in [min, max], before every reply. */
  latencyMs: [number, number];
  /** Probability that a request is answered with an error instead. */
  errorRate: number;
  errorStatuses: number[];
};

export type RequestSummary = {
  at: string;
  /** Status of the injected error, null when the request was answered. */
  fault: number | null;
  hasTools: boolean;
  index: number;
  latencyMs: number;
  /** Every spec id in the conversation, in order, the current one last. */
  specs: string[];
  specId: string | null;
  step: number | null;
};

export const NO_FAULTS: MessagesFaults = {
  latencyMs: [0, 0],
  errorRate: 0,
  errorStatuses: [500],
};

const SPEC_ID = new RegExp(`${SPEC_MARKER}\\{[^\\n]*?"id":"([^"\\\\]+)"`, "g");

type Message = { content: unknown; role: string };

/** Spec ids of every user text block, oldest first, each once. */
export function specIds(messages: readonly Message[]): string[] {
  const found: string[] = [];
  for (const message of messages) {
    if (message.role !== "user") continue;
    const blocks =
      typeof message.content === "string"
        ? [{ type: "text", text: message.content }]
        : Array.isArray(message.content)
          ? (message.content as Array<{ text?: string; type: string }>)
          : [];
    for (const block of blocks) {
      if (block.type !== "text" || block.text === undefined) continue;
      for (const match of block.text.matchAll(SPEC_ID)) {
        const id = match[1];
        if (id !== undefined && !found.includes(id)) found.push(id);
      }
    }
  }
  return found;
}

export function validFaults(value: unknown): MessagesFaults {
  const faults = value as Partial<MessagesFaults>;
  const [min, max] = faults.latencyMs ?? [];
  if (
    typeof min !== "number" ||
    typeof max !== "number" ||
    min < 0 ||
    max < min
  ) {
    throw new Error("latencyMs must be [min, max] with 0 <= min <= max");
  }
  const rate = faults.errorRate;
  if (typeof rate !== "number" || rate < 0 || rate > 1) {
    throw new Error("errorRate must be within [0, 1]");
  }
  const statuses = faults.errorStatuses;
  if (
    !Array.isArray(statuses) ||
    statuses.length === 0 ||
    !statuses.every((status) => Number.isInteger(status) && status >= 400)
  ) {
    throw new Error("errorStatuses must be a non-empty list of HTTP errors");
  }
  return { latencyMs: [min, max], errorRate: rate, errorStatuses: statuses };
}

const ERROR_TYPES: Record<number, string> = {
  429: "rate_limit_error",
  500: "api_error",
  529: "overloaded_error",
};

export function createMessages(
  options: { logMax?: number; random?: () => number } = {},
) {
  const random = options.random ?? Math.random;
  const logMax = options.logMax ?? 0;
  const log: RequestSummary[] = [];
  let received = 0;
  let faults = NO_FAULTS;

  async function reply(
    request: RecordedRequest,
  ): Promise<Response | ReturnType<typeof textReply>> {
    const messages = (request.body.messages ?? []) as Message[];
    const hasTools = (request.body.tools ?? []).length > 0;
    const plan = hasTools ? planOf(messages) : null;
    const [min, max] = faults.latencyMs;
    const latencyMs = Math.round(min + (max - min) * random());
    const fault =
      random() < faults.errorRate
        ? (faults.errorStatuses[
            Math.floor(random() * faults.errorStatuses.length)
          ] ?? 500)
        : null;
    const summary: RequestSummary = {
      at: new Date().toISOString(),
      fault,
      hasTools,
      index: received++,
      latencyMs,
      specs: hasTools ? specIds(messages) : [],
      specId: plan?.spec.id ?? null,
      step: plan?.step ?? null,
    };
    log.push(summary);
    if (logMax > 0 && log.length > logMax) log.splice(0, log.length - logMax);
    if (latencyMs > 0) await Bun.sleep(latencyMs);
    if (fault !== null) {
      return errorResponse({
        status: fault,
        type: ERROR_TYPES[fault] ?? "api_error",
        message: "injected by the soak (94S-135)",
      });
    }
    if (plan === null) return textReply("ok");
    const next = plan.spec.steps[plan.step];
    const scripted =
      next === undefined
        ? textReply(plan.spec.final)
        : toolReply(
            next.tool,
            next.input,
            `toolu_soak_${plan.spec.id}_${plan.step}`,
          );
    const delayMs = next === undefined ? plan.spec.finalDelayMs : next.delayMs;
    if (delayMs !== undefined) await Bun.sleep(delayMs);
    return scripted;
  }

  return {
    reply,
    setFaults(value: unknown): MessagesFaults {
      faults = validFaults(value);
      return faults;
    },
    get faults() {
      return faults;
    },
    requests(filter: { since?: number; spec?: string | null }) {
      return log.filter(
        (entry) =>
          entry.index >= (filter.since ?? 0) &&
          (filter.spec == null || entry.specId === filter.spec),
      );
    },
  };
}

if (import.meta.main) {
  const messages = createMessages({
    logMax: Number(process.env.SOAK_MESSAGES_LOG_MAX ?? "200000"),
  });
  const port = Number(process.env.FAKE_MESSAGES_PORT ?? "4010");
  const controlPort = Number(process.env.GATE_CONTROL_PORT ?? "4011");
  startFakeAnthropicServer((request) => messages.reply(request), {
    listen: { hostname: "0.0.0.0", port },
  });
  // Read and armed by the soak from the host; workers only see `port`.
  Bun.serve({
    hostname: "0.0.0.0",
    port: controlPort,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/healthz") return new Response("ok");
      // The container clock, which is the database's and the fault
      // injector's too: the soak aligns host timestamps against it.
      if (url.pathname === "/clock") return Response.json({ now: Date.now() });
      if (url.pathname === "/faults") {
        if (request.method === "GET") return Response.json(messages.faults);
        try {
          return Response.json(messages.setFaults(await request.json()));
        } catch (error) {
          return Response.json({ error: String(error) }, { status: 400 });
        }
      }
      if (url.pathname === "/requests") {
        return Response.json(
          messages.requests({
            since: Number(url.searchParams.get("since") ?? "0"),
            spec: url.searchParams.get("spec"),
          }),
        );
      }
      return new Response("not found", { status: 404 });
    },
  });
  console.log(
    JSON.stringify({ msg: "Soak Messages API listening", port, controlPort }),
  );
  process.on("SIGTERM", () => process.exit(0));
}
