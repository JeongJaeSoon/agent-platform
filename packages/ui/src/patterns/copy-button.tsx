import { Check, Copy } from "lucide-react";
import {
  type JSX,
  type ReactNode,
  type RefObject,
  useEffect,
  useRef,
  useState,
} from "react";

import { writeClipboard } from "../foundations/clipboard.ts";
import { Button, type ButtonProps } from "../primitives/button.tsx";

export type CopyButtonProps = Omit<
  ButtonProps,
  "asChild" | "children" | "onClick"
> & {
  /** What goes to the clipboard. */
  readonly value: string;
  /** Visible text. Leave out for an icon-only button named by `aria-label`. */
  readonly label?: ReactNode;
  /**
   * Visible text once the clipboard took the value; `label` by default. Not
   * beside a fixed `aria-label` that lacks it: that fails label-in-name.
   */
  readonly copiedLabel?: ReactNode;
  /**
   * Announced politely after a copy. A button's changed name is not announced
   * reliably, and a fixed `aria-label` hides it entirely.
   */
  readonly copiedMessage?: string;
  /** Leaves out the Copy icon that turns into a Check once copied. */
  readonly hideIcon?: boolean;
  /** Focused when the clipboard refuses, so it can select the value. */
  readonly fallbackField?: RefObject<HTMLElement | null>;
  /** The outcome, for the screen to show its own success or failure line. */
  readonly onResult?: (copied: boolean) => void;
};

/**
 * A button that copies `value`. Its icon turns into a Check while the copy
 * holds; what the screen says about it is left to `onResult`.
 */
export function CopyButton({
  value,
  label,
  copiedLabel = label,
  copiedMessage,
  hideIcon = false,
  fallbackField,
  onResult,
  type = "button",
  ...props
}: CopyButtonProps): JSX.Element {
  const [copied, setCopied] = useState(false);
  // A new value has not been copied yet.
  const [copiedFor, setCopiedFor] = useState(value);
  if (copiedFor !== value) {
    setCopiedFor(value);
    setCopied(false);
  }
  // A copy that settles after the value changed must not report.
  const latest = useRef(value);
  useEffect(() => {
    latest.current = value;
  }, [value]);

  const copy = async () => {
    const started = value;
    const ok = await writeClipboard(started);
    if (latest.current !== started) return;
    if (!ok) fallbackField?.current?.focus();
    setCopied(ok);
    onResult?.(ok);
  };

  const Icon = copied ? Check : Copy;
  const text = copied ? copiedLabel : label;
  return (
    <>
      <Button
        data-slot="copy-button"
        data-copied={copied ? "" : undefined}
        type={type}
        onClick={() => void copy()}
        {...props}
      >
        {hideIcon ? null : <Icon aria-hidden="true" />}
        {text === undefined || text === null ? null : <span>{text}</span>}
      </Button>
      {copiedMessage === undefined ? null : (
        <output className="sr-only">{copied ? copiedMessage : ""}</output>
      )}
    </>
  );
}
