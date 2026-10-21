import type { ReceiptStatus } from "@agent-platform/contracts";
import type { JSX } from "react";

import { cn } from "../lib/cn.ts";
import {
  formatTimestamp,
  type TimestampLocale,
} from "../receipt/format-timestamp.ts";

export interface MessageProps {
  readonly from: "user" | "assistant";
  /** Shown above the text: who said it. */
  readonly author: string;
  readonly text: string;
  readonly occurredAt?: string | undefined;
  /**
   * A sent message's receipt. `accepted` is not `succeeded`, so the
   * screen's label must say which one it is.
   */
  readonly receipt?:
    | { readonly status: ReceiptStatus; readonly label: string }
    | undefined;
  /** Why the message was refused, under the text. */
  readonly error?: string | undefined;
  readonly locale?: TimestampLocale | undefined;
  readonly className?: string | undefined;
}

export function Message({
  from,
  author,
  text,
  occurredAt,
  receipt,
  error,
  locale = "ko",
  className,
}: MessageProps): JSX.Element | null {
  // A message with nothing in it would be an empty bubble.
  if (!text.trim()) return null;
  const user = from === "user";
  return (
    <article
      data-slot="message"
      data-from={from}
      className={cn(
        "flex w-fit min-w-0 max-w-[85%] flex-col gap-1 rounded-lg border px-3 py-2 text-sm",
        user ? "ml-auto bg-secondary" : "bg-card",
        error && "border-destructive",
        className,
      )}
    >
      <header className="flex flex-wrap items-baseline gap-x-2 text-muted-foreground text-xs">
        <span className="font-medium text-foreground">{author}</span>
        {occurredAt ? (
          <time dateTime={occurredAt}>
            {formatTimestamp(occurredAt, locale)}
          </time>
        ) : null}
      </header>
      <p className="whitespace-pre-wrap [overflow-wrap:anywhere]">{text}</p>
      {receipt || error ? (
        <footer className="flex flex-col gap-1">
          {receipt ? (
            <span
              data-receipt={receipt.status}
              className={cn(
                "text-muted-foreground text-xs",
                receipt.status === "failed" && "text-destructive",
              )}
            >
              {receipt.label}
            </span>
          ) : null}
          {error ? (
            <p className="text-destructive text-xs [overflow-wrap:anywhere]">
              {error}
            </p>
          ) : null}
        </footer>
      ) : null}
    </article>
  );
}
