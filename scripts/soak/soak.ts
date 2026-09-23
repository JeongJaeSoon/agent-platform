import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Pool } from "pg";
import { database, Workers } from "../../tests/d2-gate/harness.ts";
import {
  ContainerLifetimes,
  checkInvariants,
  type InvariantResult,
  SlotWatch,
} from "./invariants.ts";
import {
  between,
  type Criterion,
  clockOffset,
  compose,
  composeToFile,
  criterion,
  distribution,
  markdownReport,
  Output,
  reproMeta,
  type SoakEnv,
  sha256File,
  soakEnv,
} from "./lib.ts";
import { type MessagesFaults, validFaults } from "./messages.ts";
import {
  Api,
  admissionProbe,
  type ControlSample,
  interruptProbe,
  Model,
  modelEvidence,
  resumeStartup,
  type StartupSample,
  settle,
  startupSample,
  type TurnKind,
  terminateProbe,
  turnPrompt,
} from "./probes.ts";

/**
 * The 94S-135 soak runner: N sessions repeating scripted turns against the
 * stack scripts/soak/stack.sh started, for a duration and with measurements
 * fixed in a config file before the run (scripts/soak/config/*.json).
 *
 *   source "$SOAK_STATE/vars.sh"
 *   bun scripts/soak/soak.ts scripts/soak/config/preflight-1h.json [out-dir]
 *   bun scripts/soak/soak.ts --judge <out-dir>     judge a run again from its files
 *
 * Every raw observation lands as JSONL in the output directory (turns,
 * controls, readyz, invariants, clock, model requests, fault injector
 * traffic, reconciler passes, worker logs), next to config.json (the file
 * as run), meta.json (reproducibility), summary.json and report.md (the
 * criteria table). The exit code is 0 only when every criterion passed.
 */

export type SoakConfig = {
  name: string;
  purpose: string;
  sessions: number;
  durationMin: number;
  warmupMin: number;
  drainSec: number;
  quiesceSec: number;
  ramp: number[];
  turn: {
    stepDelayMs: [number, number];
    thinkMs: [number, number];
    timeoutSec: number;
    pollMs: number;
  };
  probes: {
    interruptEveryTurns: number;
    terminateEveryMin: number;
    pauseResumeEveryMin: number;
    slowStepMs: number;
    pollMs: number;
  };
  messagesFaults: MessagesFaults;
  readyz: { intervalMs: number; timeoutMs: number };
  invariants: {
    intervalMin: number;
    slotLeakGraceSec: number;
    slotLimit: number;
    toleranceMs: number;
  };
  /**
   * How often the product reconciler's status file is read (94S-320), and
   * how old its last successful pass may be at any reading — the compose
   * healthcheck's RECONCILER_HEALTH_STALE_SEC.
   */
  reconciler: { intervalSec: number; staleSec: number };
  sampleIntervalSec: number;
  targets: {
    acceptP95Ms: number;
    interruptEffectMs: number;
    terminateEffectMs: number;
    readyzAvailability: number;
  };
  measurement: Record<string, unknown>;
};

export function validConfig(value: unknown): SoakConfig {
  const config = value as SoakConfig;
  const problems: string[] = [];
  const positive = (name: string, n: unknown) => {
    if (typeof n !== "number" || !(n > 0)) problems.push(`${name} must be > 0`);
  };
  const range = (name: string, r: unknown) => {
    if (
      !Array.isArray(r) ||
      r.length !== 2 ||
      typeof r[0] !== "number" ||
      typeof r[1] !== "number" ||
      r[0] < 0 ||
      r[1] < r[0]
    ) {
      problems.push(`${name} must be [min, max]`);
    }
  };
  if (!config.name) problems.push("name is required");
  positive("sessions", config.sessions);
  positive("durationMin", config.durationMin);
  if (!(config.warmupMin >= 0 && config.warmupMin < config.durationMin)) {
    problems.push("warmupMin must be within [0, durationMin)");
  }
  if (
    !Array.isArray(config.ramp) ||
    config.ramp.length === 0 ||
    config.ramp.some((n, i) => !(n > (config.ramp[i - 1] ?? 0))) ||
    config.ramp.at(-1) !== config.sessions
  ) {
    problems.push("ramp must rise strictly and end at sessions");
  }
  range("turn.stepDelayMs", config.turn?.stepDelayMs);
  range("turn.thinkMs", config.turn?.thinkMs);
  positive("turn.timeoutSec", config.turn?.timeoutSec);
  positive("turn.pollMs", config.turn?.pollMs);
  positive("probes.interruptEveryTurns", config.probes?.interruptEveryTurns);
  positive("probes.terminateEveryMin", config.probes?.terminateEveryMin);
  positive("probes.pauseResumeEveryMin", config.probes?.pauseResumeEveryMin);
  positive("probes.slowStepMs", config.probes?.slowStepMs);
  positive("probes.pollMs", config.probes?.pollMs);
  if (
    config.probes?.slowStepMs <=
    Math.max(config.targets?.interruptEffectMs ?? 0, 0)
  ) {
    problems.push(
      "probes.slowStepMs must outlast targets.interruptEffectMs, or a slow step ending on its own reads as an interrupt",
    );
  }
  const readyz = config.readyz;
  if (
    !Number.isInteger(readyz?.intervalMs) ||
    readyz.intervalMs < 1000 ||
    !(readyz.timeoutMs > 0 && readyz.timeoutMs < readyz.intervalMs)
  ) {
    problems.push(
      "readyz.intervalMs must be an integer >= 1000 and readyz.timeoutMs within (0, intervalMs)",
    );
  }
  positive("invariants.intervalMin", config.invariants?.intervalMin);
  positive("invariants.slotLimit", config.invariants?.slotLimit);
  positive("sampleIntervalSec", config.sampleIntervalSec);
  positive("reconciler.intervalSec", config.reconciler?.intervalSec);
  positive("reconciler.staleSec", config.reconciler?.staleSec);
  positive("targets.acceptP95Ms", config.targets?.acceptP95Ms);
  try {
    validFaults(config.messagesFaults);
  } catch (error) {
    problems.push(`messagesFaults: ${String(error)}`);
  }
  if (problems.length > 0) {
    throw new Error(`invalid soak config:\n- ${problems.join("\n- ")}`);
  }
  return config;
}

// ---------------------------------------------------------------- runtime

type Clock = { stopping: boolean };

type TurnRecord = {
  slot: number;
  generation: number;
  sessionId: string | null;
  turnId: string | null;
  specId: string;
  kind: TurnKind;
  endpoint: "POST /v1/sessions" | "POST /v1/sessions/{id}/messages";
  sentAt: number;
  acceptMs: number;
  acceptStatus: number;
  inWindow: boolean;
  rampStep: number | null;
  startupClass: "cold-create" | "cold-relaunch" | "warm" | "unknown" | null;
  status: string | null;
  terminalReason: unknown;
  outcomeUnknown: unknown;
  settleMs: number | null;
  startup: Awaited<ReturnType<typeof startupSample>> | null;
  contextKept: boolean | null;
  startsAnswered: number | null;
  modelFaults: number | null;
  error?: string;
};

class Soak {
  readonly turns: TurnRecord[] = [];
  readonly controls: ControlSample[] = [];
  readonly readyz: ReadyzSample[] = [];
  readonly phases: Array<Record<string, unknown>> = [];
  readonly reconciler: ReconcilerSample[] = [];
  readonly invariantSamples: Array<{
    at: string;
    results: InvariantResult[];
    observations: Record<string, unknown>;
  }> = [];
  readonly anomalies: Array<Record<string, unknown>> = [];
  windowStart = Number.POSITIVE_INFINITY;
  windowEnd = Number.POSITIVE_INFINITY;
  readonly lifetimes: ContainerLifetimes;
  readonly slots = new SlotWatch();

  constructor(
    readonly config: SoakConfig,
    readonly env: SoakEnv,
    readonly out: Output,
    readonly api: Api,
    readonly model: Model,
    readonly db: Pool,
  ) {
    this.lifetimes = new ContainerLifetimes(
      env.installation,
      out.jsonl("container-events"),
    );
  }

  inWindow(at: number): boolean {
    return at >= this.windowStart && at <= this.windowEnd;
  }

  recordTurn(record: TurnRecord): void {
    this.turns.push(record);
    this.out.jsonl("turns").write(record);
  }

  recordControl(sample: ControlSample): void {
    const inWindow = this.inWindow(Date.now());
    this.controls.push(sample);
    this.out.jsonl("controls").write({ ...sample, inWindow });
  }

  phase(entry: Record<string, unknown>): void {
    this.phases.push(entry);
    this.out.jsonl("phases").write(entry);
  }

  anomaly(entry: Record<string, unknown>): void {
    this.anomalies.push(entry);
    this.out.jsonl("anomalies").write(entry);
    console.error(`anomaly: ${JSON.stringify(entry)}`);
  }
}

class SessionLoop {
  sessionId: string | null = null;
  generation = 0;
  turnNo = 0;
  lastCompletedSpec: string | null = null;
  pending: "terminate" | "pause" | null = null;
  busy = false;

  constructor(
    private readonly soak: Soak,
    readonly slot: number,
  ) {}

  private get config() {
    return this.soak.config;
  }

  /** The session's first turn, as a new session; the ramp tags it. */
  async open(rampStep: number | null): Promise<void> {
    this.generation++;
    this.sessionId = null;
    this.turnNo = 0;
    this.lastCompletedSpec = null;
    await this.turn("normal", rampStep);
  }

  async loop(schedule: { deadline: number }, clock: Clock): Promise<void> {
    while (Date.now() < schedule.deadline && !clock.stopping) {
      if (this.sessionId === null) {
        await this.open(null);
        continue;
      }
      const action = this.pending;
      this.pending = null;
      const kind: TurnKind =
        action === "terminate"
          ? "terminate"
          : (this.turnNo + 1) % this.config.probes.interruptEveryTurns === 0
            ? "interrupt"
            : "normal";
      await this.turn(kind, null);
      if (action === "pause" && this.sessionId !== null) {
        await this.pauseAndResume();
      }
      await Bun.sleep(between(this.config.turn.thinkMs));
    }
  }

  private async turn(kind: TurnKind, rampStep: number | null): Promise<void> {
    const soak = this.soak;
    const creating = this.sessionId === null;
    this.turnNo++;
    const specId = `s${this.slot}g${this.generation}t${this.turnNo}`;
    const text = turnPrompt({
      id: specId,
      kind,
      slowStepMs: this.config.probes.slowStepMs,
      stepDelayMs: between(this.config.turn.stepDelayMs),
      slot: this.turnNo % 20,
    });
    this.busy = true;
    try {
      const posted = creating
        ? await soak.api.createSession(text)
        : await soak.api.postMessage(this.sessionId ?? "", text);
      const body = (posted.body ?? {}) as {
        session_id?: string;
        turn_id?: string;
      };
      if (creating && body.session_id) this.sessionId = body.session_id;
      const record: TurnRecord = {
        slot: this.slot,
        generation: this.generation,
        sessionId: this.sessionId,
        turnId: body.turn_id ?? null,
        specId,
        kind,
        endpoint: creating
          ? "POST /v1/sessions"
          : "POST /v1/sessions/{id}/messages",
        sentAt: posted.sentAt,
        acceptMs: posted.ms,
        acceptStatus: posted.status,
        inWindow: soak.inWindow(posted.sentAt),
        rampStep,
        startupClass: null,
        status: null,
        terminalReason: null,
        outcomeUnknown: null,
        settleMs: null,
        startup: null,
        contextKept: null,
        startsAnswered: null,
        modelFaults: null,
      };
      if (
        (posted.status !== 201 && posted.status !== 202) ||
        !this.sessionId ||
        !body.turn_id
      ) {
        record.error = `accept ${posted.status} ${JSON.stringify(posted.body).slice(0, 300)}`;
        soak.recordTurn(record);
        await this.recover(`turn not accepted: ${record.error}`);
        return;
      }
      const sessionId = this.sessionId;
      const turnId = body.turn_id;

      if (kind === "interrupt") {
        soak.recordControl(
          await interruptProbe(soak.api, soak.model, {
            budgetMs: this.config.probes.slowStepMs + 60_000,
            pollMs: this.config.probes.pollMs,
            sessionId,
            slowStepMs: this.config.probes.slowStepMs,
            specId,
            turnId,
          }),
        );
      }
      if (kind === "terminate") {
        soak.recordControl(
          await terminateProbe(soak.api, soak.model, {
            budgetMs: 120_000,
            installation: soak.env.installation,
            pollMs: Math.max(this.config.probes.pollMs, 250),
            sessionId,
            specId,
            turnId,
          }),
        );
      }

      const settled = await settle(soak.api, sessionId, turnId, {
        pollMs: this.config.turn.pollMs,
        timeoutMs: this.config.turn.timeoutSec * 1000,
      });
      record.settleMs = settled ? settled.at - posted.sentAt : null;
      record.status = settled ? String(settled.turn.status) : "timeout";
      record.terminalReason = settled?.turn.terminal_reason ?? null;
      const evidence = modelEvidence(
        await soak.model.requests({ spec: specId }),
        creating ? null : this.lastCompletedSpec,
      );
      record.contextKept = evidence.contextKept;
      record.startsAnswered = evidence.startsAnswered;
      record.modelFaults = evidence.faults;
      record.startup = await startupSample(soak.db, soak.model, {
        sessionId,
        specId,
        turnId,
      });
      record.outcomeUnknown = record.startup.outcomeUnknown;
      record.startupClass = creating
        ? "cold-create"
        : record.startup.temperature === "cold"
          ? "cold-relaunch"
          : record.startup.temperature;
      soak.recordTurn(record);

      if (kind === "terminate") {
        this.sessionId = null;
        return;
      }
      if (record.status === "completed") this.lastCompletedSpec = specId;
      if (!settled) {
        await this.recover(
          `turn ${turnId} did not end in ${this.config.turn.timeoutSec}s`,
        );
      }
    } catch (error) {
      soak.anomaly({
        slot: this.slot,
        sessionId: this.sessionId,
        specId,
        error: String(error),
      });
      await this.recover(`exception: ${String(error)}`);
    } finally {
      this.busy = false;
    }
  }

  private async pauseAndResume(): Promise<void> {
    const soak = this.soak;
    const sessionId = this.sessionId;
    if (!sessionId) return;
    const pause = await admissionProbe(soak.api, {
      budgetMs: 180_000,
      op: "pause",
      pollMs: 250,
      sessionId,
    });
    soak.recordControl(pause);
    if (pause.receiptStatus !== "succeeded") return;
    const resume = await admissionProbe(soak.api, {
      budgetMs: 180_000,
      op: "resume",
      pollMs: 250,
      sessionId,
    });
    if (resume.receiptStatus === "succeeded" && resume.receiptId) {
      resume.extra = {
        ...resume.extra,
        startup: await resumeStartup(soak.db, soak.env.chaosUrl, {
          receiptId: resume.receiptId,
          sessionId,
        }),
      };
    }
    soak.recordControl(resume);
    if (resume.receiptStatus !== "succeeded")
      await this.recover(`resume ${resume.receiptStatus ?? "timeout"}`);
  }

  /**
   * A session the loop cannot drive any more (not accepted, stuck, not
   * resumed) is recorded, terminated best-effort and replaced, so the soak
   * keeps its session count.
   */
  private async recover(reason: string): Promise<void> {
    const soak = this.soak;
    const sessionId = this.sessionId;
    const session = sessionId ? await soak.api.session(sessionId) : null;
    soak.anomaly({
      slot: this.slot,
      sessionId,
      reason,
      admission_state: session?.admission_state ?? null,
      status: session?.status ?? null,
    });
    if (sessionId) await soak.api.control(sessionId, "terminate");
    this.sessionId = null;
    await Bun.sleep(5000);
  }
}

// ---------------------------------------------------------------- background

async function every(
  clock: Clock,
  intervalMs: number,
  task: () => Promise<void>,
): Promise<void> {
  while (!clock.stopping) {
    const started = Date.now();
    try {
      await task();
    } catch (error) {
      console.error(`background task: ${String(error)}`);
    }
    const wait = intervalMs - (Date.now() - started);
    const until = Date.now() + Math.max(0, wait);
    while (!clock.stopping && Date.now() < until) {
      await Bun.sleep(Math.min(1000, until - Date.now()));
    }
  }
}

/**
 * One /readyz request, timed by curl rather than by this process: the
 * runner's own event loop stalls while it parses a large log batch, and a
 * timer measured here would charge that stall to the API. `wallMs` is kept
 * beside it so such a stall stays visible.
 */
type ReadyzSample = {
  error: string | null;
  ms: number;
  ok: boolean;
  status: number;
  t: string;
  wallMs: number;
};

type ReconcilerSample = {
  t: string;
  code: number;
  status: {
    consecutiveFailures?: number;
    lastFailureAt?: string | null;
    lastFailureReason?: string | null;
    lastSuccessAt?: string | null;
    loopStartedAt?: string;
    passes?: number;
  } | null;
};

/**
 * /readyz on fixed slots from the loop's start. Every slot yields a sample:
 * a probe that could not run, and a slot the runner was too stalled to
 * reach, are failed intervals, never missing ones.
 */
async function readyzLoop(soak: Soak, clock: Clock): Promise<void> {
  const { config, env, out } = soak;
  const interval = config.readyz.intervalMs;
  const record = (sample: ReadyzSample) => {
    soak.readyz.push(sample);
    out.jsonl("readyz").write(sample);
  };
  const failed = (t: number, error: string): ReadyzSample => ({
    t: new Date(t).toISOString(),
    error,
    ms: 0,
    ok: false,
    status: 0,
    wallMs: 0,
  });
  // How late a probe may start and still stand for its slot.
  const grace = Math.min(1000, interval / 2);
  let slot = Date.now();
  while (!clock.stopping) {
    if (Date.now() > slot + grace) {
      record(failed(slot, "slot missed: the runner did not get to it"));
    } else {
      const t = new Date().toISOString();
      record(
        await readyzProbe(env.apiUrl, config.readyz.timeoutMs).then(
          (probe) => ({ t, ...probe }),
          (error) => failed(Date.now(), `probe did not run: ${String(error)}`),
        ),
      );
    }
    slot += interval;
    while (!clock.stopping && Date.now() < slot) {
      await Bun.sleep(Math.min(1000, slot - Date.now()));
    }
  }
}

async function readyzProbe(
  apiUrl: string,
  timeoutMs: number,
): Promise<Omit<ReadyzSample, "t">> {
  const sent = Date.now();
  const child = Bun.spawn(
    [
      "curl",
      "-s",
      "-o",
      "/dev/null",
      "-m",
      String(timeoutMs / 1000),
      "-w",
      "%{http_code} %{time_total}",
      `${apiUrl}/readyz`,
    ],
    { stderr: "ignore", stdout: "pipe" },
  );
  const [text, code] = await Promise.all([
    new Response(child.stdout).text(),
    child.exited,
  ]);
  const [httpCode = "0", seconds = "0"] = text.trim().split(" ");
  const status = Number(httpCode);
  return {
    error: code === 0 ? null : `curl exit ${code}`,
    ms: Math.round(Number(seconds) * 1000),
    ok: code === 0 && status === 200,
    status,
    wallMs: Date.now() - sent,
  };
}

function background(soak: Soak, clock: Clock): Promise<void>[] {
  const { config, env, out } = soak;
  let modelCursor = 0;
  let chaosCursor = 0;
  const tasks = [
    readyzLoop(soak, clock),
    every(clock, config.sampleIntervalSec * 1000, async () => {
      out.jsonl("clock").write(await clockOffset(env.messagesUrl));
      const requests = await soak.model.requests({ since: modelCursor });
      const sink = out.jsonl("model-requests");
      for (const entry of requests) sink.write({ ...entry });
      modelCursor = (requests.at(-1)?.index ?? modelCursor - 1) + 1;
      const traffic = (await fetch(
        `${env.chaosUrl}/log?since=${chaosCursor}`,
      ).then((response) => response.json())) as Array<{ index: number }>;
      const chaosSink = out.jsonl("worker-traffic");
      for (const entry of traffic) chaosSink.write({ ...entry });
      chaosCursor = (traffic.at(-1)?.index ?? chaosCursor - 1) + 1;
    }),
    every(clock, config.invariants.intervalMin * 60_000, async () => {
      await invariantSample(soak);
    }),
  ];
  // The compose reconciler (94S-320) runs its own loop; its status file is
  // the record of whether passes kept succeeding over the whole run.
  tasks.push(
    every(clock, config.reconciler.intervalSec * 1000, async () => {
      const result = await compose(env, [
        "exec",
        "-T",
        "reconciler",
        "cat",
        "/tmp/reconciler-status.json",
      ]);
      let status: unknown = null;
      try {
        status = JSON.parse(result.stdout);
      } catch {}
      const sample = {
        t: new Date().toISOString(),
        code: result.code,
        status: status as ReconcilerSample["status"],
      };
      soak.reconciler.push(sample);
      out.jsonl("reconciler").write({
        ...sample,
        ...(status === null ? { output: result.stderr.slice(-2000) } : {}),
      });
    }),
  );
  return tasks;
}

async function invariantSample(soak: Soak): Promise<void> {
  const { results, observations } = await checkInvariants(
    soak.db,
    { installation: soak.env.installation, ...soak.config.invariants },
    { lifetimes: soak.lifetimes, slots: soak.slots },
  );
  const sample = { at: new Date().toISOString(), results, observations };
  soak.invariantSamples.push(sample);
  soak.out.jsonl("invariants").write(sample);
}

// ---------------------------------------------------------------- report

export type JudgeInput = Pick<
  Soak,
  | "anomalies"
  | "config"
  | "controls"
  | "invariantSamples"
  | "phases"
  | "readyz"
  | "reconciler"
  | "turns"
>;

/** The longest stretch in [from, to] with no sample, in ms. */
function longestGap(times: number[], from: number, to: number): number {
  const points = [from, ...times.filter((t) => t > from && t < to), to].sort(
    (a, b) => a - b,
  );
  let longest = 0;
  for (let i = 1; i < points.length; i++) {
    longest = Math.max(longest, (points[i] ?? 0) - (points[i - 1] ?? 0));
  }
  return longest;
}

export function judge(
  soak: JudgeInput,
  meta: Record<string, unknown>,
): {
  criteria: Criterion[];
  summary: Record<string, unknown>;
} {
  const { config, turns, controls, readyz, invariantSamples } = soak;
  // The steady phase the run was meant to cover, and whether it got there.
  const steadyPhase = soak.phases.find((entry) => entry.phase === "steady") as
    | { deadline?: number; rampEnded?: number }
    | undefined;
  const quiescePhase = soak.phases.find((entry) => entry.phase === "quiesce") as
    | { at?: number }
    | undefined;
  const steadyFrom = Number(steadyPhase?.rampEnded ?? Number.NaN);
  const steadyTo = Number(steadyPhase?.deadline ?? Number.NaN);
  const steadyKnown = Number.isFinite(steadyFrom) && Number.isFinite(steadyTo);
  const gap = (times: number[]) =>
    steadyKnown ? longestGap(times, steadyFrom, steadyTo) : null;
  const gaps = {
    readyz: gap(readyz.map((sample) => Date.parse(sample.t))),
    invariants: gap(invariantSamples.map((sample) => Date.parse(sample.at))),
    reconciler: gap(soak.reconciler.map((sample) => Date.parse(sample.t))),
  };
  const gapLimits = {
    readyz: 3 * config.readyz.intervalMs + config.readyz.timeoutMs,
    invariants: 1.5 * config.invariants.intervalMin * 60_000,
    reconciler: 3 * config.reconciler.intervalSec * 1000,
  };
  const inSteady = (t: string) =>
    steadyKnown && Date.parse(t) >= steadyFrom && Date.parse(t) <= steadyTo;
  const reconcilerSamples = soak.reconciler.filter((sample) =>
    inSteady(sample.t),
  );
  const unreadable = reconcilerSamples.filter(
    (sample) => sample.code !== 0 || sample.status === null,
  );
  // The status keeps only the latest failure, so a failed pass followed by
  // a success between two readings still shows through lastFailureAt.
  const failing = reconcilerSamples.filter(
    (sample) =>
      (sample.status?.consecutiveFailures ?? 0) > 0 ||
      (sample.status?.lastFailureAt != null &&
        Date.parse(sample.status.lastFailureAt) >= steadyFrom),
  );
  const staleness = reconcilerSamples.map((sample) =>
    sample.status?.lastSuccessAt
      ? Date.parse(sample.t) - Date.parse(sample.status.lastSuccessAt)
      : Number.POSITIVE_INFINITY,
  );
  // A restarted loop writes a new loopStartedAt, whatever its pass count.
  // The last reading before steady is the baseline, and a loop that started
  // inside the window is a restart even when no earlier reading shows the
  // one it replaced (its fresh status also clears lastFailureAt).
  const baseline = soak.reconciler
    .filter((sample) => steadyKnown && Date.parse(sample.t) < steadyFrom)
    .at(-1)?.status?.loopStartedAt;
  const loopIds = new Set(
    [
      baseline,
      ...reconcilerSamples.map((sample) => sample.status?.loopStartedAt),
    ].filter((id): id is string => typeof id === "string"),
  );
  const startedInSteady = [...loopIds].some(
    (id) => Date.parse(id) >= steadyFrom,
  );
  const restarts = Math.max(loopIds.size - 1, startedInSteady ? 1 : 0);
  const targets = config.targets;
  const accepted = (endpoint: TurnRecord["endpoint"]) =>
    distribution(
      turns
        .filter(
          (turn) =>
            turn.endpoint === endpoint &&
            turn.inWindow &&
            (turn.acceptStatus === 201 || turn.acceptStatus === 202),
        )
        .map((turn) => turn.acceptMs),
    );
  const messagesAccept = accepted("POST /v1/sessions/{id}/messages");
  const createAccept = accepted("POST /v1/sessions");
  const rejected = turns.filter(
    (turn) => turn.acceptStatus !== 201 && turn.acceptStatus !== 202,
  );
  const ofOp = (op: ControlSample["op"]) => controls.filter((c) => c.op === op);
  const interrupts = ofOp("interrupt");
  const terminates = ofOp("terminate");
  const effect = (samples: ControlSample[]) =>
    distribution(
      samples
        .map((sample) => sample.effectMs)
        .filter((ms): ms is number => ms !== null),
    );
  // Latency of what the API accepted; refusals are counted, not timed.
  const acceptedOf = (samples: ControlSample[]) =>
    distribution(
      samples
        .filter((sample) => sample.acceptStatus === 202)
        .map((sample) => sample.acceptedMs),
    );
  const refused = (samples: ControlSample[]) =>
    samples.filter((sample) => sample.acceptStatus !== 202).length;
  const valid = (samples: ControlSample[]) =>
    samples.filter((sample) => sample.extra?.valid === true);
  const validInterrupts = valid(interrupts);
  const validTerminates = valid(terminates);

  const stages = (samples: StartupSample[]) => {
    const of = (key: keyof StartupSample) =>
      distribution(
        samples
          .map((sample) => sample[key])
          .filter((value): value is number => typeof value === "number"),
      );
    return {
      acceptedToClaim: of("acceptedToClaimMs"),
      claimToReady: of("claimToReadyMs"),
      acceptedToReady: of("acceptedToReadyMs"),
    };
  };
  const startupOf = (name: NonNullable<TurnRecord["startupClass"]>) =>
    turns
      .filter((turn) => turn.startupClass === name)
      .flatMap((turn) => (turn.startup ? [turn.startup] : []));
  const resumeStartups = ofOp("resume").flatMap((sample) => {
    const startup = sample.extra?.startup as StartupSample | undefined;
    return startup ? [startup] : [];
  });
  const startupRows: Record<string, ReturnType<typeof stages>> = {
    "cold-create": stages(startupOf("cold-create")),
    "cold-resume": stages(resumeStartups),
    "cold-relaunch": stages(startupOf("cold-relaunch")),
    warm: stages(startupOf("warm")),
  };
  const rampRows: Record<string, ReturnType<typeof stages>> = {};
  for (const step of config.ramp) {
    rampRows[`concurrency_${step}`] = stages(
      turns
        .filter((turn) => turn.rampStep === step)
        .flatMap((turn) => (turn.startup ? [turn.startup] : [])),
    );
  }

  const worst = new Map<string, InvariantResult>();
  for (const sample of invariantSamples) {
    for (const result of sample.results) {
      const seen = worst.get(result.id);
      if (!seen || result.count > seen.count) worst.set(result.id, result);
    }
  }
  const byInvariant = (name: InvariantResult["invariant"]) =>
    [...worst.values()].filter((result) => result.invariant === name);
  const violations = (name: InvariantResult["invariant"]) =>
    byInvariant(name).filter((result) => result.count > 0);
  const contextLost = turns.filter((turn) => turn.contextKept === false);
  const contextChecked = turns.filter((turn) => turn.contextKept !== null);
  const startedTwice = turns.filter((turn) => (turn.startsAnswered ?? 0) > 1);
  const continued = interrupts.filter(
    (sample) => Number(sample.extra?.continuedAfterInterrupt ?? 0) > 0,
  );
  const succeededWhileRunning = terminates.filter(
    (sample) => sample.extra?.succeededWhileRunning === true,
  );
  const timeouts = turns.filter((turn) => turn.status === "timeout");
  const statusCounts: Record<string, number> = {};
  for (const turn of turns) {
    const key = turn.status ?? `rejected ${turn.acceptStatus}`;
    statusCounts[key] = (statusCounts[key] ?? 0) + 1;
  }
  const readyzOk = readyz.filter((sample) => sample.ok).length;
  const availability = readyz.length ? readyzOk / readyz.length : null;
  const lastObservations = invariantSamples.at(-1)?.observations ?? {};
  const maxObservation = (name: string) =>
    Math.max(
      0,
      ...invariantSamples.map((sample) =>
        Number(sample.observations[name] ?? 0),
      ),
    );
  const invariantRow = (
    id: string,
    name: InvariantResult["invariant"],
    extra: { count: number; label: string }[],
  ) => {
    const found = violations(name);
    const extraFound = extra.filter((entry) => entry.count > 0);
    return criterion({
      id,
      area: "불변식",
      input: `${invariantSamples.length}회 표본의 DB·Docker 검사 (${byInvariant(
        name,
      )
        .map((result) => result.id)
        .join(
          ", ",
        )})${extra.length ? ` + ${extra.map((e) => e.label).join(", ")}` : ""}`,
      expected: "모든 검사 0건",
      actual:
        found.length + extraFound.length === 0
          ? "0건"
          : [
              ...found.map(
                (result) =>
                  `${result.id}=${result.count} ${JSON.stringify(result.rows.slice(0, 3))}`,
              ),
              ...extraFound.map((entry) => `${entry.label}=${entry.count}`),
            ].join("; "),
      pass:
        invariantSamples.length > 0 && found.length + extraFound.length === 0,
    });
  };

  const criteria: Criterion[] = [
    criterion({
      id: "L-1",
      area: "지속 부하",
      input: `${config.sessions}세션, ${config.durationMin}분, turn ${turns.length}개 (${JSON.stringify(statusCounts)})`,
      expected:
        "모든 슬롯이 끝까지 turn을 반복하고, 제한 시간을 넘긴 turn과 잃어버린 세션이 0",
      actual: `timeout ${timeouts.length}, anomaly ${soak.anomalies.length}, rejected ${rejected.length}`,
      pass: timeouts.length === 0 && soak.anomalies.length === 0,
    }),
    criterion({
      id: "P-1",
      area: "성능",
      input: `POST /v1/sessions/{id}/messages ${messagesAccept.n}건 (창 안, 202)`,
      expected: `p95 ≤ ${targets.acceptP95Ms}ms`,
      actual: messagesAccept,
      pass:
        messagesAccept.p95 !== null &&
        messagesAccept.p95 <= targets.acceptP95Ms,
    }),
    criterion({
      id: "P-2",
      area: "성능",
      input: `POST /v1/sessions ${createAccept.n}건 (창 안, 201/202)`,
      expected: `p95 ≤ ${targets.acceptP95Ms}ms`,
      actual: createAccept,
      pass:
        createAccept.p95 === null
          ? null
          : createAccept.p95 <= targets.acceptP95Ms,
    }),
    criterion({
      id: "P-3",
      area: "성능·종료 의미",
      input: `interrupt ${interrupts.length}건 (유효 ${validInterrupts.length}: 느린 호출 중·202·receipt no_op=false): accepted ${JSON.stringify(acceptedOf(interrupts))}`,
      expected: `유효하지 않은 표본 0, 모든 표본이 ${targets.interruptEffectMs}ms 안에 turn이 interrupted, 수락 뒤 모델 호출 0`,
      actual: `effect ${JSON.stringify(effect(validInterrupts))}, 무효 ${interrupts.length - validInterrupts.length}, 관찰 못 함 ${interrupts.filter((s) => s.effectMs === null).length}, interrupted 아님 ${interrupts.filter((s) => s.effect !== "interrupted").length}, 계속 호출 ${continued.length}`,
      pass:
        interrupts.length > 0 &&
        validInterrupts.length === interrupts.length &&
        interrupts.every(
          (sample) =>
            sample.effect === "interrupted" &&
            sample.effectMs !== null &&
            sample.effectMs <= targets.interruptEffectMs,
        ) &&
        continued.length === 0,
    }),
    criterion({
      id: "P-4",
      area: "성능·종료 의미",
      input: `terminate ${terminates.length}건 (유효 ${validTerminates.length}: 느린 호출 중·202): accepted ${JSON.stringify(acceptedOf(terminates))}`,
      expected: `유효하지 않은 표본 0, 모든 표본이 ${targets.terminateEffectMs}ms 안에 receipt succeeded|unknown + worker 없음(receipt 정산 뒤에도)`,
      actual: `effect ${JSON.stringify(effect(validTerminates))}, receipt ${JSON.stringify(terminates.map((s) => s.receiptStatus))}, 확인 못 함 ${terminates.filter((s) => s.effectMs === null).length}, docker 관찰 실패 ${terminates.reduce((n, s) => n + Number(s.extra?.dockerFailures ?? 0), 0)}`,
      pass:
        terminates.length > 0 &&
        validTerminates.length === terminates.length &&
        terminates.every(
          (sample) =>
            sample.effectMs !== null &&
            sample.effectMs <= targets.terminateEffectMs,
        ),
    }),
    criterion({
      id: "P-5",
      area: "성능",
      input: `control accepted (interrupt·terminate·pause·resume ${controls.length}건, 202만 시간 표본)`,
      expected: `각 p95 ≤ ${targets.acceptP95Ms}ms, 거절(202 아님) 0`,
      actual: Object.fromEntries(
        (["interrupt", "terminate", "pause", "resume"] as const).map((op) => [
          op,
          { p95: acceptedOf(ofOp(op)).p95, refused: refused(ofOp(op)) },
        ]),
      ),
      pass: (["interrupt", "terminate", "pause", "resume"] as const).every(
        (op) => {
          const p95 = acceptedOf(ofOp(op)).p95;
          return (
            p95 !== null &&
            p95 <= targets.acceptP95Ms &&
            refused(ofOp(op)) === 0
          );
        },
      ),
    }),
    criterion({
      id: "S-1",
      area: "기동",
      input:
        "accepted→claim→SDK ready, 분류별 (cold-resume: resume receipt→claim→/ready 보고)",
      expected: "cold-create·cold-resume·warm 모두 표본 있음 (숫자 목표 없음)",
      actual: startupRows,
      pass: (["cold-create", "cold-resume", "warm"] as const).every(
        (name) => (startupRows[name]?.acceptedToReady.n ?? 0) > 0,
      ),
    }),
    criterion({
      id: "S-2",
      area: "기동",
      input: `새 세션 첫 turn, 동시 세션 ${config.ramp.join("→")}`,
      expected: "램프 단계마다 표본 있음 (숫자 목표 없음)",
      actual: rampRows,
      pass: config.ramp.every(
        (step) => (rampRows[`concurrency_${step}`]?.acceptedToReady.n ?? 0) > 0,
      ),
    }),
    invariantRow("I-1", "context", [
      {
        count: contextLost.length,
        label: `모델 요청에서 직전 완료 turn이 사라진 turn (검사 ${contextChecked.length}건)`,
      },
    ]),
    invariantRow("I-2", "stale_write", []),
    invariantRow("I-3", "duplicate_execution", [
      {
        count: startedTwice.length,
        label: "같은 turn의 첫 모델 호출이 두 번 응답된 turn",
      },
    ]),
    invariantRow("I-4", "slot_leak", []),
    invariantRow("I-5", "unconfirmed_success", [
      {
        count: succeededWhileRunning.length,
        label: "terminate succeeded인데 worker running",
      },
    ]),
    criterion({
      id: "O-1",
      area: "관측",
      input: `/readyz ${readyz.length}회, ${config.readyz.intervalMs}ms 간격`,
      expected: `가용률 ≥ ${targets.readyzAvailability}`,
      actual: `가용률 ${availability}, 실패 ${readyz.length - readyzOk}회, 응답 시간(curl) ${JSON.stringify(distribution(readyz.map((sample) => sample.ms)))}`,
      pass: availability !== null && availability >= targets.readyzAvailability,
    }),
    criterion({
      id: "O-3",
      area: "관측",
      input: `compose reconciler status 파일 ${reconcilerSamples.length}회 (${config.reconciler.intervalSec}s 간격, steady 구간)`,
      expected: `모든 표본을 읽을 수 있고, 실패한 pass 0, 마지막 성공이 ${config.reconciler.staleSec}s보다 오래된 표본 0, 재시작(passes 감소) 0`,
      actual: {
        unreadable: unreadable.length,
        failing: failing.map((sample) => ({
          t: sample.t,
          reason: sample.status?.lastFailureReason ?? null,
        })),
        maxStalenessMs: staleness.length ? Math.max(...staleness) : null,
        restarts,
        passes: reconcilerSamples.at(-1)?.status?.passes ?? null,
      },
      pass:
        reconcilerSamples.length > 0 &&
        unreadable.length === 0 &&
        failing.length === 0 &&
        restarts === 0 &&
        staleness.every((ms) => ms <= config.reconciler.staleSec * 1000),
    }),
    criterion({
      id: "W-1",
      area: "실행 완주",
      input: `phases.jsonl과 표본 시각 (steady ${config.durationMin}분)`,
      expected: `steady 구간이 설정 길이이고 끝까지 돌았으며(quiesce ≥ deadline), 표본 공백이 readyz ≤ ${gapLimits.readyz}ms · invariants ≤ ${gapLimits.invariants}ms · reconciler ≤ ${gapLimits.reconciler}ms`,
      actual: {
        steadyFrom: steadyKnown ? new Date(steadyFrom).toISOString() : null,
        steadyTo: steadyKnown ? new Date(steadyTo).toISOString() : null,
        quiesceAt: quiescePhase?.at
          ? new Date(quiescePhase.at).toISOString()
          : null,
        gaps,
      },
      pass:
        steadyKnown &&
        steadyTo - steadyFrom === config.durationMin * 60_000 &&
        Number(quiescePhase?.at ?? 0) >= steadyTo &&
        (Object.keys(gaps) as Array<keyof typeof gaps>).every(
          (key) => gaps[key] !== null && (gaps[key] ?? 0) <= gapLimits[key],
        ),
    }),
    criterion({
      id: "O-2",
      area: "관측",
      input: "DB 관측 쿼리",
      expected: "기록 (판정 없음)",
      actual: {
        queue_oldest_age_sec_max: maxObservation("queue_oldest_age_sec"),
        accepted_to_started_p95_ms:
          lastObservations.accepted_to_started_p95_ms ?? null,
        outcome_unknown_turns: lastObservations.outcome_unknown_turns ?? null,
        recovery_required: lastObservations.recovery_required ?? null,
        checkpoint_pending: lastObservations.checkpoint_pending ?? null,
        turns_by_status: lastObservations.turns_by_status ?? null,
      },
      pass: true,
    }),
    criterion({
      id: "R-1",
      area: "재현성",
      input: "meta.json",
      expected:
        "commit·설정·SDK 0.3.270·CLI 2.1.270·Bun·이미지 식별자·bun.lock 해시·명령이 모두 기록됨",
      actual: {
        tested_sha: meta.tested_sha,
        worktree_dirty: meta.worktree_dirty,
        claude_agent_sdk: meta.claude_agent_sdk,
        claude_code: meta.claude_code,
        worker_bun: meta.worker_bun,
        bun_lock_sha256: meta.bun_lock_sha256,
        config_sha256: meta.config_sha256,
      },
      pass:
        meta.claude_agent_sdk === "0.3.270" &&
        String(meta.claude_code).startsWith("2.1.270") &&
        Boolean(meta.tested_sha) &&
        Boolean(meta.bun_lock_sha256) &&
        Boolean(meta.worker_bun),
    }),
  ];
  return {
    criteria,
    summary: {
      accept: { messages: messagesAccept, create: createAccept },
      interrupt: {
        accepted: acceptedOf(interrupts),
        effect: effect(interrupts),
      },
      terminate: {
        accepted: acceptedOf(terminates),
        effect: effect(terminates),
      },
      pause: {
        accepted: acceptedOf(ofOp("pause")),
        effect: effect(ofOp("pause")),
      },
      resume: {
        accepted: acceptedOf(ofOp("resume")),
        effect: effect(ofOp("resume")),
      },
      startup: startupRows,
      ramp: rampRows,
      turns: { total: turns.length, byStatus: statusCounts },
      readyz: { samples: readyz.length, ok: readyzOk, availability },
      anomalies: soak.anomalies.length,
      invariantSamples: invariantSamples.length,
    },
  };
}

// ---------------------------------------------------------------- main

async function main(): Promise<number> {
  const [configPath, outArg] = process.argv.slice(2);
  if (!configPath) {
    console.error("usage: bun scripts/soak/soak.ts <config.json> [out-dir]");
    return 2;
  }
  const config = validConfig(await Bun.file(configPath).json());
  const env = soakEnv();
  const stamp = new Date().toISOString().replaceAll(":", "").slice(0, 15);
  const dir = resolve(
    outArg ??
      join(process.env.SOAK_STATE ?? ".", `soak-${config.name}-${stamp}`),
  );
  const out = new Output(dir);
  copyFileSync(configPath, join(dir, "config.json"));
  const meta = await reproMeta(env, {
    config: configPath,
    config_sha256: sha256File(configPath),
    run_started_at: new Date().toISOString(),
    reconciler: "compose reconciler service (94S-320)",
  });
  out.json("meta", meta);
  console.error(`soak ${config.name}: output ${dir}`);

  const api = new Api(env.apiUrl, env.apiKey);
  const model = new Model(env.messagesUrl);
  const db = database(env.databaseUrl);
  const soak = new Soak(config, env, out, api, model, db);
  const workerLogs = join(dir, "workers");
  mkdirSync(workerLogs, { recursive: true });
  const workers = new Workers(env.installation, workerLogs);
  workers.watch();
  await soak.lifetimes.start();
  await model.setFaults(config.messagesFaults);

  const clock: Clock = { stopping: false };
  const tasks = background(soak, clock);
  const loops = Array.from(
    { length: config.sessions },
    (_, slot) => new SessionLoop(soak, slot),
  );

  // Ramp: open sessions up to each step at once, so the first turns of a
  // step start together and are tagged with that concurrency; sessions
  // already open keep working meanwhile, as they would while an
  // installation scales from 1 to 10.
  const schedule = { deadline: Number.POSITIVE_INFINITY };
  const running: Promise<void>[] = [];
  let open = 0;
  for (const step of config.ramp) {
    const opening = loops.slice(open, step);
    console.error(`ramp → ${step} sessions`);
    await Promise.all(opening.map((loop) => loop.open(step)));
    for (const loop of opening) running.push(loop.loop(schedule, clock));
    open = step;
  }
  const rampEnded = Date.now();
  soak.windowStart = rampEnded + config.warmupMin * 60_000;
  const deadline = rampEnded + config.durationMin * 60_000;
  schedule.deadline = deadline;
  soak.windowEnd = deadline;
  soak.phase({
    phase: "steady",
    rampEnded,
    windowStart: soak.windowStart,
    deadline,
  });

  let next = 0;
  const pick = () => loops[next++ % loops.length];
  const timers = [
    setInterval(() => {
      const loop = pick();
      if (loop && loop.pending === null) loop.pending = "terminate";
    }, config.probes.terminateEveryMin * 60_000),
    setInterval(() => {
      const loop = pick();
      if (loop && loop.pending === null) loop.pending = "pause";
    }, config.probes.pauseResumeEveryMin * 60_000),
  ];
  const steady = Promise.all(running);
  const drainLimit = new Promise<void>((resolveLimit) =>
    setTimeout(resolveLimit, deadline - Date.now() + config.drainSec * 1000),
  );
  await Promise.race([steady, drainLimit]);
  for (const timer of timers) clearInterval(timer);
  const stuck = loops.filter((loop) => loop.busy).map((loop) => loop.slot);
  if (stuck.length > 0) soak.anomaly({ reason: "drain ran out", slots: stuck });
  soak.phase({ phase: "quiesce", at: Date.now() });
  await Bun.sleep(config.quiesceSec * 1000);
  await invariantSample(soak);
  clock.stopping = true;
  await Promise.all(tasks);
  workers.stop();
  soak.lifetimes.stop();

  await dumpTables(db, out);
  await composeToFile(
    env,
    ["logs", "--no-color", "--timestamps"],
    join(dir, "compose.log"),
  );
  await db.end();
  return report(dir, soak, meta);
}

/** The rows the verdict rests on, kept with the run as raw evidence. */
async function dumpTables(db: Pool, out: Output): Promise<void> {
  for (const table of [
    "sessions",
    "turns",
    "attempts",
    "worker_launches",
    "executions",
    "checkpoints",
    "receipts",
    "control_intents",
  ]) {
    const { rows } = await db.query(`SELECT * FROM ${table}`);
    const sink = out.jsonl(`db-${table}`);
    for (const row of rows) sink.write(row as Record<string, unknown>);
  }
}

function report(
  dir: string,
  data: JudgeInput,
  meta: Record<string, unknown>,
): number {
  const out = new Output(dir);
  const { criteria, summary } = judge(data, meta);
  out.json("summary", summary);
  out.json("criteria", criteria);
  out.text(
    "report.md",
    markdownReport(`94S-135 soak — ${data.config.name}`, meta, criteria),
  );
  const failed = criteria.filter((row) => row.status === "fail");
  console.error(
    `soak ${data.config.name}: ${criteria.length - failed.length}/${criteria.length} pass or skip; report ${join(dir, "report.md")}`,
  );
  return failed.length === 0 ? 0 : 1;
}

function readJsonl<T>(path: string): T[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as T);
}

/**
 * Judges a finished run again from its raw files, with the same rules the
 * live run used. A control sample from before probes recorded their own
 * validity carries no proof the slow call was still pending, so it counts
 * as invalid rather than being reconstructed after the fact.
 */
function rejudge(dir: string): number {
  const at = (name: string) => join(dir, name);
  const config = validConfig(
    JSON.parse(readFileSync(at("config.json"), "utf8")),
  );
  const meta = JSON.parse(readFileSync(at("meta.json"), "utf8"));
  const controls = readJsonl<ControlSample>(at("controls.jsonl")).map(
    (sample) => {
      const extra = sample.extra ?? {};
      const proven =
        sample.op !== "interrupt" ||
        (typeof extra.acceptedBy === "string" &&
          typeof extra.slowPendingUntil === "string" &&
          Date.parse(extra.acceptedBy) < Date.parse(extra.slowPendingUntil));
      return extra.valid === true && proven
        ? sample
        : { ...sample, extra: { ...extra, valid: false, unproven: !proven } };
    },
  );
  return report(
    dir,
    {
      anomalies: readJsonl(at("anomalies.jsonl")),
      config,
      controls,
      invariantSamples: readJsonl(at("invariants.jsonl")),
      phases: readJsonl(at("phases.jsonl")),
      readyz: readJsonl(at("readyz.jsonl")),
      reconciler: readJsonl(at("reconciler.jsonl")),
      turns: readJsonl(at("turns.jsonl")),
    },
    { ...meta, rejudged_at: new Date().toISOString() },
  );
}

if (import.meta.main) {
  const [first, second] = process.argv.slice(2);
  process.exit(
    first === "--judge" && second ? rejudge(resolve(second)) : await main(),
  );
}
