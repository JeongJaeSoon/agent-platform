/**
 * The soak's VM stall probe (94S-443): a container on the soak stack that
 * ticks every 100ms and records every tick that came late by a stall, so a
 * readyz sample that failed while the whole Docker Desktop VM stood still
 * (94S-442) can be told from one the product failed. It shares nothing with
 * the product: it runs on the gate's plain Bun image and only reads clocks.
 *
 *   GET /stalls?since=<index>   {bootId, now, stalls: [...]} after <index>
 *   GET /healthz
 *
 * A stall's `from`/`to` are this container's wall clock at the tick before
 * and the tick after; `gapMs` is the monotonic time between them.
 */

export type Stall = { index: number; from: number; to: number; gapMs: number };

const TICK_MS = 100;
/** Kept well under the 1s the soak judges on, so the log shows near misses. */
const RECORD_MS = 500;
/** A day at the 94S-442 rate is ~600 stalls; this bounds a runaway. */
const KEEP = 100_000;

export class StallRecorder {
  readonly stalls: Stall[] = [];
  private next = 0;
  private last: { mono: number; wall: number } | null = null;

  constructor(private readonly recordMs = RECORD_MS) {}

  tick(mono: number, wall: number): void {
    const last = this.last;
    this.last = { mono, wall };
    if (last === null) return;
    const gapMs = mono - last.mono;
    if (gapMs < this.recordMs) return;
    this.stalls.push({ index: this.next++, from: last.wall, to: wall, gapMs });
    if (this.stalls.length > KEEP) this.stalls.shift();
  }

  since(index: number): Stall[] {
    return this.stalls.filter((stall) => stall.index >= index);
  }
}

if (import.meta.main) {
  const recorder = new StallRecorder();
  const bootId = crypto.randomUUID();
  setInterval(() => recorder.tick(performance.now(), Date.now()), TICK_MS);
  recorder.tick(performance.now(), Date.now());
  Bun.serve({
    port: Number(process.env.VM_LAG_PORT ?? 8098),
    fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/healthz") return new Response("ok");
      if (url.pathname !== "/stalls") {
        return new Response("not found", { status: 404 });
      }
      const since = Number(url.searchParams.get("since") ?? 0);
      return Response.json({
        bootId,
        now: Date.now(),
        stalls: recorder.since(Number.isInteger(since) ? since : 0),
      });
    },
  });
}
