import {
  claudeContractRun,
  FakeAgentRuntime,
  type FakeStep,
} from "@werft-ai/runtime-claude";

import { engineProfile } from "../composition.ts";
import type { RuntimeRegistry } from "../worker-host.ts";

export type { FakeStep as ScriptedStep };

/**
 * How the golden tests plug a scripted engine into the host. Kept out of the
 * golden files so the runtime contract can change underneath them while
 * their scenarios and expected bytes stay as they are.
 */
export function scriptedRuntimes(steps: FakeStep[]): {
  engine: FakeAgentRuntime;
  runtimes: RuntimeRegistry;
} {
  const engine = new FakeAgentRuntime(steps);
  const runtimes: RuntimeRegistry = {
    launcherFor: () => ({
      start: ({ runtimeConfig, principal, ...launch }) =>
        claudeContractRun((hooks) =>
          engine.start(
            {
              claudeConfigDir: "/tmp/fake/config",
              cwd: "/tmp/fake/workspace",
              home: "/tmp/fake/home",
              model: runtimeConfig.model,
              profile: engineProfile(
                runtimeConfig.provider,
                principal.owner_scope,
                "http://egress-proxy.test:3129",
              ),
              tools: runtimeConfig.tools,
              ...launch,
            },
            hooks,
          ),
        ),
    }),
  };
  return { engine, runtimes };
}
