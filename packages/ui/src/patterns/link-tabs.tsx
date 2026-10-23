import {
  type ComponentProps,
  cloneElement,
  isValidElement,
  type JSX,
  type ReactNode,
} from "react";

import { cn } from "../foundations/cn.ts";
import { Badge } from "../primitives/badge.tsx";
import { Link } from "../primitives/link.tsx";

/*
 * Route tabs: each tab is an address, so they are links in a `nav`, the one
 * the screen is on marked `aria-current="page"`. Panels switched inside one
 * screen are Tabs (role=tab) instead. The look is the console's API keys
 * screen nav: an underline under the current tab, 24px between tabs.
 */

export type LinkTabsProps = Omit<ComponentProps<"nav">, "aria-label"> & {
  /** Names the tabs for screen readers, e.g. "API 키 종류". */
  readonly "aria-label": string;
};

/**
 * Too many tabs scroll sideways inside the nav instead of wrapping. 4px of
 * room on every side keeps a focused tab's 2px outline at 2px offset out of
 * the scroll clip: padding given back by margin above, below and on the left,
 * and the list's own padding on the right, so the nav never grows past its
 * parent's right edge.
 */
export function LinkTabs({
  className,
  children,
  ...props
}: LinkTabsProps): JSX.Element {
  return (
    <nav
      data-slot="link-tabs"
      className={cn("-my-1 -ml-1 overflow-x-auto py-1 pl-1", className)}
      {...props}
    >
      <ul className="m-0 flex w-max min-w-full list-none gap-6 border-b py-0 pr-1 pl-0">
        {children}
      </ul>
    </nav>
  );
}

// A router link's children may be a function of its state.
type ChildProps = { readonly children?: unknown };

export type LinkTabProps = ComponentProps<"a"> & {
  /**
   * The tab of the screen being shown; the caller matches the route. A router
   * link sets its own `aria-current` when it counts as active (TanStack does
   * for a parent path too), so give such a link exact matching.
   */
  readonly current?: boolean | undefined;
  /** Drawn in a badge after the label, 0 included; omit for no badge. */
  readonly count?: number | undefined;
  /**
   * Screen-reader text for the count, e.g. "3개 실행 중". Without it the
   * number itself is read after the label.
   */
  readonly countLabel?: ReactNode | undefined;
  /** Render the single child (a router link) as the tab. */
  readonly asChild?: boolean | undefined;
};

function append(children: unknown, extra: ReactNode): unknown {
  if (typeof children !== "function") {
    return (
      <>
        {children as ReactNode}
        {extra}
      </>
    );
  }
  return (...args: unknown[]) => (
    <>
      {children(...args)}
      {extra}
    </>
  );
}

export function LinkTab({
  className,
  current = false,
  count,
  countLabel,
  asChild = false,
  children,
  ...props
}: LinkTabProps): JSX.Element {
  const hasLabel = countLabel !== undefined && countLabel !== null;
  // The space keeps the label and the number apart in the accessible name;
  // flex drops it from the layout.
  const badge =
    count === undefined ? null : (
      <>
        {" "}
        <Badge aria-hidden={hasLabel ? "true" : undefined}>{count}</Badge>
        {hasLabel ? <span className="sr-only">{countLabel}</span> : null}
      </>
    );
  const child =
    asChild && isValidElement<ChildProps>(children) ? children : null;
  return (
    <li className="flex">
      {/* Link brings asChild and the focus outline; its colour, weight and
          underline give way to the tab's. */}
      <Link
        data-slot="link-tab"
        aria-current={current ? "page" : undefined}
        asChild={child !== null}
        className={cn(
          "-mb-px flex items-center gap-2 border-transparent border-b-2 py-2 font-normal text-control text-muted-foreground no-underline!",
          "hover:text-foreground",
          "aria-[current=page]:border-foreground aria-[current=page]:font-semibold aria-[current=page]:text-foreground",
          className,
        )}
        {...props}
      >
        {child ? (
          badge ? (
            cloneElement(child, {
              children: append(child.props.children, badge),
            })
          ) : (
            child
          )
        ) : (
          <>
            {children}
            {badge}
          </>
        )}
      </Link>
    </li>
  );
}
