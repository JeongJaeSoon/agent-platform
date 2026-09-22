import * as Dialog from "@radix-ui/react-dialog";
import type { JSX, ReactNode } from "react";
import { useEffect, useId, useRef } from "react";

import { cn } from "../lib/cn.ts";

export interface ConfirmDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly title: string;
  /**
   * What actually happens if they go through with it — stated in the user's
   * own terms. Required, because a confirmation without a consequence is a
   * speed bump, not a decision (Kollegium §12.4).
   */
  readonly consequence: ReactNode;
  readonly onConfirm: () => void;
  readonly confirmLabel?: string | undefined;
  readonly cancelLabel?: string | undefined;
  /**
   * The request is in flight. The owner keeps the dialog open until the server
   * answers: 승인·활성화·취소에 optimistic 성공을 쓰지 않는다 (§1).
   */
  readonly busy?: boolean | undefined;
  readonly confirmDisabled?: boolean | undefined;
  readonly tone?: "default" | "danger" | undefined;
  /** Extra controls between the consequence and the buttons. */
  readonly children?: ReactNode | undefined;
  readonly className?: string | undefined;
}

export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  consequence,
  onConfirm,
  confirmLabel = "확인",
  cancelLabel = "취소",
  busy = false,
  confirmDisabled = false,
  tone = "default",
  children,
  className,
}: ConfirmDialogProps): JSX.Element {
  /*
   * Who to give the keyboard back to. Radix restores focus to `Dialog.Trigger`,
   * but the screens own their buttons and never mount one, so its ref is empty
   * and focus falls to <body> — a keyboard user loses their place.
   *
   * Tracked by watching focus rather than read at open time: Radix skips its
   * own open event when a child already took focus (an `autoFocus` input), and
   * by the time any effect of ours runs the opener is no longer current. The
   * last thing focused outside *this* content is the opener — outside this one
   * specifically, so a dialog opened from within another returns to the button
   * inside it.
   *
   * The marker attribute rather than a ref: React attaches a parent's ref after
   * the subtree is in the DOM, so an `autoFocus` child fires before we could
   * recognise our own content by it. The attribute is already there.
   */
  const instanceId = useId();
  const openerRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const remember = (event: FocusEvent): void => {
      const target = event.target as HTMLElement | null;
      if (
        !target?.closest ||
        target.closest(`[data-ap-dialog="${instanceId}"]`)
      ) {
        return;
      }
      openerRef.current = target;
    };
    document.addEventListener("focusin", remember);
    return () => {
      document.removeEventListener("focusin", remember);
    };
  }, [instanceId]);

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="ap-dialog__overlay" />
        {/* Radix wires aria-labelledby/aria-describedby to the Title and
            Description below, and owns Escape and the focus trap. */}
        <Dialog.Content
          data-ap-dialog={instanceId}
          className={cn("ap-dialog", className)}
          data-tone={tone}
          data-busy={busy || undefined}
          onCloseAutoFocus={(event) => {
            const opener = openerRef.current;
            // Gone from the page — the screen that owned it was torn down with
            // the dialog. Nothing to return to, so leave Radix's fallback.
            if (!opener?.isConnected) return;
            event.preventDefault();
            opener.focus();
          }}
        >
          <Dialog.Title className="ap-dialog__title">{title}</Dialog.Title>
          <Dialog.Description className="ap-dialog__consequence">
            {consequence}
          </Dialog.Description>
          {children}
          <div className="ap-dialog__actions">
            <Dialog.Close asChild>
              <button type="button" className="ap-button ap-button--quiet">
                {cancelLabel}
              </button>
            </Dialog.Close>
            <button
              type="button"
              className={cn(
                "ap-button",
                tone === "danger" ? "ap-button--danger" : "ap-button--primary",
              )}
              onClick={onConfirm}
              disabled={busy || confirmDisabled}
            >
              {busy ? (
                <span className="ap-button__spinner" aria-hidden="true" />
              ) : null}
              {confirmLabel}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
