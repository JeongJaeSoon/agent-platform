import { useQuery } from "@tanstack/react-query";
import type { ProfileSummary } from "@werft-ai/contracts";
import { useAgentPlatform } from "@werft-ai/react";
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Badge,
  EmptyState,
  GridTable,
  GridTableCell,
  GridTableColumnHeader,
  GridTableHeader,
  GridTableRow,
  Page,
  Skeleton,
} from "@werft-ai/ui";
import { profilesQuery } from "../api/queries.ts";
import { useHasPermission } from "../auth/guard.tsx";
import { LoadFailure } from "../components/load-failure.tsx";
import { useI18n } from "../i18n/i18n.tsx";

const PROFILE_COLUMNS =
  "minmax(0,1.4fr) minmax(0,1fr) minmax(0,1fr) minmax(0,1.4fr) 96px";
const PROFILE_NARROW_COLUMNS = "minmax(0,1fr) minmax(0,1fr)";
const META = "text-caption text-muted-foreground";

/**
 * The catalog's run profiles, read only: the operator defines them in the
 * installation's settings file (console v4 `profiles`).
 */
export function ProfilesScreen() {
  const { t } = useI18n();
  const { client } = useAgentPlatform();
  const profiles = useQuery(profilesQuery(client));
  const oversight = useHasPermission("workspace.manage");
  const items = profiles.data?.items ?? [];

  return (
    <Page title={t("profiles.title")} description={t("profiles.description")}>
      <Alert variant="blue">
        <AlertTitle>
          {t(oversight ? "profiles.readOnlyTitle" : "profiles.pickTitle")}
        </AlertTitle>
        <AlertDescription>
          {t(oversight ? "profiles.readOnlyText" : "profiles.pickText")}
        </AlertDescription>
      </Alert>
      {profiles.isPending ? (
        <Skeleton width="60%" />
      ) : profiles.isError ? (
        <LoadFailure
          error={profiles.error}
          onRetry={() => void profiles.refetch()}
        />
      ) : items.length === 0 ? (
        <EmptyState title={t("profiles.empty")} />
      ) : (
        <div className="flex flex-col gap-3">
          <div className="rounded-card border bg-card">
            <GridTable
              aria-label={t("profiles.title")}
              columns={PROFILE_COLUMNS}
              narrowAt={640}
              narrowColumns={PROFILE_NARROW_COLUMNS}
            >
              <GridTableHeader>
                <GridTableColumnHeader>
                  {t("profiles.column.profile")}
                </GridTableColumnHeader>
                <GridTableColumnHeader>
                  {t("profiles.column.model")}
                </GridTableColumnHeader>
                <GridTableColumnHeader hideNarrow={true}>
                  {t("profiles.column.repository")}
                </GridTableColumnHeader>
                <GridTableColumnHeader hideNarrow={true}>
                  {t("profiles.column.tools")}
                </GridTableColumnHeader>
                <GridTableColumnHeader hideNarrow={true}>
                  {t("profiles.column.billing")}
                </GridTableColumnHeader>
              </GridTableHeader>
              {items.map((profile) => (
                <ProfileRow key={profile.id} profile={profile} />
              ))}
            </GridTable>
          </div>
          <p className={`m-0 ${META}`}>
            {t("profiles.foot", { count: items.length })}
          </p>
        </div>
      )}
    </Page>
  );
}

function ProfileRow({ profile }: { readonly profile: ProfileSummary }) {
  const { t } = useI18n();
  const tools = profile.tools.join(", ");
  return (
    <GridTableRow>
      <GridTableCell lines={true}>
        <span className="truncate font-medium font-mono text-foreground">
          {profile.id}
        </span>
        <span className={`truncate ${META}`}>
          {t("profiles.runtime", { version: profile.runtime_version })}
        </span>
      </GridTableCell>
      <GridTableCell>
        <Badge variant="mono" className="max-w-full truncate">
          {profile.model}
        </Badge>
      </GridTableCell>
      <GridTableCell hideNarrow={true}>
        <span className="truncate">
          {t(`profiles.repository.${profile.repository_mode}`)}
        </span>
      </GridTableCell>
      <GridTableCell hideNarrow={true}>
        <span className="truncate" title={tools || undefined}>
          {tools || t("profiles.noTools")}
        </span>
      </GridTableCell>
      <GridTableCell hideNarrow={true}>
        <span className="truncate">
          {t(`profiles.billing.${profile.billing}`)}
        </span>
      </GridTableCell>
    </GridTableRow>
  );
}
