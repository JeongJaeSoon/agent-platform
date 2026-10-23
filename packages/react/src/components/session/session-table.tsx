/* biome-ignore-all lint/a11y/useSemanticElements: container-responsive columns use a div-grid table. */
/* biome-ignore-all lint/a11y/useFocusableInteractive: static table rows delegate keyboard navigation to their cell links. */
import { cn } from "@werft-ai/ui";
import type { ReactNode } from "react";

import { SESSION_COLUMNS } from "./session-row.tsx";

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
      className="@container m-0 w-full overflow-hidden rounded-card border bg-card p-0"
    >
      <div
        role="row"
        className={cn(
          SESSION_COLUMNS,
          "min-h-[var(--ap-row-head-min-height)] items-center gap-4 border-b bg-surface-sunken px-[var(--ap-row-padding-x)] py-[var(--ap-row-head-padding-y)] text-muted-foreground text-caption font-medium",
        )}
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
