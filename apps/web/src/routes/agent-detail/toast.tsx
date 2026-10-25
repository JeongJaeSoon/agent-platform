import { type ReactNode, useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";

const SHOWN_MS = 4000;

/**
 * A short notice floating over the page bottom. It never takes focus or
 * moves the layout. Each notice mounts a fresh region on `document.body`, so
 * a modal dialog opened earlier has not hidden it from assistive technology.
 */
export function useToast(): {
  readonly notify: (text: string) => void;
  readonly toast: ReactNode;
} {
  const [current, setCurrent] = useState<{
    readonly id: number;
    readonly text: string;
  } | null>(null);
  const notify = useCallback(
    (text: string) =>
      setCurrent((previous) => ({ id: (previous?.id ?? 0) + 1, text })),
    [],
  );
  const dismiss = useCallback(() => setCurrent(null), []);
  return {
    notify,
    toast: current ? (
      <Toast key={current.id} text={current.text} onDone={dismiss} />
    ) : null,
  };
}

function Toast({
  text,
  onDone,
}: {
  readonly text: string;
  readonly onDone: () => void;
}) {
  // The region exists empty first: a live region inserted with its text
  // already in it is not announced by every screen reader.
  const [shown, setShown] = useState("");
  useEffect(() => {
    const fill = setTimeout(() => setShown(text), 50);
    const done = setTimeout(onDone, SHOWN_MS);
    return () => {
      clearTimeout(fill);
      clearTimeout(done);
    };
  }, [text, onDone]);
  return createPortal(
    <output
      aria-live="polite"
      data-slot="toast"
      className="pointer-events-none fixed inset-x-4 bottom-4 z-[60] flex justify-center sm:inset-x-auto sm:right-6 sm:bottom-6"
    >
      {shown ? (
        <p className="m-0 max-w-sm rounded-card border bg-popover px-4 py-3 text-control text-popover-foreground shadow-pop">
          {shown}
        </p>
      ) : null}
    </output>,
    document.body,
  );
}
