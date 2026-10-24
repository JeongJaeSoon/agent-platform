import { type ComponentProps, type JSX, type ReactNode, useId } from "react";

export type SectionProps = Omit<ComponentProps<"section">, "title"> & {
  readonly title: ReactNode;
  /** The heading level; `h2` under a page's `h1`. */
  readonly titleAs?: "h2" | "h3" | "h4" | undefined;
  /** A Badge after the title, outside the heading's name. */
  readonly badge?: ReactNode | undefined;
  /** One meta line under the title. */
  readonly description?: ReactNode | undefined;
  /** The section's own actions, on the right of its head. */
  readonly actions?: ReactNode | undefined;
};

/**
 * A titled block of a page (mockup v4 `.section-head`): head 28px tall,
 * 12px above the content. The space between sections is the page's.
 */
export function Section({
  title,
  titleAs: Heading = "h2",
  badge,
  description,
  actions,
  className,
  children,
  ...props
}: SectionProps): JSX.Element {
  const titleId = useId();
  return (
    <section
      data-slot="section"
      aria-labelledby={titleId}
      className={className}
      {...props}
    >
      <div className="mb-3 flex min-h-7 items-center justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-0.5">
          <div className="flex items-center gap-2">
            <Heading
              id={titleId}
              className="m-0 font-semibold text-body leading-5"
            >
              {title}
            </Heading>
            {badge}
          </div>
          {description ? (
            <p className="m-0 text-caption text-subtle-foreground leading-normal">
              {description}
            </p>
          ) : null}
        </div>
        {actions ? (
          <div className="flex flex-none items-center gap-2">{actions}</div>
        ) : null}
      </div>
      {children}
    </section>
  );
}
