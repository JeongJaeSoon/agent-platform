import { describe, expect, test } from "bun:test";
import type {
  HeartbeatRequest,
  HeartbeatResponse,
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
  options: { leaseExpiresAt?: Date; now?: () => Date } = {},
) {
  const lost: string[] = [];
  const beats: HeartbeatRequest[] = [];
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
    leaseExpiresAt: options.leaseExpiresAt ?? new Date(Date.now() + 30_000),
    onLost: (reason) => lost.push(reason),
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  return { beats, heartbeat: instance, lost };
}

async function settle(): Promise<void> {
  await Bun.sleep(30);
}

describe("Heartbeat", () => {
  test("reports the attempt alive and carries the lease forward", async () => {
    const lease = new Date(Date.now() + 60_000).toISOString();
    const { beats, heartbeat: beat } = heartbeat(async () => ({
      lease_expires_at: lease,
      auth_revision: scope.auth_revision,
      control_pending: false,
    }));
    beat.start();
    await settle();
    await beat.stop();

    expect(beats.length).toBeGreaterThan(0);
    expect(beats[0]?.attempt_state).toBe("running");
    expect(beats[0]?.lease_epoch).toBe(3);
    expect(beat.leaseExpiresAt.toISOString()).toBe(lease);
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
    const { heartbeat: beat, lost } = heartbeat(async () => ({
      lease_expires_at: new Date(Date.now() + 30_000).toISOString(),
      auth_revision: scope.auth_revision + 1,
      control_pending: false,
    }));
    beat.start();
    await settle();
    await beat.stop();

    expect(lost).toEqual(["auth_revision advanced to 8"]);
  });

  test("rides out an unreachable gateway until the lease actually lapses", async () => {
    let clock = Date.now();
    const {
      beats,
      heartbeat: beat,
      lost,
    } = heartbeat(
      async () => {
        throw new WorkerGatewayRequestError(0, null, "socket closed", true);
      },
      {
        leaseExpiresAt: new Date(clock + 25),
        now: () => new Date(clock),
      },
    );
    beat.start();
    await Bun.sleep(10);
    expect(lost).toEqual([]);
    expect(beats.length).toBeGreaterThan(0);

    clock += 100;
    await settle();
    await beat.stop();

    expect(lost).toHaveLength(1);
    expect(lost[0]).toContain("lease expired");
  });

  test("declares the lease gone when it lapses with a beat still unanswered", async () => {
    const { heartbeat: beat, lost } = heartbeat(() => new Promise(() => {}), {
      leaseExpiresAt: new Date(Date.now() + 50),
    });
    beat.start();
    await Bun.sleep(20);
    expect(lost).toEqual([]);

    await Bun.sleep(80);

    expect(lost).toHaveLength(1);
    expect(lost[0]).toContain("before the gateway answered");
    await beat.stop();
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
          return {
            lease_expires_at: new Date(Date.now() + 30_000).toISOString(),
            auth_revision: scope.auth_revision,
            control_pending: false,
          };
        },
      },
      scope: () => scope,
      attemptState: () => state,
      intervalMs: 1,
      leaseExpiresAt: new Date(Date.now() + 30_000),
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
