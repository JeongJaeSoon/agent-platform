import type { PendingRequest, SessionSummary } from "@werft-ai/contracts";
import {
  Button,
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@werft-ai/ui";
import { X } from "lucide-react";
import { type ReactNode, useState } from "react";
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
  // Where each request is answered, fixed the first time it is drawn: a
  // form that moved would drop what was chosen and a send in flight. Once
  // placed, a slot stays after its request is gone, so its "sent" line
  // keeps the keyboard.
  const [placed, setPlaced] = useState<ReadonlyMap<string, "top" | "timeline">>(
    new Map(),
  );
  const items = pending.data?.items ?? [];
  const asked = new Set(
    events.events.flatMap((frame) =>
      frame.payload.event === "question" ? [frame.payload.data.request_id] : [],
    ),
  );
  // Until the stream has replayed, a request's line may still be on its way.
  const settled = events.state !== "connecting";
  const fresh = items.filter(
    (request) =>
      (!placed.has(request.request_id) &&
        (settled || asked.has(request.request_id))) ||
      // Its line left the stream's window while it still waits: answered
      // from the top, so it stays answerable.
      (placed.get(request.request_id) === "timeline" &&
        !asked.has(request.request_id)),
  );
  if (fresh.length > 0) {
    const next = new Map(placed);
    for (const request of fresh) {
      next.set(
        request.request_id,
        asked.has(request.request_id) ? "timeline" : "top",
      );
    }
    setPlaced(next);
  }
  // Asked before the timeline's window, never seen on the stream, or since
  // dropped from it.
  const elsewhere = items.filter(
    (request) => placed.get(request.request_id) === "top",
  );
  const anyTop = [...placed.values()].includes("top");
  const status = detail.data?.status ?? listed.status;
  const title = detail.data?.title ?? listed.title ?? id.slice(0, 8);
  const answers = (requests: readonly PendingRequest[]) =>
    pending.data ? (
      <PendingAnswers
        sessionId={id}
        items={requests}
        answerable={pending.data.answerable}
        showEmpty={false}
        unavailable={unavailable}
        refusal={refusal}
        {...(onAnswered ? { onAnswered } : {})}
      />
    ) : null;
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
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4">
        {pending.error
          ? renderError(pending.error, () => void pending.refetch())
          : null}
        {anyTop ? answers(elsewhere) : null}
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
              placed.get(requestId) === "timeline"
                ? answers(
                    items.filter((request) => request.request_id === requestId),
                  )
                : null
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
