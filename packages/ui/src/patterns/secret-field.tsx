import { CircleAlert, Copy } from "lucide-react";
import {
  type ComponentProps,
  type JSX,
  useEffect,
  useRef,
  useState,
} from "react";

import { cn } from "../foundations/cn.ts";
import { Button } from "../primitives/button.tsx";

export type SecretFieldProps = Omit<ComponentProps<"div">, "children"> & {
  /** The value to show and copy, such as an ID or a key shown once. */
  readonly value: string;
  /** The copy button's text. */
  readonly copyLabel: string;
  /** Announced and shown after the value reached the clipboard. */
  readonly copiedMessage: string;
  /** Announced and shown when the clipboard refused; the value is selected. */
  readonly copyFailedMessage: string;
};

type Result = { readonly value: string; readonly ok: boolean };

/**
 * A value in a sunken box with a copy button (mockup v4 `.secret`). The
 * outcome stays on screen under the box and is announced politely.
 */
export function SecretField({
  value,
  copyLabel,
  copiedMessage,
  copyFailedMessage,
  className,
  ...props
}: SecretFieldProps): JSX.Element {
  const valueRef = useRef<HTMLSpanElement>(null);
  const [result, setResult] = useState<Result | null>(null);
  // A new value clears the old result, so A -> B -> A does not bring it back.
  const [resultFor, setResultFor] = useState(value);
  if (resultFor !== value) {
    setResultFor(value);
    setResult(null);
  }
  // A copy that settles after the value changed must not report or select.
  const latest = useRef(value);
  useEffect(() => {
    latest.current = value;
  }, [value]);
  const shown = result?.value === value ? result : null;

  const copy = async () => {
    const copied = value;
    let ok = true;
    try {
      const clipboard = globalThis.navigator?.clipboard;
      if (!clipboard) throw new Error("clipboard unavailable");
      await clipboard.writeText(copied);
    } catch {
      ok = false;
    }
    if (latest.current !== copied) return;
    // Selected, the value is one keystroke from a manual copy.
    if (!ok && valueRef.current) {
      globalThis.getSelection?.()?.selectAllChildren(valueRef.current);
    }
    setResult({ value: copied, ok });
  };

  return (
    <div
      data-slot="secret-field"
      className={cn("min-w-0", className)}
      {...props}
    >
      <div className="flex items-center gap-2 rounded-control border bg-surface-sunken px-3 py-2">
        <span
          ref={valueRef}
          className="min-w-0 flex-1 select-all font-mono text-caption [overflow-wrap:anywhere]"
        >
          {value}
        </span>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={value === ""}
          onClick={() => void copy()}
        >
          <Copy aria-hidden="true" className="size-3.5" strokeWidth={1.5} />
          {copyLabel}
        </Button>
      </div>
      <p
        aria-live="polite"
        className={cn(
          "m-0 flex items-center gap-1 text-caption",
          shown?.ok === false ? "text-destructive" : "text-subtle-foreground",
          shown && "mt-2",
        )}
      >
        {shown ? (
          shown.ok ? (
            copiedMessage
          ) : (
            <>
              <CircleAlert
                aria-hidden="true"
                className="size-3.5 shrink-0"
                strokeWidth={1.5}
              />
              {copyFailedMessage}
            </>
          )
        ) : null}
      </p>
    </div>
  );
}
