import type { PendingRequest } from "@werft-ai/contracts";
import { Hourglass } from "lucide-react";
import {
  type FormEvent,
  type JSX,
  type ReactNode,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";

import { cn } from "../foundations/cn.ts";
import {
  formatTimestamp,
  type TimestampLocale,
} from "../foundations/format-timestamp.ts";
import { Button } from "../primitives/button.tsx";
import { Field, FieldError, FieldLabel } from "../primitives/field.tsx";
import { Textarea } from "../primitives/textarea.tsx";
import { useExpired, useExpiryFocus } from "./expiry.ts";

export type PermissionRequest = Extract<PendingRequest, { kind: "permission" }>;

export interface ApprovalCardMessages {
  readonly title: (tool: string) => string;
  /** Names the folded view of the tool input. */
  readonly input: string;
  /** Takes the formatted expiry time. */
  readonly expires: (at: string) => string;
  readonly expired: string;
  readonly allow: string;
  readonly deny: string;
  readonly denyReason: string;
  readonly denySubmit: string;
  readonly cancel: string;
}

export interface ApprovalCardProps {
  readonly request: PermissionRequest;
  readonly messages: ApprovalCardMessages;
  readonly onAllow: () => void;
  /** A denial always carries the reason the person typed. */
  readonly onDeny: (reason: string) => void;
  /** An answer was sent and its receipt has not come back. */
  readonly pending?: boolean | undefined;
  /** The reader may not answer; the screen says why next to the card. */
  readonly disabled?: boolean | undefined;
  /** Why the last answer was refused. */
  readonly error?: string | undefined;
  /** Epoch ms the expiry is compared against; the screen's clock. */
  readonly now?: number | undefined;
  readonly locale?: TimestampLocale | undefined;
  /** What the request belongs to, such as a link to its session; shown on the title line. */
  readonly subject?: ReactNode;
  readonly className?: string | undefined;
}

function inputText(input: unknown): string {
  try {
    return JSON.stringify(input, null, 2) ?? String(input);
  } catch {
    return String(input);
  }
}

export function ApprovalCard({
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
}: ApprovalCardProps): JSX.Element {
  const titleId = useId();
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
    // An article, not a section: two requests for the same tool would make
    // two landmarks with one name.
    <article
      aria-labelledby={titleId}
      aria-busy={pending || undefined}
      data-slot="approval-card"
      data-expired={expired || undefined}
      className={cn(
        "flex min-w-0 flex-col gap-3 rounded-card border border-[var(--ap-tone-attention-border)] bg-[var(--ap-tone-attention-bg)] p-4 text-control",
        className,
      )}
      {...within}
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <Hourglass
          className="size-4 shrink-0"
          strokeWidth={1.5}
          aria-hidden="true"
        />
        {/* Not a heading: the level depends on the screen around the card. */}
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
              : messages.expires(formatTimestamp(request.expires_at, locale))}
          </p>
        </span>
      </div>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <details className="min-w-0 flex-1 basis-40">
          {/* As tall as the buttons beside it, so the two read as one line. */}
          <summary className="cursor-pointer text-muted-foreground text-caption leading-[var(--ap-control-height)]">
            {messages.input}
          </summary>
          <pre className="mt-2 max-h-60 overflow-auto rounded-control bg-card p-2 font-mono text-caption">
            {inputText(request.input)}
          </pre>
        </details>
        {expired || denying ? null : (
          <div className="flex flex-wrap gap-2">
            <Button type="button" disabled={blocked} onClick={onAllow}>
              {messages.allow}
            </Button>
            <Button
              ref={denyRef}
              type="button"
              variant="outline"
              disabled={blocked}
              onClick={() => setDenying(true)}
            >
              {messages.deny}
            </Button>
          </div>
        )}
      </div>
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
          <div className="flex flex-wrap gap-2">
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
