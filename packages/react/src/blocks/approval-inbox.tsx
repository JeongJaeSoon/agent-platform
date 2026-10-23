import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { SessionSummary } from "@werft-ai/contracts";
import { waitingSessionsQuery } from "@werft-ai/core";
import { Badge } from "@werft-ai/ui";
import { type ReactNode, useId, useLayoutEffect, useRef } from "react";
import { useAgentPlatform } from "../provider.tsx";
import { usePendingRequests } from "../sessions.ts";
import {
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
        <p className="m-0 text-muted-foreground text-body">
          {t("inbox.empty")}
        </p>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-[var(--ap-space-block)] p-0">
          {items.map((session) => (
            <WaitingSession
              key={session.id}
              session={session}
              unavailable={unavailable}
              refusal={refusal}
              renderError={renderError}
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
      <div className="flex items-center gap-2">
        <h2
          id={titleId}
          ref={titleRef}
          tabIndex={-1}
          className="m-0 font-semibold text-body"
        >
          {t("inbox.title")}
        </h2>
        {count}
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
}: SessionActionProps & {
  readonly session: SessionSummary;
  readonly renderError: ApprovalInboxProps["renderError"];
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
  return (
    <li className="flex min-w-0 flex-col gap-2">
      {/* Without a card to carry it, the session still needs its way in. */}
      {pending.data?.items.length ? null : (
        <p className="m-0 text-caption">{link}</p>
      )}
      {pending.data ? (
        <PendingAnswers
          sessionId={session.id}
          items={pending.data.items}
          answerable={pending.data.answerable}
          subject={link}
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
        renderError(pending.error, () => void pending.refetch())
      ) : null}
    </li>
  );
}
