// Everything specific to POST /v1/sessions/{id}/close lives here, so a
// change to that contract touches this file only.
import type { components } from "@werft-ai/client";
import type { CloseReceiptResult as ContractCloseResult } from "@werft-ai/contracts";
import { call, type MutationOptions } from "../core/request.ts";
import type {
  Opened,
  Receipt,
  ReceiptAccepted,
  Session,
  SessionAttention,
  SessionId,
} from "../types.ts";
import type { Context } from "./context.ts";

type Schemas = components["schemas"];

/** `{ expected_revision, reason? }`: the revision the caller decided on. */
export type CloseParams = Schemas["CloseSessionRequest"];
/** A close receipt's `result` once it succeeded. */
export type CloseReceiptResult = Opened<ContractCloseResult>;
export type CloseBlockedAttention = Extract<
  SessionAttention,
  { code: "CLOSE_BLOCKED" }
>;

/** Admission while the worker drains for a close; `closed` follows. */
export const SESSION_ADMISSION_CLOSING = "closing" satisfies Extract<
  Schemas["SessionDetail"]["admission_state"],
  "closing"
>;
/** A message or control sent while the session is `closing`. */
export const SESSION_CLOSING = "SESSION_CLOSING" satisfies Extract<
  Schemas["ApiErrorResponse"]["error"]["code"],
  "SESSION_CLOSING"
>;
/** Attention on a close whose drain has run over 60 seconds. Nothing is killed for it. */
export const CLOSE_BLOCKED =
  "CLOSE_BLOCKED" satisfies CloseBlockedAttention["code"];

export function isClosing(session: Pick<Session, "admission_state">): boolean {
  return session.admission_state === SESSION_ADMISSION_CLOSING;
}

export function closeBlocked(
  session: Pick<Session, "attention">,
): CloseBlockedAttention | null {
  const attention = session.attention;
  return attention?.code === CLOSE_BLOCKED
    ? (attention as CloseBlockedAttention)
    : null;
}

/** The typed result of a succeeded close receipt; null for any other receipt. */
export function closeResult(receipt: Receipt): CloseReceiptResult | null {
  if (receipt.operation !== "close" || receipt.status !== "succeeded")
    return null;
  const result = receipt.result as Record<string, unknown> | null;
  if (
    typeof result?.resulting_admission_state !== "string" ||
    typeof result.cancelled_turn_count !== "number" ||
    (result.checkpoint_revision !== null &&
      typeof result.checkpoint_revision !== "number")
  )
    return null;
  return result as unknown as CloseReceiptResult;
}

/**
 * Ends a session whose work is done; the running turn finishes first. A
 * caller closing its own session from inside a turn must not wait on the
 * receipt: the drain waits for that turn to end.
 */
export function closeSession(
  context: Context,
  id: SessionId,
  params: CloseParams,
  options?: MutationOptions,
): Promise<ReceiptAccepted> {
  return call(
    context.policy,
    "keyed",
    ({ signal, headers, idempotencyKey }) =>
      context.api.POST("/v1/sessions/{id}/close", {
        params: { path: { id }, header: { "Idempotency-Key": idempotencyKey } },
        body: params,
        signal,
        headers,
      }),
    options,
  );
}
