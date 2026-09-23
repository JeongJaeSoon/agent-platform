import { describe, expect, setSystemTime, test } from "bun:test";
import type {
  HeartbeatRequest,
  HeartbeatResponse,
  TranscriptReport,
  WorkerScope,
} from "@agent-platform/contracts";

import { WorkerGatewayRequestError } from "./gateway-client.ts";
import { Heartbeat, type HeartbeatOptions } from "./heartbeat.ts";

const scope: WorkerScope = {
  session_id: "11111111-1111-4111-8111-111111111111",
  turn_id: null,
  attempt_id: "att_1",
  lease_epoch: 3,
  execution_generation: 1,
  auth_revision: 7,
};

function heartbeat(
  beat: (request: HeartbeatRequest) => Promise<HeartbeatResponse>,
  options: {
    remainingMs?: number;
    safetyMarginMs?: number;
    monotonicNow?: () => number;
    transcript?: () => TranscriptReport | undefined;
  } = {},
) {
  const lost: string[] = [];
  const beats: HeartbeatRequest[] = [];
  const monotonicNow = options.monotonicNow ?? (() => performance.now());
  const instance = new Heartbeat({
    gateway: {
      heartbeat: (request) => {
        beats.push(request);
        return beat(request);
      },
    },
    scope: () => scope,
    attemptState: () => "running",
    intervalMs: 1,
    lease: {
      remainingMs: options.remainingMs ?? 30_000,
      sentAt: monotonicNow(),
    },
    safetyMarginMs: options.safetyMarginMs ?? 1_000,
    onLost: (reason) => lost.push(reason),
    monotonicNow,
    ...(options.transcript === undefined
      ? {}
      : { transcript: options.transcript }),
  });
  return { beats, heartbeat: instance, lost };
}

function answer(remainingMs: number, authRevision = scope.auth_revision) {
  return {
    lease_expires_at: new Date(Date.now() + remainingMs).toISOString(),
    lease_remaining_ms: remainingMs,
    auth_revision: authRevision,
    control_pending: false,
  };
}

async function settle(): Promise<void> {
  await Bun.sleep(30);
}

async function until(done: () => boolean, withinMs = 2_000): Promise<void> {
  const started = performance.now();
  while (!done()) {
    if (performance.now() - started > withinMs) throw new Error("timed out");
    await Bun.sleep(5);
  }
}

describe("Heartbeat", () => {
  test("reports the attempt alive and carries the lease forward", async () => {
    const { beats, heartbeat: beat } = heartbeat(async () => answer(60_000), {
      remainingMs: 5_000,
    });
    beat.start();
    await settle();
    await beat.stop();

    expect(beats.length).toBeGreaterThan(0);
    expect(beats[0]?.attempt_state).toBe("running");
    expect(beats[0]?.lease_epoch).toBe(3);
    expect(beat.leaseLeftMs).toBeGreaterThan(5_000);
    expect(beat.leaseLeftMs).toBeLessThanOrEqual(60_000 - 1_000);
  });

  test("counts the remainder from when the beat was sent, not from when its answer came (94S-322)", async () => {
    let clock = 0;
    const { heartbeat: beat } = heartbeat(
      async () => {
        // The answer takes 4s to come back: that is spent lease, not extra.
        clock += 4_000;
        return answer(30_000);
      },
      { remainingMs: 10_000, safetyMarginMs: 2_000, monotonicNow: () => clock },
    );
    await beat.beatOnce();

    expect(beat.leaseLeftMs).toBe(30_000 - 4_000 - 2_000);
  });

  test("an answer that grants less never shortens a lease already granted", async () => {
    let clock = 0;
    const grants = [30_000, 5_000];
    const { heartbeat: beat } = heartbeat(
      async () => answer(grants.shift() ?? 0),
      {
        remainingMs: 10_000,
        safetyMarginMs: 1_000,
        monotonicNow: () => clock,
      },
    );
    await beat.beatOnce();
    clock += 1_000;
    await beat.beatOnce();

    expect(beat.leaseLeftMs).toBe(30_000 - 1_000 - 1_000);
  });

  test("the lease is judged on the monotonic clock whatever the wall clock or the answer's deadline say (94S-322)", async () => {
    // A gateway whose clock is an hour behind the worker's: the deadline it
    // names is already past on this side, and only the remainder counts.
    const {
      beats,
      heartbeat: beat,
      lost,
    } = heartbeat(
      async () => ({
        ...answer(5_000),
        lease_expires_at: new Date(Date.now() - 3_600_000).toISOString(),
      }),
      { remainingMs: 5_000, safetyMarginMs: 1_000 },
    );
    try {
      beat.start();
      await settle();
      // The wall clock jumps an hour ahead, then two hours back, mid-lease.
      setSystemTime(new Date(Date.now() + 3_600_000));
      await settle();
      expect(beat.leaseLeftMs).toBeGreaterThan(1_000);
      setSystemTime(new Date(Date.now() - 7_200_000));
      await settle();
      expect(beat.leaseLeftMs).toBeGreaterThan(1_000);
      const before = beats.length;
      await until(() => beats.length > before);
      expect(lost).toEqual([]);
    } finally {
      setSystemTime();
      await beat.stop();
    }
  });

  test("carries the transcript report as of each beat, and none while there is no mirror", async () => {
    const reports: Array<TranscriptReport | undefined> = [
      undefined,
      { persisted_at: "2026-09-23T00:00:00.000Z", mirror_error: null },
    ];
    let next = 0;
    const { beats, heartbeat: beat } = heartbeat(async () => answer(60_000), {
      transcript: () => reports[Math.min(next++, 1)],
    });
    beat.start();
    await until(() => beats.length > 1);
    await beat.stop();

    expect("transcript" in (beats[0] ?? {})).toBe(false);
    expect(beats[1]?.transcript).toEqual({
      persisted_at: "2026-09-23T00:00:00.000Z",
      mirror_error: null,
    });
  });

  test("declares ownership lost on a fenced-out answer", async () => {
    const { heartbeat: beat, lost } = heartbeat(async () => {
      throw new WorkerGatewayRequestError(
        409,
        "LEASE_EXPIRED",
        "Lease expired; the attempt must stop writing",
        false,
      );
    });
    beat.start();
    await settle();
    await beat.stop();

    expect(lost).toHaveLength(1);
    expect(lost[0]).toContain("LEASE_EXPIRED");
  });

  test("declares ownership lost when the session's authorization moves on", async () => {
    const { heartbeat: beat, lost } = heartbeat(async () =>
      answer(30_000, scope.auth_revision + 1),
    );
    beat.start();
    await settle();
    await beat.stop();

    expect(lost).toEqual(["auth_revision advanced to 8"]);
  });

  test("rides out an unreachable gateway until the safety margin before the lease's end", async () => {
    let clock = 0;
    const {
      beats,
      heartbeat: beat,
      lost,
    } = heartbeat(
      async () => {
        throw new WorkerGatewayRequestError(0, null, "socket closed", true);
      },
      { remainingMs: 1_000, safetyMarginMs: 300, monotonicNow: () => clock },
    );
    beat.start();
    await Bun.sleep(10);
    clock = 650;
    await Bun.sleep(10);
    expect(lost).toEqual([]);
    expect(beats.length).toBeGreaterThan(0);

    // Still 300ms of lease on the database's side: given up all the same.
    clock = 700;
    await settle();
    await beat.stop();

    expect(lost).toHaveLength(1);
    expect(lost[0]).toContain("lease given up 300ms before it runs out");
  });

  test("gives the lease up a safety margin early with a beat still unanswered", async () => {
    const { heartbeat: beat, lost } = heartbeat(() => new Promise(() => {}), {
      remainingMs: 2_000,
      safetyMarginMs: 1_000,
    });
    const started = performance.now();
    beat.start();
    await Bun.sleep(100);
    expect(lost).toEqual([]);

    await until(() => lost.length > 0, 3_000);

    expect(lost).toHaveLength(1);
    expect(lost[0]).toContain("had not answered");
    // Given up at the margin (~1s), not at the lease's end (2s).
    expect(performance.now() - started).toBeLessThan(2_000);
    await beat.stop();
  });

  test("a margin the lease cannot cover loses the attempt at its first beat, and says why", async () => {
    const {
      beats,
      heartbeat: beat,
      lost,
    } = heartbeat(async () => answer(1_000), {
      remainingMs: 1_000,
      safetyMarginMs: 60_000,
    });
    beat.start();
    await settle();
    await beat.stop();

    expect(beats).toEqual([]);
    expect(lost).toEqual([
      "lease given up 60000ms before it runs out: no beat renewed it in time",
    ]);
  });

  test("an answer that comes back after the lease was given up does not revive it", async () => {
    let clock = 0;
    const { heartbeat: beat, lost } = heartbeat(
      async () => {
        // The event loop stalled past the cutoff; the race's timer never got
        // to fire, and the answer grants a whole new lease.
        clock = 950;
        return answer(30_000);
      },
      { remainingMs: 1_000, safetyMarginMs: 100, monotonicNow: () => clock },
    );
    await beat.beatOnce();

    expect(lost).toHaveLength(1);
    expect(lost[0]).toContain("had not answered");
    expect(beat.leaseLeftMs).toBe(0);
  });

  test("beats before a lease shorter than the interval runs out", async () => {
    const beats: HeartbeatRequest[] = [];
    const lost: string[] = [];
    const instance = new Heartbeat({
      gateway: {
        heartbeat: async (request) => {
          beats.push(request);
          return answer(60_000);
        },
      },
      scope: () => scope,
      attemptState: () => "running",
      intervalMs: 10_000,
      lease: { remainingMs: 100, sentAt: 0 },
      safetyMarginMs: 50,
      onLost: (reason) => lost.push(reason),
      // Frozen, so a loaded machine's late timers cannot run the lease out.
      monotonicNow: () => 0,
    });
    instance.start();
    await Bun.sleep(150);
    await instance.stop();

    expect(beats.length).toBeGreaterThan(0);
    expect(lost).toEqual([]);
  });

  test("owes a beat asked for while one is in flight", async () => {
    let state: "running" | "draining" = "running";
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const beats: HeartbeatRequest[] = [];
    const options: HeartbeatOptions = {
      gateway: {
        heartbeat: async (request) => {
          beats.push(request);
          if (beats.length === 1) await held;
          return answer(30_000);
        },
      },
      scope: () => scope,
      attemptState: () => state,
      intervalMs: 1,
      lease: { remainingMs: 30_000, sentAt: performance.now() },
      safetyMarginMs: 1_000,
      onLost: () => {},
    };
    const beat = new Heartbeat(options);
    beat.start();
    for (let waited = 0; beats.length === 0 && waited < 1_000; waited += 1) {
      await Bun.sleep(1);
    }
    // Now slow the loop down: only an owed beat can arrive in time.
    options.intervalMs = 60_000;
    state = "draining";
    beat.beatNow();
    release();
    await settle();
    await beat.stop();

    expect(beats.map((request) => request.attempt_state)).toEqual([
      "running",
      "draining",
    ]);
  });

  test("a stop does not drop a beat owed for a mirror error, and says once one landed", async () => {
    let mirrorError: string | null = null;
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const beats: HeartbeatRequest[] = [];
    const beat = new Heartbeat({
      gateway: {
        heartbeat: async (request) => {
          beats.push(request);
          if (beats.length === 1) await held;
          return answer(30_000);
        },
      },
      scope: () => scope,
      attemptState: () => "running",
      intervalMs: 60_000,
      lease: { remainingMs: 30_000, sentAt: performance.now() },
      safetyMarginMs: 1_000,
      onLost: () => {},
      transcript: () => ({ persisted_at: null, mirror_error: mirrorError }),
    });
    beat.beatNow();
    beat.start();
    for (let waited = 0; beats.length === 0 && waited < 1_000; waited += 1) {
      await Bun.sleep(1);
    }
    // The beat in flight carries no error; the drain starts before it lands.
    mirrorError = "Transcript mirror dropped a batch";
    beat.beatNow();
    const stopping = beat.stop();
    release();
    await stopping;

    expect(beats.map((request) => request.transcript?.mirror_error)).toEqual([
      null,
      "Transcript mirror dropped a batch",
    ]);
    expect(beat.mirrorErrorRecorded).toBe(true);
  });

  test("stops beating once it has lost ownership", async () => {
    const { beats, heartbeat: beat } = heartbeat(async () => {
      throw new WorkerGatewayRequestError(409, "STALE_EPOCH", "gone", false);
    });
    beat.start();
    await settle();
    const afterLoss = beats.length;
    await settle();
    await beat.stop();

    expect(beats).toHaveLength(afterLoss);
    expect(afterLoss).toBe(1);
  });
});
