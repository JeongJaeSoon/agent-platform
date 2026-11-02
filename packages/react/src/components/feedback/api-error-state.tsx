import { ErrorState, type ErrorStateProps } from "@werft-ai/ui";
import type { JSX } from "react";

import type { Locale } from "../../messages/index.ts";
import { guidanceFor } from "./error-guidance.ts";

export interface ApiErrorStateProps extends Omit<ErrorStateProps, "guidance"> {
  /** `error.code` — branching and copy key on the code, not the HTTP status. */
  readonly code?: string | undefined;
  /** The language of the guidance and of the default title and buttons. */
  readonly locale?: Locale | undefined;
}

const COPY: Record<
  Locale,
  { readonly title: string; readonly retry: string; readonly evidence: string }
> = {
  ko: { title: "문제가 생겼습니다", retry: "다시 시도", evidence: "기록 보기" },
  en: {
    title: "Something went wrong",
    retry: "Try again",
    evidence: "View record",
  },
  ja: { title: "問題が発生しました", retry: "再試行", evidence: "記録を見る" },
};

/** `ErrorState` that leads with what to do about the API's error code. */
export function ApiErrorState({
  code,
  locale = "ko",
  title,
  retryLabel,
  evidenceLink,
  ...props
}: ApiErrorStateProps): JSX.Element {
  const copy = COPY[locale];
  return (
    <ErrorState
      {...props}
      title={title ?? copy.title}
      retryLabel={retryLabel ?? copy.retry}
      evidenceLink={
        evidenceLink
          ? { ...evidenceLink, label: evidenceLink.label ?? copy.evidence }
          : undefined
      }
      code={code}
      guidance={guidanceFor(code, locale)}
    />
  );
}
