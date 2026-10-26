import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { type ApiError, isApiError, unwrap } from "@werft-ai/client";
import type {
  AgentAdminChangeResponse,
  AgentAdminKind,
} from "@werft-ai/contracts";
import { useAgentPlatform } from "@werft-ai/react";
import {
  Avatar,
  avatarInitials,
  Button,
  buttonVariants,
  ConfirmDialog,
  EmptyState,
  NativeSelect,
  NativeSelectOptGroup,
  NativeSelectOption,
  RowLines,
  RowList,
  RowListItem,
  Link as TextLink,
} from "@werft-ai/ui";
import { useId, useState } from "react";
import {
  administeredAgentsQuery,
  agentAdminsQuery,
  membersQuery,
  queryKeysOf,
  teamsQuery,
} from "../api/queries.ts";
import {
  permissionReason,
  refusalText,
  useHasPermission,
  useMe,
  usePermissionReason,
  useRole,
} from "../auth/guard.tsx";
import { ReasonButton } from "../auth/reason-button.tsx";
import { useI18n } from "../i18n/i18n.tsx";
import { LoadFailure } from "./load-failure.tsx";
import { MUTED, SECTION, SECTION_TITLE } from "./my-teams.tsx";
import type { Outcome } from "./outcome.tsx";
import { OPENS_ROW, ROW_LINK } from "./row-link.ts";
import { StatusScreen } from "./status-screen.tsx";

// Lines that wrap on a narrow screen sit a line gap apart, not RowListItem's 8px.
const ADMIN_ROW = "gap-y-[var(--ap-row-line-gap)]";
const PRIMARY = "font-semibold [overflow-wrap:anywhere]";
const SECONDARY = "text-caption text-muted-foreground [overflow-wrap:anywhere]";

// Month/day in the product's zone, the way the console shows a short date.
const DAY = new Intl.DateTimeFormat("en-US", {
  timeZone: "Asia/Seoul",
  month: "2-digit",
  day: "2-digit",
});

/** The same person gets the same avatar colour on every visit. */
function avatarTone(id: string): 1 | 2 | 3 | 4 {
  let sum = 0;
  for (const char of id) sum += char.charCodeAt(0);
  return ((sum % 4) + 1) as 1 | 2 | 3 | 4;
}

/**
 * Who administers an agent: people and teams (design 4.1). Owners and admins
 * hold the right on every agent; anyone else only on the agents they already
 * administer, which /v1/administered-agents answers without leaving a refused
 * decision behind. The list itself is the probe for everyone else.
 */
/** contracts TEAM_LIST_LIMIT: a list this long may have left agents out. */
export const ADMINISTERED_LIST_LIMIT = 200;

export function AgentAdmins({
  agentId,
  onOutcome,
}: {
  readonly agentId: string;
  readonly onOutcome: (outcome: Outcome | null) => void;
}) {
  const { t } = useI18n();
  const { client } = useAgentPlatform();
  const role = useRole();
  const everywhere = useHasPermission("agent.admin.manage");
  const administered = useQuery({
    ...administeredAgentsQuery(client),
    enabled: !everywhere,
  });
  const items = administered.data?.items;
  // A full list may have cut this agent off; then the admin list itself
  // answers, at the cost of a refused decision row if it is not theirs.
  const mine =
    everywhere ||
    (items !== undefined &&
      (items.some((agent) => agent.id === agentId) ||
        items.length >= ADMINISTERED_LIST_LIMIT));
  const titleId = useId();

  return (
    <section className={SECTION} aria-labelledby={titleId}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
        <h2 id={titleId} className={SECTION_TITLE}>
          {t("agentAdmins.title")}
        </h2>
        <p className={`${MUTED} text-caption`}>{t("agentAdmins.intro")}</p>
      </div>
      {mine ? (
        <AdminList agentId={agentId} onOutcome={onOutcome} />
      ) : administered.isPending && !everywhere ? (
        <StatusScreen kind="loading" />
      ) : administered.error ? (
        <LoadFailure
          error={administered.error}
          onRetry={() => void administered.refetch()}
        />
      ) : (
        <p className="web-guarded__reason">
          {permissionReason(t, "agent.admin.manage", role)}
        </p>
      )}
    </section>
  );
}

function AdminList({
  agentId,
  onOutcome,
}: {
  readonly agentId: string;
  readonly onOutcome: (outcome: Outcome | null) => void;
}) {
  const { t } = useI18n();
  const { client } = useAgentPlatform();
  const queryClient = useQueryClient();
  const role = useRole();
  const admins = useQuery(agentAdminsQuery(client, agentId));
  const reason = usePermissionReason("agent.admin.manage", admins);
  // Asked only of roles that can list them, so an agent's own admin does
  // not leave a refused decision on every visit.
  const listsMembers = useHasPermission("member.manage");
  const listsTeams = useHasPermission("team.manage");
  // Every member is read once someone reaches for the picker, not with the
  // page.
  const [picking, setPicking] = useState(false);
  const members = useQuery({
    ...membersQuery(client),
    enabled: listsMembers && picking,
  });
  const teams = useQuery({ ...teamsQuery(client), enabled: listsTeams });
  // "<kind>:<id>", so one picker holds people and teams.
  const [picked, setPicked] = useState("");
  const [removing, setRemoving] = useState<{
    kind: AgentAdminKind;
    id: string;
    name: string;
  } | null>(null);
  const me = useMe();
  // Owners and admins manage every agent whatever this list says.
  const everywhere = useHasPermission("agent.admin.manage");
  const losesAccess =
    !everywhere && removing?.kind === "users" && removing.id === me?.user?.id;
  const pickerId = useId();
  const hintId = useId();

  const change = useMutation<
    AgentAdminChangeResponse,
    ApiError,
    { add: boolean; kind: AgentAdminKind; id: string; name: string }
  >({
    mutationFn: ({ add, kind, id }) =>
      unwrap(
        add
          ? client.POST("/v1/agents/{id}/admins", {
              params: { path: { id: agentId } },
              body: kind === "users" ? { user_id: id } : { team_id: id },
            })
          : client.DELETE("/v1/agents/{id}/admins/{kind}/{subject_id}", {
              params: { path: { id: agentId, kind, subject_id: id } },
            }),
      ),
    onMutate: () => onOutcome(null),
    onSettled: () => setRemoving(null),
    onSuccess: async (result, { add, name }) => {
      queryClient.setQueryData(
        queryKeysOf(client).agentAdmins(agentId),
        result.admins,
      );
      if (add) setPicked("");
      onOutcome({
        kind: "notice",
        text: t(add ? "agentAdmins.added" : "agentAdmins.removed", { name }),
      });
      // Naming or dropping the caller (or their team) changes what they
      // administer; the list's summaries name the admins.
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: queryKeysOf(client).administeredAgents,
        }),
        queryClient.invalidateQueries({
          queryKey: queryKeysOf(client).agents,
          exact: true,
        }),
      ]);
    },
    onError: (error) =>
      onOutcome({
        kind: "error",
        text: refusalText(t, error, "agent.admin.manage", role),
      }),
  });

  if (admins.isPending) return <StatusScreen kind="loading" />;
  if (admins.error) {
    return isApiError(admins.error, "FORBIDDEN") ? (
      <p className="web-guarded__reason">{reason}</p>
    ) : (
      <LoadFailure error={admins.error} onRetry={() => void admins.refetch()} />
    );
  }

  const userIds = new Set(admins.data.users.map((user) => user.user_id));
  const teamIds = new Set(admins.data.teams.map((row) => row.team_id));
  const people =
    members.data?.items.filter(
      (member) => member.disabled_at === null && !userIds.has(member.user_id),
    ) ?? [];
  const groups = teams.data?.items.filter((row) => !teamIds.has(row.id)) ?? [];
  const pickedPerson = people.find(
    (member) => `users:${member.user_id}` === picked,
  );
  const pickedTeam = groups.find((row) => `teams:${row.id}` === picked);
  // Picking needs the member and team lists, which only owners and admins
  // read; an agent's own admin sees why the picker stays closed.
  const personReason = !listsMembers
    ? permissionReason(t, "member.manage", role)
    : members.error
      ? refusalText(t, members.error as ApiError, "member.manage", role)
      : undefined;
  const teamReason = !listsTeams
    ? permissionReason(t, "team.manage", role)
    : teams.error
      ? refusalText(t, teams.error as ApiError, "team.manage", role)
      : undefined;
  // Only when neither half can be picked is the button withheld, saying why
  // for both; a list that failed beside one that loaded is said under the
  // picker.
  const addReason =
    personReason && teamReason
      ? personReason === teamReason
        ? personReason
        : `${personReason} ${teamReason}`
      : undefined;
  // Said, not shown by disabling the picker: a picker disabled under the
  // pointer or focus greys out and drops focus to the page.
  const nothingLeft =
    picking &&
    members.isSuccess &&
    !members.isFetching &&
    teams.isSuccess &&
    !teams.isFetching &&
    people.length === 0 &&
    groups.length === 0;
  const partial =
    addReason === undefined
      ? members.error
        ? personReason
        : teams.error
          ? teamReason
          : nothingLeft
            ? t("agentAdmins.nothingLeft")
            : undefined
      : undefined;
  const since = (at: string) => {
    const parts = new Map(
      DAY.formatToParts(new Date(at)).map((p) => [p.type, p.value] as const),
    );
    return t("agentAdmins.since", {
      date: `${parts.get("month")}/${parts.get("day")}`,
    });
  };
  const removeButton = (kind: AgentAdminKind, id: string, name: string) => (
    <Button
      type="button"
      variant="outline"
      size="sm"
      className="ml-auto"
      disabled={change.isPending}
      aria-label={t("agentAdmins.removeFor", { name })}
      onClick={() => setRemoving({ kind, id, name })}
    >
      {t("agentAdmins.remove")}
    </Button>
  );

  return (
    <div className="overflow-hidden rounded-card border bg-card">
      {admins.data.users.length + admins.data.teams.length === 0 ? (
        <EmptyState title={t("agentAdmins.empty")} />
      ) : (
        <RowList variant="joined" className="rounded-none border-0">
          {admins.data.users.map((user) => {
            const name = user.display_name ?? user.email;
            return (
              <RowListItem key={`u:${user.user_id}`}>
                <Avatar
                  initials={avatarInitials(name).slice(0, 1)}
                  tone={avatarTone(user.user_id)}
                />
                <RowLines>
                  <span className={PRIMARY}>{name}</span>
                  <span className={SECONDARY}>
                    <span className="sr-only">
                      {t("agentAdmins.person")} ·{" "}
                    </span>
                    {user.email} · {since(user.created_at)}
                  </span>
                </RowLines>
                {removeButton("users", user.user_id, name)}
              </RowListItem>
            );
          })}
          {admins.data.teams.map((row) => (
            <RowListItem key={`t:${row.team_id}`}>
              <Avatar
                shape="square"
                initials={avatarInitials(row.name).slice(0, 1)}
                tone={avatarTone(row.team_id)}
              />
              <RowLines>
                <span className={PRIMARY}>{row.name}</span>
                <span className={SECONDARY}>
                  {t("agentAdmins.team")} · {since(row.created_at)}
                </span>
              </RowLines>
              {removeButton("teams", row.team_id, row.name)}
            </RowListItem>
          ))}
        </RowList>
      )}
      <form
        className="flex flex-wrap items-center gap-2 border-t px-[var(--ap-row-padding-x)] py-[var(--ap-row-padding-y)]"
        onPointerEnter={() => setPicking(true)}
        onFocus={() => setPicking(true)}
        onSubmit={(event) => {
          event.preventDefault();
          if (pickedPerson)
            change.mutate({
              add: true,
              kind: "users",
              id: pickedPerson.user_id,
              name: pickedPerson.display_name,
            });
          else if (pickedTeam)
            change.mutate({
              add: true,
              kind: "teams",
              id: pickedTeam.id,
              name: pickedTeam.name,
            });
        }}
      >
        <label className="sr-only" htmlFor={pickerId}>
          {t("agentAdmins.pick")}
        </label>
        <div className="min-w-0 flex-1 sm:flex-none">
          <NativeSelect
            id={pickerId}
            className="w-60 max-w-full"
            value={picked}
            disabled={addReason !== undefined}
            aria-busy={members.isFetching}
            aria-describedby={partial ? hintId : undefined}
            onChange={(event) => setPicked(event.target.value)}
          >
            <NativeSelectOption value="">
              {t("agentAdmins.pickPlaceholder")}
            </NativeSelectOption>
            {people.length > 0 ? (
              <NativeSelectOptGroup label={t("agentAdmins.person")}>
                {people.map((member) => (
                  <NativeSelectOption
                    key={member.user_id}
                    value={`users:${member.user_id}`}
                  >
                    {member.display_name} ({member.email})
                  </NativeSelectOption>
                ))}
              </NativeSelectOptGroup>
            ) : null}
            {groups.length > 0 ? (
              <NativeSelectOptGroup label={t("agentAdmins.team")}>
                {groups.map((row) => (
                  <NativeSelectOption key={row.id} value={`teams:${row.id}`}>
                    {row.name}
                  </NativeSelectOption>
                ))}
              </NativeSelectOptGroup>
            ) : null}
          </NativeSelect>
        </div>
        <ReasonButton
          type="submit"
          className={buttonVariants({ variant: "outline", size: "sm" })}
          reason={addReason}
          disabled={(!pickedPerson && !pickedTeam) || change.isPending}
        >
          {t("agentAdmins.add")}
        </ReasonButton>
        {partial ? (
          <p id={hintId} className={`${MUTED} basis-full text-caption`}>
            {partial}
          </p>
        ) : null}
      </form>
      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(open) => {
          if (!open) setRemoving(null);
        }}
        title={t("agentAdmins.removeTitle", { name: removing?.name ?? "" })}
        consequence={
          losesAccess
            ? t("agentAdmins.removeSelfConsequence")
            : t("agentAdmins.removeConsequence")
        }
        confirmLabel={t("agentAdmins.remove")}
        cancelLabel={t("common.cancel")}
        tone="danger"
        busy={change.isPending}
        onConfirm={() => {
          if (removing) change.mutate({ add: false, ...removing });
        }}
      />
    </div>
  );
}

/**
 * The agents the viewer was named admin of. Owners and admins hold the right
 * on every agent, so a list of some would mislead them and they get nothing.
 */
export function AdministeredAgents({
  showEmpty,
}: {
  /** Off where an empty section would only be noise (home). */
  readonly showEmpty: boolean;
}) {
  const { t } = useI18n();
  const { client } = useAgentPlatform();
  const everywhere = useHasPermission("agent.admin.manage");
  const administered = useQuery({
    ...administeredAgentsQuery(client),
    enabled: !everywhere,
  });
  const titleId = useId();
  if (everywhere || administered.isPending) return null;
  const items = administered.data?.items ?? [];
  if (!administered.error && items.length === 0 && !showEmpty) return null;

  return (
    <section className="web-section" aria-labelledby={titleId}>
      <h2 id={titleId}>{t("agentAdmins.mine.title")}</h2>
      {administered.error ? (
        <LoadFailure
          error={administered.error}
          onRetry={() => void administered.refetch()}
        />
      ) : items.length === 0 ? (
        <EmptyState title={t("agentAdmins.mine.empty")} />
      ) : (
        <>
          <p className="web-field__hint">{t("agentAdmins.mine.intro")}</p>
          <RowList>
            {items.map((agent) => (
              <RowListItem
                key={agent.id}
                className={`${ADMIN_ROW} ${OPENS_ROW}`}
              >
                <TextLink asChild className={`${PRIMARY} ${ROW_LINK}`}>
                  <Link to="/agents/$id" params={{ id: agent.id }}>
                    {agent.name}
                  </Link>
                </TextLink>
                <span className={`${SECONDARY} ml-auto`}>{agent.slug}</span>
              </RowListItem>
            ))}
          </RowList>
          {items.length >= ADMINISTERED_LIST_LIMIT ? (
            <p className="web-field__hint">
              {t("agentAdmins.mine.truncated", {
                count: ADMINISTERED_LIST_LIMIT,
              })}
            </p>
          ) : null}
        </>
      )}
    </section>
  );
}
