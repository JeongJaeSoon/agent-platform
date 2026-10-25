import type { SessionSummary } from "@werft-ai/contracts";
import {
  Button,
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@werft-ai/ui";
import { X } from "lucide-react";
import { type ReactNode, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { SessionStatusLabel } from "../components/index.ts";
import { useAgentPlatform } from "../provider.tsx";
import {
  usePendingRequests,
  useSession,
  useSessionEvents,
} from "../sessions.ts";
import { PendingAnswers, type SessionActionProps } from "./session-actions.tsx";
import { SessionTimeline } from "./session-timeline.tsx";
import { useBlockText } from "./text.ts";

export interface PendingPanelProps extends SessionActionProps {
  /** The session as the list read it; null keeps the panel closed. */
  readonly session: SessionSummary | null;
  readonly onClose: () => void;
  /** Radix's: where the keyboard goes once the panel has closed. */
  readonly onCloseAutoFocus?: ((event: Event) => void) | undefined;
  readonly renderError: (error: unknown, retry: () => void) => ReactNode;
  readonly onAnswered?: () => void;
}

/**
 * One waiting session at the screen's right edge: its timeline, with each
 * request it waits on answered on the request's own line.
 */
export function PendingPanel({
  session,
  onClose,
  onCloseAutoFocus,
  ...rest
}: PendingPanelProps) {
  return (
    <Dialog open={session !== null} onOpenChange={(open) => open || onClose()}>
      {session === null ? null : (
        <DialogContent
          onCloseAutoFocus={onCloseAutoFocus}
          // Right edge, full height; the whole width on a phone.
          className="top-0 right-0 left-auto flex h-dvh w-full max-w-full translate-x-0 translate-y-0 flex-col gap-0 rounded-none border-y-0 border-r-0 p-0 sm:max-w-[35rem]"
        >
          <PanelBody session={session} {...rest} />
        </DialogContent>
      )}
    </Dialog>
  );
}

function PanelBody({
  session: listed,
  renderError,
  unavailable,
  refusal,
  onAnswered,
}: Omit<PendingPanelProps, "session" | "onClose" | "onCloseAutoFocus"> & {
  readonly session: SessionSummary;
}) {
  const { t } = useBlockText();
  const { renderLink } = useAgentPlatform();
  const id = listed.id;
  const detail = useSession(id);
  const pending = usePendingRequests(id, true);
  const events = useSessionEvents(id, true);
  // Each request's form is rendered once, into a node of its own, and the
  // node is moved to where the request stands: on its timeline line, or on
  // top when the stream has no line for it. Moving never remounts the form,
  // so what was chosen and a send in flight survive. A form stays after its
  // request is gone, so its "sent" line keeps the keyboard.
  const [seen, setSeen] = useState<readonly string[]>([]);
  const nodes = useRef(new Map<string, HTMLDivElement>());
  // The page the panel is drawn on, known once it is: the nodes are its own.
  const [page, setPage] = useState<Document | null>(null);
  const items = pending.data?.items ?? [];
  const asked = new Set(
    events.events.flatMap((frame) =>
      frame.payload.event === "question" ? [frame.payload.data.request_id] : [],
    ),
  );
  // Until the stream has replayed, a request's line may still be on its way.
  const settled = events.state !== "connecting";
  const fresh = items
    .map((request) => request.request_id)
    .filter(
      (requestId) =>
        !seen.includes(requestId) && (settled || asked.has(requestId)),
    );
  if (fresh.length > 0) setSeen([...seen, ...fresh]);
  const nodeOf = (requestId: string, on: Document) => {
    let node = nodes.current.get(requestId);
    if (node === undefined) {
      node = on.createElement("div");
      nodes.current.set(requestId, node);
    }
    return node;
  };
  const slot = (requestId: string) => (
    <div
      key={requestId}
      ref={(host) => {
        if (host === null) return;
        const node = nodeOf(requestId, host.ownerDocument);
        if (node.parentNode !== host) host.appendChild(node);
      }}
    />
  );
  // Asked before the timeline's window, never seen on the stream, or since
  // dropped from it.
  const onTop = seen.filter((requestId) => !asked.has(requestId));
  const status = detail.data?.status ?? listed.status;
  const title = detail.data?.title ?? listed.title ?? id.slice(0, 8);
  const forms =
    pending.data && page
      ? seen.map((requestId) =>
          createPortal(
            <PendingAnswers
              sessionId={id}
              items={items.filter(
                (request) => request.request_id === requestId,
              )}
              answerable={pending.data.answerable}
              showEmpty={false}
              unavailable={unavailable}
              refusal={refusal}
              {...(onAnswered ? { onAnswered } : {})}
            />,
            nodeOf(requestId, page),
            requestId,
          ),
        )
      : null;
  const facts = [
    listed.agent?.name,
    id.slice(0, 8),
    detail.data?.runtime?.model,
  ].filter((fact) => fact !== undefined);

  return (
    <>
      <div className="flex items-center gap-3 border-b p-4">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <DialogTitle className="[overflow-wrap:anywhere]">
            {title}
          </DialogTitle>
          <DialogDescription className="flex flex-wrap items-center gap-x-2 gap-y-1 text-caption">
            <SessionStatusLabel
              status={status}
              label={t(`sessions.status.${status}`)}
              axisLabel={t("sessions.column.status")}
            />
            {facts.map((fact) => (
              <span key={fact} className="[overflow-wrap:anywhere]">
                <span aria-hidden="true">· </span>
                {fact}
              </span>
            ))}
          </DialogDescription>
        </div>
        <DialogClose asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={t("panel.close")}
          >
            <X aria-hidden="true" />
          </Button>
        </DialogClose>
      </div>
      <div
        ref={(body) => {
          if (body && page === null) setPage(body.ownerDocument);
        }}
        className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4"
      >
        {pending.error
          ? renderError(pending.error, () => void pending.refetch())
          : null}
        {forms}
        {onTop.length === 0 ? null : (
          <div className="flex flex-col gap-2">{onTop.map(slot)}</div>
        )}
        <p className="m-0 text-caption text-muted-foreground">
          {t("panel.note")}
        </p>
        <section
          aria-label={t("panel.timeline")}
          className="min-w-0 rounded-card border bg-card"
        >
          <SessionTimeline
            events={events.events}
            state={events.state}
            request={(requestId) =>
              seen.includes(requestId) ? slot(requestId) : null
            }
          />
        </section>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2 border-t px-4 py-3">
        {renderLink({
          to: "session",
          id,
          className:
            "text-control text-primary underline-offset-2 hover:underline focus-visible:underline",
          children: t("panel.openSession"),
        })}
        <DialogClose asChild>
          <Button type="button" variant="outline">
            {t("panel.done")}
          </Button>
        </DialogClose>
      </div>
    </>
  );
}
