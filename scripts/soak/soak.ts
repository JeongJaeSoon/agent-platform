import { copyFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Pool } from "pg";
import { database, run, Workers } from "../../tests/d2-gate/harness.ts";
import { checkInvariants, type InvariantResult } from "./invariants.ts";
import {
  between,
  type Criterion,
  clockOffset,
  compose,
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
  reconciler: { mode: "external-loop" | "product"; intervalSec: number };
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
  positive("readyz.intervalMs", config.readyz?.intervalMs);
  positive("invariants.intervalMin", config.invariants?.intervalMin);
  positive("invariants.slotLimit", config.invariants?.slotLimit);
  positive("sampleIntervalSec", config.sampleIntervalSec);
  if (!["external-loop", "product"].includes(config.reconciler?.mode)) {
    problems.push("reconciler.mode must be external-loop or product");
  }
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
  readonly readyz: Array<{ ok: boolean; ms: number; status: number }> = [];
  readonly invariantSamples: Array<{
    at: string;
    results: InvariantResult[];
    observations: Record<string, unknown>;
  }> = [];
  readonly anomalies: Array<Record<string, unknown>> = [];
  windowStart = Number.POSITIVE_INFINITY;
  windowEnd = Number.POSITIVE_INFINITY;

  constructor(
    readonly config: SoakConfig,
    readonly env: SoakEnv,
    readonly out: Output,
    readonly api: Api,
    readonly model: Model,
    readonly db: Pool,
  ) {}

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

  async loop(deadline: number, clock: Clock): Promise<void> {
    while (Date.now() < deadline && !clock.stopping) {
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

function background(soak: Soak, clock: Clock): Promise<void>[] {
  const { config, env, out } = soak;
  let modelCursor = 0;
  let chaosCursor = 0;
  const tasks = [
    every(clock, config.readyz.intervalMs, async () => {
      const sent = Date.now();
      let status = 0;
      let error: string | null = null;
      try {
        const response = await fetch(`${env.apiUrl}/readyz`, {
          signal: AbortSignal.timeout(config.readyz.timeoutMs),
        });
        status = response.status;
        await response.arrayBuffer();
      } catch (caught) {
        error = String(caught);
      }
      const sample = { ok: status === 200, ms: Date.now() - sent, status };
      soak.readyz.push(sample);
      out.jsonl("readyz").write({ ...sample, error });
    }),
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
  if (config.reconciler.mode === "external-loop") {
    let pass = 0;
    tasks.push(
      every(clock, config.reconciler.intervalSec * 1000, async () => {
        const result = await run(
          [
            "docker",
            "run",
            "--rm",
            "--name",
            `${env.project}-reconciler-pass-${++pass}`,
            "--network",
            env.network,
            "-e",
            "DATABASE_URL=postgres://postgres:dev@postgres:5432/sessions",
            "-e",
            "HEARTBEAT_TTL_SEC=30",
            "-e",
            "LOG_LEVEL=info",
            env.apiImage,
            "bun",
            "run",
            "apps/reconciler/src/main.ts",
          ],
          { allowFail: true },
        );
        out.jsonl("reconciler").write({
          pass,
          code: result.code,
          output: `${result.stdout}${result.stderr}`.slice(-4000),
        });
      }),
    );
  }
  return tasks;
}

async function invariantSample(soak: Soak): Promise<void> {
  const { results, observations } = await checkInvariants(soak.db, {
    installation: soak.env.installation,
    ...soak.config.invariants,
  });
  const sample = { at: new Date().toISOString(), results, observations };
  soak.invariantSamples.push(sample);
  soak.out.jsonl("invariants").write(sample);
}

// ---------------------------------------------------------------- report

function judge(
  soak: Soak,
  meta: Record<string, unknown>,
): {
  criteria: Criterion[];
  summary: Record<string, unknown>;
} {
  const { config, turns, controls, readyz, invariantSamples } = soak;
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
  const acceptedOf = (samples: ControlSample[]) =>
    distribution(samples.map((sample) => sample.acceptedMs));

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
      input: `interrupt ${interrupts.length}건: accepted ${JSON.stringify(acceptedOf(interrupts))}`,
      expected: `모든 표본이 ${targets.interruptEffectMs}ms 안에 turn 종료 관찰, 수락 뒤 모델 호출 0`,
      actual: `effect ${JSON.stringify(effect(interrupts))}, 관찰 못 함 ${interrupts.filter((s) => s.effectMs === null).length}, 상태 ${JSON.stringify(interrupts.map((s) => s.effect))}, 계속 호출 ${continued.length}`,
      pass:
        interrupts.length === 0
          ? false
          : interrupts.every(
              (sample) =>
                sample.effectMs !== null &&
                sample.effectMs <= targets.interruptEffectMs,
            ) && continued.length === 0,
    }),
    criterion({
      id: "P-4",
      area: "성능·종료 의미",
      input: `terminate ${terminates.length}건: accepted ${JSON.stringify(acceptedOf(terminates))}`,
      expected: `모든 표본이 ${targets.terminateEffectMs}ms 안에 receipt succeeded|unknown + worker 없음`,
      actual: `effect ${JSON.stringify(effect(terminates))}, receipt ${JSON.stringify(terminates.map((s) => s.receiptStatus))}, 확인 못 함 ${terminates.filter((s) => s.effectMs === null).length}`,
      pass:
        terminates.length === 0
          ? false
          : terminates.every(
              (sample) =>
                sample.effectMs !== null &&
                sample.effectMs <= targets.terminateEffectMs,
            ),
    }),
    criterion({
      id: "P-5",
      area: "성능",
      input: `control accepted (interrupt·terminate·pause·resume ${controls.length}건)`,
      expected: `각 p95 ≤ ${targets.acceptP95Ms}ms`,
      actual: Object.fromEntries(
        (["interrupt", "terminate", "pause", "resume"] as const).map((op) => [
          op,
          acceptedOf(ofOp(op)).p95,
        ]),
      ),
      pass: (["interrupt", "terminate", "pause", "resume"] as const).every(
        (op) => {
          const p95 = acceptedOf(ofOp(op)).p95;
          return p95 !== null && p95 <= targets.acceptP95Ms;
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
      actual: `가용률 ${availability}, 실패 ${readyz.length - readyzOk}회`,
      pass: availability !== null && availability >= targets.readyzAvailability,
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
    reconciler: config.reconciler.mode,
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
  await model.setFaults(config.messagesFaults);

  const clock: Clock = { stopping: false };
  const tasks = background(soak, clock);
  const loops = Array.from(
    { length: config.sessions },
    (_, slot) => new SessionLoop(soak, slot),
  );

  // Ramp: open sessions up to each step at once, so the first turns of a
  // step start together and are tagged with that concurrency.
  let open = 0;
  for (const step of config.ramp) {
    const opening = loops.slice(open, step);
    console.error(`ramp → ${step} sessions`);
    await Promise.all(opening.map((loop) => loop.open(step)));
    open = step;
  }
  const rampEnded = Date.now();
  soak.windowStart = rampEnded + config.warmupMin * 60_000;
  const deadline = rampEnded + config.durationMin * 60_000;
  soak.windowEnd = deadline;
  out.jsonl("phases").write({
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
  const steady = Promise.all(loops.map((loop) => loop.loop(deadline, clock)));
  const drainLimit = new Promise<void>((resolveLimit) =>
    setTimeout(resolveLimit, deadline - Date.now() + config.drainSec * 1000),
  );
  await Promise.race([steady, drainLimit]);
  for (const timer of timers) clearInterval(timer);
  const stuck = loops.filter((loop) => loop.busy).map((loop) => loop.slot);
  if (stuck.length > 0) soak.anomaly({ reason: "drain ran out", slots: stuck });
  out.jsonl("phases").write({ phase: "quiesce", at: Date.now() });
  await Bun.sleep(config.quiesceSec * 1000);
  await invariantSample(soak);
  clock.stopping = true;
  await Promise.all(tasks);
  workers.stop();

  const { criteria, summary } = judge(soak, meta);
  out.json("summary", summary);
  out.json("criteria", criteria);
  out.text(
    "report.md",
    markdownReport(`94S-135 soak — ${config.name}`, meta, criteria),
  );
  await compose(env, ["logs", "--no-color", "--timestamps"]).then((logs) =>
    out.text("compose.log", `${logs.stdout}${logs.stderr}`),
  );
  await db.end();
  const failed = criteria.filter((row) => row.status === "fail");
  console.error(
    `soak ${config.name}: ${criteria.length - failed.length}/${criteria.length} pass or skip; report ${join(dir, "report.md")}`,
  );
  return failed.length === 0 ? 0 : 1;
}

if (import.meta.main) {
  process.exit(await main());
}
