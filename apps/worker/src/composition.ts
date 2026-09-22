import type { SessionRuntime } from "@agent-platform/contracts";
import {
  CLAUDE_AGENT_SDK_VERSION,
  CLAUDE_CODE_VERSION,
  ClaudeSdkRuntime,
} from "@agent-platform/runtime-claude";

import { unwiredCheckpoints, type WorkerCheckpointPort } from "./checkpoint.ts";
import type { WorkerConfig } from "./config.ts";
import { HttpWorkerGatewayClient } from "./gateway-client.ts";
import {
  type RuntimeLauncher,
  type RuntimeRegistry,
  type WorkerGatewaySession,
  WorkerHost,
  type WorkerLogger,
} from "./worker-host.ts";

export type WorkerComposition = {
  checkpoints?: WorkerCheckpointPort;
  gateway?: WorkerGatewaySession;
  logger?: WorkerLogger;
  runtimes?: RuntimeRegistry;
};

/**
 * The worker's composition root. It builds the gateway transport and the one
 * runtime this image ships; it never opens a database pool or talks to an
 * execution backend, which is what `tests/architecture` holds it to.
 */
export function createWorkerHost(
  config: WorkerConfig,
  overrides: WorkerComposition = {},
): WorkerHost {
  return new WorkerHost({
    checkpoints: overrides.checkpoints ?? unwiredCheckpoints,
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
    runtimes: overrides.runtimes ?? claudeRuntimeRegistry(config),
    timeouts: config.timeouts,
    ...(overrides.logger === undefined ? {} : { logger: overrides.logger }),
  });
}

/**
 * This image runs exactly one engine. A session created for another engine —
 * or for another build of this one — is refused rather than run on whatever
 * happens to be installed, because the transcript a checkpoint resumes is only
 * replayable on the build that wrote it.
 */
export function claudeRuntimeRegistry(config: WorkerConfig): RuntimeRegistry {
  const runtime = new ClaudeSdkRuntime({
    endpoints: [config.runtime.profile.endpoint],
    models: [config.runtime.model],
  });
  const launcher: RuntimeLauncher = {
    start(launch, hooks) {
      const { correlationId, ...plan } = launch;
      return runtime.start(
        {
          claudeConfigDir: config.runtime.claudeConfigDir,
          correlationId,
          cwd: config.runtime.cwd,
          home: config.runtime.home,
          model: config.runtime.model,
          permissionMode: config.runtime.permissionMode,
          profile: config.runtime.profile,
          tools: config.runtime.tools,
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
