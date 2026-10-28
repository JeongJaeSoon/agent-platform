import type { ComponentProps, JSX, ReactNode } from "react";

import { cn } from "../foundations/cn.ts";
import { PageHeader, type PageHeaderProps } from "./page-header.tsx";

export type PageFrameProps = ComponentProps<"div"> & {
  readonly children?: ReactNode;
};

/**
 * The one frame every console page sits in (V4-PAGE-FRAME): 16px on every
 * side, then 24px from 768px (`--ap-space-page-top` above and below), and
 * a column that grows to `--ap-w-page` and then centres. Lists, settings,
 * forms and details share it, so the content's edges and the title's y are
 * the same on every page.
 */
export function PageFrame({
  children,
  className,
  ...props
}: PageFrameProps): JSX.Element {
  return (
    <div
      data-slot="page-frame"
      className={cn(
        "flex w-full min-w-0 flex-col p-4 md:px-6 md:py-[var(--ap-space-page-top)]",
        className,
      )}
      {...props}
    >
      <div
        data-slot="page-frame-body"
        className="mx-auto flex w-full min-w-0 max-w-[var(--ap-w-page)] flex-1 flex-col"
      >
        {children}
      </div>
    </div>
  );
}

export type PageProps = Omit<PageHeaderProps, "className"> & {
  readonly children?: ReactNode;
  /**
   * `form` stops the page at `--ap-w-form` for a page that is one form or
   * settings column; its head stops there too, so both end on one edge.
   */
  readonly width?: "full" | "form" | undefined;
};

/**
 * A page's content inside the frame: its header, then its sections 32px
 * apart (console v35). `actions` takes several elements, such as a view
 * switch before the primary button.
 */
export function Page({
  children,
  width = "full",
  ...header
}: PageProps): JSX.Element {
  return (
    <div
      data-slot="page"
      data-width={width}
      className={cn(
        "flex flex-col",
        width === "form" && "w-full max-w-[var(--ap-w-form)]",
      )}
    >
      <PageHeader {...header} />
      <div className="flex flex-col gap-[var(--ap-space-section)]">
        {children}
      </div>
    </div>
  );
}
