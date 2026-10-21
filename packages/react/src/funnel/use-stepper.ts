import type { ReactNode } from "react";
import { useAgentPlatform } from "../provider.tsx";

export interface StepInput {
  readonly id: string;
  readonly label: ReactNode;
  readonly description?: ReactNode | undefined;
}

export interface StepperOptions {
  readonly steps: readonly StepInput[];
  readonly currentStepId: string;
  /** Called with a finished step the user picked to look at again. */
  readonly onStepSelect?: ((id: string) => void) | undefined;
}

/** The props `@werft-ai/ui`'s Stepper takes, less its `label`. */
export interface StepperState {
  readonly steps: readonly (StepInput & { readonly disabled: boolean })[];
  readonly currentStepId: string;
  readonly onStepSelect?: ((id: string) => void) | undefined;
  readonly completedLabel: string;
}

/**
 * A finished step can be opened again and the current one stays reachable;
 * a step not yet reached cannot be skipped to.
 */
export function useStepper({
  steps,
  currentStepId,
  onStepSelect,
}: StepperOptions): StepperState {
  const { messages } = useAgentPlatform();
  const currentIndex = steps.findIndex((step) => step.id === currentStepId);
  return {
    steps: steps.map((step, index) => ({
      ...step,
      disabled: index > currentIndex,
    })),
    currentStepId,
    ...(onStepSelect
      ? {
          onStepSelect: (id: string) => {
            if (id !== currentStepId) onStepSelect(id);
          },
        }
      : {}),
    completedLabel: messages["flow.stepCompleted"],
  };
}
