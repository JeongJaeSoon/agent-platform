// Times the contract check on a 100-row list and 1,000 session events:
// bun packages/core/scripts/parse-time.ts
import { contractValidators } from "../src/schemas/index.ts";

const ROUNDS = 50;
const uuid = (n: number) =>
  `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
const AT = "2026-10-21T00:00:00.000Z";

const list = {
  items: Array.from({ length: 100 }, (_, n) => ({
    id: uuid(n),
    kind: n % 2 ? "agent" : "personal",
    name: n % 2 ? `agent-${n}` : null,
    workspace_id: uuid(100_000),
    agent_id: n % 2 ? uuid(200_000 + n) : null,
    created_by: uuid(300_000),
    created_by_user: { id: uuid(300_000), display_name: "Owner" },
    scopes: ["sessions:read", "sessions:write"],
    created_at: AT,
    expires_at: null,
    revoked_at: null,
    last_used_at: null,
  })),
};

const payloads = [
  ["status", { phase: "running" }],
  [
    "assistant",
    {
      type: "assistant",
      message: { content: [{ type: "text", text: "Listing files" }] },
    },
  ],
  [
    "tool_use",
    {
      type: "assistant",
      message: { content: [{ type: "tool_use", name: "Bash" }] },
    },
  ],
] as const;
const events = Array.from({ length: 1000 }, (_, n) => {
  const [event, data] = payloads[n % payloads.length] ?? payloads[0];
  return {
    id: `ev_${n}`,
    event,
    data: {
      schema_version: 1,
      session_id: uuid(400_000),
      turn_id: "1",
      attempt_id: null,
      occurred_at: AT,
      data,
    },
  };
});

const checkList = contractValidators.responses?.["GET /v1/api-keys"];
const checkEvent = contractValidators.sessionEvent;
if (!checkList || !checkEvent) throw new Error("validator missing");

// A fixture that fails the contract would time the error path instead.
const issues = [...checkList(list), ...events.flatMap((e) => checkEvent(e))];
if (issues.length > 0) throw new Error(JSON.stringify(issues.slice(0, 3)));

function time(label: string, run: () => void) {
  run();
  const samples: number[] = [];
  for (let round = 0; round < ROUNDS; round++) {
    const start = performance.now();
    run();
    samples.push(performance.now() - start);
  }
  samples.sort((a, b) => a - b);
  const at = (q: number) =>
    (samples[Math.floor(q * (samples.length - 1))] ?? 0).toFixed(2);
  console.log(
    `${label}: median ${at(0.5)} ms, p95 ${at(0.95)} ms (${ROUNDS} rounds)`,
  );
}

console.log(`bun ${Bun.version}, ${process.platform}/${process.arch}`);
time("GET /v1/api-keys, 100 rows", () => checkList(list));
time("session events, 1,000 frames", () => {
  for (const event of events) checkEvent(event);
});
