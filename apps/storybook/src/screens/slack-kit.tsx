import { Card, CardTitle } from "@werft-ai/ui";
import { type ReactNode, useEffect, useRef } from "react";

/*
 * Stand-ins shared by the workspace settings' Slack pages and the agent
 * GitHub screen. Kept out of screen-kit.tsx, which the web-ui lead keeps as
 * it is.
 */

/** Another story's canvas, keeping the viewport and theme of this one. */
export function storyHref(id: string): string {
  const globals = new URLSearchParams(globalThis.location?.search ?? "").get(
    "globals",
  );
  return `iframe.html?id=${id}&viewMode=story${globals ? `&globals=${globals}` : ""}`;
}

export const MUTED_TEXT = "text-control text-muted-foreground";

/** A section heading: CardTitle carries the console's 14px semibold title. */
export function Heading({
  id,
  level = 2,
  children,
}: {
  readonly id?: string | undefined;
  readonly level?: 2 | 3;
  readonly children: ReactNode;
}) {
  return (
    <CardTitle id={id} role="heading" aria-level={level}>
      {children}
    </CardTitle>
  );
}

/** Stand-in for the console's `OutcomeLine` result line. */
export function OutcomeStandIn({
  tone = "progress",
  children,
}: {
  readonly tone?: "progress" | "danger";
  readonly children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  // A result line takes focus when it appears, as the console's does.
  useEffect(() => {
    ref.current?.focus();
  }, []);
  return (
    <Card
      ref={ref}
      tabIndex={-1}
      data-tone={tone}
      role={tone === "danger" ? "alert" : "status"}
      data-outcome=""
      className="border-(color:--ap-tone-border) bg-(color:--ap-tone-bg) px-4 py-3 text-(color:--ap-tone-fg) outline-none"
    >
      {children}
    </Card>
  );
}
