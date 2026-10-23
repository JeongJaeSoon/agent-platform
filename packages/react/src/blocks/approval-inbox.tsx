import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { PendingRequest, SessionSummary } from "@werft-ai/contracts";
import { waitingSessionsQuery } from "@werft-ai/core";
import { Badge, cn } from "@werft-ai/ui";
import { type ReactNode, useId, useLayoutEffect, useRef } from "react";
import { useAgentPlatform } from "../provider.tsx";
import { usePendingRequests } from "../sessions.ts";
import {
  type ApprovalLayout,
  focusLost,
  PendingAnswers,
  type SessionActionProps,
} from "./session-actions.tsx";
import { useBlockText } from "./text.ts";

export interface ApprovalInboxProps extends SessionActionProps {
  /** Shown until the waiting sessions arrive. */
  readonly loading: ReactNode;
  /** The host's words for a read that failed, with the way to ask again. */
  readonly renderError: (error: unknown, retry: () => void) => ReactNode;
  /**
   * "row" draws each permission request as one line instead of a card;
   * "summary" draws each request as a line under its session's name, in one
   * framed list.
   */
  readonly layout?: ApprovalLayout | undefined;
  /** The heading's words, in place of the block's own. */
  readonly title?: ReactNode;
  /** Drawn at the heading's end, such as a link to every waiting session. */
  readonly action?: ReactNode;
  /** Shown when nothing waits, in place of the block's one line. */
  readonly empty?: ReactNode;
  /** The time the summary layout's waits are counted to. */
  readonly now?: number | undefined;
}

/**
 * The reader's sessions waiting on an answer, each request answerable here.
 * It reads the same first page as the shell's badge, so the two counts agree.
 */
export function ApprovalInbox({
  loading,
  renderError,
  unavailable,
  refusal,
  layout,
  title,
  action,
  empty,
  now,
}: ApprovalInboxProps) {
  const { t } = useBlockText();
  const { client } = useAgentPlatform();
  const titleId = useId();
  const waiting = useQuery(waitingSessionsQuery(client));
  const titleRef = useRef<HTMLHeadingElement>(null);
  const shown = useRef<readonly string[]>([]);

  // A session answered from here leaves the list with the focus it held;
  // the keyboard goes back to the inbox's heading.
  useLayoutEffect(() => {
    const ids = waiting.data?.items.map((session) => session.id) ?? [];
    const left = shown.current.some((id) => !ids.includes(id));
    shown.current = ids;
    if (left && focusLost(titleRef.current)) {
      titleRef.current?.focus();
    }
  }, [waiting.data]);

  let body: ReactNode;
  let count: ReactNode = null;
  if (waiting.data === undefined) {
    body = waiting.isPending
      ? loading
      : renderError(waiting.error, () => void waiting.refetch());
  } else {
    const { items, next_cursor } = waiting.data;
    const more = next_cursor !== null;
    if (items.length > 0) {
      count = (
        <Badge variant="amber">
          <span aria-hidden="true">
            {items.length}
            {more ? "+" : ""}
          </span>
          <span className="sr-only">
            {t(more ? "inbox.countMore" : "inbox.count", {
              count: items.length,
            })}
          </span>
        </Badge>
      );
    }
    body =
      items.length === 0 ? (
        (empty ?? (
          <p className="m-0 text-muted-foreground text-body">
            {t("inbox.empty")}
          </p>
        ))
      ) : (
        <ul
          className={cn(
            "m-0 flex list-none flex-col p-0",
            layout === "summary"
              ? "divide-y rounded-card border bg-card"
              : "gap-[var(--ap-space-block)]",
          )}
        >
          {items.map((session) => (
            <WaitingSession
              key={session.id}
              session={session}
              unavailable={unavailable}
              refusal={refusal}
              renderError={renderError}
              layout={layout}
              now={now}
            />
          ))}
        </ul>
      );
  }
  return (
    <section
      className="flex min-w-0 flex-col gap-[var(--ap-space-block)]"
      aria-labelledby={titleId}
    >
      <div className="flex min-h-7 items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <h2
            id={titleId}
            ref={titleRef}
            tabIndex={-1}
            className="m-0 font-semibold text-body"
          >
            {title ?? t("inbox.title")}
          </h2>
          {count}
        </div>
        {action}
      </div>
      {body}
    </section>
  );
}

function WaitingSession({
  session,
  unavailable,
  refusal,
  renderError,
  layout,
  now = Date.now(),
}: SessionActionProps & {
  readonly session: SessionSummary;
  readonly renderError: ApprovalInboxProps["renderError"];
  readonly layout: ApprovalInboxProps["layout"];
  readonly now: ApprovalInboxProps["now"];
}) {
  const { t } = useBlockText();
  const { renderLink, client } = useAgentPlatform();
  const queryClient = useQueryClient();
  const pending = usePendingRequests(session.id, true);
  const link = renderLink({
    to: "session",
    id: session.id,
    className: "font-mono text-primary underline underline-offset-2",
    "aria-label": `${t("inbox.open")} ${session.id}`,
    children: <code>{session.id.slice(0, 8)}…</code>,
  });
  const short = session.id.slice(0, 8);
  const summary = layout === "summary";
  const heading = summary
    ? renderLink({
        to: "session",
        id: session.id,
        className: "text-foreground hover:underline focus-visible:underline",
        "aria-label": `${t("inbox.open")} ${session.title ?? session.id}`,
        children: session.title ?? short,
      })
    : undefined;
  const meta = (request: PendingRequest) => {
    const waited = t("inbox.waited", {
      minutes: Math.max(
        0,
        Math.floor((now - Date.parse(request.created_at)) / 60_000),
      ),
    });
    // Untitled, the name line already is the short id.
    return session.title ? `${short} · ${waited}` : waited;
  };
  return (
    <li className={cn("flex min-w-0 flex-col", summary ? null : "gap-2")}>
      {/* Without a card to carry it, the session still needs its way in. */}
      {pending.data?.items.length ? null : (
        <p
          className={cn(
            "m-0 text-caption",
            summary &&
              "px-[var(--ap-row-padding-x)] py-[var(--ap-row-padding-y)]",
          )}
        >
          {link}
        </p>
      )}
      {pending.data ? (
        <PendingAnswers
          sessionId={session.id}
          items={pending.data.items}
          answerable={pending.data.answerable}
          subject={link}
          layout={layout}
          heading={heading}
          meta={summary ? meta : undefined}
          unavailable={unavailable}
          refusal={refusal}
          // No event stream is open here; the badge and this list learn the
          // session moved on from the next read.
          onAnswered={() =>
            void queryClient.invalidateQueries({
              ...waitingSessionsQuery(client),
              exact: true,
            })
          }
        />
      ) : pending.error ? (
        <div
          className={cn(
            summary &&
              "px-[var(--ap-row-padding-x)] py-[var(--ap-row-padding-y)]",
          )}
        >
          {renderError(pending.error, () => void pending.refetch())}
        </div>
      ) : null}
    </li>
  );
}
