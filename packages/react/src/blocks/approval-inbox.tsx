import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  type PendingRequest,
  presentTurnEvent,
  type SessionSummary,
} from "@werft-ai/contracts";
import { pendingRequestsQuery, waitingSessionsQuery } from "@werft-ai/core";
import { Badge, Button, cn, formatTimestamp, Skeleton } from "@werft-ai/ui";
import {
  type ReactNode,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { turnSummaryText } from "../components/index.ts";
import { useExpired } from "../components/session/expiry.ts";
import { useMinute } from "../components/session/use-minute.ts";
import { useAgentPlatform } from "../provider.tsx";
import type { PendingRail } from "./pending-rail.tsx";
import {
  type ApprovalLayout,
  focusLost,
  PendingAnswers,
  type SessionActionProps,
} from "./session-actions.tsx";
import { useBlockText } from "./text.ts";

export interface ApprovalInboxProps extends SessionActionProps {
  /** Shown until the waiting sessions arrive, in place of the block's rows. */
  readonly loading?: ReactNode;
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
  /** At most this many sessions are drawn; the rest are left to `more`. */
  readonly limit?: number | undefined;
  /**
   * The list's last line when sessions are left out, by `limit` or past the
   * first page: `count` is how many, with "+" when the page has more.
   */
  readonly more?: ((count: string) => ReactNode) | undefined;
  /**
   * Summary layout only: each line opens its session in the host's rail
   * (`usePendingRail`), its timeline and its answers, instead of answering
   * on the line.
   */
  readonly rail?: Pick<PendingRail, "open" | "openedId"> | undefined;
}

// Framed like the list it stands in for, one placeholder per line at a
// line's least height.
function InboxSkeleton({
  rows,
  label,
}: {
  readonly rows: number;
  readonly label?: string;
}) {
  return (
    <div
      data-slot="inbox-skeleton"
      className="flex flex-col divide-y rounded-card border bg-card"
    >
      {Array.from({ length: rows }, (_, index) => index).map((index) => (
        <div
          // Placeholder rows have no identity beyond their position.
          key={index}
          className="flex min-h-[var(--ap-row-min-height)] flex-col justify-center gap-1.5 px-[var(--ap-row-padding-x)] py-[var(--ap-row-padding-y)]"
        >
          <Skeleton
            width="40%"
            {...(index === 0 && label !== undefined
              ? { label }
              : { decorative: true })}
          />
          <Skeleton width="25%" decorative />
        </div>
      ))}
    </div>
  );
}

const FRAME = "rounded-card border bg-card";
const FRAME_PADDING =
  "px-[var(--ap-row-padding-x)] py-[var(--ap-row-padding-y)]";

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
  now: givenNow,
  limit,
  more: moreLine,
  rail,
}: ApprovalInboxProps) {
  const { t } = useBlockText();
  const { client } = useAgentPlatform();
  const queryClient = useQueryClient();
  const titleId = useId();
  const waiting = useQuery(waitingSessionsQuery(client));
  const now = useMinute(layout === "summary" && givenNow === undefined);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const shownBefore = useRef<readonly string[]>([]);
  const [sent, setSent] = useState(false);

  const sessions = waiting.data?.items ?? [];
  // The same reads each line makes, so the block knows which sessions still
  // hold a request before it draws or counts them.
  const lists = useQueries({
    queries: sessions.map((session) =>
      pendingRequestsQuery(client, session.id),
    ),
  });
  // A session listed as waiting whose own list came back empty was answered
  // or lapsed since the waiting list was read: it is left out, and the
  // waiting list read again so the count and the shell's badge catch up.
  const shown = sessions.filter(
    (_, index) => lists[index]?.data?.items.length !== 0,
  );
  const shownKey = shown.map((session) => session.id).join();
  const emptyKey = sessions
    .filter((_, index) => lists[index]?.data?.items.length === 0)
    .map((session) => session.id)
    .join();
  useEffect(() => {
    if (emptyKey === "") return;
    void queryClient.invalidateQueries({
      ...waitingSessionsQuery(client),
      exact: true,
    });
  }, [emptyKey, queryClient, client]);

  // A session answered from here leaves the list with the focus it held;
  // the keyboard goes back to the inbox's heading. One answered in the open
  // rail keeps it there.
  const railOpen = rail?.openedId != null;
  useLayoutEffect(() => {
    const ids = shownKey === "" ? [] : shownKey.split(",");
    const left = shownBefore.current.some((id) => !ids.includes(id));
    shownBefore.current = ids;
    if (left && !railOpen && focusLost(titleRef.current)) {
      titleRef.current?.focus();
    }
  }, [shownKey, railOpen]);

  let body: ReactNode;
  let count: ReactNode = null;
  if (waiting.data === undefined) {
    body = waiting.isPending
      ? (loading ?? <InboxSkeleton rows={2} label={t("inbox.loading")} />)
      : // The host's error state carries its own frame.
        renderError(waiting.error, () => void waiting.refetch());
  } else {
    const more = waiting.data.next_cursor !== null;
    const drawn = limit === undefined ? shown : shown.slice(0, limit);
    const left = shown.length - drawn.length;
    if (shown.length > 0) {
      count = (
        <Badge variant="amber">
          <span aria-hidden="true">
            {shown.length}
            {more ? "+" : ""}
          </span>
          <span className="sr-only">
            {t(more ? "inbox.countMore" : "inbox.count", {
              count: shown.length,
            })}
          </span>
        </Badge>
      );
    }
    body =
      shown.length === 0 ? (
        (empty ?? (
          <p
            className={cn(
              "m-0 text-muted-foreground text-body",
              FRAME,
              FRAME_PADDING,
            )}
          >
            {t("inbox.empty")}
          </p>
        ))
      ) : (
        <ul
          className={cn(
            "m-0 flex list-none flex-col p-0",
            layout === "summary"
              ? cn("divide-y", FRAME)
              : "gap-[var(--ap-space-block)]",
          )}
        >
          {drawn.map((session) => (
            <WaitingSession
              key={session.id}
              session={session}
              unavailable={unavailable}
              refusal={refusal}
              renderError={renderError}
              layout={layout}
              now={givenNow ?? now}
              onAnswered={() => setSent(true)}
              opened={rail?.openedId === session.id}
              onOpen={
                rail && layout === "summary"
                  ? (opener) => rail.open(session, opener, titleRef.current)
                  : undefined
              }
            />
          ))}
          {left > 0 && moreLine !== undefined ? (
            <li
              className={cn(
                "text-control",
                layout === "summary" ? FRAME_PADDING : null,
              )}
            >
              {moreLine(`${left}${more ? "+" : ""}`)}
            </li>
          ) : null}
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
          {/* On the heading's line, not the answered one: that line leaves
              with the read that follows. Always mounted so a screen reader
              hears it; in the line, so nothing below moves. */}
          <output className="min-w-0 truncate text-caption text-muted-foreground">
            {sent ? t("session.answer.sent") : null}
          </output>
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
  now,
  onAnswered,
  opened,
  onOpen,
}: SessionActionProps & {
  readonly session: SessionSummary;
  readonly renderError: ApprovalInboxProps["renderError"];
  readonly layout: ApprovalInboxProps["layout"];
  readonly now: number;
  readonly onAnswered: () => void;
  /** Whether the rail shows this session. */
  readonly opened: boolean;
  /** Given, each line opens the rail instead of answering. */
  readonly onOpen?: ((opener: HTMLElement) => void) | undefined;
}) {
  const { t } = useBlockText();
  const { renderLink, client } = useAgentPlatform();
  const queryClient = useQueryClient();
  const pending = useQuery(pendingRequestsQuery(client, session.id));
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
    const parts = [
      session.agent?.name,
      session.title ? short : undefined,
      waited,
    ].filter((part) => part !== undefined);
    return (
      <>
        {parts.map((part, index) => (
          // A long agent name wraps; the id and the wait stay whole.
          <span
            key={part}
            className={
              part === session.agent?.name ? undefined : "whitespace-nowrap"
            }
          >
            {index === 0 ? null : <span aria-hidden="true"> · </span>}
            {part}
          </span>
        ))}
      </>
    );
  };
  // The inbox leaves out a session whose list came back empty.
  if (pending.data?.items.length === 0) return null;
  return (
    <li className={cn("flex min-w-0 flex-col", summary ? null : "gap-2")}>
      {pending.data && onOpen ? (
        <ul className="m-0 flex list-none flex-col divide-y p-0">
          {pending.data.items.map((request) => (
            <li key={request.request_id}>
              <PanelLine
                request={request}
                heading={heading}
                meta={meta(request)}
                name={session.title ?? short}
                opened={opened}
                onOpen={onOpen}
              />
            </li>
          ))}
        </ul>
      ) : pending.data ? (
        <PendingAnswers
          sessionId={session.id}
          items={pending.data.items}
          answerable={pending.data.answerable}
          subject={link}
          layout={layout}
          heading={heading}
          meta={summary ? meta : undefined}
          announceSent={false}
          unavailable={unavailable}
          refusal={refusal}
          // No event stream is open here; the badge and this list learn the
          // session moved on from the next read.
          onAnswered={() => {
            onAnswered();
            void queryClient.invalidateQueries({
              ...waitingSessionsQuery(client),
              exact: true,
            });
          }}
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
      ) : (
        <div
          data-slot="inbox-row-skeleton"
          className={cn(
            "flex min-h-[var(--ap-row-min-height)] flex-col justify-center gap-1.5",
            summary
              ? "px-[var(--ap-row-padding-x)] py-[var(--ap-row-padding-y)]"
              : cn(FRAME, FRAME_PADDING),
          )}
        >
          <Skeleton width="40%" decorative />
          <Skeleton width="25%" decorative />
        </div>
      )}
    </li>
  );
}

/**
 * A waiting request as one list line whose one action opens the rail:
 * what it asks or wants to run, and until when.
 */
function PanelLine({
  request,
  heading,
  meta,
  name,
  opened,
  onOpen,
}: {
  readonly request: PendingRequest;
  readonly heading: ReactNode;
  readonly meta: ReactNode;
  /** The session as the button's accessible name says it. */
  readonly name: string;
  readonly opened: boolean;
  readonly onOpen: (opener: HTMLElement) => void;
}) {
  const { t, formatMessage, locale } = useBlockText();
  const expired = useExpired(
    request.request_id,
    request.expires_at,
    Date.now(),
  );
  const asks =
    request.kind === "question"
      ? request.questions[0]?.prompt
      : turnSummaryText(
          presentTurnEvent({
            event: "question",
            data: {
              kind: "permission",
              tool: request.tool,
              input: request.input,
            },
          }).summary,
          formatMessage,
        );
  return (
    <div className="flex min-h-[var(--ap-row-min-height)] flex-wrap items-center justify-end gap-x-4 gap-y-2 px-[var(--ap-row-padding-x)] py-[var(--ap-row-padding-y)]">
      <div className="flex min-w-0 flex-1 basis-60 flex-col gap-0.5">
        <p className="m-0 flex min-w-0 items-center gap-2 font-medium text-control leading-5">
          <span className="min-w-16 truncate">{heading}</span>
          <Badge variant="amber" className="min-w-0 max-w-max shrink">
            <span className="truncate">
              {request.kind === "question"
                ? t("session.pending.question")
                : t("session.pending.permission", { tool: request.tool })}
            </span>
          </Badge>
        </p>
        {asks ? (
          <p className="m-0 truncate text-control leading-5">{asks}</p>
        ) : null}
        <p className="m-0 text-caption text-muted-foreground leading-4 [overflow-wrap:anywhere]">
          {meta}
          <span aria-hidden="true"> · </span>
          {expired
            ? t("session.pending.expired")
            : t("session.pending.expires", {
                at: formatTimestamp(request.expires_at, locale),
              })}
        </p>
      </div>
      <Button
        type="button"
        variant="outline"
        className="shrink-0"
        aria-expanded={opened}
        aria-label={t("inbox.detailFor", { session: name })}
        onClick={(event) => onOpen(event.currentTarget)}
      >
        {t("inbox.detail")}
      </Button>
    </div>
  );
}
