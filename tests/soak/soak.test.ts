import { describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import type { RecordedRequest } from "../../packages/testkit/src/fake-anthropic.ts";
import { CAMPAIGNS } from "../../scripts/soak/campaigns.ts";
import { distribution, percentile } from "../../scripts/soak/lib.ts";
import {
  createMessages,
  specIds,
  validFaults,
} from "../../scripts/soak/messages.ts";
import { modelEvidence, turnPrompt } from "../../scripts/soak/probes.ts";
import { validConfig } from "../../scripts/soak/soak.ts";

const CONFIG_DIR = join(import.meta.dir, "../../scripts/soak/config");

function request(messages: unknown[]): RecordedRequest {
  return {
    body: { messages, tools: [{ name: "Write" }] },
    headers: {},
    path: "/v1/messages",
    signal: new AbortController().signal,
  };
}

const user = (text: string) => ({
  role: "user",
  content: [{ type: "text", text }],
});

describe("94S-135 soak tooling", () => {
  test("percentiles are nearest-rank over the samples", () => {
    const samples = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(percentile(samples, 95)).toBe(95);
    expect(percentile(samples, 50)).toBe(50);
    expect(percentile([7], 95)).toBe(7);
    expect(percentile([], 95)).toBeNull();
    expect(distribution([3, 1, 2])).toEqual({
      n: 3,
      min: 1,
      p50: 2,
      p95: 3,
      p99: 3,
      max: 3,
    });
  });

  test("every committed config is valid and fixes its measurements", async () => {
    const files = readdirSync(CONFIG_DIR).filter((f) => f.endsWith(".json"));
    expect(files.sort()).toEqual(["preflight-1h.json", "soak-24h.json"]);
    for (const file of files) {
      const config = validConfig(await Bun.file(join(CONFIG_DIR, file)).json());
      expect(config.sessions).toBe(10);
      expect(config.targets).toMatchObject({
        acceptP95Ms: 500,
        interruptEffectMs: 5000,
        terminateEffectMs: 30000,
      });
      for (const key of [
        "acceptance",
        "interrupt",
        "terminate",
        "startup",
        "environment",
      ]) {
        expect(config.measurement[key]).toBeDefined();
      }
    }
    const soak = validConfig(
      await Bun.file(join(CONFIG_DIR, "soak-24h.json")).json(),
    );
    expect(soak.durationMin).toBe(24 * 60);
  });

  test("a config the run could not judge is refused before it starts", async () => {
    const good = await Bun.file(join(CONFIG_DIR, "preflight-1h.json")).json();
    expect(() => validConfig({ ...good, ramp: [1, 5] })).toThrow(/ramp/);
    expect(() =>
      validConfig({ ...good, probes: { ...good.probes, slowStepMs: 3000 } }),
    ).toThrow(/slowStepMs/);
    expect(() =>
      validConfig({
        ...good,
        messagesFaults: { ...good.messagesFaults, errorRate: 2 },
      }),
    ).toThrow(/errorRate/);
  });

  test("the spec ids a conversation carries are read in order, once each", () => {
    const first = turnPrompt({
      id: "s0g1t1",
      kind: "normal",
      slowStepMs: 30000,
      stepDelayMs: 0,
      slot: 1,
    });
    const second = turnPrompt({
      id: "s0g1t2",
      kind: "interrupt",
      slowStepMs: 30000,
      stepDelayMs: 0,
      slot: 2,
    });
    expect(specIds([user(first), user(first), user(second)])).toEqual([
      "s0g1t1",
      "s0g1t2",
    ]);
  });

  test("the Messages API injects the configured faults and still plays the spec", async () => {
    const failing = createMessages({ random: () => 0 });
    failing.setFaults({
      latencyMs: [0, 0],
      errorRate: 1,
      errorStatuses: [529],
    });
    const prompt = turnPrompt({
      id: "t",
      kind: "normal",
      slowStepMs: 30000,
      stepDelayMs: 0,
      slot: 0,
    });
    const refused = await failing.reply(request([user(prompt)]));
    expect(refused instanceof Response && refused.status).toBe(529);
    expect(failing.requests({})[0]).toMatchObject({
      fault: 529,
      specId: "t",
      step: 0,
    });

    const answering = createMessages({ random: () => 0.99 });
    answering.setFaults({
      latencyMs: [0, 0],
      errorRate: 0.5,
      errorStatuses: [500],
    });
    const reply = await answering.reply(request([user(prompt)]));
    expect(reply).toMatchObject({ stopReason: "tool_use" });
    expect(() => validFaults({ latencyMs: [5, 1] })).toThrow(/latencyMs/);
  });

  test("model evidence names a lost context and a turn started twice", () => {
    const entry = (step: number, specs: string[], fault: number | null) => ({
      at: new Date().toISOString(),
      fault,
      hasTools: true,
      index: 0,
      latencyMs: 0,
      specs,
      specId: specs.at(-1) ?? null,
      step,
    });
    expect(modelEvidence([entry(0, ["a", "b"], null)], "a")).toMatchObject({
      contextKept: true,
      startsAnswered: 1,
    });
    expect(
      modelEvidence(
        [entry(0, ["b"], 500), entry(0, ["b"], null), entry(0, ["b"], null)],
        "a",
      ),
    ).toEqual({ contextKept: false, startsAnswered: 2, faults: 1 });
  });

  test("campaign ids are unique and hooks name the ticket they wait for", () => {
    const ids = CAMPAIGNS.map((campaign) => campaign.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const campaign of CAMPAIGNS) {
      expect(Boolean(campaign.run) !== Boolean(campaign.waitsFor)).toBe(true);
    }
    expect(
      CAMPAIGNS.filter((campaign) => campaign.waitsFor)
        .map((campaign) => campaign.waitsFor?.ticket)
        .sort(),
    ).toEqual(["94S-117", "94S-321", "94S-324"]);
  });
});
