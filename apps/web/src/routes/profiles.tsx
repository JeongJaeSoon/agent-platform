import { useQuery } from "@tanstack/react-query";
import type { ProfileSummary } from "@werft-ai/contracts";
import { useAgentPlatform } from "@werft-ai/react";
import {
  Alert,
  AlertDescription,
  AlertTitle,
  cn,
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
      {/* The notice reads with the table it is about (v4: 16 between). */}
      <div className="flex flex-col gap-[var(--ap-space-block)]">
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
          <div className="flex flex-col gap-[var(--ap-space-block)]">
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
      </div>
    </Page>
  );
}

function ProfileRow({ profile }: { readonly profile: ProfileSummary }) {
  const { t } = useI18n();
  return (
    <GridTableRow>
      <GridTableCell>
        <Stack
          first={profile.id}
          firstClassName="font-medium font-mono text-foreground"
          second={t("profiles.runtime", { version: profile.runtime_version })}
        />
      </GridTableCell>
      <GridTableCell>
        <Stack
          first={profile.model}
          firstClassName="font-mono text-caption"
          second={t(`profiles.billing.${profile.billing}`)}
        />
      </GridTableCell>
      <GridTableCell>
        <Stack
          first={t(`profiles.repository.${profile.repository_mode}`)}
          second={profile.tools.join(", ") || t("profiles.noTools")}
        />
      </GridTableCell>
    </GridTableRow>
  );
}

// Not GridTableCell `lines`, which truncates: on a phone every value wraps
// in full instead (no detail view holds the rest).
function Stack({
  first,
  firstClassName,
  second,
}: {
  readonly first: string;
  readonly firstClassName?: string;
  readonly second: string;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-[var(--ap-row-line-gap)]">
      <span className={cn("wrap-anywhere leading-5", firstClassName)}>
        {first}
      </span>
      <span className={cn("wrap-anywhere leading-4", META)}>{second}</span>
    </div>
  );
}
