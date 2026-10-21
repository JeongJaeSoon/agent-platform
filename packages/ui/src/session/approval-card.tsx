import type { PendingRequest } from "@agent-platform/contracts";
import {
  type FormEvent,
  type JSX,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";

import { cn } from "../lib/cn.ts";
import { Button } from "../primitives/button.tsx";
import { Field, FieldError, FieldLabel } from "../primitives/field.tsx";
import { Textarea } from "../primitives/textarea.tsx";
import {
  formatTimestamp,
  type TimestampLocale,
} from "../receipt/format-timestamp.ts";

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
  /** Why the last answer was refused. */
  readonly error?: string | undefined;
  /** Epoch ms the expiry is compared against; the screen's clock. */
  readonly now?: number | undefined;
  readonly locale?: TimestampLocale | undefined;
  readonly className?: string | undefined;
}

const TIMER_MAX = 2 ** 31 - 1;

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
  error,
  now = Date.now(),
  locale = "ko",
  className,
}: ApprovalCardProps): JSX.Element {
  const titleId = useId();
  const [denying, setDenying] = useState(false);
  const [reason, setReason] = useState("");
  const reasonRef = useRef<HTMLTextAreaElement>(null);
  const denyRef = useRef<HTMLButtonElement>(null);
  // Set when a cancel should hand focus back to the button that opened it.
  const returnFocus = useRef(false);
  const expiresAt = Date.parse(request.expires_at);
  // A card left open past its expiry must stop taking answers without
  // waiting for the screen to render again.
  const [lapsedId, setLapsedId] = useState<string | null>(null);
  const requestId = request.request_id;
  const expired = lapsedId === requestId || expiresAt <= now;

  useEffect(() => {
    if (expired) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // `now` may be the screen's clock; the wait runs on this one.
    const deadline = Date.now() + (expiresAt - now);
    // setTimeout fires at once past 2^31-1 ms, so a far expiry waits in
    // steps, each measured again in case the machine slept.
    const wait = () => {
      const remaining = deadline - Date.now();
      if (remaining <= 0) setLapsedId(requestId);
      else timer = setTimeout(wait, Math.min(remaining, TIMER_MAX));
    };
    wait();
    return () => clearTimeout(timer);
  }, [expired, expiresAt, now, requestId]);

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
        "flex min-w-0 flex-col gap-3 rounded-lg border bg-card p-4 text-sm",
        className,
      )}
    >
      <div className="flex flex-col gap-1">
        {/* Not a heading: the level depends on the screen around the card. */}
        <p id={titleId} className="font-medium [overflow-wrap:anywhere]">
          {messages.title(request.tool)}
        </p>
        <p className="text-muted-foreground text-xs">
          {expired
            ? messages.expired
            : messages.expires(formatTimestamp(request.expires_at, locale))}
        </p>
      </div>
      <details>
        <summary className="cursor-pointer text-muted-foreground text-xs">
          {messages.input}
        </summary>
        <pre className="mt-2 max-h-60 overflow-auto rounded-md bg-muted p-2 text-xs">
          {inputText(request.input)}
        </pre>
      </details>
      <FieldError>{error}</FieldError>
      {expired ? null : denying ? (
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
              disabled={pending || !reason.trim()}
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
      ) : (
        <div className="flex flex-wrap gap-2">
          <Button type="button" disabled={pending} onClick={onAllow}>
            {messages.allow}
          </Button>
          <Button
            ref={denyRef}
            type="button"
            variant="outline"
            disabled={pending}
            onClick={() => setDenying(true)}
          >
            {messages.deny}
          </Button>
        </div>
      )}
    </article>
  );
}
