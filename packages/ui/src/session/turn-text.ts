import type { TurnEventMessage, TurnEventPart } from "@werft-ai/contracts";

/*
 * presentTurnEvent says what an event is as message keys; the screen owns the
 * wording, so every session pattern takes this function instead of copy.
 */
export type FormatTurnMessage = (message: TurnEventMessage) => string;

/** A presentation's summary as the one line a reader sees. */
export function turnSummaryText(
  summary: readonly TurnEventPart[],
  formatMessage: FormatTurnMessage,
): string {
  return summary
    .map((part) => ("text" in part ? part.text : formatMessage(part)))
    .join(" · ");
}
