import { useMutation, useQuery } from "@tanstack/react-query";
import { type ApiError, unwrap } from "@werft-ai/client";
import { queryKeysOf } from "@werft-ai/core";
import { useAgentPlatform } from "@werft-ai/react";
import { Button, FieldError, Heading, Text } from "@werft-ai/ui";
import { useId, useState } from "react";
import { LoadFailure } from "../../components/load-failure.tsx";
import { errorKey, type MessageKey, useI18n } from "../../i18n/i18n.tsx";
import {
  INSTALLED_PER_PAGE,
  type InstalledRepository,
  InstalledRepositoryPage,
} from "../installed-repositories.tsx";

const PICK_REFUSALS: Partial<Record<string, MessageKey>> = {
  not_installed: "github.repo.pickHint",
  no_author_app: "github.repo.pickNoApp",
  name_held: "github.repo.pickNameHeld",
  file_repository: "github.repo.pickFileHeld",
};

/**
 * Repositories the author App's installations reach, a page at a time, for
 * an agent whose ceiling runs on all of them. A pick resolves one to its
 * catalog id, which `onPicked` puts in the unsaved settings.
 */
export function AppRepositoryPicker({
  agentId,
  chosen,
  disabled,
  onPicked,
}: {
  readonly agentId: string;
  /** Catalog ids the settings already name. */
  readonly chosen: readonly string[];
  readonly disabled: boolean;
  readonly onPicked: (catalogId: string, name: string) => Promise<unknown>;
}) {
  const { t } = useI18n();
  const { client } = useAgentPlatform();
  const titleId = useId();
  const [installation, setInstallation] = useState<number | undefined>();
  const [page, setPage] = useState(1);
  const [refusal, setRefusal] = useState<string | null>(null);
  const list = useQuery({
    queryKey: [
      ...queryKeysOf(client).agent(agentId),
      "github",
      "repositories",
      installation ?? null,
      page,
    ],
    queryFn: () =>
      unwrap(
        client.GET("/v1/agents/{id}/github/repositories", {
          params: {
            path: { id: agentId },
            query: {
              ...(installation === undefined
                ? {}
                : { installation_id: installation }),
              page,
              per_page: INSTALLED_PER_PAGE,
            },
          },
        }),
      ),
    placeholderData: (previous) => previous,
  });
  const pick = useMutation<
    { catalog_id: string },
    ApiError,
    InstalledRepository
  >({
    mutationFn: (repository) =>
      unwrap(
        client.POST("/v1/agents/{id}/github/repositories", {
          params: { path: { id: agentId } },
          body: {
            installation_id: list.data?.installation_id ?? 0,
            github_repository_id: repository.github_repository_id,
          },
        }),
      ),
    onMutate: () => setRefusal(null),
    onSuccess: async (picked, repository) => {
      await onPicked(picked.catalog_id, repository.full_name);
      await list.refetch();
    },
    onError: (error) => {
      const reason = (error.details as { reason_code?: string } | null)
        ?.reason_code;
      const key = reason === undefined ? undefined : PICK_REFUSALS[reason];
      setRefusal(
        t("agentGitHub.pickRefused", {
          reason: t(key ?? errorKey(error.code)),
        }),
      );
    },
  });

  // A listed ceiling picks among the tab's own list only; until the page
  // says which it is, nothing shows rather than a section that may vanish.
  if (
    list.isPending ||
    list.data?.unavailable === "ceiling_listed" ||
    list.data?.unavailable === "no_active_release"
  ) {
    return null;
  }
  return (
    <section
      aria-labelledby={titleId}
      className="flex flex-col gap-2 rounded-md border p-3"
    >
      <Heading id={titleId} level={3} className="font-medium text-control">
        {t("agentGitHub.pickTitle")}
      </Heading>
      <Text variant="meta">{t("agentGitHub.pickHint")}</Text>
      {list.isError ? (
        <LoadFailure error={list.error} onRetry={() => list.refetch()} />
      ) : (
        <InstalledRepositoryPage
          page={list.data}
          onInstallation={(next) => {
            setInstallation(next);
            setPage(1);
          }}
          onPage={setPage}
          action={(repository) =>
            repository.catalog_id !== null &&
            chosen.includes(repository.catalog_id) ? (
              <Text as="span" variant="meta">
                {t("agentGitHub.pickInList")}
              </Text>
            ) : (
              <Button
                type="button"
                size="sm"
                variant="outline"
                aria-label={t("agentGitHub.pickName", {
                  name: repository.full_name,
                })}
                aria-disabled={disabled || pick.isPending || undefined}
                onClick={() => {
                  if (!disabled && !pick.isPending) pick.mutate(repository);
                }}
              >
                {t("agentGitHub.pickOne")}
              </Button>
            )
          }
        />
      )}
      <FieldError>{refusal}</FieldError>
    </section>
  );
}
