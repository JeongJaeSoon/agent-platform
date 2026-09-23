import {
  type FakeReply,
  type RecordedRequest,
  startFakeAnthropicServer,
  textReply,
  toolReply,
} from "../../packages/testkit/src/fake-anthropic.ts";

/**
 * The D2 gate's Messages API (94S-247). What the model does is written into
 * the prompt itself, so the gate test scripts every turn and every subagent
 * without this server knowing the scenario: a user text block reading
 * `GATE-SPEC {"id":…,"steps":[…],"final":…}` is the plan, and the number of
 * tool results after it says which step comes next. The Agent tool's prompt
 * carries its own spec, which is how a subagent gets one.
 *
 * Side requests the engine makes without tools (titles, summaries) are
 * answered with plain text and never read a spec, even when they quote one.
 */

export const SPEC_MARKER = "GATE-SPEC ";

export type GateStep = {
  delayMs?: number;
  input: Record<string, unknown>;
  tool: string;
};

export type GateSpec = {
  final: string;
  finalDelayMs?: number;
  id: string;
  steps: GateStep[];
};

type Message = { content: unknown; role: string };
type Block = { text?: string; type: string };

export type GateRequest = {
  at: string;
  hasTools: boolean;
  index: number;
  messages: unknown[];
  specId: string | null;
  step: number | null;
  system: unknown;
};

function blocksOf(message: Message): Block[] {
  if (typeof message.content === "string") {
    return [{ type: "text", text: message.content }];
  }
  return Array.isArray(message.content) ? (message.content as Block[]) : [];
}

/** The latest spec in the conversation and how many tool results follow it. */
export function planOf(
  messages: readonly Message[],
): { spec: GateSpec; step: number } | null {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message?.role !== "user") continue;
    for (const block of blocksOf(message)) {
      if (block.type !== "text" || block.text === undefined) continue;
      const at = block.text.lastIndexOf(SPEC_MARKER);
      if (at < 0) continue;
      const spec = JSON.parse(
        firstJsonObject(block.text.slice(at + SPEC_MARKER.length)),
      ) as GateSpec;
      let step = 0;
      for (const later of messages.slice(index + 1)) {
        if (later.role !== "user") continue;
        step += blocksOf(later).filter(
          (candidate) => candidate.type === "tool_result",
        ).length;
      }
      return { spec, step };
    }
  }
  return null;
}

/** The spec is followed by whatever the engine appends to a prompt. */
function firstJsonObject(text: string): string {
  let depth = 0;
  let inString = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (inString) {
      if (char === "\\") index++;
      else if (char === '"') inString = false;
    } else if (char === '"') inString = true;
    else if (char === "{") depth++;
    else if (char === "}" && --depth === 0) return text.slice(0, index + 1);
  }
  throw new Error(`unterminated ${SPEC_MARKER.trim()}`);
}

export function replyFor(
  request: RecordedRequest,
  recorded: GateRequest[],
): Promise<FakeReply> | FakeReply {
  const messages = (request.body.messages ?? []) as Message[];
  const hasTools = (request.body.tools ?? []).length > 0;
  const plan = hasTools ? planOf(messages) : null;
  recorded.push({
    at: new Date().toISOString(),
    hasTools,
    index: recorded.length,
    messages,
    specId: plan?.spec.id ?? null,
    step: plan?.step ?? null,
    system: request.body.system,
  });
  if (plan === null) return textReply("ok");
  const { spec, step } = plan;
  const next = spec.steps[step];
  const reply =
    next === undefined
      ? textReply(spec.final)
      : toolReply(next.tool, next.input, `toolu_gate_${spec.id}_${step}`);
  const delayMs = next === undefined ? spec.finalDelayMs : next.delayMs;
  return delayMs === undefined
    ? reply
    : Bun.sleep(delayMs).then(() => reply);
}

if (import.meta.main) {
  const recorded: GateRequest[] = [];
  const port = Number(process.env.FAKE_MESSAGES_PORT ?? "4010");
  const controlPort = Number(process.env.GATE_CONTROL_PORT ?? "4011");
  startFakeAnthropicServer((request) => replyFor(request, recorded), {
    listen: { hostname: "0.0.0.0", port },
  });
  // Read by the gate test from the host; workers only ever see `port`.
  Bun.serve({
    hostname: "0.0.0.0",
    port: controlPort,
    fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/healthz") return new Response("ok");
      if (url.pathname !== "/requests") {
        return new Response("not found", { status: 404 });
      }
      const spec = url.searchParams.get("spec");
      return Response.json(
        spec === null
          ? recorded
          : recorded.filter((entry) => entry.specId === spec),
      );
    },
  });
  console.log(
    JSON.stringify({ msg: "Gate Messages API listening", port, controlPort }),
  );
  process.on("SIGTERM", () => process.exit(0));
}
