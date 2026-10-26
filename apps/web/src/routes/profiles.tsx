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

// No column drops on a phone: each cell stacks two values instead.
const PROFILE_COLUMNS = "minmax(0,1.2fr) minmax(0,1fr) minmax(0,1.4fr)";
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
            >
              <GridTableHeader>
                <GridTableColumnHeader>
                  {t("profiles.column.profile")}
                </GridTableColumnHeader>
                <GridTableColumnHeader>
                  {t("profiles.column.model")}
                </GridTableColumnHeader>
                <GridTableColumnHeader>
                  {t("profiles.column.environment")}
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
      <GridTableCell lines={true}>
        <Badge variant="mono" className="max-w-full truncate">
          {profile.model}
        </Badge>
        <span className={`truncate ${META}`}>
          {t(`profiles.billing.${profile.billing}`)}
        </span>
      </GridTableCell>
      <GridTableCell lines={true}>
        <span className="truncate">
          {t(`profiles.repository.${profile.repository_mode}`)}
        </span>
        <span className={`truncate ${META}`} title={tools || undefined}>
          {tools || t("profiles.noTools")}
        </span>
      </GridTableCell>
    </GridTableRow>
  );
}
