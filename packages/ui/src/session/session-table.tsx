/* biome-ignore-all lint/a11y/useSemanticElements: container-responsive columns use a div-grid table. */
/* biome-ignore-all lint/a11y/useFocusableInteractive: static table rows delegate keyboard navigation to their cell links. */
import type { ReactNode } from "react";

export interface SessionTableProps {
  readonly label: string;
  readonly messages: {
    readonly id: string;
    readonly status: string;
    readonly admission: string;
    readonly runtime: string;
    readonly lastEvent: string;
    readonly created: string;
  };
  readonly children: ReactNode;
}

export function SessionTable({ label, messages, children }: SessionTableProps) {
  return (
    <div
      role="table"
      aria-label={label}
      className="@container m-0 w-full overflow-hidden rounded-lg border bg-card p-0"
    >
      <div
        role="row"
        className="grid min-h-9 grid-cols-[minmax(0,1fr)_120px] @[480px]:grid-cols-[minmax(0,1fr)_120px_136px] items-center gap-4 border-b bg-surface-sunken px-4 text-muted-foreground text-caption font-medium @[820px]:grid-cols-[minmax(0,2fr)_120px_120px_minmax(0,2fr)_minmax(72px,1fr)]"
      >
        <span role="columnheader">{messages.id}</span>
        <span role="columnheader">{messages.status}</span>
        <span role="columnheader" className="hidden @[820px]:block">
          {messages.admission}
        </span>
        <span role="columnheader" className="hidden @[820px]:block">
          {messages.runtime}
        </span>
        <span role="columnheader" className="hidden text-right @[480px]:block">
          {messages.lastEvent} / {messages.created}
        </span>
      </div>
      {children}
    </div>
  );
}
