import type { SessionRuntime } from "@agent-platform/contracts";
import {
  CLAUDE_AGENT_SDK_VERSION,
  CLAUDE_CODE_VERSION,
  ClaudeSdkRuntime,
} from "@agent-platform/runtime-claude";
import type { CheckpointObjectStore } from "@agent-platform/runtime-core";

import { checkpointsOn, type WorkerCheckpointPort } from "./checkpoint.ts";
import type { WorkerConfig } from "./config.ts";
import { EngineProcesses } from "./engine-processes.ts";
import { HttpWorkerGatewayClient } from "./gateway-client.ts";
import { createWorkerObjectStore } from "./object-store.ts";
import {
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
  const objectStore =
    overrides.objectStore ?? createWorkerObjectStore(config.objectStore);
  return new WorkerHost({
    checkpoints: overrides.checkpoints ?? checkpointsOn(objectStore),
    engines,
    execution: {
      bootstrapNonce: config.bootstrapNonce,
      generation: config.executionGeneration,
      id: config.executionId,
    },
    gateway:
      overrides.gateway ??
      new HttpWorkerGatewayClient({
        baseUrl: config.gatewayUrl,
        credential: config.bootstrapNonce,
        requestTimeoutMs: config.timeouts.requestTimeoutMs,
      }),
    runtimes: overrides.runtimes ?? claudeRuntimeRegistry(config, engines),
    timeouts: config.timeouts,
    workspace: overrides.workspace ?? new GitWorkspace(config.runtime.cwd),
    ...(overrides.logger === undefined ? {} : { logger: overrides.logger }),
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
      const { correlationId, principal, runtimeConfig, ...plan } = launch;
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
          claudeConfigDir: config.runtime.claudeConfigDir,
          correlationId,
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
          // commands no permission callback sees, with the provider key in
          // reach, and the claim's profile is the only policy reviewed. Its
          // CLAUDE.md comes back only when that profile says so, read by the
          // adapter apart from the rest (`projectSettingsSchema`).
          repositoryClaudeMd: runtimeConfig.project_settings.claude_md,
          settingSources: [],
          tools: runtimeConfig.tools,
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
