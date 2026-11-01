import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  type ApiClient,
  type ApiError,
  isApiError,
  unwrap,
} from "@werft-ai/client";
import type {
  CatalogGitHubRepository,
  GitHubRepositoryCandidate,
} from "@werft-ai/contracts";
import { useAgentPlatform } from "@werft-ai/react";
import {
  Badge,
  Button,
  ConfirmDialog,
  EmptyState,
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
  Input,
  RowList,
  RowListItem,
  SearchInput,
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
import { SEARCH_MAX } from "../components/search-term.ts";
import { useI18n } from "../i18n/i18n.tsx";
import { type OnOutcome, SettingsCard } from "./workspace-settings.tsx";

const ACTION = "min-w-12";

export const repositoriesKey = (client: ApiClient, workspaceId: string) =>
  scopedKey(client, "workspace", workspaceId, "github-repositories");
const candidatesKey = (client: ApiClient, workspaceId: string) =>
  scopedKey(
    client,
    "workspace",
    workspaceId,
    "github-repositories",
    "candidates",
  );

const reasonOf = (error: ApiError): unknown =>
  (error.details as { reason_code?: unknown } | null)?.reason_code;

const accountOf = (repository: CatalogGitHubRepository) =>
  repository.full_name?.split("/")[0] ?? repository.id;

/**
 * The catalog's GitHub repositories, by account: added from the author App's
 * installations, a branch changed or removed here; the operator file's
 * entries are listed read-only.
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
  const [picking, setPicking] = useState(false);
  const pickerId = useId();
  const list = useQuery({
    queryKey: repositoriesKey(client, workspaceId),
    queryFn: () =>
      unwrap(
        client.GET("/v1/workspaces/{id}/github-repositories", {
          params: { path: { id: workspaceId } },
        }),
      ),
    enabled: workspaceId !== "",
  });
  const queryClient = useQueryClient();
  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({
        queryKey: repositoriesKey(client, workspaceId),
      }),
      queryClient.invalidateQueries({
        queryKey: candidatesKey(client, workspaceId),
      }),
      onChanged(),
    ]);

  const repositories = list.data?.repositories ?? [];
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
          aria-expanded={picking}
          aria-controls={picking ? pickerId : undefined}
          onClick={() => setPicking(!picking)}
        >
          {t("github.repo.add")}
        </Button>
      </div>
      {picking ? (
        <Picker id={pickerId} refresh={refresh} onOutcome={onOutcome} />
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

function Picker({
  id,
  refresh,
  onOutcome,
}: {
  readonly id: string;
  readonly refresh: () => Promise<unknown>;
  readonly onOutcome: OnOutcome;
}) {
  const { t } = useI18n();
  const { client } = useAgentPlatform();
  const role = useRole();
  const workspaceId = useMe()?.workspace?.id ?? "";
  const titleId = useId();
  const candidates = useQuery({
    queryKey: candidatesKey(client, workspaceId),
    queryFn: () =>
      unwrap(
        client.GET("/v1/workspaces/{id}/github-repositories/candidates", {
          params: { path: { id: workspaceId } },
        }),
      ),
    enabled: workspaceId !== "",
  });
  const add = useMutation<unknown, ApiError, GitHubRepositoryCandidate>({
    mutationFn: (candidate) =>
      unwrap(
        client.POST("/v1/workspaces/{id}/github-repositories", {
          params: { path: { id: workspaceId } },
          body: { github_repository_id: candidate.github_repository_id },
        }),
      ),
    onMutate: () => onOutcome(null),
    onSuccess: async (_, candidate) => {
      onOutcome({
        kind: "notice",
        text: t("github.repo.added", { name: candidate.full_name }),
      });
      await refresh();
    },
    onError: async (error) => {
      const reason = reasonOf(error);
      onOutcome({
        kind: "error",
        text:
          reason === "already_added"
            ? t("github.repo.alreadyAdded")
            : reason === "no_author_app"
              ? t("github.repo.pickNoApp")
              : reason === "not_installed"
                ? t("github.repo.pickHint")
                : isApiError(error, "BACKEND_UNAVAILABLE")
                  ? t("github.repo.pickUnreachable")
                  : refusalText(t, error, "workspace.manage", role),
      });
      await refresh();
    },
  });

  const data = candidates.data;
  const [query, setQuery] = useState("");
  const search = useRef<HTMLInputElement>(null);
  const needle = query.trim().normalize("NFKC").toLowerCase();
  const shown =
    data?.candidates.filter((candidate) =>
      candidate.full_name.toLowerCase().includes(needle),
    ) ?? [];
  return (
    <section
      id={id}
      aria-labelledby={titleId}
      className="flex flex-col gap-2 rounded-md border p-3"
    >
      <h3 id={titleId} className="m-0 font-medium text-control">
        {t("github.repo.pickTitle")}
      </h3>
      <p className="m-0 text-caption text-subtle-foreground">
        {t("github.repo.pickHint")}
      </p>
      {candidates.isPending ? (
        <Skeleton className="h-5 w-48" />
      ) : candidates.isError ? (
        <LoadFailure
          error={candidates.error}
          onRetry={() => candidates.refetch()}
        />
      ) : data?.unavailable ? (
        <p className="m-0 text-caption">
          {t(
            data.unavailable === "no_author_app"
              ? "github.repo.pickNoApp"
              : "github.repo.pickUnreachable",
          )}
        </p>
      ) : data?.candidates.length ? (
        <>
          <div className="flex">
            <SearchInput
              ref={search}
              type="search"
              aria-label={t("github.repo.search")}
              placeholder={t("github.repo.search")}
              maxLength={SEARCH_MAX}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>
          {shown.length === 0 ? (
            <EmptyState
              className="w-full"
              title={t("github.repo.searchEmpty")}
              action={
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setQuery("");
                    search.current?.focus();
                  }}
                >
                  {t("members.clearSearch")}
                </Button>
              }
            />
          ) : (
            // An App can sit on hundreds of repositories: the list scrolls
            // inside the card instead of stretching the page. Focusable, so
            // the keyboard can scroll it when no row holds a button.
            <section
              aria-label={t("github.repo.pickList")}
              // biome-ignore lint/a11y/noNoninteractiveTabindex: a scrolling region must take focus
              tabIndex={0}
              className="max-h-96 overflow-y-auto"
            >
              <RowList variant="joined">
                {shown.map((candidate) => (
                  <SettingRow
                    key={candidate.github_repository_id}
                    title={candidate.full_name}
                    badge={
                      candidate.private ? (
                        <Badge>{t("github.repo.private")}</Badge>
                      ) : null
                    }
                    description={`${t("github.repo.branch")} ${candidate.default_branch}`}
                    actions={
                      candidate.catalog_id === null ? (
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          className={ACTION}
                          aria-label={t("github.repo.addName", {
                            name: candidate.full_name,
                          })}
                          aria-disabled={add.isPending || undefined}
                          onClick={() => {
                            if (!add.isPending) add.mutate(candidate);
                          }}
                        >
                          {t("github.repo.addOne")}
                        </Button>
                      ) : (
                        <span className="text-caption text-subtle-foreground">
                          {t("github.repo.alreadyAdded")}
                        </span>
                      )
                    }
                  />
                ))}
              </RowList>
            </section>
          )}
        </>
      ) : (
        <p className="m-0 text-caption">{t("github.repo.pickEmpty")}</p>
      )}
    </section>
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
  const [removing, setRemoving] = useState(false);
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
  const path = {
    params: { path: { id: workspaceId, repositoryId: repository.id } },
  };

  const failed = async (error: ApiError) => {
    const details = error.details as {
      installation_profiles?: string[];
      agents?: string[];
    } | null;
    onOutcome({
      kind: "error",
      text: isApiError(error, "REVISION_CONFLICT")
        ? t("github.repo.conflict")
        : isApiError(error, "REPOSITORY_IN_USE")
          ? t("github.repo.inUse", {
              profiles:
                details?.installation_profiles?.join(", ") ||
                t("github.repo.none"),
              agents: details?.agents?.join(", ") || t("github.repo.none"),
            })
          : refusalText(t, error, "workspace.manage", role),
    });
    await refresh();
  };
  const save = useMutation<unknown, ApiError, string>({
    mutationFn: (branch) =>
      unwrap(
        client.PATCH("/v1/workspaces/{id}/github-repositories/{repositoryId}", {
          ...path,
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
      await failed(error);
    },
  });
  const remove = useMutation<unknown, ApiError>({
    mutationFn: () =>
      unwrap(
        client.DELETE(
          "/v1/workspaces/{id}/github-repositories/{repositoryId}",
          path,
        ),
      ),
    onMutate: () => onOutcome(null),
    onSuccess: async () => {
      setRemoving(false);
      onOutcome({ kind: "notice", text: t("github.repo.removed", { name }) });
      await refresh();
    },
    onError: async (error) => {
      setRemoving(false);
      await failed(error);
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
                variant="danger"
                className="mr-auto"
                aria-label={t("github.repo.removeName", { name })}
                onClick={() => setRemoving(true)}
              >
                {t("github.repo.remove")}
              </Button>
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
      <ConfirmDialog
        open={removing}
        onOpenChange={setRemoving}
        title={t("github.repo.removeTitle")}
        consequence={t("github.repo.removeConsequence")}
        target={name}
        confirmLabel={t("github.repo.remove")}
        cancelLabel={t("common.cancel")}
        tone="danger"
        busy={remove.isPending}
        onConfirm={() => {
          if (!remove.isPending) remove.mutate();
        }}
      />
    </>
  );
}
