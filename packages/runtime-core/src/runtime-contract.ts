import { createHash } from "node:crypto";
import {
  type RuntimeConfig as ClaimRuntimeConfig,
  canonicalJson,
  type PermissionMode,
  type RuntimeKind,
  type SessionEvent,
} from "@werft-ai/contracts";

import type { RuntimeMode } from "./agent-runtime.ts";

export const RUNTIME_CONTRACT_VERSION = "runtime-contract/v1" as const;
export const RUNTIME_EVENT_SCHEMA = "runtime-event/v1" as const;

export type Support = "native" | "emulated" | "none";

export type FeatureKey =
  | "approval_park"
  | "classifier_review"
  | "mcp"
  | "session_resume"
  | "skills"
  | "subagents"
  | "user_hooks";

/** A key that is absent reads as `none`. */
export type FeatureSupportMap = Partial<Record<FeatureKey, Support>>;

/**
 * The rows of the capability table that a FeatureKey or a gate reads today.
 * The full table (instructions, toolGate, approval style, usage, sandbox)
 * stays in the design until a policy row reads it.
 */
export type RuntimeCapabilityTable = {
  checkpoint: boolean;
  interrupt: boolean;
  mcp: Support;
  permissionModes: Partial<Record<PermissionMode, Support>>;
  resume: boolean;
  skills: Support;
};

/** Plain data: the control plane reads it without importing an engine SDK. */
export type RuntimeDescriptor = {
  capabilities: RuntimeCapabilityTable;
  contractVersion: typeof RUNTIME_CONTRACT_VERSION;
  /** Only the keys the table cannot express. */
  extraFeatures: FeatureSupportMap;
  kind: RuntimeKind;
  /** The `runtime_options.<namespace>` this kind's adapter alone reads. */
  optionsNamespace: string;
  process: "in_process" | "subprocess";
  runtimeVersion: string;
  /** Whether a tool sees the engine's own env or only what is given to it. */
  toolEnv: "engine_inherited" | "tool_only";
};

export type RuntimeRequirements = { features: readonly FeatureKey[] };

/**
 * The features a session's settings cannot do without, read the same way by
 * the control plane before the session exists and by the worker after
 * `ready()`. A profile or release `requires_features` would add here.
 */
export function runtimeRequirementsOf(
  runtimeConfig: Pick<ClaimRuntimeConfig, "mcp_servers" | "permission_mode">,
): RuntimeRequirements {
  const features: FeatureKey[] = [];
  if ((runtimeConfig.mcp_servers ?? []).length > 0) features.push("mcp");
  if (runtimeConfig.permission_mode === "auto") {
    features.push("classifier_review");
  }
  return { features };
}

export function featureSupport(
  table: RuntimeCapabilityTable,
  extra: FeatureSupportMap,
  key: FeatureKey,
): Support {
  switch (key) {
    case "skills":
      return table.skills;
    case "mcp":
      return table.mcp;
    case "session_resume":
      return table.resume && table.checkpoint ? "native" : "none";
    case "approval_park":
      return table.interrupt && table.checkpoint && table.resume
        ? "native"
        : "none";
    case "classifier_review":
      // A classifier is not something another mechanism stands in for.
      return table.permissionModes.auto === "native" ? "native" : "none";
    default:
      return extra[key] ?? "none";
  }
}

/** The required features the offer does not support, in request order. */
export function unmetFeatures(
  table: RuntimeCapabilityTable,
  extra: FeatureSupportMap,
  requirements: RuntimeRequirements,
): FeatureKey[] {
  return requirements.features.filter(
    (key) => featureSupport(table, extra, key) === "none",
  );
}

export type RuntimeWarning = { code: string; message: string };

/** What `ready()` saw: the descriptor narrowed, never widened. */
export type NegotiatedCapabilities = {
  effective: RuntimeCapabilityTable;
  effectiveExtraFeatures: FeatureSupportMap;
  mcpConnected: ReadonlyArray<{ name: string; ok: boolean }>;
  skillsLoaded: ReadonlyArray<{ name: string; ok: boolean }>;
  warnings: readonly RuntimeWarning[];
};

export function negotiatedFromDescriptor(
  descriptor: RuntimeDescriptor,
): NegotiatedCapabilities {
  return {
    effective: descriptor.capabilities,
    effectiveExtraFeatures: descriptor.extraFeatures,
    mcpConnected: [],
    skillsLoaded: [],
    warnings: [],
  };
}

export type RuntimeStartConfig = RuntimeMode & {
  correlationId: string;
  cwd: string;
  home: string;
  maxBudgetUsd?: number;
  maxTurns?: number;
  model: string;
  permissionMode: PermissionMode;
};

export type ProviderAuth =
  | { kind: "api_key"; value: string }
  | { kind: "bearer"; value: string }
  | { kind: "egress_token"; token: string; transport: string };

export type RuntimeBindings = {
  principal: { ownerScope: string };
  provider: {
    auth: ProviderAuth;
    endpoint: string;
    kind: "anthropic" | "litellm";
  };
};

/**
 * One instruction in the order the engine reads it. `text: null` is a part
 * the profile switched on that has nothing to say (a repository without a
 * CLAUDE.md): the switch, not the text, is what a checkpoint is bound to.
 */
export type InstructionPart = {
  scope: "agent" | "workspace" | "repository" | "platform";
  source?: string;
  text: string | null;
  versionId?: string;
};

export type SkillRef = {
  digest: string;
  name: string;
  required: boolean;
  root: string;
};

/**
 * A remote MCP server the worker reaches through the egress proxy. The token
 * stays in the worker process; an adapter that runs the engine in-process
 * relays to it, one that cannot must not declare `mcp`.
 */
export type PlatformMcpServer = {
  binding: string;
  name: string;
  relay: { token: string; url: string };
  required: boolean;
  tools: readonly string[];
};

export type ToolRule = { decision: "ask" | "deny"; tool: string };

/** Rules only narrow: the allowlist in `tools` is the ceiling. */
export type PermissionPolicy = { rules: readonly ToolRule[] };

export type RuntimeBundle = {
  instructions: readonly InstructionPart[];
  mcpServers: readonly PlatformMcpServer[];
  permissionPolicy?: PermissionPolicy;
  skills: readonly SkillRef[];
  tools: readonly string[];
};

/** Values handed to the engine itself; never provider or MCP credentials. */
export type RuntimeEnv = {
  vars: ReadonlyArray<{ name: string; value: string }>;
};

export type RuntimeStart<TOptions = unknown> = {
  bindings: RuntimeBindings;
  bundle: RuntimeBundle;
  config: RuntimeStartConfig;
  env: RuntimeEnv;
  /** `runtime_options[descriptor.optionsNamespace]`, already parsed. */
  options: TOptions;
  requirements: RuntimeRequirements;
};

export type ToolDecision = "allow" | "ask" | "deny";

/**
 * The platform's verdict on one tool call. `allow` means only that the
 * platform has no objection: the engine's permission mode still applies.
 */
export function evaluateToolPolicy(
  bundle: Pick<RuntimeBundle, "permissionPolicy" | "tools">,
  tool: string,
): ToolDecision {
  if (!bundle.tools.includes(tool)) return "deny";
  const rules = bundle.permissionPolicy?.rules ?? [];
  if (rules.some((rule) => rule.tool === tool && rule.decision === "deny")) {
    return "deny";
  }
  if (rules.some((rule) => rule.tool === tool && rule.decision === "ask")) {
    return "ask";
  }
  return "allow";
}

/**
 * Over the arguments the engine will act on, before any redaction. The
 * adapter stamps it on the request and the worker checks it, so an answer
 * can only ever land on the call it was given for.
 */
export function approvalInputHash(
  tool: string,
  input: Record<string, unknown>,
): string {
  return createHash("sha256")
    .update(canonicalJson({ tool, input }))
    .digest("hex");
}

export type ApprovalOptionKind = "allow_once" | "reject_once";

export type ApprovalRequested = {
  type: "approval.requested";
  /** Unique within the attempt; the worker's request id is its own. */
  localId: string;
  inputHash: string;
  kind: "permission" | "question";
  toolCallId: string;
  /** Unredacted: the worker hashes and redacts it, and never publishes it. */
  tool: { input: Record<string, unknown>; name: string };
  nativeRef: { id: string; method: string };
};

type AnswerBase = {
  decidedBy: "policy" | "user";
  inputHash: string;
  localId: string;
};

export type ApprovalAnswer =
  | (AnswerBase & {
      message?: string;
      optionKind: ApprovalOptionKind;
      outcome: "selected";
    })
  | (AnswerBase & {
      /** Keyed by question prompt, the way the question tool reads them. */
      answers: Readonly<Record<string, string>>;
      outcome: "answered";
    })
  | (AnswerBase & { message?: string; outcome: "cancelled" });

/** `stale`: already answered, closed, or given for other arguments. */
export type AnswerResult = "applied" | "stale" | "unknown";

export type ApprovalResolved = {
  type: "approval.resolved";
  decidedBy: "policy" | "runtime" | "user";
  localId: string;
  outcome: "answered" | "cancelled" | "selected";
};

export type TurnEnded = {
  type: "turn.ended";
  /** The run was stopped (interrupt or abort) while this turn was in flight. */
  abortedByStop: boolean;
  /** The engine's running total for its session, when it reports one. */
  costTotalUsd?: number;
  /** The engine's terminal as it reported it, for the turn's stored result. */
  detail: {
    apiErrorStatus: unknown;
    isError: unknown;
    stopReason: unknown;
    subtype: unknown;
    terminalReason: unknown;
  };
  engineSessionId?: string;
  /** The input uuids this terminal settles. */
  inputs: readonly string[];
  usage: unknown;
};

export type RuntimeEventBody =
  /** The public v1 events this step projects to, published as they are. */
  | { type: "v1.projected"; events: SessionEvent[] }
  | { type: "message"; role: "assistant"; error?: string }
  | {
      type: "runtime.warning";
      code: "api_retry" | "mirror_error";
      /** The engine's own words or error class, when it gave any. */
      message?: string;
      status?: number | null;
    }
  | ApprovalRequested
  | ApprovalResolved
  | TurnEnded;

export type RuntimeEvent = RuntimeEventBody & {
  correlationId: string;
  id: string;
  parentToolCallId?: string;
  schema: typeof RUNTIME_EVENT_SCHEMA;
  sequence: number;
};
