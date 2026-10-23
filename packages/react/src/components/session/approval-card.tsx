import type { PendingRequest } from "@werft-ai/contracts";
import {
  Button,
  cn,
  Field,
  FieldError,
  FieldLabel,
  formatTimestamp,
  Textarea,
  type TimestampLocale,
} from "@werft-ai/ui";
import { Check, Hourglass, X } from "lucide-react";
import {
  type FormEvent,
  type JSX,
  type ReactNode,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";

import { useExpired, useExpiryFocus } from "./expiry.ts";

export type PermissionRequest = Extract<PendingRequest, { kind: "permission" }>;

export interface ApprovalCardMessages {
  readonly title: (tool: string) => string;
  /** Names the view of the tool input. */
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
      {/* Console v4 `.ask`: the tool input in full, the answers below it. */}
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <Hourglass
          className="size-4 shrink-0 text-[var(--ap-tone-attention-fg)]"
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
      <p className="sr-only">{messages.input}</p>
      {/* Browsers that scroll it also let the keyboard reach it; -1 lets a
          screen hand focus here while the buttons are off. */}
      <pre
        data-slot="approval-input"
        tabIndex={-1}
        className="m-0 max-h-60 overflow-auto whitespace-pre-wrap rounded-control border bg-card px-3 py-2 font-mono text-caption leading-[1.6] [overflow-wrap:anywhere]"
      >
        {inputText(request.input)}
      </pre>
      {expired || denying ? null : (
        <div className="flex flex-wrap gap-2 [&>button]:flex-[1_1_0]">
          <Button type="button" disabled={blocked} onClick={onAllow}>
            <Check strokeWidth={1.5} aria-hidden="true" />
            {messages.allow}
          </Button>
          <Button
            ref={denyRef}
            type="button"
            variant="outline"
            // Console v4 `.btn.danger`: an outline in the danger tone.
            className="border-[var(--ap-tone-danger-border)] text-destructive hover:bg-[var(--ap-tone-danger-bg)] hover:text-destructive"
            disabled={blocked}
            onClick={() => setDenying(true)}
          >
            <X strokeWidth={1.5} aria-hidden="true" />
            {messages.deny}
          </Button>
        </div>
      )}
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
