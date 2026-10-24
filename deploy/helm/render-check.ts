// Renders the chart with helm and fails on any manifest that breaks the
// chart's promises: every container hardened, sized and pinned by digest,
// probes on every long-running one, a token only where the scheduler needs
// one, the scheduler Role exactly the kubernetes backend's verbs, worker
// traffic held to the egress proxy (no DNS), and the Ingress routing only
// the api's public paths on an ALB that is not internet-facing. Run from the
// repository root:
// `bun deploy/helm/render-check.ts` (CI's helm-chart job).

import { spawnSync } from "node:child_process";
import { join } from "node:path";

const dir = import.meta.dir;
const chart = join(dir, "agent-platform");
const ciDigests = join(dir, "ci-digests.yaml");
const awsExample = join(chart, "values-aws.example.yaml");

type Manifest = {
  kind: string;
  metadata: { name: string; labels?: Record<string, string> };
  // biome-ignore lint/suspicious/noExplicitAny: rendered Kubernetes objects
  spec?: any;
  // biome-ignore lint/suspicious/noExplicitAny: rendered Kubernetes objects
  rules?: any[];
};

function helmTemplate(args: string[]): { ok: boolean; out: string } {
  const result = spawnSync("helm", ["template", "ap", chart, ...args], {
    encoding: "utf8",
  });
  if (result.error) throw result.error;
  return { ok: result.status === 0, out: result.stdout + result.stderr };
}

function render(args: string[]): Manifest[] {
  const { ok, out } = helmTemplate(args);
  if (!ok) throw new Error(`helm template ${args.join(" ")} failed:\n${out}`);
  return (Bun.YAML.parse(out) as (Manifest | null)[]).filter(
    (doc): doc is Manifest => doc !== null,
  );
}

// biome-ignore lint/suspicious/noExplicitAny: rendered Kubernetes objects
function podSpecOf(m: Manifest): any {
  switch (m.kind) {
    case "Deployment":
    case "Job":
      return m.spec.template.spec;
    case "CronJob":
      return m.spec.jobTemplate.spec.template.spec;
    default:
      return undefined;
  }
}

const DIGEST_REF = /^[^@\s]+@sha256:[0-9a-f]{64}$/;
const SCHEDULER_RULES = {
  pods: ["create", "delete", "get", "list"],
  secrets: ["create", "delete", "get", "list"],
  persistentvolumeclaims: ["create", "delete", "get", "list"],
};
const WORKER_LABELS = {
  "app.kubernetes.io/part-of": "agent-platform",
  "app.kubernetes.io/component": "worker",
};

function check(
  label: string,
  manifests: Manifest[],
  scheduler: boolean,
): string[] {
  const errors: string[] = [];
  const fail = (m: Manifest, message: string) =>
    errors.push(`${label}: ${m.kind}/${m.metadata.name}: ${message}`);

  let workloads = 0;
  for (const m of manifests) {
    const pod = podSpecOf(m);
    if (pod === undefined) continue;
    workloads++;
    const component = m.metadata.labels?.["app.kubernetes.io/component"];
    if (pod.securityContext?.seccompProfile?.type !== "RuntimeDefault") {
      fail(m, "pod seccompProfile is not RuntimeDefault");
    }
    if (pod.securityContext?.runAsNonRoot !== true) {
      fail(m, "pod runAsNonRoot is not true");
    }
    const wantsToken = component === "scheduler";
    if (pod.automountServiceAccountToken !== wantsToken) {
      fail(m, `automountServiceAccountToken is not ${wantsToken}`);
    }
    for (const c of [...(pod.initContainers ?? []), ...pod.containers]) {
      const where = `container ${c.name}`;
      const sc = c.securityContext ?? {};
      if (sc.runAsNonRoot !== true) fail(m, `${where}: runAsNonRoot`);
      if (sc.allowPrivilegeEscalation !== false) {
        fail(m, `${where}: allowPrivilegeEscalation`);
      }
      if (sc.readOnlyRootFilesystem !== true) {
        fail(m, `${where}: readOnlyRootFilesystem`);
      }
      if (!sc.capabilities?.drop?.includes("ALL")) {
        fail(m, `${where}: capabilities.drop ALL`);
      }
      if (sc.seccompProfile?.type !== "RuntimeDefault") {
        fail(m, `${where}: seccompProfile RuntimeDefault`);
      }
      if (!c.resources?.requests?.memory || !c.resources?.limits?.memory) {
        fail(m, `${where}: memory request and limit`);
      }
      if (!DIGEST_REF.test(c.image)) {
        fail(m, `${where}: image ${c.image} is not repository@sha256:digest`);
      }
      // Long-running workloads only: a Job's pod has nothing to probe.
      if (m.kind === "Deployment" && !(c.readinessProbe && c.livenessProbe)) {
        fail(m, `${where}: readiness and liveness probes`);
      }
    }
  }
  if (workloads < 5) {
    errors.push(`${label}: only ${workloads} workloads rendered`);
  }

  const roles = manifests.filter((m) => m.kind === "Role");
  if (roles.length !== (scheduler ? 1 : 0)) {
    errors.push(
      `${label}: expected ${scheduler ? 1 : 0} Role, got ${roles.length}`,
    );
  }
  for (const role of roles) {
    const got: Record<string, string[]> = {};
    for (const rule of role.rules ?? []) {
      if (JSON.stringify(rule.apiGroups) !== '[""]') {
        fail(role, `rule outside the core API group: ${JSON.stringify(rule)}`);
      }
      for (const resource of rule.resources) {
        got[resource] = [...(got[resource] ?? []), ...rule.verbs].sort();
      }
    }
    if (JSON.stringify(got) !== JSON.stringify(SCHEDULER_RULES)) {
      fail(role, `rules ${JSON.stringify(got)} are not the contract's`);
    }
  }
  const schedulers = manifests.filter(
    (m) =>
      m.kind === "Deployment" &&
      m.metadata.labels?.["app.kubernetes.io/component"] === "scheduler",
  );
  if (schedulers.length !== (scheduler ? 1 : 0)) {
    errors.push(`${label}: expected ${scheduler ? 1 : 0} scheduler Deployment`);
  }
  for (const m of schedulers) {
    const variables: { name: string; value?: string }[] =
      podSpecOf(m).containers[0].env ?? [];
    const backend = variables.find((v) => v.name === "EXECUTION_BACKEND");
    if (backend?.value !== "kubernetes") {
      fail(m, "EXECUTION_BACKEND is not kubernetes");
    }
  }
  if (manifests.some((m) => m.kind.startsWith("Cluster"))) {
    errors.push(`${label}: a cluster-scoped RBAC object rendered`);
  }

  const workerPolicy = manifests.find(
    (m) =>
      m.kind === "NetworkPolicy" &&
      m.spec.podSelector?.matchLabels?.["app.kubernetes.io/component"] ===
        "worker",
  );
  if (workerPolicy === undefined) {
    errors.push(`${label}: no worker NetworkPolicy`);
  } else {
    const spec = workerPolicy.spec;
    const selector = spec.podSelector.matchLabels;
    for (const [key, value] of Object.entries(WORKER_LABELS)) {
      if (selector[key] !== value) fail(workerPolicy, `selector ${key}`);
    }
    if (!selector["agent-platform.installation"]) {
      fail(workerPolicy, "selector has no installation label");
    }
    if (
      JSON.stringify([...spec.policyTypes].sort()) !== '["Egress","Ingress"]' ||
      (spec.ingress ?? []).length !== 0
    ) {
      fail(workerPolicy, "must deny all ingress and restrict egress");
    }
    const targets = (spec.egress ?? []).map(
      // biome-ignore lint/suspicious/noExplicitAny: rendered NetworkPolicy
      (rule: any) => ({
        component:
          rule.to?.[0]?.podSelector?.matchLabels?.[
            "app.kubernetes.io/component"
          ] ?? rule.to?.[0]?.podSelector?.matchLabels?.["k8s-app"],
        hasNamespace: rule.to?.[0]?.namespaceSelector !== undefined,
        // biome-ignore lint/suspicious/noExplicitAny: rendered NetworkPolicy
        ports: (rule.ports ?? []).map((p: any) => `${p.protocol}/${p.port}`),
        peers: rule.to?.length ?? 0,
      }),
    );
    const expected = [
      {
        component: "egress-proxy",
        hasNamespace: false,
        ports: ["TCP/3128", "TCP/3129"],
        peers: 1,
      },
    ];
    // biome-ignore lint/suspicious/noExplicitAny: rendered NetworkPolicy
    const dns = (spec.egress ?? []).some((rule: any) =>
      // No port is every port.
      ((rule.ports ?? [{}]) as { port?: number }[]).some(
        (p) => p.port === undefined || p.port === 53,
      ),
    );
    if (dns) {
      fail(workerPolicy, "egress reaches DNS: a query is a way out");
    }
    if (JSON.stringify(targets) !== JSON.stringify(expected)) {
      fail(workerPolicy, `egress ${JSON.stringify(targets)}`);
    }
  }

  const apiPolicy = manifests.find(
    (m) =>
      m.kind === "NetworkPolicy" &&
      m.spec.podSelector?.matchLabels?.["app.kubernetes.io/component"] ===
        "api",
  );
  const authorizerRule = apiPolicy?.spec.ingress?.find(
    // biome-ignore lint/suspicious/noExplicitAny: rendered NetworkPolicy
    (rule: any) => rule.ports?.some((p: any) => p.port === 3100),
  );
  if (
    authorizerRule?.from?.length !== 1 ||
    authorizerRule.from[0].podSelector?.matchLabels?.[
      "app.kubernetes.io/component"
    ] !== "egress-proxy"
  ) {
    errors.push(`${label}: api 3100 must admit the egress proxy alone`);
  }
  for (const service of manifests.filter((m) => m.kind === "Service")) {
    if (
      service.spec.ports.some(
        // biome-ignore lint/suspicious/noExplicitAny: rendered Service
        (p: any) => p.port === 3100,
      ) &&
      service.spec.type !== "ClusterIP"
    ) {
      fail(service, "the authorizer must stay ClusterIP");
    }
  }
  return errors;
}

const OBJECT_STORE_KEYS = ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"];
const IRSA_ROLE = "eks.amazonaws.com/role-arn";

/**
 * Static S3 keys reach the api and the checkpoint GC exactly when `keys`, and
 * no other workload ever. Without them the api's ServiceAccount must carry
 * an IRSA role, or nothing could sign the object store.
 */
function checkObjectStoreKeys(
  label: string,
  manifests: Manifest[],
  keys: boolean,
): string[] {
  const errors: string[] = [];
  const holders = ["api", "checkpoint-gc"];
  for (const m of manifests) {
    const pod = podSpecOf(m);
    if (pod === undefined) continue;
    const component = m.metadata.labels?.["app.kubernetes.io/component"] ?? "";
    for (const c of [...(pod.initContainers ?? []), ...pod.containers]) {
      const names = new Set((c.env ?? []).map((v: { name: string }) => v.name));
      const got = OBJECT_STORE_KEYS.filter((name) => names.has(name));
      const want = keys && holders.includes(component) ? OBJECT_STORE_KEYS : [];
      if (JSON.stringify(got) !== JSON.stringify(want)) {
        errors.push(
          `${label}: ${m.kind}/${m.metadata.name}: container ${c.name} has AWS keys ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`,
        );
      }
    }
  }
  const apiAccount = manifests.find(
    (m) =>
      m.kind === "ServiceAccount" &&
      m.metadata.labels?.["app.kubernetes.io/component"] === "api",
  ) as
    | (Manifest & { metadata: { annotations?: Record<string, string> } })
    | undefined;
  if (!keys && !apiAccount?.metadata.annotations?.[IRSA_ROLE]) {
    errors.push(
      `${label}: no static keys and no IRSA role on the api ServiceAccount`,
    );
  }
  return errors;
}

const SECRET_KEY = "PLATFORM_SECRET_KEY";

function checkSecretKey(label: string, manifests: Manifest[]): string[] {
  const errors: string[] = [];
  let holders = 0;
  for (const m of manifests) {
    const pod = podSpecOf(m);
    if (pod === undefined) continue;
    const component = m.metadata.labels?.["app.kubernetes.io/component"] ?? "";
    for (const c of [...(pod.initContainers ?? []), ...pod.containers]) {
      // biome-ignore lint/suspicious/noExplicitAny: rendered Kubernetes objects
      const entry = (c.env ?? []).find((v: any) => v.name === SECRET_KEY);
      if (entry === undefined) continue;
      const where = `${label}: ${m.kind}/${m.metadata.name}: container ${c.name}`;
      if (component !== "api" || c.name !== "api") {
        errors.push(`${where} has ${SECRET_KEY}`);
        continue;
      }
      holders++;
      if (entry.valueFrom?.secretKeyRef?.optional !== true) {
        errors.push(`${where}: ${SECRET_KEY} is not an optional secretKeyRef`);
      }
    }
  }
  if (holders !== 1) {
    errors.push(`${label}: ${SECRET_KEY} is on ${holders} api containers`);
  }
  return errors;
}

// The api's public mounts (apps/control-host/src/api/app.ts). /internal is
// the workers' gateway and must never be reachable from the load balancer.
const PUBLIC_PATHS = [
  "Prefix /v1",
  "Prefix /v1/slack/events",
  "Prefix /docs",
  "Exact /healthz",
  "Exact /readyz",
];

function checkIngress(
  label: string,
  manifests: Manifest[],
  enabled: boolean,
): string[] {
  const errors: string[] = [];
  const ingresses = manifests.filter((m) => m.kind === "Ingress");
  if (ingresses.length !== (enabled ? 1 : 0)) {
    errors.push(
      `${label}: expected ${enabled ? 1 : 0} Ingress, got ${ingresses.length}`,
    );
  }
  for (const ingress of ingresses) {
    const fail = (message: string) =>
      errors.push(`${label}: Ingress/${ingress.metadata.name}: ${message}`);
    const scheme = (
      ingress.metadata as { annotations?: Record<string, string> }
    ).annotations?.["alb.ingress.kubernetes.io/scheme"];
    if (scheme === "internet-facing") {
      fail("the ALB scheme is internet-facing; the entrance is in-house only");
    }
    if (ingress.spec.defaultBackend !== undefined) {
      fail("a default backend routes every path");
    }
    for (const rule of ingress.spec.rules ?? []) {
      const paths: { path: string; pathType: string }[] =
        rule.http?.paths ?? [];
      for (const { path } of paths) {
        if ("/internal/".startsWith(path) || path.startsWith("/internal")) {
          fail(`${path} routes /internal`);
        }
      }
      const got = paths.map((p) => `${p.pathType} ${p.path}`);
      if (JSON.stringify(got) !== JSON.stringify(PUBLIC_PATHS)) {
        fail(
          `paths ${JSON.stringify(got)} are not ${JSON.stringify(PUBLIC_PATHS)}`,
        );
      }
    }
  }
  return errors;
}

// Renders that must fail, each with the message that says why.
const MUST_FAIL: [string, string[], RegExp][] = [
  ["default values (no digests)", [], /digest must be sha256/],
  [
    "a tag-only image",
    [
      "-f",
      ciDigests,
      "--set",
      "images.controlHost.repository=example/control-host:1.0",
    ],
    /must not carry a tag or digest/,
  ],
  [
    "a malformed digest",
    ["-f", ciDigests, "--set", "images.egressProxy.digest=sha256:abc"],
    /digest must be sha256/,
  ],
  [
    "an installation id that is no label value",
    ["-f", ciDigests, "--set", "installationId=not/a/label"],
    /installationId must be a Kubernetes label value/,
  ],
];

const errors = [
  ...check("default", render(["-f", ciDigests]), true),
  ...check(
    "scheduler off",
    render(["-f", ciDigests, "--set", "scheduler.enabled=false"]),
    false,
  ),
  ...check("aws example", render(["-f", ciDigests, "-f", awsExample]), true),
  ...check(
    "aws example, scheduler off",
    render([
      "-f",
      ciDigests,
      "-f",
      awsExample,
      "--set",
      "scheduler.enabled=false",
    ]),
    false,
  ),
];
errors.push(
  ...checkObjectStoreKeys("default", render(["-f", ciDigests]), true),
  ...checkObjectStoreKeys(
    "aws example",
    render(["-f", ciDigests, "-f", awsExample]),
    false,
  ),
  ...checkSecretKey("default", render(["-f", ciDigests])),
  ...checkSecretKey("aws example", render(["-f", ciDigests, "-f", awsExample])),
  ...checkIngress("default", render(["-f", ciDigests]), false),
  ...checkIngress(
    "aws example",
    render(["-f", ciDigests, "-f", awsExample]),
    true,
  ),
);
const exposed = checkIngress(
  "aws example, internet-facing",
  render([
    "-f",
    ciDigests,
    "-f",
    awsExample,
    "--set-string",
    "ingress.annotations.alb\\.ingress\\.kubernetes\\.io/scheme=internet-facing",
  ]),
  true,
);
if (!exposed.some((error) => error.includes("internet-facing;"))) {
  errors.push("an internet-facing ALB scheme was not refused");
}
for (const [label, args, message] of MUST_FAIL) {
  const { ok, out } = helmTemplate(args);
  if (ok || !message.test(out)) {
    errors.push(`${label}: expected the render to fail with ${message}`);
  }
}

if (errors.length > 0) {
  console.error(errors.join("\n"));
  process.exit(1);
}
console.log(
  `render-check: default and aws example renders pass, scheduler off and on; ${MUST_FAIL.length} bad inputs and an internet-facing ALB refused`,
);
