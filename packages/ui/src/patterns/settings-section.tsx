import { type FormEvent, type JSX, type ReactNode, useId } from "react";

import { RowList } from "../primitives/row-list.tsx";

export interface SettingsSectionProps {
  /** A fragment others link to. */
  readonly id?: string | undefined;
  readonly title: string;
  /** `h3` under a page whose own sections are `h2`. */
  readonly titleAs?: "h2" | "h3" | undefined;
  /** After the title, outside the heading's name: a count. */
  readonly badge?: ReactNode | undefined;
  readonly description?: string | undefined;
  readonly descriptionId?: string | undefined;
  /** SettingRows under the body, edge to edge like the foot. */
  readonly rows?: ReactNode | undefined;
  readonly foot?: ReactNode | undefined;
  /** Wraps the body, rows and foot in a form. */
  readonly onSubmit?: ((event: FormEvent) => void) | undefined;
  readonly children?: ReactNode | undefined;
}

/**
 * A settings page's block: a title ruled off from its body, an optional
 * description, then the body, a joined list of SettingRows and a foot.
 */
export function SettingsSection({
  id,
  title,
  titleAs: Heading = "h2",
  badge,
  description,
  descriptionId,
  rows,
  foot,
  onSubmit,
  children,
}: SettingsSectionProps): JSX.Element {
  const titleId = useId();
  const content = (
    <>
      {children}
      {rows ? <RowList variant="joined">{rows}</RowList> : null}
      {foot ? (
        <div className="flex flex-wrap items-center justify-between gap-3">
          {foot}
        </div>
      ) : null}
    </>
  );
  return (
    <section id={id} aria-labelledby={titleId} className="flex flex-col gap-4">
      <div className="flex flex-col gap-1 border-b pb-2">
        <div className="flex items-center gap-2">
          <Heading
            id={titleId}
            className="m-0 font-semibold text-body leading-6"
          >
            {title}
          </Heading>
          {badge}
        </div>
        {description ? (
          // The rule above runs to the page's edge; the text keeps to a
          // reading line.
          <p
            id={descriptionId}
            className="m-0 max-w-[var(--ap-layout-reading-width)] text-control text-muted-foreground"
          >
            {description}
          </p>
        ) : null}
      </div>
      {onSubmit ? (
        // noValidate: the server owns the limits and says why it refused.
        <form onSubmit={onSubmit} noValidate className="flex flex-col gap-4">
          {content}
        </form>
      ) : (
        content
      )}
    </section>
  );
}
