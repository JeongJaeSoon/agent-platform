import {
  type ComponentProps,
  cloneElement,
  type JSX,
  type MouseEvent,
  type ReactElement,
  type ReactNode,
  type Ref,
  useId,
} from "react";

import { cn } from "../foundations/cn.ts";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "../primitives/tooltip.tsx";

type KeptControlProps = ComponentProps<"button">;

export type DisabledReasonProps =
  | {
      /** A box around a disabled control takes the focus and the reason. */
      readonly mode?: "box" | undefined;
      /** Why the control inside is unavailable. */
      readonly reason: ReactNode;
      /** The withheld action, e.g. "Disable Alex"; the box is read by it. */
      readonly label: string;
      /** The disabled control. */
      readonly children: ReactElement<{ "aria-describedby"?: string }>;
      readonly className?: string | undefined;
    }
  | (Omit<KeptControlProps, "children"> & {
      /**
       * The button itself stays focusable and carries the reason; see
       * `KeptControl`. Other props (a `DialogTrigger asChild` around it
       * passes its own) go to the button.
       */
      readonly mode: "control";
      /** Why the button is unavailable; nothing while it is available. */
      readonly reason: ReactNode | undefined;
      /** A `button` or `Button`, not disabled for the reason itself. */
      readonly children: ReactElement<KeptControlProps>;
    });

/**
 * Says why a control is unavailable, on hover, keyboard focus or a tap,
 * without moving it. The note opens above, where it covers no row below.
 *
 * `box` (the default): a disabled button takes neither focus nor the
 * pointer, so the box around it takes both and carries the reason as its
 * description. `control`: the button stays where focus and the pointer
 * reach it; see `KeptControl`.
 */
export function DisabledReason(props: DisabledReasonProps): JSX.Element {
  if (props.mode === "control") {
    const { mode: _mode, ...rest } = props;
    return <KeptControl {...rest} />;
  }
  return <ReasonBox {...props} />;
}

function ReasonBox({
  reason,
  label,
  children,
  className,
}: Extract<DisabledReasonProps, { label: string }>): JSX.Element {
  const reasonId = useId();
  // Reading the page line by line reaches the control, not the box.
  const control = cloneElement(children, {
    "aria-describedby": [children.props["aria-describedby"], reasonId]
      .filter(Boolean)
      .join(" "),
  });
  return (
    <Tooltip>
      {/* Radix sets type="button" on its trigger, which a span does not take. */}
      <TooltipTrigger asChild={true} type={undefined}>
        {/* biome-ignore lint/a11y/useSemanticElements: a fieldset is a form block, this is an inline box in a row */}
        <span
          role="group"
          aria-label={label}
          aria-disabled={true}
          // biome-ignore lint/a11y/noNoninteractiveTabindex: the disabled control inside cannot take focus, so its reason is reached here
          tabIndex={0}
          data-slot="disabled-reason"
          className={cn(
            "inline-flex shrink-0 rounded-control focus-visible:outline-2 focus-visible:outline-focus-ring focus-visible:outline-offset-2",
            className,
          )}
        >
          {control}
        </span>
      </TooltipTrigger>
      <TooltipContent side="top">{reason}</TooltipContent>
      <span id={reasonId} hidden={true}>
        {reason}
      </span>
    </Tooltip>
  );
}

/**
 * aria-disabled, not disabled, while a reason is set, so the button keeps the
 * focus and shows why. One tree either way: a reason that clears, as a
 * permission check answering, must not remount the button under the pointer
 * or the focus.
 */
function KeptControl({
  reason,
  children,
  ref,
  onClick: outerClick,
  className: outerClassName,
  ...outer
}: Omit<
  Extract<DisabledReasonProps, { mode: "control" }>,
  "mode"
>): JSX.Element {
  const withheld = reason !== undefined && reason !== null;
  const own = children.props;
  // As Radix Slot merges: the button's own props win, handlers both run.
  const passed = Object.fromEntries(
    Object.entries(outer).filter(
      ([key]) => own[key as keyof KeptControlProps] === undefined,
    ),
  );
  const control = cloneElement(children, {
    ...passed,
    ...(withheld && {
      "aria-disabled": true,
      // A DialogTrigger around it would announce a dialog it never opens.
      "aria-haspopup": undefined,
      "aria-expanded": undefined,
      "aria-controls": undefined,
    }),
    ref: mergeRefs(ref, own.ref),
    type: own.type ?? outer.type ?? "button",
    className: cn(
      outerClassName,
      own.className,
      "aria-disabled:cursor-not-allowed",
    ),
    disabled: withheld ? undefined : (own.disabled ?? outer.disabled),
    onClick: (event: MouseEvent<HTMLButtonElement>) => {
      if (withheld) {
        // Left alone, so a tap still pins the reason; a submit button would
        // also submit, from here or from Enter in a field.
        if (event.currentTarget.type === "submit") event.preventDefault();
        return;
      }
      own.onClick?.(event);
      outerClick?.(event);
    },
  });
  return (
    <Tooltip {...(!withheld && { open: false })}>
      <TooltipTrigger asChild={true}>{control}</TooltipTrigger>
      <TooltipContent side="top">{reason}</TooltipContent>
    </Tooltip>
  );
}

function mergeRefs<T>(
  ...refs: (Ref<T> | undefined)[]
): (node: T | null) => void {
  return (node) => {
    for (const ref of refs) {
      if (typeof ref === "function") ref(node);
      else if (ref) ref.current = node;
    }
  };
}
