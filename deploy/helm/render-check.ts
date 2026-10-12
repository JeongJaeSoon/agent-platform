// Renders the chart with helm and fails on any manifest that breaks the
// chart's promises: every container hardened, sized and pinned by digest,
// probes on every long-running one, a token only where the scheduler needs
// one, the scheduler Role exactly the kubernetes backend's verbs, and worker
// traffic held to the egress proxy and DNS. Run from the repository root:
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

function check(label: string, manifests: Manifest[]): string[] {
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
  if (roles.length !== 1) {
    errors.push(`${label}: expected exactly one Role, got ${roles.length}`);
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
      {
        component: "kube-dns",
        hasNamespace: true,
        ports: ["UDP/53", "TCP/53"],
        peers: 1,
      },
    ];
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

// Renders that must fail, each with the message that says why.
const MUST_FAIL: [string, string[], RegExp][] = [
  ["default values (no digests)", [], /digest must be sha256/],
  [
    "a tag-only image",
    ["-f", ciDigests, "--set", "images.worker.repository=example/worker:1.0"],
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
  ...check("default", render(["-f", ciDigests])),
  ...check("aws example", render(["-f", ciDigests, "-f", awsExample])),
];
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
  `render-check: default and aws example renders pass; ${MUST_FAIL.length} bad inputs refused`,
);
