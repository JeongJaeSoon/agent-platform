import type { SessionScope } from "@werft-ai/contracts";
import { cn, Tooltip, TooltipContent, TooltipTrigger } from "@werft-ai/ui";
import type { ButtonHTMLAttributes } from "react";
import { useI18n } from "../i18n/i18n.tsx";
import { useCan } from "./guard.tsx";

export interface GuardedButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement> {
  readonly scope: SessionScope;
}

/** A button that stays visible but inert, saying why, without the scope. */
export function GuardedButton({ scope, ...rest }: GuardedButtonProps) {
  const allowed = useCan(scope);
  const { t } = useI18n();
  return (
    <ReasonButton
      {...rest}
      reason={allowed ? undefined : t("guard.missingScope", { scope })}
    />
  );
}

export interface ReasonButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** Why the action is unavailable; the button is inert while it is set. */
  readonly reason: string | undefined;
}

/**
 * The shape every withheld action takes: still on the page at its own width,
 * inert, and saying why on hover, focus or a tap, described by the reason so
 * a screen reader hears it. aria-disabled, not disabled: a disabled button
 * takes neither the pointer nor focus, so its reason could not be shown.
 */
export function ReasonButton({
  reason,
  disabled,
  className = "ap-button",
  onClick,
  children,
  ...rest
}: ReasonButtonProps) {
  const withheld = reason !== undefined;
  // One tree either way: a reason that clears, as a permission check
  // answering, must not remount the button under the pointer or the focus.
  return (
    <Tooltip {...(!withheld && { open: false })}>
      <TooltipTrigger asChild={true}>
        <button
          type="button"
          {...rest}
          {...(withheld && {
            "aria-disabled": true,
            // A DialogTrigger around it would announce a dialog it never opens.
            "aria-haspopup": undefined,
            "aria-expanded": undefined,
            "aria-controls": undefined,
          })}
          className={cn(
            className,
            "aria-disabled:cursor-not-allowed aria-disabled:opacity-45",
          )}
          disabled={withheld ? undefined : disabled}
          onClick={(event) => {
            if (!withheld) return onClick?.(event);
            // Left alone, so a tap still pins the reason; a submit button
            // would also submit, from here or from Enter in a field.
            if (event.currentTarget.type === "submit") event.preventDefault();
          }}
        >
          {children}
        </button>
      </TooltipTrigger>
      <TooltipContent side="top">{reason}</TooltipContent>
    </Tooltip>
  );
}
