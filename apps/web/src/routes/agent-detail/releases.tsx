import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type ApiError, unwrap } from "@werft-ai/client";
import type {
  AgentDetail,
  AgentRelease,
  CreateAgentReleaseResponse,
  ProfileSummary,
} from "@werft-ai/contracts";
import { useWerft } from "@werft-ai/react";
import {
  Badge,
  Button,
  Code,
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
  GridTable,
  GridTableCell,
  GridTableColumnHeader,
  GridTableHeader,
  GridTableRow,
  NativeSelect,
  NativeSelectOption,
  RelativeTime,
  RowAction,
  Section,
  Skeleton,
  Text,
} from "@werft-ai/ui";
import { ChevronDown, ChevronUp, Plus } from "lucide-react";
import {
  type FormEvent,
  type ReactNode,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import {
  memberSummariesQuery,
  profilesQuery,
  queryKeysOf,
} from "../../api/queries.ts";
import { useHasPermission, useRole } from "../../auth/guard.tsx";
import { useManagesAgent } from "../../components/agent-access.tsx";
import { chosenProfile } from "../../components/agent-card-form.tsx";
import type { Outcome } from "../../components/outcome.tsx";
import {
  ProfileOptions,
  runsModel,
} from "../../components/profile-options.tsx";
import { SECTION_BODY } from "../../components/section-body.ts";
import { withNodes } from "../../components/with-nodes.tsx";
import { errorKey, useI18n } from "../../i18n/i18n.tsx";
import { agentRefusal } from "../agents.tsx";
import { previousRelease, releaseChanges } from "./release-changes.ts";
import { ReleaseChangesSummary } from "./release-changes-view.tsx";
import { latestVersion, VersionSelect } from "./versions.tsx";

// Version, status, activated, card, profile, repository, by, note, actions;
// a narrow table keeps the version and the action, and the version cell
// shows the status and lists the rest.
const COLUMNS = [
  "minmax(10rem,1.4fr) 96px minmax(0,1.2fr) 72px minmax(0,1.6fr) minmax(0,1fr) minmax(0,1fr) minmax(0,1fr) 120px",
  "minmax(0,1fr) 120px",
] as const;

/** The profile the agent runs on now: its active release's, else its newest. */
export function releasedProfile(detail: AgentDetail): string | undefined {
  const active = detail.releases.find(
    (release) => release.id === detail.agent.active_release_id,
  );
  return (active ?? detail.releases.at(-1))?.runtime_profile_id;
}

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
  profileId,
  onProfileChange,
}: {
  readonly detail: AgentDetail;
  /** The profile picked here or in the card editor; unset, the released one. */
  readonly profileId: string | undefined;
  readonly onProfileChange: (profileId: string) => void;
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
  const { client } = useWerft();
  const queryClient = useQueryClient();
  const role = useRole();
  const manages = useManagesAgent();
  const latest = latestVersion(detail);
  const versionId = picked ?? latest?.id ?? "";
  const profiles = useQuery({ ...profilesQuery(client), enabled: manages });
  const cardModel = detail.versions.find((v) => v.id === versionId)?.card.model;
  const items = profiles.data?.items ?? [];
  // The card editor's checklist resolves the same way, so both show one profile.
  const profile =
    chosenProfile(items, cardModel ?? "", profileId ?? releasedProfile(detail))
      ?.id ?? "";
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
  // Read when the tab opens, not with every visit to the agent, and only
  // for the people who made a release.
  const listsMembers = useHasPermission("member.manage");
  const authors = [
    ...new Set(
      detail.releases.flatMap((item) =>
        item.created_by ? [item.created_by] : [],
      ),
    ),
  ];
  const members = useQuery({
    ...memberSummariesQuery(client, authors),
    enabled: listsMembers && shown && authors.length > 0,
  });
  const names = new Map(
    (members.data?.items ?? []).map((m) => [m.user_id, m.display_name]),
  );
  const ordered = [...detail.releases].sort((a, b) =>
    b.created_at.localeCompare(a.created_at),
  );
  const cards = new Map(detail.versions.map((v) => [v.id, v.card]));
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
          ? t("agent.releaseCreated", { release: result.release.label })
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
    <Section
      title={t("agent.releases.title")}
      actions={
        manages ? (
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
                <DialogDescription>
                  {t("agent.releases.intro")}
                </DialogDescription>
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
                  <Skeleton label={t("agent.releases.profilesLoading")} />
                ) : profiles.error ? (
                  <FieldError>
                    {t("agent.releases.profilesFailed", {
                      reason: t(errorKey((profiles.error as ApiError).code)),
                    })}
                  </FieldError>
                ) : (
                  <ProfileSelect
                    label={t("agent.releases.profile")}
                    hint={t("agent.releases.profileHint")}
                    profiles={items}
                    cardModel={cardModel}
                    value={profile}
                    onChange={onProfileChange}
                  />
                )}
                {repositoryMode === undefined ||
                repositoryMode === "none" ? null : repositories.length === 0 &&
                  repositoryMode === "required" ? (
                  <FieldError>
                    {t("agent.releases.repositoryMissing")}
                  </FieldError>
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
        ) : undefined
      }
    >
      <div className={SECTION_BODY}>
        {result}
        {ordered.length === 0 ? (
          <EmptyState
            title={t("agent.releases.empty")}
            description={t("agent.releases.emptyBody")}
          />
        ) : (
          <GridTable
            aria-label={t("agent.releases.title")}
            columns={COLUMNS[0]}
            narrowAt={860}
            narrowColumns={COLUMNS[1]}
            framed={true}
          >
            <GridTableHeader>
              <GridTableColumnHeader>
                {t("agent.releases.colVersion")}
              </GridTableColumnHeader>
              <GridTableColumnHeader hideNarrow>
                {t("agent.releases.colStatus")}
              </GridTableColumnHeader>
              <GridTableColumnHeader hideNarrow>
                {t("agent.releases.colActivated")}
              </GridTableColumnHeader>
              <GridTableColumnHeader hideNarrow>
                {t("agent.releases.colCard")}
              </GridTableColumnHeader>
              <GridTableColumnHeader hideNarrow>
                {t("agent.releases.profile")}
              </GridTableColumnHeader>
              <GridTableColumnHeader hideNarrow>
                {t("agent.releases.repository")}
              </GridTableColumnHeader>
              <GridTableColumnHeader hideNarrow>
                {t("agent.releases.colBy")}
              </GridTableColumnHeader>
              <GridTableColumnHeader hideNarrow>
                {t("agent.releases.colNote")}
              </GridTableColumnHeader>
              <GridTableColumnHeader action>
                <span className="sr-only">
                  {t("agent.releases.colActions")}
                </span>
              </GridTableColumnHeader>
            </GridTableHeader>
            {ordered.map((item) => {
              const active = item.id === detail.agent.active_release_id;
              const name =
                item.label ??
                t("agent.versionLabel", {
                  version: versionNo(item.version_id) ?? "?",
                });
              const label = t("agent.releaseLabel", {
                release: name,
                profile: item.runtime_profile_id,
              });
              const at = (iso: string) => (
                <RelativeTime value={iso} locale={locale} />
              );
              // `== null`: an API from before these fields omits them mid-rollout.
              const activated =
                item.activated_at == null ? (
                  <Text as="span" variant="sub">
                    {t("agent.releases.noteNone")}
                  </Text>
                ) : item.deactivated_at == null ? (
                  at(item.activated_at)
                ) : (
                  withNodes((vars) => t("agent.releases.activePeriod", vars), {
                    from: at(item.activated_at),
                    to: at(item.deactivated_at),
                  })
                );
              // The narrow list is caption sized; Text sub would make its line taller.
              const listedActivated =
                item.activated_at == null ? (
                  <span className="text-muted-foreground">
                    {t("agent.releases.noteNone")}
                  </span>
                ) : (
                  activated
                );
              const card = t("agent.versionShort", {
                version: versionNo(item.version_id) ?? "?",
              });
              const profile = (
                <>
                  <Code className="wrap-anywhere">
                    {item.runtime_profile_id}
                  </Code>
                  {profiles.isSuccess &&
                  !items.some(
                    (listed) => listed.id === item.runtime_profile_id,
                  ) ? (
                    <Badge variant="amber" className="ml-2">
                      {t("agent.releases.profileGone")}
                    </Badge>
                  ) : null}
                </>
              );
              const repository = (
                <Code className="wrap-anywhere">
                  {item.repository_id ?? t("agent.releases.repositoryNone")}
                </Code>
              );
              const by =
                (item.created_by ? names.get(item.created_by) : undefined) ??
                t("agent.releases.byMember");
              const previous = previousRelease(detail.releases, item);
              const changes = (
                <ReleaseChangesSummary
                  release={item}
                  previous={previous}
                  changes={
                    previous
                      ? releaseChanges(previous, item, (id) => cards.get(id))
                      : []
                  }
                  by={item.created_by ? by : t("agent.releases.byUnknown")}
                />
              );
              const note = item.note ? (
                <ReleaseNote note={item.note} />
              ) : (
                <Text as="span" variant="sub">
                  {t("agent.releases.noteNone")}
                </Text>
              );
              // In full: the narrow list wraps, so the note needs no toggle.
              const wholeNote = item.note ? (
                <span className="wrap-anywhere">{item.note}</span>
              ) : (
                <span className="text-muted-foreground">
                  {t("agent.releases.noteNone")}
                </span>
              );
              const status = (
                <Badge variant={active ? "green" : "gray"}>
                  {active
                    ? t("agent.releases.active")
                    : item.activated_at
                      ? t("agent.releases.previous")
                      : t("agent.releases.never")}
                </Badge>
              );
              return (
                <GridTableRow key={item.id} data-active={active}>
                  <GridTableCell>
                    <div className="flex min-w-0 flex-col gap-[var(--ap-row-line-gap)]">
                      <Text
                        as="span"
                        weight="medium"
                        className="tabular-nums wrap-anywhere"
                      >
                        {name}
                      </Text>
                      {changes}
                      {/* GridTable's narrowAt={860}, where the other columns drop. */}
                      <span className="hidden [@container(max-width:860px)]:flex">
                        {status}
                      </span>
                      <dl className="m-0 hidden flex-col gap-[var(--ap-row-line-gap)] text-caption [@container(max-width:860px)]:flex">
                        {(
                          [
                            ["colActivated", listedActivated],
                            ["colCard", card],
                            ["profile", profile],
                            ["repository", repository],
                            ["colBy", by],
                            ["colNote", wholeNote],
                          ] as const
                        ).map(([key, value]) => (
                          <div
                            key={key}
                            className="flex min-w-0 flex-wrap gap-x-2"
                          >
                            <dt className="text-muted-foreground">
                              {t(`agent.releases.${key}`)}
                            </dt>
                            <dd className="m-0 min-w-0 tabular-nums">
                              {value}
                            </dd>
                          </div>
                        ))}
                      </dl>
                    </div>
                  </GridTableCell>
                  <GridTableCell hideNarrow>{status}</GridTableCell>
                  <GridTableCell hideNarrow className="flex-wrap tabular-nums">
                    {activated}
                  </GridTableCell>
                  <GridTableCell hideNarrow className="text-muted-foreground">
                    {card}
                  </GridTableCell>
                  <GridTableCell hideNarrow className="flex-wrap gap-y-1">
                    {profile}
                  </GridTableCell>
                  <GridTableCell hideNarrow>{repository}</GridTableCell>
                  <GridTableCell hideNarrow className="wrap-anywhere">
                    {by}
                  </GridTableCell>
                  <GridTableCell hideNarrow>{note}</GridTableCell>
                  <GridTableCell align="end">
                    {active || !manages ? null : (
                      <RowAction
                        disabled={activating !== undefined}
                        aria-label={t("agent.releases.activateFor", {
                          release: label,
                        })}
                        onClick={() => onActivate(item)}
                      >
                        {activating === item.id
                          ? t("agent.releases.activating")
                          : t("agent.releases.activate")}
                      </RowAction>
                    )}
                  </GridTableCell>
                </GridTableRow>
              );
            })}
          </GridTable>
        )}
      </div>
    </Section>
  );
}

/**
 * A note on one line, cut with "…" so a 200-character note does not take the
 * row. Only a note that is actually cut gets the toggle that wraps it in full.
 */
function ReleaseNote({ note }: { readonly note: string }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [cut, setCut] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const text = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const outer = box.current;
    const element = text.current;
    // While open the text wraps and never overflows; keep the toggle.
    if (!outer || !element || open) return undefined;
    // Against the whole box, not the text beside the toggle: a note that
    // fits once the toggle is gone must lose it after a resize.
    const measure = () => setCut(element.scrollWidth > outer.clientWidth);
    measure();
    if (typeof ResizeObserver === "undefined") return undefined;
    const resized = new ResizeObserver(measure);
    resized.observe(outer);
    return () => resized.disconnect();
  }, [open]);
  const Chevron = open ? ChevronUp : ChevronDown;
  return (
    <div
      ref={box}
      className={`flex min-w-0 max-w-full gap-1 ${open ? "items-start" : "items-center"}`}
    >
      <span
        ref={text}
        data-slot="release-note"
        className={
          open
            ? "min-w-0 whitespace-normal [overflow-wrap:anywhere]"
            : "min-w-0 truncate"
        }
      >
        {note}
      </span>
      {cut ? (
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-expanded={open}
          aria-label={t("agent.releases.noteToggle")}
          onClick={() => setOpen(!open)}
        >
          <Chevron aria-hidden="true" />
        </Button>
      ) : null}
    </div>
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
        {value === "" ? (
          <NativeSelectOption value="" disabled>
            {t("agents.flow.noProfile")}
          </NativeSelectOption>
        ) : null}
        <ProfileOptions
          profiles={profiles}
          fits={(profile) => runsModel(profile, cardModel)}
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
