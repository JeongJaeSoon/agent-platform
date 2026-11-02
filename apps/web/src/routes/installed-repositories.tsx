import { type components, isApiError } from "@werft-ai/client";
import {
  Badge,
  Button,
  Field,
  FieldLabel,
  NativeSelect,
  NativeSelectOption,
  RowList,
  SettingRow,
} from "@werft-ai/ui";
import { type ReactNode, useId } from "react";
import { type MessageKey, useI18n } from "../i18n/i18n.tsx";

type AgentPage = components["schemas"]["ListAgentGitHubRepositoriesResponse"];
export type InstalledRepository = AgentPage["repositories"][number];
type Page<R> = Pick<
  AgentPage,
  "installations" | "installation_id" | "page" | "per_page" | "total_count"
> & {
  repositories: readonly R[];
  unavailable: string | null;
};

/** The page size the console asks for; GitHub allows up to 100. */
export const INSTALLED_PER_PAGE = 30;

const UNAVAILABLE: Record<string, MessageKey> = {
  no_author_app: "github.repo.pickNoApp",
  no_installation: "github.repo.pickNoInstallation",
};

export const installationGone = (error: unknown) =>
  isApiError(error) &&
  error.code === "NOT_FOUND" &&
  (error.details as { reason_code?: unknown } | null)?.reason_code ===
    "installation_not_found";

/** react-query's default three retries, none for a vanished installation. */
export const retryUnlessGone = (failures: number, error: unknown) =>
  !installationGone(error) && failures < 3;

/**
 * One page of the repositories an installation of the author App reaches,
 * as GitHub pages them: an installation picker when there are several, the
 * rows, and previous/next.
 */
export function InstalledRepositoryPage<R extends InstalledRepository>({
  page,
  onInstallation,
  onPage,
  meta,
  action,
}: {
  readonly page: Page<R>;
  readonly onInstallation: (installationId: number) => void;
  readonly onPage: (page: number) => void;
  readonly meta?: (repository: R) => ReactNode;
  readonly action?: (repository: R) => ReactNode;
}) {
  const { t } = useI18n();
  const selectId = useId();
  if (page.unavailable !== null) {
    return (
      <p className="m-0 text-caption">
        {t(UNAVAILABLE[page.unavailable] ?? "github.repo.pickNoInstallation")}
      </p>
    );
  }
  const from = (page.page - 1) * page.per_page + 1;
  const to = from + page.repositories.length - 1;
  return (
    <div className="flex flex-col gap-2">
      {page.installations.length > 1 ? (
        <Field>
          <FieldLabel htmlFor={selectId}>
            {t("github.repo.installation")}
          </FieldLabel>
          <NativeSelect
            id={selectId}
            size="sm"
            value={String(page.installation_id ?? "")}
            onChange={(event) => onInstallation(Number(event.target.value))}
          >
            {page.installations.map((installation) => (
              <NativeSelectOption
                key={installation.id}
                value={String(installation.id)}
              >
                {installation.role === "reviewer"
                  ? t("github.repo.installationReviewer", {
                      account: installation.account,
                    })
                  : installation.account}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </Field>
      ) : null}
      {page.repositories.length === 0 ? (
        <p className="m-0 text-caption">{t("github.repo.pickEmpty")}</p>
      ) : (
        <RowList variant="joined">
          {page.repositories.map((repository) => (
            <SettingRow
              key={repository.github_repository_id}
              title={repository.full_name}
              badge={
                repository.private ? (
                  <Badge>{t("github.repo.private")}</Badge>
                ) : null
              }
              description={`${t("github.repo.branch")} ${repository.default_branch}`}
              meta={meta?.(repository)}
              actions={action?.(repository)}
            />
          ))}
        </RowList>
      )}
      {page.total_count > page.per_page || page.page > 1 ? (
        <nav
          aria-label={t("github.repo.pickTitle")}
          className="flex items-center justify-end gap-2"
        >
          <span className="text-caption text-subtle-foreground">
            {t("github.repo.pageOf", {
              from: Math.min(from, page.total_count),
              to: Math.max(to, 0),
              total: page.total_count,
            })}
          </span>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={page.page <= 1}
            onClick={() => onPage(page.page - 1)}
          >
            {t("github.repo.previousPage")}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={page.page * page.per_page >= page.total_count}
            onClick={() => onPage(page.page + 1)}
          >
            {t("github.repo.nextPage")}
          </Button>
        </nav>
      ) : null}
    </div>
  );
}
