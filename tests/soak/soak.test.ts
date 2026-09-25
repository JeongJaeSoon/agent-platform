import { describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RecordedRequest } from "../../packages/testkit/src/fake-anthropic.ts";
import { bunTestRows, CAMPAIGNS } from "../../scripts/soak/campaigns.ts";
import { distribution, percentile } from "../../scripts/soak/lib.ts";
import {
  createMessages,
  specIds,
  validFaults,
} from "../../scripts/soak/messages.ts";
import { Api, modelEvidence, turnPrompt } from "../../scripts/soak/probes.ts";
import {
  judgeReadyz,
  READYZ_EXCLUSION,
  type ReadyzSample,
  type VmStall,
  validConfig,
} from "../../scripts/soak/soak.ts";
import { StallRecorder } from "../../scripts/soak/vm-lag.ts";

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
    expect(files.sort()).toEqual([
      "interrupt-3h.json",
      "preflight-1h.json",
      "soak-24h.json",
    ]);
    for (const file of files) {
      const config = validConfig(await Bun.file(join(CONFIG_DIR, file)).json());
      expect(config.sessions).toBe(10);
      expect(config.targets).toMatchObject({
        acceptP95Ms: 500,
        interruptEffectMs: 5000,
        interruptTerminalMs: 50000,
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
    // P-3 on at least 500 interrupts over at least 3 hours (rc.sh checks the count).
    const interrupts = validConfig(
      await Bun.file(join(CONFIG_DIR, "interrupt-3h.json")).json(),
    );
    expect(
      interrupts.durationMin - interrupts.warmupMin,
    ).toBeGreaterThanOrEqual(180);
    expect(interrupts).toMatchObject({
      ...soak,
      name: "interrupt-3h",
      purpose: interrupts.purpose,
      durationMin: interrupts.durationMin,
      probes: { ...soak.probes, interruptEveryTurns: 8 },
      measurement: interrupts.measurement,
    });
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

  test("campaign ids are unique and each has exactly one way to run", () => {
    const ids = CAMPAIGNS.map((campaign) => campaign.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const campaign of CAMPAIGNS) {
      expect(Boolean(campaign.run) !== Boolean(campaign.standalone)).toBe(true);
    }
    expect(
      CAMPAIGNS.filter((campaign) => campaign.standalone).map(
        (campaign) => campaign.id,
      ),
    ).toEqual(["fault-backup-restore-resume"]);
  });

  test("a bun test report passes only cases that ran and asserted", () => {
    const junit = join(mkdtempSync(join(tmpdir(), "soak-junit-")), "r.xml");
    const report = (cases: string) => {
      writeFileSync(
        junit,
        `<testsuites><testsuite>${cases}</testsuite></testsuites>`,
      );
      return bunTestRows("c", "input", junit, 0, 2).map((row) => [
        row.id,
        row.status,
      ]);
    };
    expect(
      report(
        '<testcase name="H1: a &amp; b" line="1" assertions="3" />' +
          '<testcase name="H2: b" line="2" assertions="1">\n<failure type="x" />\n</testcase>' +
          '<testcase name="H3: c" line="3" assertions="0">\n<skipped />\n</testcase>' +
          '<testcase name="H4: d" line="4" assertions="0" />',
      ),
    ).toEqual([
      ["c/H1", "pass"],
      ["c/H2", "fail"],
      ["c/H3", "fail"],
      ["c/H4", "fail"],
    ]);
    // Fewer cases than required, or none at all, fails the run.
    expect(report('<testcase name="H1" line="1" assertions="1" />')).toEqual([
      ["c/H1", "pass"],
      ["c/exit", "fail"],
    ]);
    expect(
      bunTestRows("c", "input", join(tmpdir(), "no-such.xml"), 1, 1).map(
        (row) => row.status,
      ),
    ).toEqual(["fail"]);
  });
});

describe("O-1 readyz exclusions (94S-440, 94S-443)", () => {
  const T0 = Date.parse("2026-09-25T10:00:00.000Z");
  const at = (ms: number) => new Date(T0 + ms).toISOString();
  const ok = (i: number): ReadyzSample => ({
    t: at(i * 5000),
    error: null,
    ms: 3,
    ok: true,
    status: 200,
    wallMs: 20,
  });
  const timeout = (i: number): ReadyzSample => ({
    t: at(i * 5000),
    error: "curl exit 28",
    ms: 2000,
    ok: false,
    status: 0,
    wallMs: 2010,
  });
  // 200 samples: one exclusion is 0.5%, three are 1.5%.
  const samples = (replace: Record<number, ReadyzSample>) =>
    Array.from({ length: 200 }, (_, i) => replace[i] ?? ok(i));
  const stall = (from: number, gapMs: number, offsetMs = 0): VmStall => ({
    index: 0,
    bootId: "b",
    from: T0 + from,
    to: T0 + from + gapMs,
    gapMs,
    offsetMs,
    offsetErrorMs: 5,
  });
  const judge = (list: ReadyzSample[], stalls: VmStall[] = []) =>
    judgeReadyz(list, stalls, 1);

  test("the probe records a gap between ticks as a stall, from tick to tick", () => {
    const recorder = new StallRecorder(500);
    for (const mono of [0, 100, 200, 1500, 1600, 2300]) {
      recorder.tick(mono, 10_000 + mono);
    }
    expect(recorder.stalls).toEqual([
      { index: 0, from: 10_200, to: 11_500, gapMs: 1300 },
      { index: 1, from: 11_600, to: 12_300, gapMs: 700 },
    ]);
    expect(recorder.since(1)).toEqual([recorder.stalls[1]]);
  });

  test("a timeout a VM stall of 1s or more overlapped is excluded; O-1 passes on the rest", () => {
    // Sample 10 is sent at 50s; the VM stood still from 49.2s to 52.6s.
    const result = judge(samples({ 10: timeout(10) }), [stall(49_200, 3400)]);
    expect(result).toMatchObject({
      pass: true,
      availability: 1,
      judged: 199,
      hostExcluded: 1,
      hostExcludedRatio: 0.005,
      productFailures: [],
    });
    expect(result.stalls).toMatchObject({ count: 1, maxGapMs: 3400 });
  });

  test("the probe's clock offset places the stall on the host clock", () => {
    // In the VM's clock the stall is a minute early; the poll measured that.
    expect(
      judge(samples({ 10: timeout(10) }), [stall(-10_800, 3400, 60_000)]),
    ).toMatchObject({ pass: true, hostExcluded: 1 });
    expect(
      judge(samples({ 10: timeout(10) }), [stall(49_200, 3400, 60_000)]),
    ).toMatchObject({ pass: false, hostExcluded: 0 });
  });

  test("a failure no long stall overlapped stays a product failure", () => {
    for (const stalls of [
      [],
      // Over before the request was sent.
      [stall(47_000, 2900)],
      // Overlapping, but shorter than a stall O-1 excuses.
      [stall(50_500, READYZ_EXCLUSION.stallMinMs - 1)],
    ]) {
      const result = judge(samples({ 10: timeout(10) }), stalls);
      expect(result).toMatchObject({ pass: false, hostExcluded: 0 });
      expect(result.productFailures).toEqual([
        { t: at(50_000), error: "curl exit 28", status: 0 },
      ]);
    }
  });

  test("an answer that was not 200 is the product's even inside a stall", () => {
    const refused = { ...ok(10), ok: false, status: 503 };
    // Headers of a 503, then the body timed out.
    const refusedSlowly = { ...timeout(10), status: 503 };
    for (const sample of [refused, refusedSlowly]) {
      expect(
        judge(samples({ 10: sample }), [stall(49_200, 3400)]),
      ).toMatchObject({
        pass: false,
        hostExcluded: 0,
        availability: 199 / 200,
      });
    }
  });

  test("a runner slow after curl exited does not hide a stall inside curl's run", () => {
    // curl ran from t+5ms for 2s; the runner saw it end at 3.6s.
    const slowRunner = { ...timeout(10), wallMs: 3600, spawnMs: 5 };
    expect(
      judge(samples({ 10: slowRunner }), [stall(50_100, 1200)]),
    ).toMatchObject({ pass: true, hostExcluded: 1 });
  });

  test("only a stall surely inside the request excuses it", () => {
    // curl gave up after 2s, the runner noticed at 3.6s; a stall from 2.2s
    // came after the request.
    const late = { ...timeout(10), wallMs: 3600 };
    expect(judge(samples({ 10: late }), [stall(52_200, 3000)])).toMatchObject({
      pass: false,
      hostExcluded: 0,
    });
    // Ended 150ms before the request on the probe's clock, placed within
    // ±350ms: it may not have overlapped at all.
    const loose = { ...stall(46_850, 3000), offsetErrorMs: 350 };
    expect(judge(samples({ 10: timeout(10) }), [loose])).toMatchObject({
      pass: false,
      hostExcluded: 0,
    });
  });

  test("host exclusions past 1% of the samples fail O-1", () => {
    const list = samples({
      10: timeout(10),
      70: timeout(70),
      130: timeout(130),
    });
    const stalls = [10, 70, 130].map((i) => stall(i * 5000 - 800, 3000));
    expect(judge(list, stalls)).toMatchObject({
      pass: false,
      availability: 1,
      hostExcluded: 3,
      hostExcludedRatio: 0.015,
    });
    // Exactly 1% is still within the cap.
    const onePercent = samples({ 10: timeout(10) }).slice(0, 100);
    expect(judge(onePercent, stalls.slice(0, 1))).toMatchObject({
      pass: true,
      hostExcludedRatio: 0.01,
    });
  });

  test("a slot the runner missed is counted apart, and too many void the measurement", () => {
    const missed = (i: number): ReadyzSample => ({
      ...ok(i),
      error: "slot missed: the runner did not get to it",
      ok: false,
      status: 0,
      ms: 0,
      wallMs: 0,
    });
    expect(judge(samples({ 10: missed(10) }))).toMatchObject({
      pass: true,
      availability: 1,
      judged: 199,
      runnerMissed: 1,
      hostExcluded: 0,
      productFailures: [],
    });
    expect(
      judge(samples({ 10: missed(10), 70: missed(70), 130: missed(130) })),
    ).toMatchObject({ pass: false, availability: 1, runnerMissedRatio: 0.015 });
  });
});

describe("Api.statusPhase (94S-382)", () => {
  test("reads the turn's phase off the stream, resumes from the last id, and waits out the stream limit", async () => {
    const seen: Array<string | null> = [];
    let refusals = 1;
    const frame = (id: string, turn: string, phase: string) =>
      `id: ${id}\nevent: status\ndata: ${JSON.stringify({ turn_id: turn, data: { phase } })}\n\n`;
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        seen.push(request.headers.get("last-event-id"));
        if (refusals > 0) {
          refusals -= 1;
          return new Response("busy", { status: 429 });
        }
        const body =
          seen.length <= 2
            ? `: keepalive\n\n${frame("ev_1", "11", "engine_stopped")}${frame("ev_2", "12", "interrupting")}event: result\nid: ev_3\ndata: {}\n\n${frame("ev_4", "12", "engine_stopped")}`
            : frame("ev_9", "24", "engine_stopped");
        return new Response(body, {
          headers: { "content-type": "text/event-stream" },
        });
      },
    });
    try {
      const api = new Api(`http://localhost:${server.port}`, "test");
      const signal = new AbortController().signal;
      const at = await api.statusPhase("s", "12", "engine_stopped", signal);
      expect(typeof at).toBe("number");
      await api.statusPhase("s", "24", "engine_stopped", signal);
      // One refusal, the first read from the start, the next from ev_4.
      expect(seen).toEqual([null, null, "ev_4"]);
    } finally {
      server.stop(true);
    }
  });

  test("reopens a stream the API closed from the last id it read", async () => {
    const seen: Array<string | null> = [];
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        seen.push(request.headers.get("last-event-id"));
        const body =
          seen.length === 1
            ? "event: status\nid: ev_1\ndata: {}\n\n"
            : `id: ev_2\nevent: status\ndata: ${JSON.stringify({ turn_id: "1", data: { phase: "engine_stopped" } })}\n\n`;
        return new Response(body, {
          headers: { "content-type": "text/event-stream" },
        });
      },
    });
    try {
      const api = new Api(`http://localhost:${server.port}`, "test");
      const at = await api.statusPhase(
        "s",
        "1",
        "engine_stopped",
        new AbortController().signal,
      );
      expect(typeof at).toBe("number");
      expect(seen).toEqual([null, "ev_1"]);
    } finally {
      server.stop(true);
    }
  });

  test("answers null once aborted, and at once for a stream refused for good", async () => {
    const server = Bun.serve({
      port: 0,
      fetch: (request) =>
        new URL(request.url).pathname.includes("gone")
          ? new Response("no", { status: 404 })
          : new Response(": keepalive\n\n", {
              headers: { "content-type": "text/event-stream" },
            }),
    });
    try {
      const api = new Api(`http://localhost:${server.port}`, "test");
      expect(
        await api.statusPhase(
          "gone",
          "1",
          "engine_stopped",
          new AbortController().signal,
        ),
      ).toBeNull();
      expect(
        await api.statusPhase(
          "s",
          "1",
          "engine_stopped",
          AbortSignal.timeout(300),
        ),
      ).toBeNull();
    } finally {
      server.stop(true);
    }
  });
});
