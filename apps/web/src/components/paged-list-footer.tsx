import type {
  InfiniteData,
  UseInfiniteQueryResult,
} from "@tanstack/react-query";
import { ApiError } from "@werft-ai/client";
import { LoadMoreButton } from "@werft-ai/react/components";
import {
  Alert,
  AlertActions,
  AlertDescription,
  AlertTitle,
  Button,
} from "@werft-ai/ui";
import { errorKey, useI18n } from "../i18n/i18n.tsx";

/**
 * Under a list read a page at a time: why the last read failed, with its
 * retry, and the button for the next page.
 */
export function PagedListFooter({
  list,
}: {
  readonly list: UseInfiniteQueryResult<InfiniteData<unknown>>;
}) {
  const { t } = useI18n();
  return (
    <>
      {list.error ? (
        <MoreFailure
          error={list.error}
          onRetry={() =>
            void (list.isFetchNextPageError
              ? list.fetchNextPage()
              : list.refetch())
          }
        />
      ) : null}
      {/* After a failed refresh the alert's retry is the way on: more
          rows on top of it would keep the stale ones. A failed next
          page keeps the button, and the keyboard on it. */}
      <LoadMoreButton
        hasMore={list.hasNextPage && (!list.error || list.isFetchNextPageError)}
        loading={list.isFetchingNextPage}
        // A refresh after a change rereads every page; asking for the
        // next one now would cancel it and keep the stale rows.
        busy={list.isFetching}
        onLoadMore={() => void list.fetchNextPage({ cancelRefetch: false })}
        messages={{
          more: t("sessions.more"),
          loading: t("sessions.loadingMore"),
        }}
      />
    </>
  );
}

/** A later page that failed: the rows already shown stay above it. */
function MoreFailure({
  error,
  onRetry,
}: {
  readonly error: unknown;
  readonly onRetry: () => void;
}) {
  const { t } = useI18n();
  return (
    <Alert variant="red" role="alert">
      <AlertTitle>{t("status.loadFailed")}</AlertTitle>
      <AlertDescription>
        {t(error instanceof ApiError ? errorKey(error.code) : "error.UNKNOWN")}
      </AlertDescription>
      <AlertActions>
        <Button type="button" variant="outline" size="sm" onClick={onRetry}>
          {t("common.retry")}
        </Button>
      </AlertActions>
    </Alert>
  );
}
