import {
  type ComponentProps,
  createContext,
  type JSX,
  type PointerEvent,
  type ReactNode,
  type Ref,
  useContext,
  useId,
  useRef,
  useState,
} from "react";

import { Popover, PopoverContent, PopoverTrigger } from "./popover.tsx";

/*
 * A Popover held open by hover and keyboard focus as well as by a press, so
 * the note reaches mouse, keyboard and touch users alike (Radix's own
 * Tooltip never opens on a tap). Focus never moves into the note: the
 * trigger keeps it, and names the note with aria-describedby through a
 * hidden copy that is there while the note is closed too.
 */

type OpenedBy = "hover" | "focus" | "press";

interface TooltipContextValue {
  readonly show: (by: OpenedBy) => void;
  readonly hide: () => void;
  readonly descriptionId: string;
  /** Set by the trigger's click, read by the toggle Radix runs after it. */
  readonly pressed: { current: boolean };
  readonly trigger: { current: HTMLElement | null };
  readonly content: { current: HTMLElement | null };
}

const TooltipContext = createContext<TooltipContextValue | null>(null);

function useTooltip(part: string): TooltipContextValue {
  const context = useContext(TooltipContext);
  if (!context) throw new Error(`${part} must be used within <Tooltip>`);
  return context;
}

export interface TooltipProps {
  readonly open?: boolean;
  readonly defaultOpen?: boolean;
  readonly onOpenChange?: (open: boolean) => void;
  readonly children: ReactNode;
}

export function Tooltip({
  open: openProp,
  defaultOpen = false,
  onOpenChange,
  children,
}: TooltipProps): JSX.Element {
  const [uncontrolled, setUncontrolled] = useState(defaultOpen);
  const open = openProp ?? uncontrolled;
  const openedBy = useRef<OpenedBy | null>(null);
  const pressed = useRef(false);
  const trigger = useRef<HTMLElement | null>(null);
  const content = useRef<HTMLElement | null>(null);
  const descriptionId = useId();

  const setOpen = (next: boolean) => {
    if (!next) openedBy.current = null;
    if (openProp === undefined) setUncontrolled(next);
    if (next !== open) onOpenChange?.(next);
  };
  const show = (by: OpenedBy) => {
    openedBy.current ??= by;
    setOpen(true);
  };
  const hide = () => setOpen(false);

  // Radix calls this for its trigger toggle, Escape and a press outside.
  const onPopoverOpenChange = (next: boolean) => {
    if (!pressed.current) return setOpen(next);
    pressed.current = false;
    // A press on a note that hover or focus opened pins it rather than
    // closing it: a mouse hovers before it clicks, and a tap focuses first.
    if (open && openedBy.current !== "press") {
      openedBy.current = "press";
      return;
    }
    if (next) openedBy.current = "press";
    setOpen(next);
  };

  return (
    <TooltipContext.Provider
      value={{ show, hide, descriptionId, pressed, trigger, content }}
    >
      <Popover open={open} onOpenChange={onPopoverOpenChange}>
        {children}
      </Popover>
    </TooltipContext.Provider>
  );
}

function within(
  element: { current: HTMLElement | null },
  target: EventTarget | null,
): boolean {
  return target instanceof Node && (element.current?.contains(target) ?? false);
}

function assignRef<T>(ref: Ref<T> | undefined, node: T | null): void {
  if (typeof ref === "function") ref(node);
  else if (ref) ref.current = node;
}

export function TooltipTrigger({
  ref,
  onPointerEnter,
  onPointerLeave,
  onFocus,
  onBlur,
  onClick,
  ...props
}: ComponentProps<typeof PopoverTrigger>): JSX.Element {
  const tooltip = useTooltip("TooltipTrigger");
  return (
    <PopoverTrigger
      {...props}
      ref={(node) => {
        tooltip.trigger.current = node;
        assignRef(ref, node);
      }}
      // A description, not a popup the trigger controls.
      aria-haspopup={false}
      aria-expanded={undefined}
      aria-controls={undefined}
      aria-describedby={tooltip.descriptionId}
      onPointerEnter={(event: PointerEvent<HTMLButtonElement>) => {
        onPointerEnter?.(event);
        if (event.pointerType === "mouse") tooltip.show("hover");
      }}
      onPointerLeave={(event: PointerEvent<HTMLButtonElement>) => {
        onPointerLeave?.(event);
        if (
          event.pointerType === "mouse" &&
          !within(tooltip.content, event.relatedTarget)
        )
          tooltip.hide();
      }}
      onFocus={(event) => {
        onFocus?.(event);
        tooltip.show("focus");
      }}
      onBlur={(event) => {
        onBlur?.(event);
        if (!within(tooltip.content, event.relatedTarget)) tooltip.hide();
      }}
      onClick={(event) => {
        onClick?.(event);
        tooltip.pressed.current = true;
      }}
    />
  );
}

export function TooltipContent({
  ref,
  children,
  onPointerLeave,
  ...props
}: Omit<
  ComponentProps<typeof PopoverContent>,
  "onOpenAutoFocus" | "onCloseAutoFocus"
>): JSX.Element {
  const tooltip = useTooltip("TooltipContent");
  return (
    <>
      <span id={tooltip.descriptionId} hidden={true}>
        {children}
      </span>
      <PopoverContent
        {...props}
        ref={(node) => {
          tooltip.content.current = node;
          assignRef(ref, node);
        }}
        // The trigger already carries the hidden copy as its description.
        role="tooltip"
        aria-hidden={true}
        onOpenAutoFocus={(event) => event.preventDefault()}
        // Closing on a hover that ended must not pull focus to the trigger.
        onCloseAutoFocus={(event) => event.preventDefault()}
        onPointerLeave={(event) => {
          onPointerLeave?.(event);
          if (
            event.pointerType === "mouse" &&
            !within(tooltip.trigger, event.relatedTarget)
          )
            tooltip.hide();
        }}
      >
        {children}
      </PopoverContent>
    </>
  );
}
