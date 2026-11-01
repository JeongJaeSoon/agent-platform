import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  type ApiClient,
  type ApiError,
  isApiError,
  unwrap,
} from "@werft-ai/client";
import type { CatalogGitHubRepository } from "@werft-ai/contracts";
import { useAgentPlatform } from "@werft-ai/react";
import {
  Badge,
  Button,
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
  Input,
  RowListItem,
  SettingRow,
  Skeleton,
} from "@werft-ai/ui";
import { Building2 } from "lucide-react";
import {
  type FormEvent,
  type ReactNode,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { scopedKey } from "../api/queries.ts";
import { refusalText, useMe, useRole } from "../auth/guard.tsx";
import { IconTile } from "../components/icon-tile.tsx";
import { LoadFailure } from "../components/load-failure.tsx";
import { useI18n } from "../i18n/i18n.tsx";
import {
  INSTALLED_PER_PAGE,
  InstalledRepositoryPage,
} from "./installed-repositories.tsx";
import { type OnOutcome, SettingsCard } from "./workspace-settings.tsx";

const ACTION = "min-w-12";

export const repositoriesKey = (client: ApiClient, workspaceId: string) =>
  scopedKey(client, "workspace", workspaceId, "github-repositories");

const reasonOf = (error: ApiError): unknown =>
  (error.details as { reason_code?: unknown } | null)?.reason_code;

const accountOf = (repository: CatalogGitHubRepository) =>
  repository.full_name?.split("/")[0] ?? repository.id;

/**
 * The catalog's GitHub repositories, by account: rows agents' picks
 * resolved (their branch changed here) and the operator file's entries,
 * read-only; beside them, a page at a time, what the author App's
 * installations reach.
 */
export function RepositoryCatalog({
  id,
  installBadge,
  onChanged,
  onOutcome,
}: {
  readonly id: string;
  /** How the App's own read places a repository, when it lists it. */
  readonly installBadge: (repositoryId: string) => ReactNode | null;
  /** After a write: the App's read lists the catalog too. */
  readonly onChanged: () => Promise<unknown>;
  readonly onOutcome: OnOutcome;
}) {
  const { t } = useI18n();
  const { client } = useAgentPlatform();
  const workspaceId = useMe()?.workspace?.id ?? "";
  const [browsing, setBrowsing] = useState(false);
  const [installation, setInstallation] = useState<number | undefined>();
  const [page, setPage] = useState(1);
  const browseId = useId();
  const titleId = useId();
  const list = useQuery({
    queryKey: [
      ...repositoriesKey(client, workspaceId),
      installation ?? null,
      page,
    ],
    queryFn: () =>
      unwrap(
        client.GET("/v1/workspaces/{id}/github-repositories", {
          params: {
            path: { id: workspaceId },
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
    enabled: workspaceId !== "",
    placeholderData: (previous) => previous,
  });
  const queryClient = useQueryClient();
  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({
        queryKey: repositoriesKey(client, workspaceId),
      }),
      onChanged(),
    ]);

  const repositories = list.data?.catalog ?? [];
  const groups = new Map<string, CatalogGitHubRepository[]>();
  for (const repository of repositories) {
    const account = accountOf(repository);
    groups.set(account, [...(groups.get(account) ?? []), repository]);
  }

  return (
    <SettingsCard
      id={id}
      title={t("github.repositories")}
      badge={<Badge>{repositories.length}</Badge>}
      description={t("github.repositoriesHint")}
      foot={
        <span className="text-caption text-subtle-foreground">
          {t("github.repositoriesFoot")}
        </span>
      }
      rows={
        list.isPending ? (
          <RowListItem>
            <Skeleton className="h-5 w-48" />
          </RowListItem>
        ) : list.isError ? (
          <RowListItem>
            <LoadFailure error={list.error} onRetry={() => list.refetch()} />
          </RowListItem>
        ) : repositories.length === 0 ? (
          <SettingRow title={t("github.repositoriesEmpty")} />
        ) : (
          [...groups].map(([account, held]) => (
            <AccountGroup key={account} account={account}>
              {held.map((repository) => (
                <RepositoryRow
                  key={repository.id}
                  repository={repository}
                  badge={installBadge(repository.id)}
                  refresh={refresh}
                  onOutcome={onOutcome}
                />
              ))}
            </AccountGroup>
          ))
        )
      }
    >
      <div className="flex justify-end">
        <Button
          type="button"
          size="sm"
          variant="outline"
          aria-expanded={browsing}
          aria-controls={browsing ? browseId : undefined}
          onClick={() => setBrowsing(!browsing)}
        >
          {t("github.repo.browse")}
        </Button>
      </div>
      {browsing && list.data ? (
        <section
          id={browseId}
          aria-labelledby={titleId}
          className="flex flex-col gap-2 rounded-md border p-3"
        >
          <h3 id={titleId} className="m-0 font-medium text-control">
            {t("github.repo.pickTitle")}
          </h3>
          <p className="m-0 text-caption text-subtle-foreground">
            {t("github.repo.pickHint")}
          </p>
          <InstalledRepositoryPage
            page={list.data}
            onInstallation={(next) => {
              setInstallation(next);
              setPage(1);
            }}
            onPage={setPage}
            meta={(repository) =>
              repository.agent_count > 0
                ? t("github.repo.agentCount", {
                    count: repository.agent_count,
                  })
                : undefined
            }
          />
        </section>
      ) : null}
    </SettingsCard>
  );
}

function AccountGroup({
  account,
  children,
}: {
  readonly account: string;
  readonly children: ReactNode;
}) {
  return (
    <>
      <RowListItem className="gap-2 bg-surface-sunken py-2 font-medium text-caption">
        <IconTile icon={Building2} hue="slate" />
        {account}
      </RowListItem>
      {children}
    </>
  );
}

function RepositoryRow({
  repository,
  badge,
  refresh,
  onOutcome,
}: {
  readonly repository: CatalogGitHubRepository;
  readonly badge: ReactNode | null;
  readonly refresh: () => Promise<unknown>;
  readonly onOutcome: OnOutcome;
}) {
  const { t } = useI18n();
  const { client } = useAgentPlatform();
  const role = useRole();
  const workspaceId = useMe()?.workspace?.id ?? "";
  const [editing, setEditing] = useState(false);
  const [invalid, setInvalid] = useState(false);
  const branchId = useId();
  const branchHint = useId();
  const branchRef = useRef<HTMLInputElement>(null);
  const editRef = useRef<HTMLButtonElement>(null);
  const wasEditing = useRef(false);
  useEffect(() => {
    if (editing) branchRef.current?.focus();
    else if (wasEditing.current) editRef.current?.focus();
    wasEditing.current = editing;
  }, [editing]);
  const name = repository.full_name ?? repository.id;

  const save = useMutation<unknown, ApiError, string>({
    mutationFn: (branch) =>
      unwrap(
        client.PATCH("/v1/workspaces/{id}/github-repositories/{repositoryId}", {
          params: { path: { id: workspaceId, repositoryId: repository.id } },
          body: { branch, version: repository.version ?? 1 },
        }),
      ),
    onMutate: () => onOutcome(null),
    onSuccess: async (_, branch) => {
      setEditing(false);
      onOutcome({
        kind: "notice",
        text: t("github.repo.saved", { name, branch }),
      });
      await refresh();
    },
    onError: async (error) => {
      if (isApiError(error, "BAD_REQUEST") && reasonOf(error) === undefined) {
        setInvalid(true);
        branchRef.current?.focus();
        return;
      }
      onOutcome({
        kind: "error",
        text: isApiError(error, "REVISION_CONFLICT")
          ? t("github.repo.conflict")
          : refusalText(t, error, "workspace.manage", role),
      });
      await refresh();
    },
  });

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const input = event.currentTarget.elements.namedItem("branch");
    const branch = input instanceof HTMLInputElement ? input.value.trim() : "";
    // The server holds the full rule and answers 400 past it.
    if (branch === "" || /\s/.test(branch)) {
      setInvalid(true);
      branchRef.current?.focus();
      return;
    }
    setInvalid(false);
    if (branch === repository.branch) {
      setEditing(false);
      return;
    }
    if (!save.isPending) save.mutate(branch);
  };

  const description = `${t("github.repo.branch")} ${repository.branch}`;
  if (!repository.editable) {
    return (
      <SettingRow
        title={name}
        badge={<Badge>{t("github.repo.file")}</Badge>}
        description={description}
        meta={t("github.repo.fileHint")}
      />
    );
  }
  return (
    <>
      <SettingRow
        title={name}
        badge={
          badge ??
          (repository.installed === null ? null : repository.installed ? (
            <Badge variant="green">{t("github.installed")}</Badge>
          ) : (
            <Badge variant="amber">{t("github.notInstalled")}</Badge>
          ))
        }
        description={description}
        meta={repository.source === "seed" ? t("github.repo.seed") : undefined}
        actions={
          editing ? null : (
            <Button
              ref={editRef}
              type="button"
              size="sm"
              variant="outline"
              className={ACTION}
              aria-label={t("github.repo.editName", { name })}
              onClick={() => setEditing(true)}
            >
              {t("github.repo.edit")}
            </Button>
          )
        }
      />
      {editing ? (
        <RowListItem>
          <form
            className="flex w-full flex-col gap-4"
            noValidate
            onSubmit={submit}
          >
            <Field>
              <FieldLabel htmlFor={branchId}>
                {t("github.repo.branch")}
              </FieldLabel>
              <Input
                ref={branchRef}
                id={branchId}
                name="branch"
                className="max-w-80"
                autoComplete="off"
                spellCheck={false}
                defaultValue={repository.branch}
                aria-describedby={branchHint}
                aria-invalid={invalid || undefined}
              />
              <FieldDescription id={branchHint}>
                {t("github.repo.branchHint")}
              </FieldDescription>
              {invalid ? (
                <FieldError>{t("github.repo.branchInvalid")}</FieldError>
              ) : null}
            </Field>
            <div className="flex flex-wrap items-center justify-end gap-2">
              <Button
                type="button"
                variant="ghost"
                onClick={() => {
                  setInvalid(false);
                  setEditing(false);
                }}
              >
                {t("common.cancel")}
              </Button>
              <Button type="submit" aria-disabled={save.isPending || undefined}>
                {t("github.repo.save")}
              </Button>
            </div>
          </form>
        </RowListItem>
      ) : null}
    </>
  );
}
