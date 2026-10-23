import type {
  BootstrapClaimResponse,
  RuntimeConfig,
  SessionRuntime,
} from "@werft-ai/contracts";
import {
  CLAUDE_AGENT_SDK_VERSION,
  CLAUDE_CODE_VERSION,
  CLAUDE_RUNTIME_FINGERPRINT,
  ClaudeAgentRuntime,
  type ClaudeDeployment,
  type ClaudeOptions,
  type ClaudeRuntimeConfig,
  claudeProfileFingerprint,
  claudeRuntimeConfig,
  type RuntimeProfile,
} from "@werft-ai/runtime-claude";
import {
  type CheckpointObjectStore,
  type InstructionPart,
  type PlatformMcpServer,
  type RuntimeFingerprint,
  type RuntimeStart,
  runtimeRequirementsOf,
} from "@werft-ai/runtime-core";

import type { WorkerCheckpointPort } from "./checkpoint.ts";
import type { WorkerConfig } from "./config.ts";
import { consoleLogger } from "./console-logger.ts";
import { EngineProcesses } from "./engine-processes.ts";
import { HttpWorkerGatewayClient } from "./gateway-client.ts";
import { createWorkerObjectStore, ObjectStoreToken } from "./object-store.ts";
import { scrubbingLogger } from "./secret-scrubber.ts";
import { SessionCheckpoints } from "./session-checkpoints.ts";
import {
  type RuntimeLaunch,
  type RuntimeLauncher,
  type RuntimeRegistry,
  type WorkerGatewaySession,
  WorkerHost,
  type WorkerLogger,
} from "./worker-host.ts";
import { GitWorkspace, type WorkspacePreparer } from "./workspace.ts";

export type WorkerComposition = {
  checkpoints?: WorkerCheckpointPort;
  engines?: EngineProcesses;
  gateway?: WorkerGatewaySession;
  logger?: WorkerLogger;
  objectStore?: CheckpointObjectStore;
  runtimes?: RuntimeRegistry;
  workspace?: WorkspacePreparer;
};

/**
 * The worker's composition root. It builds the gateway transport, the
 * session-scoped object store and the one runtime this image ships; it never
 * opens a database pool or talks to an execution backend, which is what
 * `tests/architecture` holds it to.
 */
export function createWorkerHost(
  config: WorkerConfig,
  overrides: WorkerComposition = {},
): WorkerHost {
  const engines =
    overrides.engines ?? new EngineProcesses("/proc", config.runtime.cwd);
  const logger = overrides.logger ?? consoleLogger;
  const gateway =
    overrides.gateway ??
    new HttpWorkerGatewayClient({
      baseUrl: config.gatewayUrl,
      credential: config.bootstrapNonce,
      requestTimeoutMs: config.timeouts.requestTimeoutMs,
    });
  const workspace =
    overrides.workspace ??
    new GitWorkspace(config.runtime.cwd, config.egressCredentialUrl);
  const objectToken = new ObjectStoreToken();
  // Built before the host that learns the claim's secrets, so it asks the
  // host for them at each line.
  let host: WorkerHost | undefined;
  const checkpointLogger = scrubbingLogger(logger, () => host?.secrets);
  host = new WorkerHost({
    checkpoints:
      overrides.checkpoints ??
      new SessionCheckpoints({
        fingerprint: claudeClaimFingerprint(config),
        gateway,
        instructionsCommit: () => workspace.instructionsCommit(),
        logger: checkpointLogger,
        objectPrefix: config.objectStore.scope,
        objects:
          overrides.objectStore ??
          createWorkerObjectStore(config.objectStore, () =>
            objectToken.current(),
          ),
        workspaceRoot: config.runtime.cwd,
        claudeConfigDir: config.runtime.claudeConfigDir,
      }),
    engines,
    execution: {
      bootstrapNonce: config.bootstrapNonce,
      generation: config.executionGeneration,
      id: config.executionId,
    },
    gateway,
    logger,
    objectStoreAccess: objectToken,
    runtimes: overrides.runtimes ?? claudeRuntimeRegistry(config, engines),
    timeouts: config.timeouts,
    workspace,
  });
  return host;
}

/**
 * This image runs exactly one engine. A session created for another engine —
 * or for another build of this one — is refused rather than run on whatever
 * happens to be installed, because the transcript a checkpoint resumes is only
 * replayable on the build that wrote it.
 */
export function claudeRuntimeRegistry(
  config: WorkerConfig,
  engines: EngineProcesses,
): RuntimeRegistry {
  const launcher: RuntimeLauncher = {
    start(launch) {
      // The claim is the only source of what to run, so the adapter's
      // allowlist is that one endpoint and model. Left out: an allowlist
      // baked into the image to check the server against — worth adding
      // once one image serves tenants that must not share a provider.
      const runtime = new ClaudeAgentRuntime(
        {
          endpoints: [launch.runtimeConfig.provider.endpoint],
          models: [launch.runtimeConfig.model],
        },
        {
          ...claudeDeployment(config),
          // Not part of the fingerprint: how often a provider call is retried
          // changes nothing a checkpoint resumes.
          ...(config.runtime.providerMaxRetries === undefined
            ? {}
            : { providerMaxRetries: config.runtime.providerMaxRetries }),
          ...(launch.sessionStore === undefined
            ? {}
            : { sessionStore: launch.sessionStore }),
          ...(launch.mode === "resume" && launch.localTranscriptResume === true
            ? { localTranscriptResume: true as const }
            : {}),
        },
        engines,
      );
      return runtime.start(
        claimRuntimeStart(config, launch, launch.committedClaudeMd),
      );
    },
  };
  return {
    launcherFor(session: SessionRuntime): RuntimeLauncher {
      if (session.kind !== "claude_agent_sdk") {
        throw new Error(
          `This worker runs claude_agent_sdk, not ${session.kind}`,
        );
      }
      if (
        session.version !== CLAUDE_AGENT_SDK_VERSION &&
        session.version !== CLAUDE_CODE_VERSION
      ) {
        throw new Error(
          `Session needs runtime version ${session.version}; this worker ships Agent SDK ${CLAUDE_AGENT_SDK_VERSION} (Claude Code ${CLAUDE_CODE_VERSION})`,
        );
      }
      return launcher;
    },
  };
}

/**
 * What the engine of a session without a repository is told, since it has
 * nowhere to push: `out/` is where the platform looks for what to hand over.
 * It is part of the fingerprint, so rewording it stops those sessions'
 * checkpoints from resuming.
 */
export const OUT_DIRECTORY_PROMPT =
  "This workspace has no repository. Put files meant for people in `out/` at the workspace root.";

type ClaudeRunConfig = Pick<
  Extract<ClaudeRuntimeConfig, { mode: "new" }>,
  | "appendSystemPrompt"
  | "claudeConfigDir"
  | "cwd"
  | "home"
  | "identities"
  | "mcpServers"
  | "model"
  | "permissionMode"
  | "profile"
  | "repositoryClaudeMd"
  | "settingSources"
  | "tools"
>;

const RUN_CONFIG_KEYS = [
  "appendSystemPrompt",
  "claudeConfigDir",
  "cwd",
  "home",
  "identities",
  "mcpServers",
  "model",
  "permissionMode",
  "profile",
  "repositoryClaudeMd",
  "settingSources",
  "tools",
] as const satisfies ReadonlyArray<keyof ClaudeRunConfig>;

/** What every claim on this image runs with, whatever the session. */
function claudeDeployment(
  config: Pick<WorkerConfig, "runtime">,
): ClaudeDeployment {
  // None of the repository's own Claude settings: its hooks would run
  // commands no permission callback sees, with the egress token in reach,
  // and the claim's profile is the only policy reviewed.
  return {
    claudeConfigDir: config.runtime.claudeConfigDir,
    settingSources: [],
  };
}

/**
 * What a claim runs, short of how it resumes: the same conversion the
 * launcher starts the engine with, so the fingerprint a checkpoint is
 * stamped with cannot describe a different run.
 */
export function claudeRunConfig(
  config: Pick<WorkerConfig, "egressCredentialUrl" | "runtime">,
  launch: Pick<RuntimeLaunch, "principal" | "runtimeConfig" | "workspace">,
  committedClaudeMd: () => string | null,
): ClaudeRunConfig {
  const full = claudeRuntimeConfig(
    claimRuntimeStart(
      config,
      { ...launch, correlationId: "", mode: "new" },
      committedClaudeMd,
    ),
    claudeDeployment(config),
  ) as Record<string, unknown>;
  return Object.fromEntries(
    RUN_CONFIG_KEYS.filter((key) => full[key] !== undefined).map((key) => [
      key,
      full[key],
    ]),
  ) as ClaudeRunConfig;
}

/** The claim as the runtime contract's start. */
export function claimRuntimeStart(
  config: Pick<WorkerConfig, "egressCredentialUrl" | "runtime">,
  launch: Pick<
    RuntimeLaunch,
    | "correlationId"
    | "maxBudgetUsd"
    | "principal"
    | "runtimeConfig"
    | "workspace"
  > &
    ({ mode: "new" } | { mode: "resume"; resume: string }),
  committedClaudeMd: () => string | null,
): RuntimeStart<ClaudeOptions> {
  const { principal, runtimeConfig } = launch;
  const profile = engineProfile(
    runtimeConfig.provider,
    principal.owner_scope,
    config.egressCredentialUrl,
  );
  const instructions: InstructionPart[] = [
    // Only then: a repository session's digest stays the one its
    // checkpoints were taken under.
    ...(launch.workspace?.repository === null
      ? [{ scope: "platform" as const, text: OUT_DIRECTORY_PROMPT }]
      : []),
    // Its CLAUDE.md comes back only when the profile says so, as committed
    // on the branch rather than as the checkout now reads
    // (`projectSettingsSchema`).
    ...(runtimeConfig.project_settings?.claude_md === true
      ? [{ scope: "repository" as const, text: committedClaudeMd() }]
      : []),
  ];
  return {
    bindings: {
      // The catalog provider is shared across partitions; the claim's
      // principal is what makes this session's checkpoints its own.
      principal: profile.principal,
      provider: {
        auth: profile.auth,
        endpoint: profile.endpoint,
        kind: profile.kind,
      },
    },
    bundle: {
      instructions,
      mcpServers: mcpServersOf(runtimeConfig, config.egressCredentialUrl),
      skills: [],
      tools: runtimeConfig.tools,
    },
    config: {
      correlationId: launch.correlationId,
      cwd: config.runtime.cwd,
      home: config.runtime.home,
      // Nor is this: it is what the session had left at the claim, so it
      // differs on every resume of the same run.
      ...(launch.maxBudgetUsd === undefined
        ? {}
        : { maxBudgetUsd: launch.maxBudgetUsd }),
      model: runtimeConfig.model,
      permissionMode: runtimeConfig.permission_mode,
      ...(launch.mode === "resume"
        ? { mode: "resume" as const, resume: launch.resume }
        : { mode: "new" as const }),
    },
    env: { vars: [] },
    options: {},
    requirements: runtimeRequirementsOf(runtimeConfig),
  };
}

function mcpServersOf(
  runtimeConfig: RuntimeConfig,
  egressCredentialUrl: string,
): PlatformMcpServer[] {
  return (runtimeConfig.mcp_servers ?? []).map((server) => ({
    binding: server.binding,
    name: server.name,
    relay: {
      token: server.access.token,
      url: `${egressCredentialUrl}/mcp/${server.name}`,
    },
    required: true,
    tools: runtimeConfig.tools,
  }));
}

/**
 * The fingerprint a checkpoint of this claim's run is stamped with, and the
 * one a restore plan is asked for. The committed CLAUDE.md is not
 * read: the digest records only that the profile lets it in. A claim given
 * without its workspace is taken for a session with a repository, which is
 * all `image-runtime.ts` is fed.
 */
export function claudeClaimFingerprint(
  config: Pick<WorkerConfig, "egressCredentialUrl" | "runtime">,
): (
  claim: Pick<BootstrapClaimResponse, "principal" | "runtime_config"> & {
    workspace?: BootstrapClaimResponse["workspace"] | undefined;
  },
) => RuntimeFingerprint {
  return (claim) => ({
    ...CLAUDE_RUNTIME_FINGERPRINT,
    profileSha256: claudeProfileFingerprint(
      claudeRunConfig(
        config,
        {
          principal: claim.principal,
          runtimeConfig: claim.runtime_config,
          ...(claim.workspace === undefined
            ? {}
            : { workspace: claim.workspace }),
        },
        () => null,
      ),
    ),
  });
}

/**
 * The claim's provider as the engine sees it: the upstream endpoint stays
 * (policy approves it and the checkpoint fingerprint names it), but the
 * calls go to the egress proxy's provider route with the attempt's token,
 * and the proxy adds the credential.
 */
export function engineProfile(
  provider: RuntimeConfig["provider"],
  ownerScope: string,
  egressCredentialUrl: string,
): RuntimeProfile {
  const auth = {
    kind: "egress_token" as const,
    token: provider.auth.token,
    transport: `${egressCredentialUrl}/provider`,
  };
  // The catalog provider is shared across partitions; the claim's
  // principal is what makes this session's checkpoints its own.
  const principal = { ownerScope };
  return provider.kind === "anthropic"
    ? { kind: "anthropic", endpoint: provider.endpoint, auth, principal }
    : { kind: "litellm", endpoint: provider.endpoint, auth, principal };
}
