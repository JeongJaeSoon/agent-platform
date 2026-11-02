import { ApiError } from "@werft-ai/client";
import { ApiErrorState } from "@werft-ai/react/components";
import { useI18n } from "../i18n/i18n.tsx";

/**
 * A first read that failed: `ApiErrorState` in the reader's language, with a
 * button that asks again. A 403 is not this; each screen says who may see it
 * instead.
 */
export function LoadFailure({
  error,
  onRetry,
  guidance,
}: {
  readonly error: unknown;
  readonly onRetry: () => void;
  /** The screen's own instruction, where it knows more than the code. */
  readonly guidance?: string | undefined;
}) {
  const { t, locale } = useI18n();
  const code = error instanceof ApiError ? error.code : undefined;
  return (
    <ApiErrorState
      locale={locale}
      title={t("status.loadFailed")}
      code={code}
      guidance={guidance}
      // Without a code there is no guidance to lead with.
      message={code || guidance ? undefined : t("error.UNKNOWN")}
      retry={onRetry}
      retryLabel={t("common.retry")}
    />
  );
}
