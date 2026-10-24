import { Slot } from "@radix-ui/react-slot";
import {
  Children,
  type ComponentProps,
  Fragment,
  type JSX,
  type ReactNode,
} from "react";

import { cn } from "../foundations/cn.ts";

export interface PageBreadcrumbProps {
  /** The landmark's name, such as "위치". */
  readonly label: string;
  /** `PageBreadcrumbLink`s up the way, then the page's `PageBreadcrumbCurrent`. */
  readonly children: ReactNode;
  readonly className?: string | undefined;
}

/**
 * Where a page sits, on the line above its title (`PageHeader`'s
 * `breadcrumb`): the way back is a crumb, not a button, so the head's
 * actions stay the page's own (V4-PAGE-FRAME).
 */
export function PageBreadcrumb({
  label,
  children,
  className,
}: PageBreadcrumbProps): JSX.Element {
  const crumbs = Children.toArray(children);
  return (
    <nav
      data-slot="page-breadcrumb"
      aria-label={label}
      className={cn("min-w-0", className)}
    >
      <ol className="m-0 flex min-w-0 list-none flex-wrap items-center gap-x-2 p-0 text-control text-subtle-foreground">
        {crumbs.map((crumb, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: crumbs are positional
          <Fragment key={index}>
            {index > 0 ? (
              <li aria-hidden="true" className="text-border-strong">
                /
              </li>
            ) : null}
            <li className="min-w-0">{crumb}</li>
          </Fragment>
        ))}
      </ol>
    </nav>
  );
}

export type PageBreadcrumbLinkProps = ComponentProps<"a"> & {
  /** Render the single child (a router link) with the crumb's look. */
  readonly asChild?: boolean;
};

export function PageBreadcrumbLink({
  asChild = false,
  className,
  ...props
}: PageBreadcrumbLinkProps): JSX.Element {
  const Comp = asChild ? Slot : "a";
  return (
    <Comp
      data-slot="page-breadcrumb-link"
      className={cn(
        "text-subtle-foreground no-underline hover:text-foreground hover:underline",
        className,
      )}
      {...props}
    />
  );
}

export function PageBreadcrumbCurrent({
  className,
  ...props
}: ComponentProps<"span">): JSX.Element {
  return (
    <span
      data-slot="page-breadcrumb-current"
      aria-current="page"
      className={cn("font-medium text-foreground", className)}
      {...props}
    />
  );
}
