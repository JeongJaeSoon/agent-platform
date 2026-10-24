import type { ComponentProps, JSX, ReactNode } from "react";

import { cn } from "../foundations/cn.ts";
import { Field, FieldDescription, FieldLabel } from "../primitives/field.tsx";
import { RowLines, RowListItem } from "../primitives/row-list.tsx";

export type SettingRowProps = Omit<ComponentProps<"li">, "title"> & {
  readonly title: ReactNode;
  /** A Badge after the title, outside the control's name. */
  readonly badge?: ReactNode | undefined;
  readonly description?: ReactNode | undefined;
  /** Lines under the description, such as a value or a time. */
  readonly meta?: ReactNode | undefined;
  /** Words for the control's state, before it. Not part of its name. */
  readonly status?: ReactNode | undefined;
  /**
   * One form control (Switch, NativeSelect). The title becomes its name and
   * the description its description.
   */
  readonly control?: ReactNode | undefined;
  /** Buttons. They keep their own names. */
  readonly actions?: ReactNode | undefined;
};

const TITLE = "m-0 font-medium text-control leading-5";
const DESCRIPTION = "m-0 text-caption text-subtle-foreground leading-4";

/**
 * One setting in a `RowList variant="joined"`: title and description on the
 * left, the control on the right. Below 640px the control goes under the
 * text, at the right edge.
 */
export function SettingRow({
  title,
  badge,
  description,
  meta,
  status,
  control,
  actions,
  className,
  ...props
}: SettingRowProps): JSX.Element {
  const labelled = control !== undefined && control !== null;
  const body = (
    <>
      <RowLines>
        <span className="flex flex-wrap items-center gap-2">
          {labelled ? (
            <FieldLabel className={TITLE}>{title}</FieldLabel>
          ) : (
            <span className={TITLE}>{title}</span>
          )}
          {badge}
        </span>
        {description ? (
          labelled ? (
            <FieldDescription className={cn(DESCRIPTION, "nth-last-2:mt-0")}>
              {description}
            </FieldDescription>
          ) : (
            <p className={DESCRIPTION}>{description}</p>
          )
        ) : null}
        {meta}
      </RowLines>
      {labelled || status || actions ? (
        <div className="flex shrink-0 flex-wrap items-center justify-end gap-2 self-end sm:self-auto">
          {status}
          {control}
          {actions}
        </div>
      ) : null}
    </>
  );
  return (
    <RowListItem
      data-slot="setting-row"
      className={cn(
        "flex-col flex-nowrap items-stretch sm:flex-row sm:items-center",
        className,
      )}
      {...props}
    >
      {labelled ? (
        // The Field only lends its ids; its children lay out in the row.
        <Field orientation="horizontal" className="contents">
          {body}
        </Field>
      ) : (
        body
      )}
    </RowListItem>
  );
}
