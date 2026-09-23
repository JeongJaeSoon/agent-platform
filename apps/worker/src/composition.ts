import type {
  BootstrapClaimResponse,
  SessionRuntime,
} from "@agent-platform/contracts";
import {
  CLAUDE_AGENT_SDK_VERSION,
  CLAUDE_CODE_VERSION,
  CLAUDE_RUNTIME_FINGERPRINT,
  type ClaudeRuntimeConfig,
  ClaudeSdkRuntime,
  claudeProfileFingerprint,
} from "@agent-platform/runtime-claude";
import type {
  CheckpointObjectStore,
  RuntimeFingerprint,
} from "@agent-platform/runtime-core";

import type { WorkerCheckpointPort } from "./checkpoint.ts";
import type { WorkerConfig } from "./config.ts";
import { EngineProcesses } from "./engine-processes.ts";
import { HttpWorkerGatewayClient } from "./gateway-client.ts";
import { createWorkerObjectStore } from "./object-store.ts";
import { SessionCheckpoints } from "./session-checkpoints.ts";
import {
  consoleLogger,
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
  const engines = overrides.engines ?? new EngineProcesses();
  const logger = overrides.logger ?? consoleLogger;
  const gateway =
    overrides.gateway ??
    new HttpWorkerGatewayClient({
      baseUrl: config.gatewayUrl,
      credential: config.bootstrapNonce,
      requestTimeoutMs: config.timeouts.requestTimeoutMs,
    });
  const workspace = overrides.workspace ?? new GitWorkspace(config.runtime.cwd);
  return new WorkerHost({
    checkpoints:
      overrides.checkpoints ??
      new SessionCheckpoints({
        fingerprint: claudeClaimFingerprint(config),
        gateway,
        instructionsCommit: () => workspace.instructionsCommit(),
        logger,
        objectPrefix: config.objectStore.scope,
        objects:
          overrides.objectStore ?? createWorkerObjectStore(config.objectStore),
        workspaceRoot: config.runtime.cwd,
      }),
    engines,
    execution: {
      bootstrapNonce: config.bootstrapNonce,
      generation: config.executionGeneration,
      id: config.executionId,
    },
    gateway,
    logger,
    runtimes: overrides.runtimes ?? claudeRuntimeRegistry(config, engines),
    timeouts: config.timeouts,
    workspace,
  });
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
    start(launch, hooks) {
      const {
        committedClaudeMd,
        correlationId,
        maxBudgetUsd,
        // Read by claudeRunConfig; kept out of the resume plan spread below.
        principal: _principal,
        // The host's to report, not the engine's to read.
        restoredRevision: _restoredRevision,
        runtimeConfig,
        ...plan
      } = launch;
      // The claim is the only source of what to run, so the adapter's
      // allowlist is that one endpoint and model. Left out: an allowlist
      // baked into the image to check the server against — worth adding
      // once one image serves tenants that must not share a provider.
      const runtime = new ClaudeSdkRuntime(
        {
          endpoints: [runtimeConfig.provider.endpoint],
          models: [runtimeConfig.model],
        },
        engines,
      );
      return runtime.start(
        {
          ...claudeRunConfig(config, launch, committedClaudeMd),
          correlationId,
          // Not part of the fingerprint: how often a provider call is retried
          // changes nothing a checkpoint resumes.
          providerMaxRetries: config.runtime.providerMaxRetries,
          // Nor is this: it is what the session had left at the claim, so
          // it differs on every resume of the same run.
          maxBudgetUsd,
          ...plan,
        },
        hooks,
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

type ClaudeRunConfig = Pick<
  Extract<ClaudeRuntimeConfig, { mode: "new" }>,
  | "claudeConfigDir"
  | "cwd"
  | "home"
  | "model"
  | "permissionMode"
  | "profile"
  | "repositoryClaudeMd"
  | "settingSources"
  | "tools"
>;

/**
 * What a claim runs, short of how it resumes: shared by the launcher and by
 * the fingerprint a checkpoint is stamped with, so the two cannot describe
 * different runs.
 */
function claudeRunConfig(
  config: WorkerConfig,
  launch: Pick<RuntimeLaunch, "principal" | "runtimeConfig">,
  committedClaudeMd: () => string | null,
): ClaudeRunConfig {
  const { principal, runtimeConfig } = launch;
  return {
    claudeConfigDir: config.runtime.claudeConfigDir,
    cwd: config.runtime.cwd,
    home: config.runtime.home,
    model: runtimeConfig.model,
    permissionMode: runtimeConfig.permission_mode,
    // The catalog provider is shared across partitions; the claim's
    // principal is what makes this session's checkpoints its own.
    profile: {
      ...runtimeConfig.provider,
      principal: { ownerScope: principal.owner_scope },
    },
    // None of the repository's own Claude settings: its hooks would run
    // commands no permission callback sees, with the provider key in reach,
    // and the claim's profile is the only policy reviewed. Its CLAUDE.md
    // comes back only when that profile says so, as committed on the branch
    // rather than as the checkout now reads (`projectSettingsSchema`).
    ...(runtimeConfig.project_settings?.claude_md === true
      ? { repositoryClaudeMd: { contents: committedClaudeMd() } }
      : {}),
    settingSources: [],
    tools: runtimeConfig.tools,
  };
}

/**
 * The fingerprint a checkpoint of this claim's run is stamped with, and the
 * one a restore plan is asked for (94S-261). The committed CLAUDE.md is not
 * read: the digest records only that the profile lets it in.
 */
export function claudeClaimFingerprint(
  config: WorkerConfig,
): (claim: BootstrapClaimResponse) => RuntimeFingerprint {
  return (claim) => ({
    ...CLAUDE_RUNTIME_FINGERPRINT,
    profileSha256: claudeProfileFingerprint(
      claudeRunConfig(
        config,
        { principal: claim.principal, runtimeConfig: claim.runtime_config },
        () => null,
      ),
    ),
  });
}
