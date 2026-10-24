import { useQuery } from "@tanstack/react-query";
import { isApiError, unwrap } from "@werft-ai/client";
import type {
  ListSessionOutputsResponse,
  SessionDetail,
} from "@werft-ai/contracts";
import { useAgentPlatform } from "@werft-ai/react";
import { buttonVariants, EmptyState, Link } from "@werft-ai/ui";
import { Download } from "lucide-react";
import { useId } from "react";
import { LoadFailure } from "../components/load-failure.tsx";
import { StatusScreen } from "../components/status-screen.tsx";
import { useI18n } from "../i18n/i18n.tsx";

const UNITS = ["byte", "kilobyte", "megabyte", "gigabyte"] as const;

export function formatBytes(bytes: number, locale: string): string {
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return new Intl.NumberFormat(locale, {
    style: "unit",
    unit: UNITS[unit],
    unitDisplay: "short",
    maximumFractionDigits: unit === 0 ? 0 : 1,
  }).format(value);
}

function useSessionOutputs(session: SessionDetail) {
  const { client } = useAgentPlatform();
  return useQuery({
    // A new checkpoint is a new list.
    queryKey: ["sessions", session.id, "outputs", session.checkpoint_revision],
    queryFn: () =>
      unwrap(
        client.GET("/v1/sessions/{id}/outputs", {
          params: { path: { id: session.id } },
        }),
      ) as Promise<ListSessionOutputsResponse>,
    retry: false,
    enabled: session.checkpoint_revision !== null,
  });
}

/** How many outputs the session has, once read: the outputs tab's count. */
export function SessionOutputsCount({
  session,
}: {
  readonly session: SessionDetail;
}) {
  const outputs = useSessionOutputs(session);
  return session.checkpoint_revision === null
    ? 0
    : (outputs.data?.items.length ?? null);
}

/**
 * The files the session left under `out/` at its latest checkpoint, each
 * with a download link.
 */
export function SessionOutputs({
  session,
}: {
  readonly session: SessionDetail;
}) {
  const { t, locale } = useI18n();
  const titleId = useId();
  const outputs = useSessionOutputs(session);

  // A session gone from view is the detail screen's to report.
  if (outputs.error && !isApiError(outputs.error, "NOT_FOUND")) {
    return (
      <LoadFailure
        error={outputs.error}
        onRetry={() => void outputs.refetch()}
      />
    );
  }
  if (outputs.isPending && session.checkpoint_revision !== null) {
    return <StatusScreen kind="loading" />;
  }
  const items = outputs.data?.items ?? [];
  if (items.length === 0) {
    return <EmptyState title={t("session.outputs.empty")} />;
  }
  return (
    <section
      className="flex flex-col gap-[var(--ap-space-block)] rounded-card border bg-card p-4"
      aria-labelledby={titleId}
    >
      <h2 id={titleId} className="sr-only">
        {t("session.outputs.title")}
      </h2>
      <ul className="m-0 flex list-none flex-col gap-2 p-0">
        {items.map((item) => {
          const name = item.path.replace(/^out\//, "");
          return (
            <li
              key={item.path}
              className="flex min-w-0 items-center justify-between gap-3 text-control"
            >
              <div className="flex min-w-0 flex-col">
                <span className="font-mono [overflow-wrap:anywhere]">
                  {name}
                </span>
                <span className="text-caption text-muted-foreground">
                  {item.omitted === null
                    ? formatBytes(item.bytes, locale)
                    : `${formatBytes(item.bytes, locale)} · ${t("session.outputs.tooLarge")}`}
                </span>
              </div>
              {item.omitted === null ? (
                <Link
                  href={`/v1/sessions/${encodeURIComponent(session.id)}/outputs/${encodeURIComponent(item.path)}`}
                  download={name.slice(name.lastIndexOf("/") + 1)}
                  aria-label={t("session.outputs.download", { name })}
                  title={t("session.outputs.download", { name })}
                  className={buttonVariants({
                    variant: "outline",
                    size: "icon",
                  })}
                >
                  <Download className="size-3.5" aria-hidden="true" />
                </Link>
              ) : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
