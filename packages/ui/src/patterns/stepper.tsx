import { Check } from "lucide-react";
import {
  type JSX,
  type KeyboardEvent,
  type ReactNode,
  useRef,
  useState,
} from "react";

import { cn } from "../foundations/cn.ts";

/*
 * Not a shadcn item (shadcn has no stepper). The steps form one tab stop:
 * Tab lands on the current step, the arrow keys, Home and End move between
 * steps that can be selected, and Enter or Space selects one. Which steps a
 * user may go back or forward to is the screen's decision, passed in as
 * `disabled`; without `onStepSelect` the steps are only a progress display.
 */

export interface StepperStep {
  readonly id: string;
  readonly label: ReactNode;
  readonly description?: ReactNode | undefined;
  readonly disabled?: boolean | undefined;
}

export interface StepperProps {
  readonly steps: readonly StepperStep[];
  readonly currentStepId: string;
  /** Names the step list for screen readers, e.g. "에이전트 만들기 단계". */
  readonly label: string;
  readonly onStepSelect?: ((id: string) => void) | undefined;
  /** Read out after each step before the current one. */
  readonly completedLabel?: string | undefined;
  readonly className?: string | undefined;
}

type StepState = "complete" | "current" | "upcoming";

const NEXT_KEYS = new Set(["ArrowRight", "ArrowDown"]);
const PREVIOUS_KEYS = new Set(["ArrowLeft", "ArrowUp"]);

export function Stepper({
  steps,
  currentStepId,
  label,
  onStepSelect,
  completedLabel = "완료",
  className,
}: StepperProps): JSX.Element {
  const currentIndex = steps.findIndex((step) => step.id === currentStepId);
  const [focusId, setFocusId] = useState(currentStepId);
  // When the screen moves to another step, the tab stop follows it.
  const [shownStepId, setShownStepId] = useState(currentStepId);
  if (shownStepId !== currentStepId) {
    setShownStepId(currentStepId);
    setFocusId(currentStepId);
  }
  const buttons = useRef(new Map<string, HTMLButtonElement>());
  const selectable = steps.filter((step) => !step.disabled);
  const tabStopId = selectable.some((step) => step.id === focusId)
    ? focusId
    : (selectable.find((step) => step.id === currentStepId) ?? selectable[0])
        ?.id;

  const moveFocus = (event: KeyboardEvent, fromId: string): void => {
    const at = selectable.findIndex((step) => step.id === fromId);
    let target: StepperStep | undefined;
    if (NEXT_KEYS.has(event.key))
      target = selectable[(at + 1) % selectable.length];
    else if (PREVIOUS_KEYS.has(event.key))
      target = selectable[(at - 1 + selectable.length) % selectable.length];
    else if (event.key === "Home") target = selectable[0];
    else if (event.key === "End") target = selectable.at(-1);
    if (!target) return;
    event.preventDefault();
    setFocusId(target.id);
    buttons.current.get(target.id)?.focus();
  };

  return (
    <nav aria-label={label} data-slot="stepper" className={className}>
      <ol className="flex flex-col gap-3 sm:flex-row sm:gap-4">
        {steps.map((step, index) => {
          const state: StepState =
            index < currentIndex
              ? "complete"
              : index === currentIndex
                ? "current"
                : "upcoming";
          const body = (
            <>
              <StepIndicator state={state} number={index + 1} />
              <span className="flex min-w-0 flex-col gap-0.5 text-left">
                <span className="font-medium text-sm leading-snug">
                  {step.label}
                  {state === "complete" ? (
                    <span className="sr-only">, {completedLabel}</span>
                  ) : null}
                </span>
                {step.description ? (
                  <span className="text-muted-foreground text-xs leading-snug">
                    {step.description}
                  </span>
                ) : null}
              </span>
            </>
          );
          const itemClass = cn(
            "flex items-start gap-2 rounded-md p-1 text-muted-foreground",
            state === "current" && "text-foreground",
            state === "complete" && "text-foreground",
          );
          return (
            <li
              key={step.id}
              data-slot="stepper-step"
              data-state={state}
              className="sm:flex-1"
            >
              {onStepSelect ? (
                <button
                  type="button"
                  ref={(node) => {
                    if (node) buttons.current.set(step.id, node);
                    else buttons.current.delete(step.id);
                  }}
                  aria-current={state === "current" ? "step" : undefined}
                  disabled={step.disabled}
                  tabIndex={step.id === tabStopId ? 0 : -1}
                  onFocus={() => setFocusId(step.id)}
                  onKeyDown={(event) => moveFocus(event, step.id)}
                  onClick={() => onStepSelect(step.id)}
                  className={cn(
                    itemClass,
                    "w-full outline-none transition-[color,box-shadow] hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none",
                  )}
                >
                  {body}
                </button>
              ) : (
                <div
                  aria-current={state === "current" ? "step" : undefined}
                  className={itemClass}
                >
                  {body}
                </div>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

function StepIndicator({
  state,
  number,
}: {
  readonly state: StepState;
  readonly number: number;
}): JSX.Element {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "grid size-6 shrink-0 place-content-center rounded-full border font-medium text-xs",
        state === "upcoming" && "border-input bg-card text-muted-foreground",
        state !== "upcoming" &&
          "border-primary bg-primary text-primary-foreground",
        state === "current" && "ring-[3px] ring-primary/25",
      )}
    >
      {state === "complete" ? (
        <Check className="size-3.5" strokeWidth={2} aria-hidden="true" />
      ) : (
        number
      )}
    </span>
  );
}
