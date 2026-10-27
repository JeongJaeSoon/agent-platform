import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type ApiError, unwrap } from "@werft-ai/client";
import type {
  ProfileSummary,
  WorkspaceProfileChangeResponse,
  WorkspaceProfileState,
} from "@werft-ai/contracts";
import { workspaceProfileId } from "@werft-ai/core/forms";
import { useAgentPlatform } from "@werft-ai/react";
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Badge,
  Button,
  ConfirmDialog,
  cn,
  EmptyState,
  GridTable,
  GridTableCell,
  GridTableColumnHeader,
  GridTableHeader,
  GridTableRow,
  Page,
  Section,
  Skeleton,
} from "@werft-ai/ui";
import { Lock, Plus } from "lucide-react";
import { useState } from "react";
import { profilesQuery, queryKeysOf } from "../api/queries.ts";
import {
  refusalText,
  useHasPermission,
  useMe,
  useRole,
} from "../auth/guard.tsx";
import { Notice } from "../components/auth-page.tsx";
import { LoadFailure } from "../components/load-failure.tsx";
import { useI18n } from "../i18n/i18n.tsx";
import { type EditorStart, ProfileEditor } from "./profile-editor.tsx";

const PROFILE_COLUMNS = "minmax(0,1.2fr) minmax(0,1fr) minmax(0,1.4fr)";
// The base column leaves a phone; the editor shows it again.
const VERSION_COLUMNS = {
  manage: [
    "minmax(0,1.4fr) minmax(0,1fr) 96px 184px",
    "minmax(0,1fr) 88px 112px",
  ],
  read: ["minmax(0,1.4fr) minmax(0,1fr) 96px", "minmax(0,1fr) 88px"],
} as const;
const META = "text-caption text-muted-foreground";

const STATE_BADGE: Record<WorkspaceProfileState, "green" | "red" | "gray"> = {
  usable: "green",
  base_changed: "red",
  base_missing: "red",
  retired: "gray",
};

export function ProfilesScreen() {
  const { t } = useI18n();
  const { client } = useAgentPlatform();
  const queryClient = useQueryClient();
  const role = useRole();
  const workspace = useMe()?.workspace;
  const profiles = useQuery(profilesQuery(client));
  const manages = useHasPermission("workspace.manage");
  const [editor, setEditor] = useState<EditorStart | null>(null);
  const [retiring, setRetiring] = useState<ProfileSummary | null>(null);
  const [retireError, setRetireError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const items = profiles.data?.items ?? [];
  const operators = items.filter((item) => item.source === "operator");
  const versions = items
    .filter((item) => item.source === "workspace")
    .sort(
      (a, b) =>
        (a.workspace?.name ?? "").localeCompare(b.workspace?.name ?? "") ||
        (b.workspace?.version ?? 0) - (a.workspace?.version ?? 0),
    );
  const nextId = (name: string) =>
    workspaceProfileId(
      workspace ?? { id: "", slug: "" },
      name,
      Math.max(
        0,
        ...versions
          .filter((item) => item.workspace?.name === name)
          .map((item) => item.workspace?.version ?? 0),
      ) + 1,
    );
  const baseOf = (item: ProfileSummary) =>
    operators.find((base) => base.id === item.workspace?.base_profile_id);
  const stranded = versions.filter(
    (item) =>
      (item.workspace?.state === "base_changed" ||
        item.workspace?.state === "base_missing") &&
      !versions.some(
        (other) =>
          other.workspace?.name === item.workspace?.name &&
          (other.workspace?.version ?? 0) > (item.workspace?.version ?? 0),
      ),
  );

  const retire = useMutation<WorkspaceProfileChangeResponse, ApiError, string>({
    mutationFn: (id) =>
      unwrap(
        client.POST("/v1/workspace-profiles/{profile_id}/retire", {
          params: { path: { profile_id: id } },
        }),
      ),
    onMutate: () => setRetireError(null),
    onSuccess: async ({ profile }) => {
      setRetiring(null);
      setNotice(t("profiles.retired", { id: profile.id }));
      await queryClient.invalidateQueries({
        queryKey: queryKeysOf(client).profiles,
      });
    },
    onError: (failure) =>
      setRetireError(refusalText(t, failure, "workspace.manage", role)),
  });

  const open = (start: EditorStart) => {
    setNotice(null);
    setEditor(start);
  };

  return (
    <Page
      title={t("profiles.title")}
      description={t("profiles.description")}
      actions={
        manages && operators[0] !== undefined ? (
          <Button
            type="button"
            onClick={() =>
              operators[0] && open({ mode: "new", base: operators[0] })
            }
          >
            <Plus aria-hidden="true" />
            {t("profiles.create")}
          </Button>
        ) : null
      }
    >
      {profiles.isPending ? (
        <Skeleton width="60%" />
      ) : profiles.isError ? (
        <LoadFailure
          error={profiles.error}
          onRetry={() => void profiles.refetch()}
        />
      ) : (
        <div className="flex flex-col gap-[var(--ap-space-section)]">
          <Notice>{notice ?? undefined}</Notice>
          {stranded.map((item) => (
            <Alert key={item.id} variant="red">
              <AlertTitle>
                {t(
                  item.workspace?.state === "base_missing"
                    ? "profiles.baseMissing.title"
                    : "profiles.baseChanged.title",
                  { name: item.workspace?.name ?? item.id },
                )}
              </AlertTitle>
              <AlertDescription>
                {t(
                  item.workspace?.state === "base_missing"
                    ? "profiles.baseMissing.text"
                    : "profiles.baseChanged.text",
                  {
                    name: item.workspace?.name ?? item.id,
                    base: item.workspace?.base_profile_id ?? "",
                    id: item.id,
                  },
                )}
              </AlertDescription>
            </Alert>
          ))}
          {editor === null ? null : (
            <ProfileEditor
              key={editor.mode === "new" ? "new" : editor.from.id}
              start={editor}
              operators={operators}
              nextId={nextId}
              onCancel={() => setEditor(null)}
              onSaved={(id) => {
                setEditor(null);
                setNotice(t("profiles.saved", { id }));
              }}
            />
          )}
          <Section
            title={t("profiles.workspace.title")}
            description={t("profiles.workspace.description")}
          >
            {manages ? null : (
              <p className={cn("m-0 mb-3 flex items-center gap-1", META)}>
                <Lock aria-hidden="true" className="size-3.5 shrink-0" />
                {t("profiles.locked")}
              </p>
            )}
            {versions.length === 0 ? (
              <EmptyState
                title={t("profiles.emptyWorkspace.title")}
                description={t("profiles.emptyWorkspace.text")}
              />
            ) : (
              <div className="rounded-card border bg-card">
                <GridTable
                  aria-label={t("profiles.workspace.title")}
                  columns={VERSION_COLUMNS[manages ? "manage" : "read"][0]}
                  narrowAt={640}
                  narrowColumns={
                    VERSION_COLUMNS[manages ? "manage" : "read"][1]
                  }
                >
                  <GridTableHeader>
                    <GridTableColumnHeader>
                      {t("profiles.column.name")}
                    </GridTableColumnHeader>
                    <GridTableColumnHeader hideNarrow>
                      {t("profiles.column.base")}
                    </GridTableColumnHeader>
                    <GridTableColumnHeader>
                      {t("profiles.column.state")}
                    </GridTableColumnHeader>
                    {manages ? (
                      <GridTableColumnHeader>
                        {t("profiles.column.actions")}
                      </GridTableColumnHeader>
                    ) : null}
                  </GridTableHeader>
                  {versions.map((item) => (
                    <VersionRow
                      key={item.id}
                      profile={item}
                      manages={manages}
                      base={baseOf(item)}
                      onEdit={(mode, base) => open({ mode, from: item, base })}
                      onRetire={() => {
                        setRetireError(null);
                        setRetiring(item);
                      }}
                    />
                  ))}
                </GridTable>
              </div>
            )}
          </Section>
          <Section
            title={t("profiles.operator.title")}
            description={t("profiles.operator.description")}
          >
            {operators.length === 0 ? (
              <EmptyState title={t("profiles.empty")} />
            ) : (
              <div className="flex flex-col gap-[var(--ap-space-block)]">
                <div className="rounded-card border bg-card">
                  <GridTable
                    aria-label={t("profiles.operator.title")}
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
                    {operators.map((profile) => (
                      <ProfileRow key={profile.id} profile={profile} />
                    ))}
                  </GridTable>
                </div>
                <p className={`m-0 ${META}`}>
                  {t("profiles.foot", { count: operators.length })}
                </p>
              </div>
            )}
          </Section>
        </div>
      )}
      <ConfirmDialog
        open={retiring !== null}
        onOpenChange={(next) => {
          if (!next && !retire.isPending) setRetiring(null);
        }}
        title={t("profiles.retireTitle", { id: retiring?.id ?? "" })}
        consequence={t("profiles.retireText")}
        confirmLabel={
          retire.isPending ? t("profiles.retiring") : t("profiles.retire")
        }
        cancelLabel={t("common.cancel")}
        tone="danger"
        busy={retire.isPending}
        onConfirm={() => {
          if (retiring !== null && !retire.isPending)
            retire.mutate(retiring.id);
        }}
      >
        {retireError === null ? null : (
          <Alert variant="red" role="alert">
            <AlertDescription>{retireError}</AlertDescription>
          </Alert>
        )}
      </ConfirmDialog>
    </Page>
  );
}

function VersionRow({
  profile,
  manages,
  base,
  onEdit,
  onRetire,
}: {
  readonly profile: ProfileSummary;
  readonly manages: boolean;
  readonly base: ProfileSummary | undefined;
  readonly onEdit: (mode: "version" | "remake", base: ProfileSummary) => void;
  readonly onRetire: () => void;
}) {
  const { t } = useI18n();
  const state = profile.workspace?.state ?? "usable";
  return (
    <GridTableRow>
      <GridTableCell>
        <Stack
          first={profile.workspace?.name ?? profile.id}
          firstClassName="font-medium text-foreground"
          second={profile.id}
          secondClassName="font-mono"
        />
      </GridTableCell>
      <GridTableCell hideNarrow>
        <Stack
          first={profile.workspace?.base_profile_id ?? ""}
          firstClassName="font-mono text-caption"
          second={profile.models.join(", ")}
        />
      </GridTableCell>
      <GridTableCell>
        <Badge variant={STATE_BADGE[state]}>
          {t(`profiles.state.${state}`)}
        </Badge>
      </GridTableCell>
      {manages ? (
        <GridTableCell>
          <div className="flex flex-wrap gap-2">
            {base && (state === "usable" || state === "base_changed") ? (
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() =>
                  onEdit(state === "usable" ? "version" : "remake", base)
                }
              >
                {t(
                  state === "usable"
                    ? "profiles.newVersion"
                    : "profiles.remake",
                )}
              </Button>
            ) : null}
            {state === "retired" ? null : (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                aria-label={`${t("profiles.retire")} ${profile.id}`}
                onClick={onRetire}
              >
                {t("profiles.retire")}
              </Button>
            )}
          </div>
        </GridTableCell>
      ) : null}
    </GridTableRow>
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
  secondClassName,
}: {
  readonly first: string;
  readonly firstClassName?: string;
  readonly second: string;
  readonly secondClassName?: string;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-[var(--ap-row-line-gap)]">
      <span className={cn("wrap-anywhere leading-5", firstClassName)}>
        {first}
      </span>
      <span className={cn("wrap-anywhere leading-4", META, secondClassName)}>
        {second}
      </span>
    </div>
  );
}
