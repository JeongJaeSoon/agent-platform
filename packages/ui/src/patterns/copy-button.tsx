import { Check, Copy } from "lucide-react";
import {
  type JSX,
  type ReactNode,
  type RefObject,
  useId,
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
  /**
   * Visible text and the button's name ("Copy"). Leave out for an icon-only
   * button named by `aria-label`.
   */
  readonly label?: ReactNode;
  /**
   * What is copied, e.g. "Key ID ak_…": the button's description, so its
   * name stays the visible `label`.
   */
  readonly description?: string;
  /**
   * Visible text once the clipboard took the value; `label` by default. With
   * a fixed `aria-label` or `aria-labelledby` it shows beside the button, in
   * the live status,
   * since a name that differs from the text inside fails label-in-name.
   */
  readonly copiedLabel?: ReactNode;
  /**
   * Announced politely after each copy. A button's changed name is not
   * announced reliably, and a fixed `aria-label` hides it entirely. A copy
   * that settles after `value` changed is not announced; see `onResult`.
   * `copiedLabel` by default when it is not `label`; a `copiedLabel`
   * shown beside the button is announced in its place. Compared by
   * reference, so pass strings.
   */
  readonly copiedMessage?: string;
  /**
   * `swap`: Copy, then Check once copied. `copy`: Copy throughout, for a
   * screen that reports the copy elsewhere. `none`: text only.
   */
  readonly icon?: "swap" | "copy" | "none";
  /**
   * Sizes the icon with a `size-*` class, e.g. `size-3.5`; the button's 16px
   * default skips only icons that carry one.
   */
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
 * A button that copies `value`, showing `copiedLabel` (and a Check, with
 * `icon="swap"`) while the copy holds. Its name is what it shows (WCAG
 * 2.5.3): name the target with `description`, not with `aria-label`. What
 * the screen says about a failure is left to `onResult`.
 */
export function CopyButton({
  value,
  label,
  description,
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
  // Under a fixed name the copied text moves out to the status beside it.
  const fixedName =
    props["aria-label"] !== undefined || props["aria-labelledby"] !== undefined;
  const besideText =
    fixedName &&
    copiedLabel !== label &&
    copiedLabel !== undefined &&
    copiedLabel !== null
      ? copiedLabel
      : null;
  const text = copied && besideText === null ? copiedLabel : label;
  // A swapped label is a changed name, which is not announced reliably.
  const announced =
    copiedMessage ?? (copiedLabel !== label ? copiedLabel : undefined);
  const descriptionId = useId();
  const describedBy =
    [
      props["aria-describedby"],
      description === undefined ? null : descriptionId,
    ]
      .filter(Boolean)
      .join(" ") || undefined;
  return (
    <>
      <Button
        data-slot="copy-button"
        type={type}
        onClick={() => void copy()}
        {...props}
        aria-describedby={describedBy}
        data-copied={copied ? "" : undefined}
      >
        {icon === "none" ? null : (
          <Icon aria-hidden="true" className={iconClassName} />
        )}
        {text === undefined || text === null ? null : <span>{text}</span>}
      </Button>
      {description === undefined ? null : (
        <span id={descriptionId} hidden={true}>
          {description}
        </span>
      )}
      {besideText !== null ? (
        // Out of the flow while empty, so a gap beside it shows only with
        // the text.
        <output data-slot="copy-button-status" className="empty:absolute">
          {copied ? <span key={copies}>{besideText}</span> : null}
        </output>
      ) : announced === undefined || announced === null ? null : (
        <output className="sr-only">
          {copied ? <span key={copies}>{announced}</span> : null}
        </output>
      )}
    </>
  );
}
