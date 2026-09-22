import type { JSX, ReactNode } from "react";
import { useId, useState } from "react";

import { ConfirmDialog } from "./confirm-dialog.tsx";

export interface DestructiveActionDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly title: string;
  readonly consequence: ReactNode;
  readonly onConfirm: () => void;
  /** What is being destroyed, in the user's words: "결제 담당 에이전트". */
  readonly resourceName: string;
  /**
   * What has to be typed to unlock the button. Defaults to `resourceName`;
   * pass the id when the name is not unique enough to be worth typing.
   */
  readonly matchText?: string | undefined;
  readonly confirmLabel?: string | undefined;
  readonly cancelLabel?: string | undefined;
  readonly busy?: boolean | undefined;
  readonly className?: string | undefined;
}

/**
 * 해고·삭제처럼 되돌릴 수 없는 동작. Typing the name is the gate (§3 에이전트
 * 카드 "이름 입력 확인"); everything else is `ConfirmDialog`.
 */
export function DestructiveActionDialog({
  open,
  onOpenChange,
  title,
  consequence,
  onConfirm,
  resourceName,
  matchText,
  confirmLabel = "삭제",
  cancelLabel = "취소",
  busy = false,
  className,
}: DestructiveActionDialogProps): JSX.Element {
  const expected = matchText ?? resourceName;
  const inputId = useId();
  const [typed, setTyped] = useState("");

  const handleOpenChange = (next: boolean): void => {
    // Reopening starts from an empty field; a stale match must not carry over.
    if (!next) setTyped("");
    onOpenChange(next);
  };

  return (
    <ConfirmDialog
      open={open}
      onOpenChange={handleOpenChange}
      title={title}
      consequence={consequence}
      onConfirm={onConfirm}
      confirmLabel={confirmLabel}
      cancelLabel={cancelLabel}
      busy={busy}
      confirmDisabled={typed.trim() !== expected}
      tone="danger"
      className={className}
    >
      <div className="ap-dialog__match">
        <label className="ap-dialog__match-label" htmlFor={inputId}>
          계속하려면 <b>{expected}</b> 을(를) 그대로 입력하세요
        </label>
        <input
          id={inputId}
          className="ap-input"
          type="text"
          value={typed}
          autoComplete="off"
          onChange={(event) => setTyped(event.target.value)}
        />
      </div>
    </ConfirmDialog>
  );
}
