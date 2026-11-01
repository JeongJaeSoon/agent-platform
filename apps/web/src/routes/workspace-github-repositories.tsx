import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  type ApiClient,
  type ApiError,
  isApiError,
  unwrap,
} from "@werft-ai/client";
import type { ListGitHubRepositoriesResponse } from "@werft-ai/contracts";
import { useAgentPlatform } from "@werft-ai/react";
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Badge,
  Button,
  Card,
  CardDescription,
  CardTitle,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
  GridTable,
  GridTableCell,
  GridTableColumnHeader,
  GridTableHeader,
  GridTableRow,
  Input,
  Link,
  Skeleton,
} from "@werft-ai/ui";
import { ChevronLeft, ChevronRight, Lock, Pencil } from "lucide-react";
import {
  type FormEvent,
  type ReactNode,
  useEffect,
  useId,
  useState,
} from "react";
import { scopedKey } from "../api/queries.ts";
import { refusalText, useMe, useRole } from "../auth/guard.tsx";
import { LoadFailure } from "../components/load-failure.tsx";
import { useI18n } from "../i18n/i18n.tsx";
import { META } from "./workspace-github-access.tsx";
import type { OnOutcome } from "./workspace-settings.tsx";

/** Rows a page; GitHub pages up to 100. */
export const REPOSITORIES_PER_PAGE = 10;
// Shared by both repository tables so their branch buttons line up.
const COLUMNS = "minmax(0,1fr) 128px 104px";
const NARROW_COLUMNS = "minmax(0,1fr) 96px 72px";

export const repositoriesKey = (client: ApiClient, workspaceId: string) =>
  scopedKey(client, "workspace", workspaceId, "github-repositories");

const reasonOf = (error: unknown): unknown =>
  isApiError(error)
    ? (error.details as { reason_code?: unknown } | null)?.reason_code
    : undefined;

/** Why a page could not be read, as the screen tells the causes apart. */
export type PageFailure =
  | "gone"
  | "suspended"
  | "auth"
  | "unavailable"
  | "other";

export function pageFailureOf(error: unknown): PageFailure {
  if (
    isApiError(error, "NOT_FOUND") &&
    reasonOf(error) === "installation_not_found"
  ) {
    return "gone";
  }
  if (isApiError(error, "INSTALLATION_SUSPENDED")) return "suspended";
  if (isApiError(error, "GITHUB_UNAVAILABLE")) {
    return reasonOf(error) === "github_app_auth_failed"
      ? "auth"
      : "unavailable";
  }
  return "other";
}

/** One page of one installation's repositories, as GitHub pages them. */
export function useRepositoryPage(
  installationId: number | undefined,
  page: number,
) {
  const { client } = useAgentPlatform();
  const workspaceId = useMe()?.workspace?.id ?? "";
  return useQuery({
    queryKey: [
      ...repositoriesKey(client, workspaceId),
      installationId ?? null,
      page,
      REPOSITORIES_PER_PAGE,
    ],
    queryFn: () =>
      unwrap(
        client.GET("/v1/workspaces/{id}/github-repositories", {
          params: {
            path: { id: workspaceId },
            query: {
              ...(installationId === undefined
                ? {}
                : { installation_id: installationId }),
              page,
              per_page: REPOSITORIES_PER_PAGE,
            },
          },
        }),
      ),
    enabled: workspaceId !== "" && installationId !== undefined,
    // A cause GitHub answered with does not change on a quick retry.
    retry: (failures, error) =>
      pageFailureOf(error) === "other" && failures < 3,
  });
}

type CatalogRow = ListGitHubRepositoriesResponse["catalog"][number];

/**
 * The repositories the picked installation reaches, ten a page, with the
 * branch of the rows an agent resolved and how many agents picked each.
 */
export function InstalledRepositories({
  label,
  list,
  page,
  onPage,
  failure,
  onRotate,
  manageUrl,
  onOutcome,
}: {
  /** "App · account", for the names of the table and its page buttons. */
  readonly label: string;
  readonly list: ReturnType<typeof useRepositoryPage>;
  readonly page: number;
  readonly onPage: (page: number) => void;
  readonly failure: PageFailure | null;
  readonly onRotate: () => void;
  readonly manageUrl: string | null;
  readonly onOutcome: OnOutcome;
}) {
  const { t } = useI18n();
  const headingId = useId();
  const heading = (
    <h4 id={headingId} className="m-0 font-semibold text-control">
      {t("github.repos.title")}
      <span className="sr-only"> — {label}</span>
    </h4>
  );
  if (failure !== null && failure !== "gone") {
    return (
      <div className="flex min-w-0 flex-col gap-2">
        {heading}
        <PageFailureNotice
          failure={failure}
          onRetry={() => void list.refetch()}
          onRotate={onRotate}
          manageUrl={manageUrl}
          error={list.error}
        />
      </div>
    );
  }
  const data = list.data;
  if (data === undefined) {
    return (
      <div className="flex min-w-0 flex-col gap-2">
        {heading}
        <Skeleton className="h-5 w-48" />
      </div>
    );
  }
  const total = data.total_count;
  const pages = Math.max(1, Math.ceil(total / REPOSITORIES_PER_PAGE));
  const from = (data.page - 1) * REPOSITORIES_PER_PAGE + 1;
  const catalog = new Map(data.catalog.map((row) => [row.id, row]));
  return (
    <div className="flex min-w-0 flex-col gap-2">
      {heading}
      {total === 0 ? (
        <p className={`m-0 ${META}`}>{t("github.repos.empty")}</p>
      ) : (
        <GridTable
          aria-labelledby={headingId}
          columns={COLUMNS}
          narrowAt={480}
          narrowColumns={NARROW_COLUMNS}
          className="rounded-card border"
        >
          <RepositoryHead />
          {data.repositories.map((repository) => {
            const row =
              repository.catalog_id === null
                ? undefined
                : catalog.get(repository.catalog_id);
            return (
              <GridTableRow key={repository.github_repository_id}>
                <GridTableCell>
                  <span className="flex min-w-0 items-center gap-2">
                    <span className="[overflow-wrap:anywhere]">
                      {repository.full_name}
                    </span>
                    {repository.private ? (
                      <Lock
                        role="img"
                        aria-label={t("github.repo.private")}
                        className="size-3.5 shrink-0 text-subtle-foreground"
                        strokeWidth={1.5}
                      />
                    ) : null}
                  </span>
                </GridTableCell>
                <GridTableCell>
                  {/* Only a row an agent resolved holds its own branch. */}
                  {row?.editable ? (
                    <BranchCell row={row} onOutcome={onOutcome} />
                  ) : (
                    <span className="flex h-5 min-w-0 items-center">
                      <span className="truncate font-mono text-caption">
                        {repository.default_branch}
                      </span>
                    </span>
                  )}
                </GridTableCell>
                <GridTableCell align="end">
                  <AgentCount count={repository.agent_count} />
                </GridTableCell>
              </GridTableRow>
            );
          })}
        </GridTable>
      )}
      {total > 0 ? (
        <nav
          aria-label={t("github.repos.nav", { label })}
          className="flex items-center justify-between gap-2"
        >
          <span className={META} aria-live="polite">
            {t("github.repos.range", {
              from,
              to: from + data.repositories.length - 1,
              total,
            })}
          </span>
          {pages > 1 ? (
            <span className="flex items-center gap-1">
              <PageButton
                label={t("github.repos.previous", { label })}
                off={page <= 1 || list.isFetching}
                onClick={() => onPage(page - 1)}
              >
                <ChevronLeft aria-hidden="true" className="size-4" />
              </PageButton>
              <span className={`${META} min-w-12 text-center`}>
                {t("github.repos.pages", { page, pages })}
              </span>
              <PageButton
                label={t("github.repos.next", { label })}
                off={page >= pages || list.isFetching}
                onClick={() => onPage(page + 1)}
              >
                <ChevronRight aria-hidden="true" className="size-4" />
              </PageButton>
            </span>
          ) : null}
        </nav>
      ) : null}
    </div>
  );
}

function PageButton({
  label,
  off,
  onClick,
  children,
}: {
  readonly label: string;
  readonly off: boolean;
  readonly onClick: () => void;
  readonly children: ReactNode;
}) {
  return (
    // aria-disabled keeps focus on the button once the last page is reached.
    <Button
      type="button"
      size="sm"
      variant="outline"
      aria-label={label}
      aria-disabled={off || undefined}
      className="aria-disabled:opacity-45"
      onClick={() => {
        if (!off) onClick();
      }}
    >
      {children}
    </Button>
  );
}

function RepositoryHead() {
  const { t } = useI18n();
  return (
    <GridTableHeader>
      <GridTableColumnHeader>
        {t("github.repos.col.name")}
      </GridTableColumnHeader>
      <GridTableColumnHeader>
        {t("github.repos.col.branch")}
      </GridTableColumnHeader>
      <GridTableColumnHeader align="end">
        {t("github.repos.col.agents")}
      </GridTableColumnHeader>
    </GridTableHeader>
  );
}

function AgentCount({ count }: { readonly count: number }) {
  const { t } = useI18n();
  return count > 0 ? (
    <span>{t("github.repos.agents", { count })}</span>
  ) : (
    <span className="text-subtle-foreground">
      <span aria-hidden="true">—</span>
      <span className="sr-only">{t("github.repos.agents", { count: 0 })}</span>
    </span>
  );
}

export function PageFailureNotice({
  failure,
  onRetry,
  onRotate,
  manageUrl,
  error,
}: {
  readonly failure: Exclude<PageFailure, "gone">;
  readonly onRetry: () => void;
  readonly onRotate: () => void;
  readonly manageUrl: string | null;
  readonly error: unknown;
}) {
  const { t } = useI18n();
  if (failure === "other") {
    return <LoadFailure error={error as ApiError} onRetry={onRetry} />;
  }
  return (
    <>
      <Alert variant="amber">
        <AlertTitle>{t(`github.repos.${failure}.title`)}</AlertTitle>
        <AlertDescription>
          {t(`github.repos.${failure}.body`)}
        </AlertDescription>
      </Alert>
      <div className="flex items-center gap-3">
        {failure === "unavailable" ? (
          <Button type="button" size="sm" variant="outline" onClick={onRetry}>
            {t("github.repos.retry")}
          </Button>
        ) : failure === "auth" ? (
          <Button type="button" size="sm" variant="outline" onClick={onRotate}>
            {t("github.card.rotate")}
          </Button>
        ) : manageUrl ? (
          <Link
            href={manageUrl}
            target="_blank"
            newTabLabel={t("github.newTab")}
          >
            {t("github.card.manageInstallation")}
          </Link>
        ) : null}
      </div>
    </>
  );
}

/**
 * Resolved rows no author installation reaches now (decision
 * settings-replace-file-catalog.md §1.1); `installed` null when GitHub was
 * not asked about the row.
 */
export function OutsideRepositories({
  catalog,
  onOutcome,
}: {
  readonly catalog: readonly CatalogRow[];
  readonly onOutcome: OnOutcome;
}) {
  const { t } = useI18n();
  const headingId = useId();
  const rows = catalog.filter((row) => row.editable && row.installed !== true);
  if (rows.length === 0) return null;
  return (
    <Card flush role="region" aria-labelledby={headingId}>
      <div className="flex flex-col gap-0.5 p-4">
        <CardTitle id={headingId} role="heading" aria-level={3}>
          {t("github.outside.title")}
        </CardTitle>
        <CardDescription className="text-description">
          {t("github.outside.hint")}
        </CardDescription>
      </div>
      <div className="border-t p-4">
        <GridTable
          aria-labelledby={headingId}
          columns={COLUMNS}
          narrowAt={480}
          narrowColumns={NARROW_COLUMNS}
          className="rounded-card border"
        >
          <RepositoryHead />
          {rows.map((row) => (
            <GridTableRow key={row.id}>
              <GridTableCell>
                <span className="flex min-w-0 flex-wrap items-center gap-x-2">
                  <span className="[overflow-wrap:anywhere]">
                    {row.full_name ?? row.id}
                  </span>
                  {row.installed === null ? (
                    <Badge variant="gray">
                      {t("github.outside.unchecked")}
                    </Badge>
                  ) : (
                    <Badge variant="amber">{t("github.outside.badge")}</Badge>
                  )}
                </span>
              </GridTableCell>
              <GridTableCell>
                <BranchCell row={row} onOutcome={onOutcome} />
              </GridTableCell>
              <GridTableCell align="end">
                <AgentCount count={row.agent_count} />
              </GridTableCell>
            </GridTableRow>
          ))}
        </GridTable>
      </div>
    </Card>
  );
}

/** A resolved row's branch, changed in a dialog against the row's version. */
function BranchCell({
  row,
  onOutcome,
}: {
  readonly row: CatalogRow;
  readonly onOutcome: OnOutcome;
}) {
  const { t } = useI18n();
  const { client } = useAgentPlatform();
  const queryClient = useQueryClient();
  const role = useRole();
  const workspaceId = useMe()?.workspace?.id ?? "";
  const [open, setOpen] = useState(false);
  const [invalid, setInvalid] = useState(false);
  const inputId = useId();
  const hintId = useId();
  const name = row.full_name ?? row.id;
  useEffect(() => {
    if (!open) setInvalid(false);
  }, [open]);

  const save = useMutation<unknown, ApiError, string>({
    mutationFn: (branch) =>
      unwrap(
        client.PATCH("/v1/workspaces/{id}/github-repositories/{repositoryId}", {
          params: { path: { id: workspaceId, repositoryId: row.id } },
          body: { branch, version: row.version ?? 1 },
        }),
      ),
    onMutate: () => onOutcome(null),
    onSuccess: (_, branch) => {
      setOpen(false);
      onOutcome({
        kind: "notice",
        text: t("github.repo.saved", { name, branch }),
      });
    },
    onError: (error) => {
      if (isApiError(error, "BAD_REQUEST") && reasonOf(error) === undefined) {
        setInvalid(true);
        return;
      }
      setOpen(false);
      onOutcome({
        kind: "error",
        text: isApiError(error, "REVISION_CONFLICT")
          ? t("github.repo.conflict")
          : refusalText(t, error, "workspace.manage", role),
      });
    },
    onSettled: () =>
      queryClient.invalidateQueries({
        queryKey: repositoriesKey(client, workspaceId),
      }),
  });

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const input = event.currentTarget.elements.namedItem("branch");
    const branch = input instanceof HTMLInputElement ? input.value.trim() : "";
    // The server holds the full rule and answers 400 past it.
    if (branch === "" || /\s/.test(branch)) {
      setInvalid(true);
      return;
    }
    if (branch === row.branch) {
      setOpen(false);
      return;
    }
    if (!save.isPending) save.mutate(branch);
  };

  return (
    <span className="flex w-full min-w-0 items-center justify-between gap-1">
      <span className="truncate font-mono text-caption">{row.branch}</span>
      {/* -my-1 keeps the 28px control inside a text row's height. */}
      <Button
        type="button"
        size="icon-sm"
        variant="ghost"
        aria-label={t("github.repo.editName", { name })}
        className="-my-1 shrink-0"
        onClick={() => setOpen(true)}
      >
        <Pencil aria-hidden="true" className="size-3.5" />
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("github.repo.editTitle")}</DialogTitle>
            <DialogDescription>{name}</DialogDescription>
          </DialogHeader>
          <form className="flex flex-col gap-4" noValidate onSubmit={submit}>
            <Field>
              <FieldLabel htmlFor={inputId}>
                {t("github.repo.branch")}
              </FieldLabel>
              <Input
                id={inputId}
                name="branch"
                className="max-w-80"
                autoComplete="off"
                spellCheck={false}
                defaultValue={row.branch}
                aria-describedby={hintId}
                aria-invalid={invalid || undefined}
              />
              <FieldDescription id={hintId}>
                {t("github.repo.branchHint")}
              </FieldDescription>
              {invalid ? (
                <FieldError>{t("github.repo.branchInvalid")}</FieldError>
              ) : null}
            </Field>
            <DialogFooter>
              <Button
                type="button"
                variant="ghost"
                onClick={() => setOpen(false)}
              >
                {t("common.cancel")}
              </Button>
              <Button type="submit" aria-disabled={save.isPending || undefined}>
                {t("github.repo.save")}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </span>
  );
}
