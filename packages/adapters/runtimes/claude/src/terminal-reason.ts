import type { NativeSdkMessage } from "@agent-platform/runtime-core";
import type { TerminalReason } from "@anthropic-ai/claude-agent-sdk";

/**
 * How the SDK ends a turn cut short mid-response or with a tool (or its
 * permission prompt) outstanding. `interrupt()` ends a turn this way, but so
 * does any other abort, so a reason from this set proves an interrupt only to
 * a host that knows it sent one.
 */
export const ABORTED_TERMINAL_REASONS: ReadonlySet<TerminalReason> = new Set([
  "aborted_streaming",
  "aborted_tools",
]);

export function endedByAbort(message: NativeSdkMessage): boolean {
  return (
    message.type === "result" &&
    ABORTED_TERMINAL_REASONS.has(message.terminal_reason as TerminalReason)
  );
}
