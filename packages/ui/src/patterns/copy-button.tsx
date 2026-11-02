import { Check, Copy } from "lucide-react";
import {
  type JSX,
  type ReactNode,
  type RefObject,
  useLayoutEffect,
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
   * Announced politely after each copy. A button's changed name is not
   * announced reliably, and a fixed `aria-label` hides it entirely.
   */
  readonly copiedMessage?: string;
  /**
   * `swap`: Copy, then Check once copied. `copy`: Copy throughout, for a
   * screen that reports the copy elsewhere. `none`: text only.
   */
  readonly icon?: "swap" | "copy" | "none";
  /** Sizes the icon, e.g. `size-3.5`; the button's default is 16px. */
  readonly iconClassName?: string;
  /** Focused when the clipboard refuses, so it can select the value. */
  readonly fallbackField?: RefObject<HTMLElement | null>;
  /**
   * The outcome of the latest click, for the screen to show its own success
   * or failure line. Reported even if `value` changed meanwhile, with the
   * value that was copied.
   */
  readonly onResult?: (copied: boolean, value: string) => void;
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
  icon = "swap",
  iconClassName,
  fallbackField,
  onResult,
  type = "button",
  ...props
}: CopyButtonProps): JSX.Element {
  // Counts successes, so a repeated copy is announced again.
  const [copies, setCopies] = useState(0);
  const [copied, setCopied] = useState(false);
  const [copiedFor, setCopiedFor] = useState(value);
  if (copiedFor !== value) {
    setCopiedFor(value);
    setCopied(false);
  }
  // A layout effect runs in the commit, before any copy can settle against
  // the new value; a passive one could run after.
  const epoch = useRef({ value, count: 0 });
  useLayoutEffect(() => {
    if (epoch.current.value !== value)
      epoch.current = { value, count: epoch.current.count + 1 };
  }, [value]);
  const clicks = useRef(0);

  const copy = async () => {
    const click = ++clicks.current;
    const started = epoch.current.count;
    const text = value;
    const ok = await writeClipboard(text);
    // A later click supersedes this one; a later value keeps the report but
    // not the button's state or the focus.
    if (click !== clicks.current) return;
    if (started === epoch.current.count) {
      if (!ok) fallbackField?.current?.focus();
      setCopied(ok);
      if (ok) setCopies((count) => count + 1);
    }
    onResult?.(ok, text);
  };

  const Icon = copied && icon === "swap" ? Check : Copy;
  const text = copied ? copiedLabel : label;
  return (
    <>
      <Button
        data-slot="copy-button"
        type={type}
        onClick={() => void copy()}
        {...props}
        data-copied={copied ? "" : undefined}
      >
        {icon === "none" ? null : (
          <Icon aria-hidden="true" className={iconClassName} />
        )}
        {text === undefined || text === null ? null : <span>{text}</span>}
      </Button>
      {copiedMessage === undefined ? null : (
        <output className="sr-only">
          {copied ? <span key={copies}>{copiedMessage}</span> : null}
        </output>
      )}
    </>
  );
}
