import { describe, expect, test } from "bun:test";
import type {
  ClaimedRolloutItem,
  ProfileRolloutStore,
  RolloutItemResult,
} from "../ports/profile-rollout-store.ts";
import { createProfileRolloutRunner } from "./profile-rollout-runner.ts";

const quiet = { info: () => {}, warn: () => {} };

const item = (n: number): ClaimedRolloutItem => ({
  rolloutId: "r1",
  agentId: `agent-${n}`,
  generation: 0,
  claim: "claim-1",
  workspaceId: "w1",
  targetProfileId: "op_x_v2",
  actorUserId: "u1",
});

const profile = (version: number, tools: string[]) => ({
  id: `op_x_v${version}`,
  version,
  definition: { model: "m", tools },
});

describe("the rollout runner", () => {
  test("a stop during an item gives the rest of the claim back and ends", async () => {
    const abandoned: string[][] = [];
    const settled: [string, RolloutItemResult][] = [];
    let release: () => void = () => {};
    const inFlight = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started: () => void = () => {};
    const first = new Promise<void>((resolve) => {
      started = resolve;
    });
    let claims = 0;
    const rollouts = {
      async claim() {
        return claims++ === 0 ? [item(1), item(2), item(3)] : [];
      },
      async settle(held: ClaimedRolloutItem, result: RolloutItemResult) {
        settled.push([held.agentId, result]);
        return true;
      },
      async abandon(given: readonly ClaimedRolloutItem[]) {
        abandoned.push(given.map((held) => held.agentId));
        return given.length;
      },
      async inspect() {
        return {
          tracking: "follow" as const,
          sameLineage: true,
          latest: profile(2, ["Read", "Write"]),
          active: profile(1, ["Read"]),
        };
      },
      async sweep() {
        throw new Error("the sweep is off");
      },
    } as unknown as ProfileRolloutStore;
    const runner = createProfileRolloutRunner({
      rollouts,
      agentStore: {
        async get() {
          return { active_release: { runtime_profile_id: "op_x_v1" } } as never;
        },
      },
      agents: {
        async rolloutRelease() {
          started();
          await inFlight;
          return { status: "applied" };
        },
      },
      logger: quiet,
    });

    const running = runner.start(1);
    await first;
    const stopping = running.stop();
    release();
    await stopping;

    expect(settled.map(([agent]) => agent)).toEqual(["agent-1"]);
    expect(abandoned).toEqual([["agent-2", "agent-3"]]);
  });

  test("the sweep runs only when asked to", async () => {
    let swept = 0;
    const rollouts = {
      async claim() {
        return [];
      },
      async sweep() {
        swept++;
        return { rollouts: 0, items: 0 };
      },
    } as unknown as ProfileRolloutStore;
    const base = {
      rollouts,
      agentStore: { get: async () => null },
      agents: { rolloutRelease: async () => ({ status: "applied" as const }) },
      logger: quiet,
    };
    await createProfileRolloutRunner(base).runOnce();
    expect(swept).toBe(0);
    await createProfileRolloutRunner({ ...base, sweep: true }).runOnce();
    expect(swept).toBe(1);
  });
});
