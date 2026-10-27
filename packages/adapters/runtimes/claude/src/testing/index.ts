// Scripted Claude engines for tests outside this package. Production code
// takes runs through `claudeRuntimeModule` alone.
export type { NativeSdkMessage } from "../driver.ts";
export {
  FakeAgentRuntime,
  type FakeRuntimeOptions,
  type FakeStep,
  scriptedClaudeRuntime,
} from "./fake-adapter.ts";
