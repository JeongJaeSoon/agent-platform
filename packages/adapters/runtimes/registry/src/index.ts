import { claudeRuntimeModule } from "@werft-ai/runtime-claude";
import type { RuntimeModule } from "@werft-ai/runtime-core";

/** The runtimes this image ships; the worker serves only these kinds. */
export const installedRuntimes: readonly RuntimeModule[] = [
  claudeRuntimeModule,
];
