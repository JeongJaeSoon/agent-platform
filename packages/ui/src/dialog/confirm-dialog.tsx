import * as Dialog from "@radix-ui/react-dialog";
import type { JSX, ReactNode } from "react";

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
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="ap-dialog__overlay" />
        {/* Radix wires aria-labelledby/aria-describedby to the Title and
            Description below, and owns Escape and the focus trap. */}
        <Dialog.Content
          className={cn("ap-dialog", className)}
          data-tone={tone}
          data-busy={busy || undefined}
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
