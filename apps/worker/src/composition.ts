import type {
  BootstrapClaimResponse,
  RuntimeConfig,
  SessionRuntime,
} from "@werft-ai/contracts";
import {
  type CheckpointObjectStore,
  RuntimeRegistry as InstalledRuntimes,
  type PlatformMcpServer,
  type RuntimeBindings,
  type RuntimeFingerprint,
  type RuntimeModule,
  type RuntimeProfileInput,
  type RuntimeStart,
} from "@werft-ai/runtime-core";
import { installedRuntimes } from "@werft-ai/runtime-registry";

import type { WorkerCheckpointPort } from "./checkpoint.ts";
import type { WorkerConfig, WorkerTimeouts } from "./config.ts";
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
  const runtime = imageRuntime();
  const instructionsFile = runtime.descriptor.instructionFiles[0] ?? null;
  const workspace =
    overrides.workspace ??
    new GitWorkspace(
      config.runtime.cwd,
      instructionsFile,
      config.egressCredentialUrl,
    );
  const objectToken = new ObjectStoreToken();
  // Built before the host that learns the claim's secrets, so it asks the
  // host for them at each line.
  let host: WorkerHost | undefined;
  const checkpointLogger = scrubbingLogger(logger, () => host?.secrets);
  host = new WorkerHost({
    checkpoints:
      overrides.checkpoints ??
      new SessionCheckpoints({
        fingerprint: claimFingerprint(config),
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
        instructionsFile,
        runtime,
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
    runtimes: overrides.runtimes ?? workerRuntimeRegistry(config, engines),
    timeouts: config.timeouts,
    workspace,
  });
  return host;
}

/**
 * The one runtime this image installs. Checkpoints, the workspace's
 * instruction file and the image fingerprint all speak for a single engine,
 * so an image built with none or several is refused at start.
 */
export function imageRuntime(): RuntimeModule {
  const [runtime, ...others] = installedRuntimes;
  if (runtime === undefined || others.length > 0) {
    throw new Error(
      `This image must install exactly one runtime, not ${installedRuntimes.length}`,
    );
  }
  return runtime;
}

/**
 * This image runs exactly one engine. A session created for another engine —
 * or for another build of this one — is refused rather than run on whatever
 * happens to be installed, because the transcript a checkpoint resumes is only
 * replayable on the build that wrote it.
 */
export function workerRuntimeRegistry(
  config: Pick<WorkerConfig, "egressCredentialUrl" | "runtime"> & {
    timeouts?: Pick<WorkerTimeouts, "toolUseFrameWaitMs">;
  },
  engines: EngineProcesses,
): RuntimeRegistry {
  const installed = new InstalledRuntimes([imageRuntime()]);
  return {
    launcherFor(session: SessionRuntime): RuntimeLauncher {
      const module = installed.require(session.kind);
      module.assertCompatible(session);
      const runtime = module.createRuntime({
        processObserver: engines,
        stateDir: config.runtime.claudeConfigDir,
        providerMaxRetries: config.runtime.providerMaxRetries,
        ...(config.timeouts?.toolUseFrameWaitMs === undefined
          ? {}
          : { toolCallWaitMs: config.timeouts.toolUseFrameWaitMs }),
      });
      return {
        start: (launch) => runtime.start(runtimeStart(config, module, launch)),
      };
    },
  };
}

export function runtimeStart(
  config: Pick<WorkerConfig, "egressCredentialUrl" | "runtime">,
  module: Pick<RuntimeModule, "descriptor">,
  launch: RuntimeLaunch,
): RuntimeStart {
  const profile = runtimeProfile(
    config,
    module,
    launch,
    launch.committedInstructions,
  );
  const { correlationId, maxBudgetUsd } = launch;
  const mode =
    launch.mode === "new"
      ? { mode: "new" as const }
      : {
          mode: "resume" as const,
          resume: launch.resume,
          ...(launch.localTranscriptResume === true
            ? { localTranscriptResume: true as const }
            : {}),
        };
  return {
    config: {
      ...profile.config,
      ...mode,
      correlationId,
      ...(maxBudgetUsd === undefined ? {} : { maxBudgetUsd }),
    },
    bindings: {
      ...profile.bindings,
      ...(launch.sessionStore === undefined
        ? {}
        : { transcript: launch.sessionStore }),
    },
    bundle: profile.bundle,
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

/**
 * What a claim runs, short of how it resumes: shared by the launcher and by
 * the fingerprint a checkpoint is stamped with, so the two cannot describe
 * different runs.
 */
export function runtimeProfile(
  config: Pick<WorkerConfig, "egressCredentialUrl" | "runtime">,
  module: Pick<RuntimeModule, "descriptor">,
  launch: Pick<RuntimeLaunch, "principal" | "runtimeConfig" | "workspace">,
  committedInstructions: () => string | null,
): RuntimeProfileInput {
  const { principal, runtimeConfig } = launch;
  const { principal: owner, ...provider } = engineProfile(
    runtimeConfig.provider,
    principal.owner_scope,
    config.egressCredentialUrl,
  );
  const instructionsFile = module.descriptor.instructionFiles[0];
  return {
    config: {
      cwd: config.runtime.cwd,
      home: config.runtime.home,
      model: runtimeConfig.model,
      permissionMode: runtimeConfig.permission_mode,
      tools: runtimeConfig.tools,
    },
    bindings: { principal: owner, provider },
    bundle: {
      instructions:
        launch.workspace?.repository === null
          ? [{ scope: "platform", text: OUT_DIRECTORY_PROMPT }]
          : [],
      repoInstructions:
        runtimeConfig.project_settings?.claude_md === true &&
        instructionsFile !== undefined
          ? { file: instructionsFile, text: committedInstructions() }
          : null,
      mcpServers: mcpServersOf(runtimeConfig, config.egressCredentialUrl),
    },
  };
}

function mcpServersOf(
  runtimeConfig: RuntimeConfig,
  egressCredentialUrl: string,
): PlatformMcpServer[] {
  return (runtimeConfig.mcp_servers ?? []).map((s) => ({
    name: s.name,
    binding: s.binding,
    url: `${egressCredentialUrl}/mcp/${s.name}`,
    token: s.access.token,
    tools: runtimeConfig.tools,
  }));
}

/**
 * The fingerprint a checkpoint of this claim's run is stamped with, and the
 * one a restore plan is asked for. The committed instruction file is not
 * read: the digest records only that the profile lets it in. A claim given
 * without its workspace is taken for a session with a repository, which is
 * all `image-runtime.ts` is fed.
 */
export function claimFingerprint(
  config: Pick<WorkerConfig, "egressCredentialUrl" | "runtime">,
): (
  claim: Pick<BootstrapClaimResponse, "principal" | "runtime_config"> & {
    workspace?: BootstrapClaimResponse["workspace"] | undefined;
  },
) => RuntimeFingerprint {
  const runtime = imageRuntime();
  return (claim) =>
    runtime.fingerprint(
      runtimeProfile(
        config,
        runtime,
        {
          principal: claim.principal,
          runtimeConfig: claim.runtime_config,
          ...(claim.workspace === undefined
            ? {}
            : { workspace: claim.workspace }),
        },
        () => null,
      ),
    );
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
): RuntimeBindings["provider"] & Pick<RuntimeBindings, "principal"> {
  const auth = {
    kind: "egress_token" as const,
    token: provider.auth.token,
    transport: `${egressCredentialUrl}/provider`,
  };
  // The catalog provider is shared across partitions; the claim's
  // principal is what makes this session's checkpoints its own.
  const principal = { ownerScope };
  return { kind: provider.kind, endpoint: provider.endpoint, auth, principal };
}
