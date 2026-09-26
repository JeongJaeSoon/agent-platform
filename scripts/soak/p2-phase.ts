import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { container, distribution, type SoakEnv, soakEnv } from "./lib.ts";
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
const RC4_PRODUCT_SHA = "40864efa17cf0690be669a445bb37da8ace91daa";

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
  images?: Array<{ service?: unknown; image?: unknown; id?: unknown }>;
};

function commandText(command: string[], description: string): string {
  const result = Bun.spawnSync(command);
  if (result.exitCode !== 0) {
    throw new Error(
      `${description}: ${result.stderr.toString().trim() || `exit ${result.exitCode}`}`,
    );
  }
  return result.stdout.toString().trim();
}

function imageId(image: string): string {
  return commandText(
    ["docker", "image", "inspect", "--format", "{{.Id}}", image],
    `could not inspect image ${image}`,
  );
}

function containerImageId(name: string): string {
  return commandText(
    ["docker", "inspect", "--format", "{{.Image}}", name],
    `could not inspect container ${name}`,
  );
}

function verifyRcImages(
  rcPath: string,
  env: SoakEnv,
  egressProxyImage: string,
): {
  rcJson: string;
  productSha: string;
  imageIds: Record<string, string>;
  containerImageIds: Record<string, string>;
  apiUrl: string;
} {
  const rc = JSON.parse(readFileSync(rcPath, "utf8")) as RcRecord;
  if (typeof rc.rc_sha !== "string" || !Array.isArray(rc.images)) {
    throw new Error(`${rcPath} has no RC SHA or image records`);
  }
  if (rc.rc_sha !== RC4_PRODUCT_SHA) {
    throw new Error(
      `${rcPath} records product SHA ${rc.rc_sha}, expected ${RC4_PRODUCT_SHA}`,
    );
  }
  const images = [env.apiImage, env.workerImage, egressProxyImage];
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

  const containerImageIds = {
    api: containerImageId(container(env, "api")),
    "egress-proxy": containerImageId(container(env, "egress-proxy")),
  };
  if (containerImageIds.api !== imageIds[env.apiImage]) {
    throw new Error(
      `running API container uses ${containerImageIds.api}, expected ${imageIds[env.apiImage]}`,
    );
  }
  if (containerImageIds["egress-proxy"] !== imageIds[egressProxyImage]) {
    throw new Error(
      `running egress-proxy container uses ${containerImageIds["egress-proxy"]}, expected ${imageIds[egressProxyImage]}`,
    );
  }

  const published = commandText(
    [
      "docker",
      "compose",
      "-p",
      env.project,
      ...env.composeFiles,
      "--profile",
      "apps",
      "--profile",
      "worker",
      "port",
      "api",
      "3000",
    ],
    "could not read the soak API published port",
  );
  const expectedApiUrl = `http://${published}`;
  const configuredApiUrl = new URL(env.apiUrl);
  if (
    configuredApiUrl.origin !== expectedApiUrl ||
    configuredApiUrl.pathname !== "/"
  ) {
    throw new Error(
      `SOAK_API_URL ${env.apiUrl} is not the soak compose API at ${expectedApiUrl}`,
    );
  }
  return {
    rcJson: rcPath,
    productSha: rc.rc_sha,
    imageIds,
    containerImageIds,
    apiUrl: env.apiUrl,
  };
}

async function activeSessionIds(api: Api): Promise<string[]> {
  let cursor: string | null = null;
  const ids: string[] = [];
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
      items?: Array<{ id?: unknown; admission_state?: unknown }>;
      next_cursor?: unknown;
    };
    if (!Array.isArray(page.items)) {
      throw new Error("session list response has no items");
    }
    for (const item of page.items) {
      if (item.admission_state !== "active") continue;
      if (typeof item.id !== "string") {
        throw new Error("active session list entry has no id");
      }
      ids.push(item.id);
    }
    if (page.next_cursor !== null && typeof page.next_cursor !== "string") {
      throw new Error("session list response has an invalid next_cursor");
    }
    cursor = page.next_cursor;
  } while (cursor !== null);
  return ids.sort();
}

type WorkloadSnapshot = {
  sessionIds: string[];
  workers: Array<{ name: string; sessionId: string; imageId: string }>;
};

async function verifySteadyWorkload(
  api: Api,
  env: SoakEnv,
  workerImageId: string,
  expectedSessionIds?: readonly string[],
): Promise<WorkloadSnapshot> {
  const sessionIds = await activeSessionIds(api);
  const expected = [...(expectedSessionIds ?? sessionIds)].sort();
  if (expectedSessionIds === undefined && sessionIds.length !== 10) {
    throw new Error(
      `expected exactly 10 admission-active sessions, found ${sessionIds.length}`,
    );
  }
  const active = new Set(sessionIds);
  const missing = expected.filter((id) => !active.has(id));
  if (missing.length > 0) {
    throw new Error(
      `steady sessions are no longer active: ${missing.join(", ")}`,
    );
  }

  const listing = commandText(
    [
      "docker",
      "ps",
      "--filter",
      `label=agent-platform.installation=${env.installation}`,
      "--filter",
      "name=ap-worker-",
      "--format",
      '{{.Names}}\t{{.Label "agent-platform.session-id"}}',
    ],
    "could not list running soak workers",
  );
  const workers = listing
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [name, sessionId] = line.split("\t");
      if (!name || !sessionId) {
        throw new Error(`running worker has incomplete identity: ${line}`);
      }
      return { name, sessionId, imageId: containerImageId(name) };
    });
  for (const worker of workers) {
    if (worker.imageId !== workerImageId) {
      throw new Error(
        `running worker ${worker.name} uses ${worker.imageId}, expected ${workerImageId}`,
      );
    }
  }
  for (const sessionId of expected) {
    const count = workers.filter(
      (worker) => worker.sessionId === sessionId,
    ).length;
    if (count !== 1) {
      throw new Error(
        `steady session ${sessionId} has ${count} running workers, expected 1`,
      );
    }
  }
  if (workers.length !== 10) {
    throw new Error(
      `expected exactly 10 running steady workers, found ${workers.length}`,
    );
  }
  return { sessionIds: expected, workers };
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
  const provenance = verifyRcImages(rcPath, env, egressProxyImage);
  const workerImageId = provenance.imageIds[env.workerImage];
  if (!workerImageId) {
    throw new Error(`no verified image ID for ${env.workerImage}`);
  }
  const api = new Api(env.apiUrl, env.apiKey);
  const initialWorkload = await verifySteadyWorkload(api, env, workerImageId);

  const toolsSha = gitSha();
  const createdAt = new Date().toISOString();
  const plan = buildPhasePlan(Date.now());
  const samples: PhaseSample[] = [];
  const hostProbe: HostProbeSample[] = [];
  let warmupWorkload: WorkloadSnapshot | null = null;
  let finalWorkload: WorkloadSnapshot | null = null;
  let finalProvenance: typeof provenance | null = null;
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
      finalProvenance,
      initialWorkload,
      warmupWorkload,
      finalWorkload,
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
    warmupWorkload = await verifySteadyWorkload(
      api,
      env,
      workerImageId,
      initialWorkload.sessionIds,
    );
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
    finalProvenance = verifyRcImages(rcPath, env, egressProxyImage);
    finalWorkload = await verifySteadyWorkload(
      api,
      env,
      workerImageId,
      initialWorkload.sessionIds,
    );
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
