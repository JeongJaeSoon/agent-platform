import { cn, Section } from "@werft-ai/ui";
import type { ComponentProps, JSX, ReactNode } from "react";

export type DetailLayoutProps = Omit<ComponentProps<"div">, "children"> & {
  /** The page itself: its header, tabs and content. */
  readonly children: ReactNode;
  /** A `DetailRail`, drawn at the right edge from 1280px and under the body below. */
  readonly rail?: ReactNode;
};

/**
 * A detail page with a right rail (Cloudflare's domain overview). The host
 * gives it the whole area under the top bar, with no padding of its own: the
 * body centres in what the rail leaves, up to the list width (V4-CENTER),
 * and the rail runs from the top bar to the bottom of the screen. Below
 * 1280px the rail follows the body, so DOM, focus and reading order agree
 * at every width.
 */
export function DetailLayout({
  children,
  rail,
  className,
  ...props
}: DetailLayoutProps): JSX.Element {
  return (
    <div
      data-slot="detail-layout"
      className={cn(
        "flex min-w-0 flex-1 flex-col xl:grid xl:grid-cols-[minmax(0,1fr)_auto]",
        className,
      )}
      {...props}
    >
      <div
        data-slot="detail-layout-body"
        className="mx-auto flex w-full min-w-0 max-w-[101.25rem] flex-col p-4 pt-6 md:px-6 md:pt-[var(--ap-space-page-top)] md:pb-[var(--ap-space-section)]"
      >
        {children}
      </div>
      {rail}
    </div>
  );
}

export type DetailRailProps = Omit<
  ComponentProps<"aside">,
  "aria-label" | "children"
> & {
  /** The landmark's name: a page has one rail, and it is read by this. */
  readonly label: string;
  /** `DetailRailSection`s, in reading order. */
  readonly children: ReactNode;
};

/**
 * The rail beside a detail page's body: a 400px column with a 1px line on
 * its left, as tall as the body or the screen, whichever is taller. Its
 * content stays in view while the page scrolls and scrolls on its own when
 * taller than the screen. Below 1280px it is a band under the body, its
 * sections side by side where they fit.
 */
export function DetailRail({
  label,
  children,
  className,
  ...props
}: DetailRailProps): JSX.Element {
  return (
    <aside
      data-slot="detail-rail"
      aria-label={label}
      className={cn(
        "min-w-0 border-t bg-surface xl:w-[25rem] xl:border-t-0 xl:border-l",
        className,
      )}
      {...props}
    >
      <div
        data-slot="detail-rail-content"
        className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,22rem),1fr))] items-start gap-x-8 p-4 pt-6 md:px-6 md:pt-[var(--ap-space-page-top)] md:pb-[var(--ap-space-section)] xl:sticky xl:top-0 xl:flex xl:max-h-[calc(100dvh-var(--ap-topbar-h))] xl:flex-col xl:divide-y xl:overflow-y-auto xl:p-8"
      >
        {children}
      </div>
    </aside>
  );
}

export interface DetailRailSectionProps {
  readonly title: ReactNode;
  /** One line under the title, such as what the section's rule is. */
  readonly description?: ReactNode;
  /** Drawn at the head's far end, such as a done mark. */
  readonly actions?: ReactNode;
  readonly className?: string;
  /** Rows: a `KeyValueList`, a short paragraph, or request cards. */
  readonly children?: ReactNode;
}

/**
 * One titled group of the rail, without a card around it: lines between
 * groups stand in for the borders.
 */
export function DetailRailSection({
  title,
  description,
  actions,
  className,
  children,
}: DetailRailSectionProps): JSX.Element {
  return (
    <Section
      data-slot="detail-rail-section"
      title={title}
      description={description}
      actions={actions}
      className={cn(
        "min-w-0 pb-6 xl:py-6 xl:first:pt-0 xl:last:pb-0",
        className,
      )}
    >
      {children}
    </Section>
  );
}
