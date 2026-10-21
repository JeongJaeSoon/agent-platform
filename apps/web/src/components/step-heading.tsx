import { type ReactNode, useEffect, useRef, useState } from "react";

/**
 * Whether a step flow has left the step it opened on. A step heading takes
 * focus once the flow has moved, not on arrival.
 */
export function useStepMoved(step: string): boolean {
  const [firstStep] = useState(step);
  const [moved, setMoved] = useState(false);
  if (!moved && step !== firstStep) setMoved(true);
  return moved;
}

/** A step's heading, which takes focus when the flow moves onto the step. */
export function StepHeading({
  focus,
  id,
  children,
}: {
  readonly focus: boolean;
  readonly id?: string;
  readonly children: ReactNode;
}) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (focus) heading.current?.focus();
  }, [focus]);
  return (
    <h2
      ref={heading}
      id={id}
      tabIndex={-1}
      className="m-0 font-semibold text-lg outline-none"
    >
      {children}
    </h2>
  );
}
