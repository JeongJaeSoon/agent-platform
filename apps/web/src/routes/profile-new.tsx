import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { unwrap } from "@werft-ai/client";
import type {
  InstallationProfileOptionsResponse,
  ProfileSummary,
} from "@werft-ai/contracts";
import { useAgentPlatform } from "@werft-ai/react";
import {
  Alert,
  AlertDescription,
  EmptyState,
  Field,
  FieldContent,
  FieldDescription,
  FieldLabel,
  FieldLegend,
  FieldSet,
  Page,
  PageBreadcrumb,
  PageBreadcrumbCurrent,
  PageBreadcrumbLink,
  RadioGroup,
  RadioGroupItem,
  Skeleton,
} from "@werft-ai/ui";
import { useId } from "react";
import { profilesQuery, scopedKey } from "../api/queries.ts";
import {
  permissionReason,
  useHasPermission,
  useMe,
  useRole,
} from "../auth/guard.tsx";
import { LoadFailure } from "../components/load-failure.tsx";
import { pickable } from "../components/profile-options.tsx";
import { useI18n } from "../i18n/i18n.tsx";
import { CeilingForm } from "./profile-ceiling-form.tsx";
import {
  allowsAuto,
  type EditorStart,
  ProfileEditor,
} from "./profile-editor.tsx";
import { nextVersionId, profileName } from "./profiles.tsx";

export type ProfileKind = "workspace" | "installation";

export interface ProfileNewSearch {
  readonly kind?: ProfileKind;
  /** The profile a new one starts from: its base, or the version it follows. */
  readonly from?: string;
  /** With `from`: the next version of it, or one made again on its changed base. */
  readonly mode?: "version" | "remake";
}

export function profileNewSearch(
  search: Record<string, unknown>,
): ProfileNewSearch {
  const { kind, from, mode } = search;
  return {
    ...(kind === "workspace" || kind === "installation" ? { kind } : {}),
    ...(typeof from === "string" && from.length > 0 ? { from } : {}),
    ...(mode === "version" || mode === "remake" ? { mode } : {}),
  };
}

export function ProfileNewScreen() {
  const { t } = useI18n();
  const search = profileNewSearch(useSearch({ from: "/authed/profiles/new" }));
  const navigate = useNavigate();
  const { client } = useAgentPlatform();
  const role = useRole();
  const workspace = useMe()?.workspace;
  const manages = useHasPermission("workspace.manage");
  const operates = useHasPermission("profile.installation.manage");
  const profiles = useQuery(profilesQuery(client));
  const items = profiles.data?.items ?? [];
  const operators = items.filter((item) => item.source === "operator");
  const from =
    search.from === undefined
      ? undefined
      : items.find((item) => item.id === search.from);
  // Only an owner makes a ceiling; anyone else asking for one gets the
  // workspace form, the one choice they have.
  const kind: ProfileKind =
    operates &&
    (search.kind ??
      (search.mode && from?.source === "operator"
        ? "installation"
        : "workspace")) === "installation"
      ? "installation"
      : "workspace";
  const options = useQuery({
    queryKey: scopedKey(client, "installation-profile-options"),
    queryFn: () =>
      unwrap(
        client.GET("/v1/installation-profiles/options"),
      ) as Promise<InstallationProfileOptionsResponse>,
    enabled: kind === "installation",
    retry: false,
  });
  const kindId = useId();

  const versioned = search.mode !== undefined && from !== undefined;
  const title =
    kind === "installation"
      ? versioned
        ? t("profiles.new.ceilingVersionTitle", { name: profileName(from) })
        : t("profiles.new.ceilingTitle")
      : versioned && from.source === "workspace"
        ? t(
            search.mode === "remake"
              ? "profiles.editor.remakeTitle"
              : "profiles.editor.versionTitle",
            { name: profileName(from) },
          )
        : t("profiles.create");

  const breadcrumb = (
    <PageBreadcrumb label={t("shell.breadcrumb")}>
      <PageBreadcrumbLink asChild>
        <Link to="/profiles" activeOptions={{ exact: true }}>
          {t("profiles.title")}
        </Link>
      </PageBreadcrumbLink>
      {from ? (
        <PageBreadcrumbLink asChild>
          <Link to="/profiles/$profileId" params={{ profileId: from.id }}>
            {from.id}
          </Link>
        </PageBreadcrumbLink>
      ) : null}
      <PageBreadcrumbCurrent>{title}</PageBreadcrumbCurrent>
    </PageBreadcrumb>
  );

  const opened = (id: string) =>
    void navigate({ to: "/profiles/$profileId", params: { profileId: id } });

  const body = () => {
    if (profiles.isPending) return <Skeleton width="60%" />;
    if (profiles.isError)
      return (
        <LoadFailure
          error={profiles.error}
          onRetry={() => void profiles.refetch()}
        />
      );
    if (!manages && !operates)
      return (
        <Alert variant="amber">
          <AlertDescription>
            {permissionReason(t, "workspace.manage", role)}
          </AlertDescription>
        </Alert>
      );
    const missing =
      search.from !== undefined && from === undefined ? (
        <Alert variant="amber">
          <AlertDescription>
            {t("profiles.new.fromMissing", { id: search.from })}
          </AlertDescription>
        </Alert>
      ) : null;

    if (kind === "installation") {
      if (options.isPending) return <Skeleton width="60%" />;
      if (options.isError)
        return (
          <LoadFailure
            error={options.error}
            onRetry={() => void options.refetch()}
          />
        );
      if (
        options.data.connections.length === 0 ||
        options.data.runtimes.length === 0
      )
        return (
          <EmptyState
            title={t("profiles.new.cannotMake")}
            description={t(
              options.data.connections.length === 0
                ? "profiles.new.noConnections"
                : "profiles.new.noRuntimes",
            )}
          />
        );
      const template = from?.source === "operator" ? from : undefined;
      return (
        <>
          {missing}
          <CeilingForm
            key={`${search.from}:${search.mode}`}
            options={options.data}
            operators={operators}
            template={template}
            previous={search.mode === "version" ? template : undefined}
            cancelTo={from?.id}
            onSaved={opened}
          />
        </>
      );
    }

    if (!manages)
      return (
        <Alert variant="amber">
          <AlertDescription>
            {permissionReason(t, "workspace.manage", role)}
          </AlertDescription>
        </Alert>
      );
    const bases = operators.filter(pickable);
    const firstBase = bases.find(allowsAuto) ?? bases[0];
    const start = workspaceStart(search, from, operators, firstBase);
    if (start === null)
      return (
        <EmptyState
          title={t("profiles.new.cannotMake")}
          description={t(
            from?.source === "workspace"
              ? "profiles.error.baseUnusable"
              : "profiles.new.noBase",
          )}
        />
      );
    return (
      <>
        {missing}
        <ProfileEditor
          key={`${search.from}:${search.mode}`}
          start={start}
          operators={operators}
          nextId={(name) => nextVersionId(workspace, items, name)}
          onCancel={() =>
            void navigate(
              from
                ? { to: "/profiles/$profileId", params: { profileId: from.id } }
                : { to: "/profiles" },
            )
          }
          onSaved={opened}
        />
      </>
    );
  };

  return (
    <Page
      breadcrumb={breadcrumb}
      title={title}
      description={t(
        kind === "installation"
          ? "profiles.new.ceilingDescription"
          : "profiles.editor.description",
      )}
    >
      <div className="flex flex-col gap-[var(--ap-space-block)]">
        {operates && search.mode === undefined ? (
          <FieldSet className="gap-3">
            <FieldLegend id={kindId} variant="label" className="mb-0">
              {t("profiles.new.kind")}
            </FieldLegend>
            <RadioGroup
              value={kind}
              aria-labelledby={kindId}
              onValueChange={(next) =>
                void navigate({
                  to: "/profiles/new",
                  search: {
                    kind: next as ProfileKind,
                    ...(search.from ? { from: search.from } : {}),
                  },
                  replace: true,
                })
              }
            >
              {(["workspace", "installation"] as const).map((value) => (
                <Field key={value} orientation="horizontal">
                  <RadioGroupItem value={value} />
                  <FieldContent>
                    <FieldLabel>{t(`profiles.kind.${value}`)}</FieldLabel>
                    <FieldDescription>
                      {t(`profiles.new.kindHint.${value}`)}
                    </FieldDescription>
                  </FieldContent>
                </Field>
              ))}
            </RadioGroup>
          </FieldSet>
        ) : null}
        {body()}
      </div>
    </Page>
  );
}

/** Where a workspace profile starts, or null when nothing usable is there to narrow. */
function workspaceStart(
  search: ProfileNewSearch,
  from: ProfileSummary | undefined,
  operators: readonly ProfileSummary[],
  firstBase: ProfileSummary | undefined,
): EditorStart | null {
  if (from?.source === "workspace") {
    const base = operators.find(
      (item) => item.id === from.workspace?.base_profile_id && pickable(item),
    );
    if (base === undefined) return null;
    return {
      mode: search.mode === "remake" ? "remake" : "version",
      from,
      base,
    };
  }
  if (from !== undefined && pickable(from)) return { mode: "new", base: from };
  return firstBase === undefined ? null : { mode: "new", base: firstBase };
}
