import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { distribution, soakEnv } from "./lib.ts";
import { Api } from "./probes.ts";
import { curlLoop, HOST_PROBE, type HostProbeSample } from "./soak.ts";

const WARMUP_MS = 15 * 60_000;
const CYCLE_MS = 5 * 60_000;
const MINUTE_MS = 60_000;
const BUCKET_MS = 5_000;
const CYCLES = 24;
const MINUTES_PER_CYCLE = 5;
const SAMPLE_COUNT = CYCLES * MINUTES_PER_CYCLE;
const ACCEPT_P95_MS = 500;

export type PhasePlanEntry = {
  sequence: number;
  cycle: number;
  minute: number;
  secondOffset: number;
  plannedAt: string;
  plannedAtMs: number;
  bucket: number;
};

export type PhaseSample = {
  sequence: number;
  plannedAt: string;
  plannedBucket: number;
  sentAt: string;
  sentAtMs: number;
  actualBucket: number;
  inPlannedWindow: boolean;
  acceptMs: number;
  status: number;
  accepted: boolean;
  response: unknown;
};

export type PhaseJudgement = {
  verdict: "PASS" | "INVALID";
  reasons: string[];
  planned: number;
  sampled: number;
  accepted: number;
  inPlannedWindow: number;
  bucketCounts: number[];
  latency: ReturnType<typeof distribution>;
};

const modulo = (value: number, divisor: number) =>
  ((value % divisor) + divisor) % divisor;

export function phaseBucket(atMs: number): number {
  return Math.floor(modulo(atMs, CYCLE_MS) / BUCKET_MS);
}

export function buildPhasePlan(nowMs: number): PhasePlanEntry[] {
  const firstCycleAt = Math.ceil((nowMs + WARMUP_MS) / CYCLE_MS) * CYCLE_MS;
  const plan: PhasePlanEntry[] = [];
  for (let cycle = 0; cycle < CYCLES; cycle++) {
    const secondOffset = 2.5 + 5 * (cycle % 12);
    for (let minute = 0; minute < MINUTES_PER_CYCLE; minute++) {
      const plannedAtMs =
        firstCycleAt +
        cycle * CYCLE_MS +
        minute * MINUTE_MS +
        secondOffset * 1_000;
      plan.push({
        sequence: plan.length + 1,
        cycle,
        minute,
        secondOffset,
        plannedAt: new Date(plannedAtMs).toISOString(),
        plannedAtMs,
        bucket: phaseBucket(plannedAtMs),
      });
    }
  }
  return plan;
}

export function judgePhase(
  plan: readonly PhasePlanEntry[],
  samples: readonly PhaseSample[],
  additionalReasons: readonly string[] = [],
): PhaseJudgement {
  const reasons = [...additionalReasons];
  const sequences = new Set(samples.map((sample) => sample.sequence));
  const plannedBySequence = new Map(
    plan.map((entry) => [entry.sequence, entry] as const),
  );
  const inPlannedWindow = samples.filter((sample) => {
    const entry = plannedBySequence.get(sample.sequence);
    if (!entry) return false;
    const windowStart = Math.floor(entry.plannedAtMs / BUCKET_MS) * BUCKET_MS;
    return (
      sample.sentAtMs >= windowStart &&
      sample.sentAtMs < windowStart + BUCKET_MS
    );
  }).length;
  const accepted = samples.filter(
    (sample) => sample.status === 201 || sample.status === 202,
  ).length;
  if (plan.length !== SAMPLE_COUNT) {
    reasons.push(`planned ${plan.length}, expected ${SAMPLE_COUNT}`);
  }
  if (samples.length !== plan.length) {
    reasons.push(`sampled ${samples.length}, planned ${plan.length}`);
  }
  if (sequences.size !== samples.length) {
    reasons.push("duplicate sample sequence");
  }
  if (inPlannedWindow !== samples.length) {
    reasons.push("one or more samples left their planned 5-second window");
  }
  if (accepted !== samples.length) {
    reasons.push("one or more samples were not accepted with 201 or 202");
  }

  const bucketCounts = Array.from({ length: 60 }, () => 0);
  for (const sample of samples) {
    const bucket = phaseBucket(sample.sentAtMs);
    bucketCounts[bucket] = (bucketCounts[bucket] ?? 0) + 1;
  }
  if (bucketCounts.some((count) => count !== 2)) {
    reasons.push("actual UTC phase coverage is not exactly 60 buckets x 2");
  }

  const latency = distribution(samples.map((sample) => sample.acceptMs));
  if (latency.p95 === null || latency.p95 > ACCEPT_P95_MS) {
    reasons.push(`nearest-rank p95 is not <= ${ACCEPT_P95_MS}ms`);
  }

  return {
    verdict: reasons.length === 0 ? "PASS" : "INVALID",
    reasons,
    planned: plan.length,
    sampled: samples.length,
    accepted,
    inPlannedWindow,
    bucketCounts,
    latency,
  };
}

function gitSha(): string {
  const result = Bun.spawnSync(["git", "rev-parse", "HEAD"]);
  if (result.exitCode !== 0) {
    throw new Error("git rev-parse HEAD failed");
  }
  return result.stdout.toString().trim();
}

type RcRecord = {
  rc_sha?: unknown;
  images?: Array<{ image?: unknown; id?: unknown }>;
};

function imageId(image: string): string {
  const result = Bun.spawnSync([
    "docker",
    "image",
    "inspect",
    "--format",
    "{{.Id}}",
    image,
  ]);
  if (result.exitCode !== 0) {
    throw new Error(
      `could not inspect image ${image}: ${result.stderr.toString().trim()}`,
    );
  }
  return result.stdout.toString().trim();
}

function verifyRcImages(
  rcPath: string,
  images: readonly string[],
): { rcJson: string; productSha: string; imageIds: Record<string, string> } {
  const rc = JSON.parse(readFileSync(rcPath, "utf8")) as RcRecord;
  if (typeof rc.rc_sha !== "string" || !Array.isArray(rc.images)) {
    throw new Error(`${rcPath} has no RC SHA or image records`);
  }
  const imageIds: Record<string, string> = {};
  for (const image of images) {
    const current = imageId(image);
    const recorded = rc.images.some(
      (entry) => entry.image === image && entry.id === current,
    );
    if (!recorded) {
      throw new Error(
        `${image} is ${current}, not an image recorded in ${rcPath}`,
      );
    }
    imageIds[image] = current;
  }
  return { rcJson: rcPath, productSha: rc.rc_sha, imageIds };
}

async function steadySessionCount(api: Api): Promise<number> {
  const steadyStates = new Set([
    "active",
    "pausing",
    "paused",
    "resuming",
    "stopping",
  ]);
  let cursor: string | null = null;
  let count = 0;
  do {
    const query = new URLSearchParams({ limit: "100" });
    if (cursor) query.set("cursor", cursor);
    const response = await api.call("GET", `/v1/sessions?${query}`);
    if (response.status !== 200) {
      throw new Error(
        `could not list steady sessions: HTTP ${response.status}`,
      );
    }
    const page = response.body as {
      items?: Array<{ admission_state?: unknown }>;
      next_cursor?: unknown;
    };
    if (!Array.isArray(page.items)) {
      throw new Error("session list response has no items");
    }
    count += page.items.filter(
      (item) =>
        typeof item.admission_state === "string" &&
        steadyStates.has(item.admission_state),
    ).length;
    if (page.next_cursor !== null && typeof page.next_cursor !== "string") {
      throw new Error("session list response has an invalid next_cursor");
    }
    cursor = page.next_cursor;
  } while (cursor !== null);
  return count;
}

function atomicJson(path: string, value: unknown): void {
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(temporary, path);
}

function markdown(
  productSha: string,
  toolsSha: string,
  plan: readonly PhasePlanEntry[],
  samples: readonly PhaseSample[],
  judgement: PhaseJudgement | null,
  observedInvalidReasons: readonly string[],
): string {
  const verdict =
    judgement?.verdict ??
    (observedInvalidReasons.length > 0 ? "INVALID" : "RUNNING");
  const lines = [
    "# P-2 보완 측정",
    "",
    `- 판정: **${verdict}**`,
    `- 제품 SHA: \`${productSha}\``,
    `- 스크립트 SHA: \`${toolsSha}\``,
    `- 계획: ${plan.length}개`,
    `- 수집: ${samples.length}개`,
    ...(judgement
      ? [
          `- 수락(201/202): ${judgement.accepted}개`,
          `- 예약 창 안 전송: ${judgement.inPlannedWindow}개`,
          `- nearest-rank p95: ${judgement.latency.p95 ?? "없음"}ms`,
          `- 무효 사유: ${judgement.reasons.join("; ") || "없음"}`,
        ]
      : observedInvalidReasons.map(
          (reason) => `- 관측된 무효 사유: ${reason}`,
        )),
    "",
    "| # | 계획 시각 | bucket | 실제 시각 | 지연(ms) | 상태 | 예약 창 |",
    "|---:|---|---:|---|---:|---:|:---:|",
    ...samples.map(
      (sample) =>
        `| ${sample.sequence} | ${sample.plannedAt} | ${sample.plannedBucket} | ${sample.sentAt} | ${sample.acceptMs} | ${sample.status} | ${sample.inPlannedWindow ? "예" : "아니오"} |`,
    ),
    "",
  ];
  return lines.join("\n");
}

async function waitUntil(atMs: number): Promise<void> {
  while (Date.now() < atMs) {
    await Bun.sleep(Math.min(atMs - Date.now(), 1_000));
  }
}

async function main(): Promise<number> {
  const [outArg, rcArg] = process.argv.slice(2);
  const env = soakEnv();
  if (!env.vmLagUrl || !env.hostEchoUrl) {
    throw new Error(
      "SOAK_VM_LAG_URL and SOAK_HOST_ECHO_URL are required for host probe evidence",
    );
  }
  const stamp = new Date().toISOString().replaceAll(":", "").slice(0, 15);
  const dir = resolve(
    outArg ?? join(process.env.SOAK_STATE ?? ".", `p2-phase-${stamp}`),
  );
  mkdirSync(dir, { recursive: true });
  const jsonPath = join(dir, "p2-phase.json");
  const markdownPath = join(dir, "p2-phase.md");
  if (existsSync(jsonPath) || existsSync(markdownPath)) {
    throw new Error(`refusing to replace an existing P-2 artifact in ${dir}`);
  }

  const egressProxyImage = process.env.EGRESS_PROXY_IMAGE;
  if (!egressProxyImage) {
    throw new Error("EGRESS_PROXY_IMAGE is required");
  }
  const rcPath = resolve(
    rcArg ?? process.env.P2_PHASE_RC_JSON ?? join(dir, "..", "rc.json"),
  );
  const provenance = verifyRcImages(rcPath, [
    env.apiImage,
    env.workerImage,
    egressProxyImage,
  ]);
  const api = new Api(env.apiUrl, env.apiKey);
  const initialSteadySessions = await steadySessionCount(api);
  if (initialSteadySessions !== 10) {
    throw new Error(
      `expected 10 steady sessions before warmup, found ${initialSteadySessions}`,
    );
  }

  const toolsSha = gitSha();
  const createdAt = new Date().toISOString();
  const plan = buildPhasePlan(Date.now());
  const samples: PhaseSample[] = [];
  const hostProbe: HostProbeSample[] = [];
  const writeArtifacts = (
    judgement: PhaseJudgement | null,
    observedInvalidReasons: readonly string[] = [],
  ) => {
    const verdict =
      judgement?.verdict ??
      (observedInvalidReasons.length > 0 ? "INVALID" : "RUNNING");
    atomicJson(jsonPath, {
      schemaVersion: 1,
      createdAt,
      productSha: provenance.productSha,
      toolsSha,
      provenance,
      initialSteadySessions,
      verdict,
      plan,
      samples,
      judgement,
      observedInvalidReasons,
      hostProbe,
      hostProbeUse: "diagnostic only; never excludes a sample",
    });
    writeFileSync(
      markdownPath,
      markdown(
        provenance.productSha,
        toolsSha,
        plan,
        samples,
        judgement,
        observedInvalidReasons,
      ),
    );
  };
  writeArtifacts(null);
  console.error(`P-2 phase plan written to ${jsonPath}`);

  const probeClock = { stopping: false };
  const probeTasks = [
    ["vm-lag", `${env.vmLagUrl}/healthz`],
    ["host-echo", `${env.hostEchoUrl}/healthz`],
  ].map(([target, url]) =>
    curlLoop(
      probeClock,
      url as string,
      HOST_PROBE.intervalMs,
      HOST_PROBE.timeoutMs,
      (sample) => hostProbe.push({ target: target as string, ...sample }),
    ),
  );

  let runtimeError: string | null = null;
  try {
    const first = plan[0];
    if (!first) throw new Error("phase plan is empty");
    await waitUntil(first.plannedAtMs - 10_000);
    const steadySessions = await steadySessionCount(api);
    if (steadySessions !== 10) {
      throw new Error(
        `expected 10 steady sessions after warmup, found ${steadySessions}`,
      );
    }
    for (const entry of plan) {
      await waitUntil(entry.plannedAtMs);
      const posted = await api.createSession(
        `P-2 supplemental phase sample ${entry.sequence}`,
      );
      const windowStart = Math.floor(entry.plannedAtMs / BUCKET_MS) * BUCKET_MS;
      samples.push({
        sequence: entry.sequence,
        plannedAt: entry.plannedAt,
        plannedBucket: entry.bucket,
        sentAt: new Date(posted.sentAt).toISOString(),
        sentAtMs: posted.sentAt,
        actualBucket: phaseBucket(posted.sentAt),
        inPlannedWindow:
          posted.sentAt >= windowStart &&
          posted.sentAt < windowStart + BUCKET_MS,
        acceptMs: posted.ms,
        status: posted.status,
        accepted: posted.status === 201 || posted.status === 202,
        response: posted.body,
      });
      const observedInvalidReasons = [
        ...(samples.some((sample) => !sample.inPlannedWindow)
          ? ["one or more samples left their planned 5-second window"]
          : []),
        ...(samples.some((sample) => !sample.accepted)
          ? ["one or more samples were not accepted with 201 or 202"]
          : []),
      ];
      writeArtifacts(null, observedInvalidReasons);
    }
  } catch (error) {
    runtimeError = String(error);
  } finally {
    probeClock.stopping = true;
    await Promise.all(probeTasks);
  }

  const judgement = judgePhase(
    plan,
    samples,
    runtimeError === null ? [] : [runtimeError],
  );
  writeArtifacts(judgement);
  console.error(`P-2 phase verdict: ${judgement.verdict}`);
  return judgement.verdict === "PASS" ? 0 : 1;
}

if (import.meta.main) {
  process.exitCode = await main();
}
