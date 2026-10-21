import { ApiError } from "@agent-platform/client";
import { ErrorState } from "@agent-platform/ui";
import { errorKey, useI18n } from "../i18n/i18n.tsx";

/**
 * A read that failed for a reason the reader can do something about: what
 * went wrong in our words, and a button that asks again. A 403 is not this;
 * each screen says who may see it instead.
 */
export function LoadFailure({
  error,
  onRetry,
}: {
  readonly error: unknown;
  readonly onRetry: () => void;
}) {
  const { t } = useI18n();
  return (
    <ErrorState
      title={t("status.loadFailed")}
      message={t(
        error instanceof ApiError ? errorKey(error.code) : "error.UNKNOWN",
      )}
      retry={onRetry}
      retryLabel={t("common.retry")}
    />
  );
}
