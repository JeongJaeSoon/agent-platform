import { claudeRuntimeModule } from "@werft-ai/runtime-claude";
import { scriptedClaudeRuntime } from "@werft-ai/runtime-claude/testing";
import {
  type RuntimeHostDeps,
  type RuntimeKind,
  type RuntimeModule,
  RuntimeRegistry,
  UnsupportedRuntime,
} from "@werft-ai/runtime-core";
import type {
  ScriptedRuntime,
  ScriptedRuntimeOptions,
  ScriptedStep,
} from "@werft-ai/runtime-core/testing";

import { installedRuntimes } from "../index.ts";

type ScriptedFactory = (
  steps: ScriptedStep[],
  options: ScriptedRuntimeOptions,
  deps: Partial<RuntimeHostDeps>,
) => ScriptedRuntime;

const installed = new RuntimeRegistry(installedRuntimes);
const scripted = new Map<RuntimeKind, ScriptedFactory>([
  [claudeRuntimeModule.descriptor.kind, scriptedClaudeRuntime],
]);

/** The installed module of `kind`, engine and all, for tests that drive the real one. */
export function realRuntimeFor(kind: RuntimeKind): RuntimeModule {
  return installed.require(kind);
}

/** A scripted engine of `kind` behind the runtime contract; `emit` steps carry that engine's messages. */
export function fakeRuntimeFor(
  kind: RuntimeKind,
  steps: ScriptedStep[],
  options: ScriptedRuntimeOptions = {},
  deps: Partial<RuntimeHostDeps> = {},
): ScriptedRuntime {
  const factory = scripted.get(kind);
  if (factory === undefined) {
    throw new UnsupportedRuntime(`No scripted engine is installed for ${kind}`);
  }
  return factory(steps, options, deps);
}
