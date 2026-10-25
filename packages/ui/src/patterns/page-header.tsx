import { type JSX, type ReactNode, type Ref, useId } from "react";

import { cn } from "../foundations/cn.ts";

export interface PageHeaderProps {
  /** The page's one `h1`; match the sidebar and breadcrumb wording. */
  readonly title: ReactNode;
  /**
   * Beside the title on its line but outside the heading, such as a state
   * tag, so the heading's name stays the page's name.
   */
  readonly titleAside?: ReactNode | undefined;
  /** One line on what the page is for; screen readers hear it with the title. */
  readonly description?: ReactNode | undefined;
  /**
   * The page's own actions, such as its primary button; several sit in a
   * row (a view switch, then the primary button).
   */
  readonly actions?: ReactNode | undefined;
  /**
   * A `PageBreadcrumb` on the line above the title, where another page's
   * title starts. A detail screen's way back to its list is a button at
   * the end of `actions` instead (user decision 2026-10-25).
   */
  readonly breadcrumb?: ReactNode | undefined;
  /**
   * For a screen that hands focus to its title when the part of the page
   * that held it goes away; the title then takes `tabIndex={-1}`.
   */
  readonly titleRef?: Ref<HTMLHeadingElement> | undefined;
  readonly className?: string | undefined;
}

/**
 * The head of a console page (console v35): a 20/28 title, a 13/20
 * description, actions on the right, no divider, 24px above the content.
 */
export function PageHeader({
  title,
  titleAside,
  description,
  actions,
  breadcrumb,
  titleRef,
  className,
}: PageHeaderProps): JSX.Element {
  const descriptionId = useId();
  const hasDescription =
    description !== undefined && description !== null && description !== "";
  const heading = (
    <h1
      ref={titleRef}
      tabIndex={titleRef ? -1 : undefined}
      className="m-0 font-semibold text-foreground text-title"
      aria-describedby={hasDescription ? descriptionId : undefined}
    >
      {title}
    </h1>
  );
  return (
    <header
      data-slot="page-header"
      className={cn(
        "mb-[var(--ap-space-page-head)] flex items-start justify-between gap-4",
        className,
      )}
    >
      <div className="flex min-w-0 flex-col gap-1">
        {breadcrumb}
        {titleAside ? (
          <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
            {heading}
            {titleAside}
          </div>
        ) : (
          heading
        )}
        {hasDescription ? (
          <p
            id={descriptionId}
            className="m-0 text-description text-muted-foreground"
          >
            {description}
          </p>
        ) : null}
      </div>
      {actions ? (
        <div className="flex flex-none items-center gap-2">{actions}</div>
      ) : null}
    </header>
  );
}
