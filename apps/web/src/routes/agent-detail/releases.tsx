import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type ApiError, unwrap } from "@werft-ai/client";
import type {
  AgentDetail,
  AgentRelease,
  CreateAgentReleaseResponse,
  ProfileSummary,
} from "@werft-ai/contracts";
import { useAgentPlatform } from "@werft-ai/react";
import {
  Alert,
  Badge,
  Button,
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  EmptyState,
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
  formatTimestamp,
  NativeSelect,
  NativeSelectOption,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableHeader,
  TableRow,
} from "@werft-ai/ui";
import { Plus } from "lucide-react";
import { type FormEvent, type ReactNode, useId, useRef, useState } from "react";
import { membersQuery, profilesQuery, queryKeysOf } from "../../api/queries.ts";
import { useHasPermission, useRole } from "../../auth/guard.tsx";
import type { Outcome } from "../../components/outcome.tsx";
import { ProfileOptions, pickable } from "../../components/profile-options.tsx";
import { errorKey, useI18n } from "../../i18n/i18n.tsx";
import { agentRefusal } from "../agents.tsx";
import { MUTED, SECTION, SECTION_TITLE } from "./classes.ts";
import { latestVersion, VersionSelect } from "./versions.tsx";

// The note column no longer takes all the spare width; the columns share it,
// so a short history does not crowd to the left with only the gutter between.
const SPREAD = "w-auto";

export function Releases({
  detail,
  picked,
  onPick,
  versionNo,
  result,
  onOutcome,
  activating,
  onActivate,
  shown,
}: {
  readonly detail: AgentDetail;
  /** The version to release; null offers the latest. */
  readonly picked: string | null;
  readonly onPick: (versionId: string) => void;
  readonly versionNo: (versionId: string) => number | undefined;
  /** Release and activation results, between the form and the list. */
  readonly result: ReactNode;
  readonly onOutcome: (outcome: Outcome | null) => void;
  readonly activating: string | undefined;
  readonly onActivate: (release: AgentRelease) => void;
  /** Whether the tab is open; every tab stays mounted. */
  readonly shown: boolean;
}) {
  const { t, locale } = useI18n();
  const { client } = useAgentPlatform();
  const queryClient = useQueryClient();
  const role = useRole();
  const titleId = useId();
  const latest = latestVersion(detail);
  const versionId = picked ?? latest?.id ?? "";
  const profiles = useQuery(profilesQuery(client));
  const [chosen, setProfile] = useState(
    detail.releases.at(-1)?.runtime_profile_id ?? "",
  );
  const cardModel = detail.versions.find((v) => v.id === versionId)?.card.model;
  // A profile the catalog no longer has cannot be released again; without
  // a usable choice, offer one that runs the card's model.
  const items = profiles.data?.items ?? [];
  const usable = items.filter(pickable);
  const profile = usable.some((item) => item.id === chosen)
    ? chosen
    : ((usable.find((item) => item.model === cardModel) ?? usable[0])?.id ??
      "");
  const [chosenRepository, setRepository] = useState(
    detail.releases.at(-1)?.repository_id ?? "",
  );
  const pickedProfile = items.find((item) => item.id === profile);
  const repositoryMode = pickedProfile?.repository_mode;
  const repositories = pickedProfile?.repository_ids ?? [];
  // "" is no repository, which only an optional profile offers.
  const repository =
    repositoryMode === undefined || repositoryMode === "none"
      ? ""
      : repositories.includes(chosenRepository)
        ? chosenRepository
        : repositoryMode === "required"
          ? (repositories[0] ?? "")
          : "";
  const [open, setOpen] = useState(false);
  const submitted = useRef(false);
  // Only roles that list members get names; anyone else reads "a member".
  // Read when the tab opens, not with every visit to the agent.
  const listsMembers = useHasPermission("member.manage");
  const members = useQuery({
    ...membersQuery(client),
    enabled: listsMembers && shown,
  });
  const names = new Map(
    (members.data?.items ?? []).map((m) => [m.user_id, m.display_name]),
  );
  const ordered = [...detail.releases].sort((a, b) =>
    b.created_at.localeCompare(a.created_at),
  );
  // The server refuses a release whose profile runs another model than the
  // card names; say so before the request.
  const profileModel = items.find((item) => item.id === profile)?.model;
  const mismatch =
    cardModel !== undefined &&
    profileModel !== undefined &&
    cardModel !== profileModel;

  const release = useMutation<CreateAgentReleaseResponse, ApiError>({
    mutationFn: () =>
      unwrap(
        client.POST("/v1/agents/{id}/releases", {
          params: { path: { id: detail.agent.id } },
          body: {
            version_id: versionId,
            runtime_profile_id: profile,
            ...(repository === "" ? {} : { repository_id: repository }),
          },
        }),
      ),
    onMutate: () => onOutcome(null),
    onSuccess: async (result) => {
      onOutcome({
        kind: "notice",
        text: result.created
          ? t("agent.releaseCreated", {
              version: versionNo(result.release.version_id) ?? "?",
            })
          : t("agent.releaseExisted"),
      });
      await queryClient.invalidateQueries({
        queryKey: queryKeysOf(client).agent(detail.agent.id),
      });
    },
    onError: (error) =>
      onOutcome({ kind: "error", text: agentRefusal(t, error, role) }),
  });

  // The dialog closes before the request: the result shows under the
  // table, where focus goes, and a late answer cannot close a dialog
  // opened after it.
  const submit = (event: FormEvent) => {
    event.preventDefault();
    submitted.current = true;
    setOpen(false);
    release.mutate();
  };

  return (
    <section className={SECTION} aria-labelledby={titleId}>
      <div className="flex min-h-7 flex-wrap items-center justify-between gap-3">
        <h2 id={titleId} className={SECTION_TITLE}>
          {t("agent.releases.title")}
        </h2>
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={release.isPending}
            >
              <Plus aria-hidden="true" />
              {release.isPending
                ? t("agent.releases.creating")
                : t("agent.releases.new")}
            </Button>
          </DialogTrigger>
          <DialogContent
            className="sm:max-w-[32.5rem]"
            // The result line below the table takes the keyboard instead.
            onCloseAutoFocus={(event) => {
              if (submitted.current) event.preventDefault();
              submitted.current = false;
            }}
          >
            <DialogHeader>
              <DialogTitle>{t("agent.releases.new")}</DialogTitle>
              <DialogDescription>{t("agent.releases.intro")}</DialogDescription>
            </DialogHeader>
            <form className="flex flex-col gap-4" onSubmit={submit}>
              <VersionSelect
                label={t("agent.releases.version")}
                versions={[...detail.versions].sort(
                  (a, b) => b.version_no - a.version_no,
                )}
                value={versionId}
                onChange={onPick}
              />
              {profiles.isPending ? (
                <p className={MUTED}>{t("agent.releases.profilesLoading")}</p>
              ) : profiles.error ? (
                <p className="m-0 text-destructive text-sm" role="alert">
                  {t("agent.releases.profilesFailed", {
                    reason: t(errorKey((profiles.error as ApiError).code)),
                  })}
                </p>
              ) : (
                <ProfileSelect
                  label={t("agent.releases.profile")}
                  hint={t("agent.releases.profileHint")}
                  profiles={items}
                  cardModel={cardModel}
                  value={profile}
                  onChange={setProfile}
                />
              )}
              {repositoryMode === undefined ||
              repositoryMode === "none" ? null : repositories.length === 0 &&
                repositoryMode === "required" ? (
                <FieldError>{t("agent.releases.repositoryMissing")}</FieldError>
              ) : (
                <RepositorySelect
                  label={t("agent.releases.repository")}
                  hint={t("agent.releases.repositoryHint")}
                  repositories={repositories}
                  optional={repositoryMode === "optional"}
                  value={repository}
                  onChange={setRepository}
                />
              )}
              {mismatch ? (
                <Alert asChild variant="amber">
                  <output>
                    {t("agent.releases.modelMismatch", {
                      card: cardModel,
                      profile: profileModel,
                    })}
                  </output>
                </Alert>
              ) : null}
              <DialogFooter>
                <DialogClose asChild>
                  <Button type="button" variant="outline">
                    {t("common.cancel")}
                  </Button>
                </DialogClose>
                <Button
                  type="submit"
                  disabled={
                    release.isPending ||
                    versionId === "" ||
                    profile === "" ||
                    (repositoryMode === "required" && repository === "")
                  }
                >
                  {release.isPending
                    ? t("agent.releases.creating")
                    : t("agent.releases.create")}
                </Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>
      </div>
      {result}
      {ordered.length === 0 ? (
        <EmptyState
          title={t("agent.releases.empty")}
          description={t("agent.releases.emptyBody")}
        />
      ) : (
        <TableContainer label={t("agent.releases.title")}>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead variant="nowrap" className={SPREAD}>
                  {t("agent.releases.colVersion")}
                </TableHead>
                <TableHead variant="nowrap" className={SPREAD}>
                  {t("agent.releases.colStatus")}
                </TableHead>
                <TableHead variant="nowrap" className={SPREAD}>
                  {t("agent.releases.profile")}
                </TableHead>
                <TableHead variant="nowrap" className={SPREAD}>
                  {t("agent.releases.repository")}
                </TableHead>
                <TableHead variant="nowrap" className={SPREAD}>
                  {t("agent.releases.colBy")}
                </TableHead>
                <TableHead variant="nowrap" className={SPREAD}>
                  {t("agent.releases.colAt")}
                </TableHead>
                <TableHead className="min-w-72">
                  {t("agent.releases.colNote")}
                </TableHead>
                <TableHead variant="actions">
                  <span className="sr-only">
                    {t("agent.releases.colActions")}
                  </span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {ordered.map((item) => {
                const active = item.id === detail.agent.active_release_id;
                const label = t("agent.releaseLabel", {
                  version: versionNo(item.version_id) ?? "?",
                  profile: item.runtime_profile_id,
                });
                return (
                  <TableRow key={item.id} data-active={active}>
                    <TableCell
                      variant="nowrap"
                      className={`${SPREAD} font-medium`}
                    >
                      {t("agent.versionShort", {
                        version: versionNo(item.version_id) ?? "?",
                      })}
                    </TableCell>
                    <TableCell variant="nowrap" className={SPREAD}>
                      <Badge variant={active ? "green" : "gray"}>
                        {active
                          ? t("agent.releases.active")
                          : item.approved_at
                            ? t("agent.releases.previous")
                            : t("agent.releases.never")}
                      </Badge>
                    </TableCell>
                    <TableCell variant="nowrap" className={SPREAD}>
                      <span className="font-mono text-caption">
                        {item.runtime_profile_id}
                      </span>
                      {profiles.isSuccess &&
                      !items.some(
                        (listed) => listed.id === item.runtime_profile_id,
                      ) ? (
                        <Badge variant="amber" className="ml-2">
                          {t("agent.releases.profileGone")}
                        </Badge>
                      ) : null}
                    </TableCell>
                    <TableCell
                      variant="nowrap"
                      className={`${SPREAD} font-mono text-caption`}
                    >
                      {item.repository_id ?? t("agent.releases.repositoryNone")}
                    </TableCell>
                    <TableCell variant="nowrap" className={SPREAD}>
                      {(item.created_by
                        ? names.get(item.created_by)
                        : undefined) ?? t("agent.releases.byMember")}
                    </TableCell>
                    <TableCell
                      variant="nowrap"
                      className={`${SPREAD} tabular-nums`}
                    >
                      {formatTimestamp(item.created_at, locale)}
                    </TableCell>
                    {/* Wrapped, not cut: a note runs to 200 characters. */}
                    <TableCell className="min-w-72 break-words">
                      {item.note ?? (
                        <span className="text-muted-foreground">
                          {t("agent.releases.noteNone")}
                        </span>
                      )}
                    </TableCell>
                    <TableCell variant="actions">
                      {active ? null : (
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          disabled={activating !== undefined}
                          aria-label={t("agent.releases.activateFor", {
                            release: label,
                          })}
                          onClick={() => onActivate(item)}
                        >
                          {activating === item.id
                            ? t("agent.releases.activating")
                            : t("agent.releases.activate")}
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </TableContainer>
      )}
    </section>
  );
}

function ProfileSelect({
  label,
  hint,
  profiles,
  cardModel,
  value,
  onChange,
}: {
  readonly label: string;
  readonly hint: string;
  readonly profiles: readonly ProfileSummary[];
  readonly cardModel: string | undefined;
  readonly value: string;
  readonly onChange: (id: string) => void;
}) {
  const { t } = useI18n();
  return (
    <Field className="w-auto max-w-full">
      <FieldLabel>{label}</FieldLabel>
      <NativeSelect
        required
        value={value}
        onChange={(event) => onChange(event.target.value)}
      >
        <ProfileOptions
          profiles={profiles}
          label={(profile) =>
            t(
              cardModel !== undefined && profile.model !== cardModel
                ? "agent.releases.profileOptionMismatch"
                : "agent.releases.profileOption",
              { profile: profile.id, model: profile.model },
            )
          }
        />
      </NativeSelect>
      <FieldDescription>{hint}</FieldDescription>
      <FieldDescription>{t("agent.releases.profileUnlisted")}</FieldDescription>
    </Field>
  );
}

function RepositorySelect({
  label,
  hint,
  repositories,
  optional,
  value,
  onChange,
}: {
  readonly label: string;
  readonly hint: string;
  readonly repositories: readonly string[];
  /** Offers no repository, for a profile whose sessions may go without one. */
  readonly optional: boolean;
  readonly value: string;
  readonly onChange: (id: string) => void;
}) {
  const { t } = useI18n();
  return (
    <Field className="w-auto max-w-full">
      <FieldLabel>{label}</FieldLabel>
      <NativeSelect
        required={!optional}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      >
        {optional ? (
          <NativeSelectOption value="">
            {t("agent.releases.repositoryNone")}
          </NativeSelectOption>
        ) : null}
        {repositories.map((id) => (
          <NativeSelectOption key={id} value={id}>
            {id}
          </NativeSelectOption>
        ))}
      </NativeSelect>
      <FieldDescription>{hint}</FieldDescription>
    </Field>
  );
}
