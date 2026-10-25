import { CircleAlert, RefreshCw } from "lucide-react";
import type { JSX } from "react";

import { cn } from "../foundations/cn.ts";
import { Button } from "../primitives/button.tsx";

export interface ErrorStateProps {
  readonly title?: string | undefined;
  /** What the reader should do next; shown before the message. */
  readonly guidance?: string | undefined;
  /** The server's own message; shown under the instruction, never instead. */
  readonly message?: string | undefined;
  /** An identifier the reader can quote when reporting the failure. */
  readonly code?: string | undefined;
  readonly retry?: (() => void) | undefined;
  readonly retryLabel?: string | undefined;
  /** Where the evidence lives: journal, receipt, run log. */
  readonly evidenceLink?:
    | { readonly href: string; readonly label?: string }
    | undefined;
  readonly className?: string | undefined;
}

export function ErrorState({
  title = "문제가 생겼습니다",
  guidance,
  message,
  code,
  retry,
  retryLabel = "다시 시도",
  evidenceLink,
  className,
}: ErrorStateProps): JSX.Element {
  return (
    <div
      className={cn("ap-state", "ap-state--error", className)}
      role="alert"
      data-code={code}
    >
      <span className="ap-state__icon ap-state__mark" aria-hidden="true">
        <CircleAlert size={16} strokeWidth={1.5} />
      </span>
      <p className="ap-state__title">{title}</p>
      {guidance ? <p className="ap-state__guidance">{guidance}</p> : null}
      {message ? <p className="ap-state__description">{message}</p> : null}
      {code ? <code className="ap-state__code">{code}</code> : null}
      {retry || evidenceLink ? (
        <div className="ap-state__actions">
          {retry ? (
            <Button type="button" variant="outline" onClick={retry}>
              <RefreshCw
                aria-hidden="true"
                className="size-3.5"
                strokeWidth={1.5}
              />
              {retryLabel}
            </Button>
          ) : null}
          {evidenceLink ? (
            <Button asChild={true} variant="ghost">
              <a href={evidenceLink.href}>
                {evidenceLink.label ?? "기록 보기"}
              </a>
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
