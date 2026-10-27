import type { TokenUsage, TurnEnded } from "@werft-ai/runtime-core";

import type { NativeSdkMessage } from "./driver.ts";
import { endedByAbort } from "./run.ts";
import type { ProviderFailure, TurnAccounting } from "./turn-accounting.ts";

/**
 * The inputs a message says it is for. The SDK names an input on
 * `command_lifecycle` from the moment it queues one, and on the first reply
 * and the result of the turn that answers it.
 */
export function namedInputs(message: NativeSdkMessage): string[] {
  return [
    ...(message.type === "command_lifecycle" &&
    typeof message.command_uuid === "string"
      ? [message.command_uuid]
      : []),
    ...consumedInputs(message),
  ];
}

/** The inputs a result says it consumed, the way TurnLedger reads them. */
function consumedInputs(message: NativeSdkMessage): string[] {
  const listed = Array.isArray(message.user_message_uuids)
    ? message.user_message_uuids.filter(
        (value): value is string => typeof value === "string",
      )
    : [];
  const last =
    typeof message.user_message_uuid === "string"
      ? [message.user_message_uuid]
      : [];
  return [...new Set([...listed, ...last])];
}

/**
 * A result in the platform's terms. Settles `accounting`, which has observed
 * every message up to and including this one. The provider failure goes with
 * a result for `latestInput`, or for no input, the way a host settles its
 * turn on one; a result only for other inputs leaves it for the turn's own.
 */
export function turnEndedOf(
  result: NativeSdkMessage,
  accounting: TurnAccounting,
  latestInput: string | undefined,
): TurnEnded {
  const inputs = consumedInputs(result);
  const settlesTurn =
    inputs.length === 0 ||
    (latestInput !== undefined && inputs.includes(latestInput));
  const { costUsd, providerFailure } = settlesTurn
    ? accounting.settle()
    : {
        providerFailure: accounting.lastProviderFailure,
        costUsd: accounting.settleCost(),
      };
  const subtype =
    typeof result.subtype === "string" ? result.subtype : "unknown";
  const isError = result.is_error === true || subtype !== "success";
  const abortedByStop = endedByAbort(result);
  return {
    isError,
    abortedByStop,
    budgetExceeded: subtype === "error_max_budget_usd",
    ...(isError || abortedByStop
      ? {
          failure: {
            reason: failureReason(result, subtype),
            ...(typeof result.api_error_status === "number"
              ? { httpStatus: result.api_error_status }
              : {}),
          },
        }
      : {}),
    engineResult: engineResult(result, providerFailure),
    cost: {
      ...(costUsd === undefined ? {} : { deltaUsd: costUsd }),
      countRestarted: accounting.restarted,
      unknown: costUsd === undefined,
    },
    ...(result.usage === undefined || result.usage === null
      ? {}
      : { usage: result.usage as TokenUsage }),
    ...(typeof result.session_id === "string"
      ? { engineSessionId: result.session_id }
      : {}),
    inputs,
  };
}

/**
 * A request the provider kept refusing ends as `success` with `is_error`, so
 * the subtype says nothing there and the engine's terminal reason
 * (`api_error`, …) is the cause.
 */
function failureReason(result: NativeSdkMessage, subtype: string): string {
  if (subtype !== "success") return subtype;
  return typeof result.terminal_reason === "string" &&
    result.terminal_reason.length > 0
    ? result.terminal_reason
    : "error";
}

function engineResult(
  result: NativeSdkMessage,
  providerFailure: ProviderFailure | undefined,
): Record<string, unknown> {
  return {
    subtype: result.subtype ?? null,
    is_error: result.is_error ?? null,
    stop_reason: result.stop_reason ?? null,
    terminal_reason: result.terminal_reason ?? null,
    ...(result.terminal_reason === "api_error"
      ? {
          api_error_status:
            typeof result.api_error_status === "number"
              ? result.api_error_status
              : null,
          provider_error: providerFailure?.error ?? null,
          last_retry_status: providerFailure?.status ?? null,
        }
      : {}),
  };
}
