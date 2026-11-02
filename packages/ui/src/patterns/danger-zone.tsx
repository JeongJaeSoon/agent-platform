import {
  type ComponentProps,
  type JSX,
  type ReactNode,
  type Ref,
  useId,
} from "react";

import { cn } from "../foundations/cn.ts";
import { RowList } from "../primitives/row-list.tsx";
import { DisabledReason } from "./disabled-reason.tsx";
import { RowAction } from "./row-action.tsx";
import { SettingRow } from "./setting-row.tsx";

export type DangerZoneProps = Omit<ComponentProps<"section">, "title"> & {
  /** "Danger zone" in the reader's language. */
  readonly title: ReactNode;
  readonly titleAs?: "h2" | "h3" | undefined;
  /** For a page whose section links point at the heading. */
  readonly titleId?: string | undefined;
  /** `DangerZoneRow`s. */
  readonly children: ReactNode;
};

/**
 * The last section of a settings screen, holding what is hard to undo:
 * a red heading over one red-bordered box, a row per action. The danger
 * foreground holds AA on every surface in both themes (tokens.css test), so
 * the border drawn in it clears the 3:1 a component edge needs.
 */
export function DangerZone({
  title,
  titleAs: Heading = "h2",
  titleId,
  children,
  className,
  ...props
}: DangerZoneProps): JSX.Element {
  const ownId = useId();
  const headingId = titleId ?? ownId;
  return (
    <section
      data-slot="danger-zone"
      aria-labelledby={headingId}
      className={cn("flex flex-col gap-3", className)}
      {...props}
    >
      <Heading
        id={headingId}
        className="m-0 font-semibold text-body text-destructive leading-6"
      >
        {title}
      </Heading>
      <RowList variant="joined" className="border-destructive">
        {children}
      </RowList>
    </section>
  );
}

export type DangerZoneRowProps = {
  /** What the action does, naming its target: "Delete the GitHub App". */
  readonly title: ReactNode;
  /** One line on what is lost. */
  readonly description: ReactNode;
  /** The button's word: "Delete". */
  readonly actionLabel: string;
  /** The button's full name when the word alone is ambiguous. */
  readonly actionName?: string | undefined;
  /** Opens the confirmation; the row never acts by itself. */
  readonly onAction: () => void;
  readonly disabled?: boolean | undefined;
  /** Why the action is unavailable; the button is disabled and says so. */
  readonly reason?: ReactNode | undefined;
  readonly actionRef?: Ref<HTMLButtonElement> | undefined;
};

export function DangerZoneRow({
  title,
  description,
  actionLabel,
  actionName,
  onAction,
  disabled = false,
  reason,
  actionRef,
}: DangerZoneRowProps): JSX.Element {
  const withheld = reason !== undefined && reason !== null;
  // Right ends align down the zone; each width follows its label.
  const button = (
    <RowAction
      ref={actionRef}
      variant="danger"
      aria-label={actionName}
      disabled={disabled || withheld}
      onClick={onAction}
    >
      {actionLabel}
    </RowAction>
  );
  return (
    <SettingRow
      title={title}
      description={description}
      actions={
        withheld ? (
          <DisabledReason reason={reason} label={actionName ?? actionLabel}>
            {button}
          </DisabledReason>
        ) : (
          button
        )
      }
    />
  );
}
