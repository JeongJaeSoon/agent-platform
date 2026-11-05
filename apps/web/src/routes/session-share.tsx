import { useQuery } from "@tanstack/react-query";
import { isApiError, unwrap } from "@werft-ai/client";
import type { SessionShareView } from "@werft-ai/contracts";
import { queryKeysOf } from "@werft-ai/core";
import { useWerft } from "@werft-ai/react";
import { Button, Section, Text } from "@werft-ai/ui";
import { useI18n } from "../i18n/i18n.tsx";

function scopeText(
  t: ReturnType<typeof useI18n>["t"],
  share: SessionShareView,
): string {
  if (share.scope === "people")
    return t("session.share.people", { count: share.user_ids.length });
  if (share.scope === "team")
    return t("session.share.team", { count: share.team_ids.length });
  if (share.scope === "private") return t("session.share.private");
  // The scope reads as everyone, but the workspace's agent access setting
  // keeps it inside the agent (agent-rbac (c), axis B).
  return t(
    share.audience_limited
      ? "session.share.workspaceLimited"
      : "session.share.workspace",
  );
}

/**
 * Who sees the session, read only: the console has no screen that changes
 * it yet. Someone who can no longer read the share sees no block at all.
 */
export function SessionShareBlock({ id }: { readonly id: string }) {
  const { t } = useI18n();
  const { client } = useWerft();
  const share = useQuery({
    queryKey: [...queryKeysOf(client).session(id), "share"],
    queryFn: () =>
      unwrap(
        client.GET("/v1/sessions/{id}/share", { params: { path: { id } } }),
      ),
    retry: false,
  });
  if (
    share.isPending ||
    isApiError(share.error, "NOT_FOUND") ||
    isApiError(share.error, "FORBIDDEN")
  )
    return null;
  return (
    <Section titleAs="h3" title={t("session.share.title")}>
      {/* A failed refetch keeps stale data; it must not pass as current. */}
      {share.data && !share.isError ? (
        <Text as="div" className="text-body">
          {scopeText(t, share.data)}
        </Text>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <Text as="div" variant="meta" role="alert">
            {t("session.share.failed")}
          </Text>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void share.refetch()}
          >
            {t("common.retry")}
          </Button>
        </div>
      )}
    </Section>
  );
}
