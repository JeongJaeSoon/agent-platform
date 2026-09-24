/**
 * What one checkpoint's transcript stage costs as a session ages (94S-380):
 * a turn appends one part, and a capture runs at every turn boundary, as the
 * worker does. In memory, so what it measures is this store's own work, not
 * the object store's latency.
 *
 *   bun packages/adapters/runtimes/claude/src/session-store.bench.ts [turns] [entries-per-turn] [entry-bytes]
 */
import { performance } from "node:perf_hooks";
import type { TranscriptEntry } from "@agent-platform/runtime-core";
import { createMemoryCheckpointObjectStore } from "@agent-platform/testkit/checkpoint-objects";
import { ClaudeSessionStore } from "./session-store.ts";

const turns = Number(process.argv[2] ?? 1000);
const perTurn = Number(process.argv[3] ?? 10);
const entryBytes = Number(process.argv[4] ?? 1024);
const marks = new Set([10, 50, 100, 250, 500, 750, 1000, 1500, 2000]);
const WINDOW = 5;

const objects = createMemoryCheckpointObjectStore({ versioned: true });
const store = new ClaudeSessionStore({
  generation: 1,
  objects,
  prefix: "sessions/bench/mirror",
});
await store.ready();
const key = { projectKey: "-workspace", sessionId: "bench" };
const filler = "x".repeat(entryBytes);

const samples: number[] = [];
const rows: Array<{ turn: number; medianMs: number; entries: number }> = [];
for (let turn = 1; turn <= turns; turn += 1) {
  const entries: TranscriptEntry[] = Array.from(
    { length: perTurn },
    (_, index) => ({
      type: index % 2 === 0 ? "user" : "assistant",
      uuid: `${turn}-${index}`,
      message: { content: filler, turn },
    }),
  );
  await store.append(key, entries);
  const started = performance.now();
  const captured = await store.captureTranscripts("bench");
  samples.push(performance.now() - started);
  if (samples.length > WINDOW) samples.shift();
  if (marks.has(turn)) {
    const sorted = [...samples].sort((a, b) => a - b);
    rows.push({
      turn,
      medianMs: Number((sorted[Math.floor(sorted.length / 2)] ?? 0).toFixed(2)),
      entries: captured?.root.entryCount ?? 0,
    });
  }
}
console.table(rows);
