import type { ReactNode } from "react";

/**
 * A table wider than the screen scrolls sideways; the tab stop lets a
 * keyboard reach it and scroll with the arrow keys.
 */
export function TableScroll({
  label,
  children,
}: {
  readonly label: string;
  readonly children: ReactNode;
}) {
  return (
    // biome-ignore lint/a11y/noNoninteractiveTabindex: a scroll container must be focusable to scroll by keyboard
    <section className="web-table-wrap" aria-label={label} tabIndex={0}>
      {children}
    </section>
  );
}
