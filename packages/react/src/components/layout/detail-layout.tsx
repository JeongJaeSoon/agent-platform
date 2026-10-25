import { cn, PageFrame, Section } from "@werft-ai/ui";
import {
  type ComponentProps,
  type JSX,
  type ReactNode,
  useEffect,
  useState,
} from "react";

export type DetailLayoutProps = Omit<ComponentProps<"div">, "children"> & {
  /** The page itself: its header, tabs and content. */
  readonly children: ReactNode;
  /** A `DetailRail`, drawn at the right edge from 1280px and under the body below. */
  readonly rail?: ReactNode;
};

/**
 * A detail page with a right rail (Cloudflare's domain overview). The host
 * gives it the whole area under the top bar, with no padding of its own: the
 * body sits in the same `PageFrame` as every other page, centred in what the
 * rail leaves, and the rail runs from the top bar to the bottom of the screen. Below
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
      <PageFrame>{children}</PageFrame>
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
 * its left, 24px inside above and below at every width and on the sides
 * from 768px (V4-RAIL-PAD, V4-DETAIL-HEADER), as
 * tall as the body or the screen, whichever is taller. Its
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
  const [content, setContent] = useState<HTMLDivElement | null>(null);
  const scrollable = useOverflows(content, children);
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
        ref={setContent}
        data-slot="detail-rail-content"
        // Only while it scrolls on its own: a keyboard needs a stop to
        // scroll it, and the band below 1280px would gain a useless one.
        {...(scrollable
          ? { tabIndex: 0, role: "group", "aria-label": label }
          : undefined)}
        className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,22rem),1fr))] items-start gap-x-8 gap-y-6 px-4 py-6 md:p-[var(--ap-space-6)] xl:sticky xl:top-0 xl:flex xl:max-h-[calc(100dvh-var(--ap-topbar-h))] xl:flex-col xl:items-stretch xl:gap-y-0 xl:divide-y xl:overflow-y-auto"
      >
        {children}
      </div>
    </aside>
  );
}

function useOverflows(element: HTMLElement | null, children: ReactNode) {
  const [overflows, setOverflows] = useState(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: new children may change the height
  useEffect(() => {
    if (!element) return;
    const check = () =>
      setOverflows(element.scrollHeight > element.clientHeight);
    check();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(check);
    observer.observe(element);
    for (const child of element.children) observer.observe(child);
    return () => observer.disconnect();
  }, [element, children]);
  return overflows;
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
        "min-w-0 xl:py-[var(--ap-space-6)] xl:first:pt-0 xl:last:pb-0",
        className,
      )}
    >
      {children}
    </Section>
  );
}
