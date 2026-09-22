import type { JSX } from "react";

import { cn } from "../lib/cn.ts";
import { guidanceFor } from "./error-guidance.ts";

export interface ErrorStateProps {
  readonly title?: string | undefined;
  /** The server's own message; shown under the instruction, never instead. */
  readonly message?: string | undefined;
  /** `error.code` — branching and copy key on the code, not the HTTP status. */
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
  message,
  code,
  retry,
  retryLabel = "다시 시도",
  evidenceLink,
  className,
}: ErrorStateProps): JSX.Element {
  const guidance = guidanceFor(code);

  return (
    <div
      className={cn("ap-state", "ap-state--error", className)}
      role="alert"
      data-code={code}
    >
      <p className="ap-state__title">
        <span className="ap-state__mark" aria-hidden="true">
          !
        </span>
        {title}
      </p>
      {guidance ? <p className="ap-state__guidance">{guidance}</p> : null}
      {message ? <p className="ap-state__description">{message}</p> : null}
      <div className="ap-state__actions">
        {retry ? (
          <button type="button" className="ap-button" onClick={retry}>
            {retryLabel}
          </button>
        ) : null}
        {evidenceLink ? (
          <a className="ap-button ap-button--quiet" href={evidenceLink.href}>
            {evidenceLink.label ?? "기록 보기"}
          </a>
        ) : null}
        {code ? <code className="ap-state__code">{code}</code> : null}
      </div>
    </div>
  );
}
