import type {
  ScriptedRuntime,
  ScriptedStep,
} from "@werft-ai/runtime-core/testing";

import type { RuntimeRegistry } from "../worker-host.ts";
import { scriptedRuntime, startScripted } from "./scripted-engine.ts";

export type { ScriptedStep };

/**
 * How the golden tests plug a scripted engine into the host. Kept out of the
 * golden files so the runtime contract can change underneath them while
 * their scenarios and expected bytes stay as they are.
 */
export function scriptedRuntimes(steps: ScriptedStep[]): {
  engine: ScriptedRuntime;
  runtimes: RuntimeRegistry;
} {
  const engine = scriptedRuntime(steps);
  const runtimes: RuntimeRegistry = {
    launcherFor: () => ({
      start: (launch) => startScripted(engine, launch),
    }),
  };
  return { engine, runtimes };
}
