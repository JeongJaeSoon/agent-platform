import {
  Button,
  cn,
  Field,
  FieldError,
  FieldLabel,
  formatTimestamp,
  Textarea,
} from "@werft-ai/ui";
import { Hourglass } from "lucide-react";
import {
  type FormEvent,
  type JSX,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";

import type {
  ApprovalCardMessages,
  ApprovalCardProps,
} from "./approval-card.tsx";
import { useExpired, useExpiryFocus } from "./expiry.ts";

export interface ApprovalRowMessages extends ApprovalCardMessages {
  /**
   * The allow button's accessible name: what it approves, such as the tool
   * and the session's short id. Starts with `allow`, the visible word.
   */
  readonly allowName: (tool: string) => string;
  readonly denyName: (tool: string) => string;
}

export interface ApprovalRowProps extends Omit<ApprovalCardProps, "messages"> {
  readonly messages: ApprovalRowMessages;
}

function inputText(input: unknown): string {
  try {
    return JSON.stringify(input, null, 2) ?? String(input);
  } catch {
    return String(input);
  }
}

/**
 * One permission request on one line: what asks, for which session and until
 * when, with allow and deny at the line's end. The tool input and the denial
 * form open below the line. Answers the same way as `ApprovalCard`.
 */
export function ApprovalRow({
  request,
  messages,
  onAllow,
  onDeny,
  pending = false,
  disabled = false,
  error,
  now = Date.now(),
  locale = "ko",
  subject,
  className,
}: ApprovalRowProps): JSX.Element {
  const titleId = useId();
  const inputId = useId();
  const [inputOpen, setInputOpen] = useState(false);
  const [denying, setDenying] = useState(false);
  const [reason, setReason] = useState("");
  const reasonRef = useRef<HTMLTextAreaElement>(null);
  const denyRef = useRef<HTMLButtonElement>(null);
  // Set when a cancel should hand focus back to the button that opened it.
  const returnFocus = useRef(false);
  const expired = useExpired(request.request_id, request.expires_at, now);
  const { noticeRef, within } = useExpiryFocus(expired);
  const blocked = pending || disabled;

  useEffect(() => {
    if (denying) reasonRef.current?.focus();
    else if (returnFocus.current) {
      returnFocus.current = false;
      denyRef.current?.focus();
    }
  }, [denying]);

  const submitDenial = (event: FormEvent) => {
    event.preventDefault();
    const trimmed = reason.trim();
    if (trimmed) onDeny(trimmed);
  };

  return (
    <article
      aria-labelledby={titleId}
      aria-busy={pending || undefined}
      data-slot="approval-row"
      data-expired={expired || undefined}
      className={cn(
        "flex min-h-[var(--ap-row-min-height)] min-w-0 flex-col gap-3 rounded-card border border-[var(--ap-tone-attention-border)] bg-[var(--ap-tone-attention-bg)] px-[var(--ap-row-padding-x)] py-[var(--ap-row-padding-y)] text-control",
        className,
      )}
      {...within}
    >
      <div className="flex flex-wrap items-start justify-end gap-x-4 gap-y-2">
        {/* At least the buttons' height, centred, so the two read as one
            line; wrapped lines keep their own height. */}
        <div className="flex min-h-[var(--ap-control-height)] min-w-0 flex-1 basis-60 flex-wrap content-center items-center gap-x-4 gap-y-1">
          <div className="flex min-w-0 flex-wrap items-center gap-x-2">
            <Hourglass
              className="size-4 shrink-0"
              strokeWidth={1.5}
              aria-hidden="true"
            />
            {/* Not a heading: the level depends on the screen around the row. */}
            <p
              id={titleId}
              className="font-semibold text-body [overflow-wrap:anywhere]"
            >
              {messages.title(request.tool)}
            </p>
            {/* Each separator wraps with the item after it, never left trailing. */}
            {subject === undefined ? null : (
              <span className="flex min-w-0 items-center gap-2">
                <span aria-hidden="true" className="text-muted-foreground">
                  ·
                </span>
                <span className="min-w-0 text-caption [overflow-wrap:anywhere]">
                  {subject}
                </span>
              </span>
            )}
            <span className="flex items-center gap-2">
              <span aria-hidden="true" className="text-muted-foreground">
                ·
              </span>
              <p
                ref={noticeRef}
                tabIndex={expired ? -1 : undefined}
                className="text-muted-foreground text-caption"
              >
                {expired
                  ? messages.expired
                  : messages.expires(
                      formatTimestamp(request.expires_at, locale),
                    )}
              </p>
            </span>
          </div>
          {/* The input opens below the whole line, so the summary stays put. */}
          <details
            className="min-w-0"
            onToggle={(event) => setInputOpen(event.currentTarget.open)}
          >
            <summary
              // Only while open: a closed input is not in the DOM to name.
              aria-controls={inputOpen ? inputId : undefined}
              className="cursor-pointer text-muted-foreground text-caption"
            >
              {messages.input}
            </summary>
          </details>
        </div>
        {expired || denying ? null : (
          <div className="flex shrink-0 gap-2">
            <Button
              type="button"
              disabled={blocked}
              aria-label={messages.allowName(request.tool)}
              onClick={onAllow}
            >
              {messages.allow}
            </Button>
            <Button
              ref={denyRef}
              type="button"
              variant="outline"
              disabled={blocked}
              aria-label={messages.denyName(request.tool)}
              onClick={() => setDenying(true)}
            >
              {messages.deny}
            </Button>
          </div>
        )}
      </div>
      {inputOpen ? (
        <pre
          id={inputId}
          className="m-0 max-h-60 overflow-auto rounded-control bg-card p-2 font-mono text-caption"
        >
          {inputText(request.input)}
        </pre>
      ) : null}
      <FieldError>{error}</FieldError>
      {expired || !denying ? null : (
        <form className="flex flex-col gap-3" onSubmit={submitDenial}>
          <Field>
            <FieldLabel>{messages.denyReason}</FieldLabel>
            <Textarea
              ref={reasonRef}
              value={reason}
              required
              onChange={(event) => setReason(event.target.value)}
            />
          </Field>
          <div className="flex flex-wrap justify-end gap-2">
            <Button
              type="submit"
              variant="destructive"
              disabled={blocked || !reason.trim()}
            >
              {messages.denySubmit}
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={pending}
              onClick={() => {
                returnFocus.current = true;
                setDenying(false);
              }}
            >
              {messages.cancel}
            </Button>
          </div>
        </form>
      )}
    </article>
  );
}
