import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, Outlet, useLocation } from "@tanstack/react-router";
import { ApiError, isApiError, unwrap } from "@werft-ai/client";
import type { Invite, MemberView, WorkspaceRole } from "@werft-ai/contracts";
import { useAgentPlatform, useMemberPages } from "@werft-ai/react";
import { ListToolbar, LoadMoreButton } from "@werft-ai/react/components";
import {
  Alert,
  AlertActions,
  AlertDescription,
  AlertTitle,
  Badge,
  Button,
  ConfirmDialog,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DisabledReason,
  EmptyState,
  Field,
  FieldDescription,
  FieldLabel,
  FieldLegend,
  FieldSet,
  formatTimestamp,
  GridTable,
  GridTableCell,
  GridTableColumnHeader,
  GridTableHeader,
  GridTableRow,
  GridTableRowOpener,
  LinkTab,
  LinkTabs,
  Page,
  RadioGroup,
  RadioGroupItem,
  RowLines,
  RowList,
  RowListItem,
} from "@werft-ai/ui";
import { useId, useRef, useState } from "react";
import { invitesQuery, membersQuery, queryKeys } from "../api/queries.ts";
import {
  permissionReason,
  roleLabel,
  useHasPermission,
  useMe,
  usePermissionReason,
  useRole,
  WORKSPACE_ROLE_VALUES,
} from "../auth/guard.tsx";
import { FormError, Notice } from "../components/auth-page.tsx";
import { LoadFailure } from "../components/load-failure.tsx";
import { SEARCH_MAX, useSearchTerm } from "../components/search-term.ts";
import { StatusScreen } from "../components/status-screen.tsx";
import {
  errorKey,
  type MessageKey,
  type Translate,
  useI18n,
} from "../i18n/i18n.tsx";
import { InviteDialog } from "./invite-dialog.tsx";

const SECTION = "flex flex-col gap-[var(--ap-space-block)]";
const SECTION_TITLE = "m-0 font-semibold text-body";
const PRIMARY =
  "block break-words font-semibold group-data-[disabled=true]:text-muted-foreground";
const SECONDARY =
  "block text-muted-foreground text-xs [overflow-wrap:anywhere]";

const MEMBER_COLUMNS = "minmax(0,1.6fr) 120px minmax(0,1fr)";
const MEMBER_TABLE_MIN = "min-w-[320px]";

type Outcome =
  | { readonly kind: "notice"; readonly text: string }
  | { readonly kind: "error"; readonly text: string };

/**
 * What a refused member action says. A 403 reads exactly like the reason on a
 * disabled button, so the page and the server never describe the same
 * refusal in two ways; the server's own sentence follows it.
 */
function refusal(
  t: Translate,
  error: ApiError,
  role: string | undefined,
  target?: {
    readonly action: "role" | "disable" | "enable";
    readonly member: MemberView;
    readonly self: boolean;
  },
) {
  if (error.code === "FORBIDDEN")
    return permissionReason(t, "member.manage", role);
  // The same words as the reason beside the control the row withholds.
  if (target?.action === "role" && error.code === "LAST_OWNER")
    return t("members.roleLastOwner");
  if (target?.action === "disable" && error.code === "LAST_OWNER")
    return t(target.self ? "members.disableSelf" : "members.disableLastOwner");
  if (target?.member.role === "owner" && error.code === "OWNER_PROTECTED") {
    return t(
      target.action === "role"
        ? "members.roleOwnerProtected"
        : target.action === "disable"
          ? "members.disableOwnerProtected"
          : "members.enableOwnerProtected",
    );
  }
  return t(errorKey(error.code));
}

/**
 * The 구성원 page: its head and the 구성원 · 팀 · 초대 tabs (v3 M-01), each an
 * address of its own. A tab the viewer may not manage is not offered; 팀
 * always is, since anyone sees the teams they are in there.
 */
export function MembersLayout() {
  const { t } = useI18n();
  const { client } = useAgentPlatform();
  const { pathname } = useLocation();
  const manages = useHasPermission("member.manage");
  const members = useQuery({ ...membersQuery(client), enabled: manages });
  const reason = usePermissionReason("member.manage", members);
  // The list is also the permission probe: when it failed, nobody knows.
  const failed = members.isError && !isApiError(members.error, "FORBIDDEN");
  const onTeams = pathname.startsWith("/members/teams");

  return (
    <Page
      title={t("members.title")}
      description={t(manages ? "members.description" : "members.withheld")}
      actions={
        !manages || failed || onTeams ? undefined : (
          <InviteDialog
            reason={reason}
            members={members.data?.items ?? []}
            refusal={(error, role) => refusal(t, error, role)}
          />
        )
      }
    >
      <div className="flex flex-col gap-[var(--ap-space-block)]">
        <LinkTabs aria-label={t("members.tabs")}>
          {manages ? (
            <LinkTab asChild current={pathname === "/members"}>
              <Link to="/members" activeOptions={{ exact: true }}>
                {t("members.tab.members")}
              </Link>
            </LinkTab>
          ) : null}
          <LinkTab asChild current={onTeams}>
            <Link to="/members/teams" activeOptions={{ exact: true }}>
              {t("members.tab.teams")}
            </Link>
          </LinkTab>
          {manages ? (
            <LinkTab asChild current={pathname === "/members/invites"}>
              <Link to="/members/invites" activeOptions={{ exact: true }}>
                {t("members.tab.invites")}
              </Link>
            </LinkTab>
          ) : null}
        </LinkTabs>
        <Outlet />
      </div>
    </Page>
  );
}

/**
 * The 구성원 tab: the first page, more on request, searched on the server.
 * Without member.manage the page head already says why.
 */
export function MembersScreen() {
  const { t } = useI18n();
  const manages = useHasPermission("member.manage");
  const [query, setQuery] = useState("");
  const q = useSearchTerm(query);
  const members = useMemberPages(q, { enabled: manages });
  const search = useRef<HTMLInputElement>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);

  if (!manages) return null;

  const items = members.data?.pages.flatMap((page) => page.items) ?? [];
  // The clear button leaves with the empty state; focus goes back to the box.
  const clear = () => {
    setQuery("");
    search.current?.focus();
  };

  return (
    <div className="flex flex-col gap-[var(--ap-space-block)]">
      <OutcomeNote outcome={outcome} />
      <ListToolbar
        filter={null}
        search={{
          ref: search,
          type: "search",
          "aria-label": t("members.search"),
          placeholder: t("members.search"),
          maxLength: SEARCH_MAX,
          value: query,
          onChange: (event) => setQuery(event.target.value),
        }}
      />
      {members.isPending ? (
        <StatusScreen kind="loading" />
      ) : members.error && items.length === 0 ? (
        isApiError(members.error, "FORBIDDEN") ? (
          <StatusScreen kind="forbidden" />
        ) : (
          <LoadFailure
            error={members.error}
            onRetry={() => void members.refetch()}
          />
        )
      ) : items.length === 0 && q !== undefined ? (
        <EmptyState
          className="w-full"
          title={t("members.noMatch")}
          description={t("members.noMatchHint")}
          action={
            <Button type="button" variant="outline" size="sm" onClick={clear}>
              {t("members.clearSearch")}
            </Button>
          }
        />
      ) : (
        <div className="flex flex-col gap-4">
          <MemberTable
            items={items}
            // Who is the last owner is known only from every member at once.
            ownersKnown={!members.hasNextPage && q === undefined}
            onOutcome={setOutcome}
          />
          {members.error ? (
            <MoreFailure
              error={members.error}
              onRetry={() =>
                void (members.isFetchNextPageError
                  ? members.fetchNextPage()
                  : members.refetch())
              }
            />
          ) : null}
          {/* After a failed refresh the alert's retry is the way on: more
              rows on top of it would keep the stale ones. A failed next
              page keeps the button, and the keyboard on it. */}
          <LoadMoreButton
            hasMore={
              members.hasNextPage &&
              (!members.error || members.isFetchNextPageError)
            }
            loading={members.isFetchingNextPage}
            // A refresh after a change rereads every page; asking for the
            // next one now would cancel it and keep the stale rows.
            busy={members.isFetching}
            onLoadMore={() =>
              void members.fetchNextPage({ cancelRefetch: false })
            }
            messages={{
              more: t("sessions.more"),
              loading: t("sessions.loadingMore"),
            }}
          />
        </div>
      )}
    </div>
  );
}

/** A later page that failed: the rows already shown stay above it. */
function MoreFailure({
  error,
  onRetry,
}: {
  readonly error: unknown;
  readonly onRetry: () => void;
}) {
  const { t } = useI18n();
  return (
    <Alert variant="red" role="alert">
      <AlertTitle>{t("status.loadFailed")}</AlertTitle>
      <AlertDescription>
        {t(error instanceof ApiError ? errorKey(error.code) : "error.UNKNOWN")}
      </AlertDescription>
      <AlertActions>
        <Button type="button" variant="outline" size="sm" onClick={onRetry}>
          {t("common.retry")}
        </Button>
      </AlertActions>
    </Alert>
  );
}

/** The 초대 tab: invites still waiting to be accepted. */
export function InvitesScreen() {
  const { client } = useAgentPlatform();
  const manages = useHasPermission("member.manage");
  const members = useQuery({ ...membersQuery(client), enabled: manages });
  const [outcome, setOutcome] = useState<Outcome | null>(null);

  if (!manages) return null;

  return (
    <div className="flex flex-col gap-[var(--ap-space-block)]">
      {/* The invite button in the head waits on this list; say why it is gone. */}
      {members.isError && !isApiError(members.error, "FORBIDDEN") ? (
        <LoadFailure
          error={members.error}
          onRetry={() => void members.refetch()}
        />
      ) : null}
      <OutcomeNote outcome={outcome} />
      <InviteList onOutcome={setOutcome} />
    </div>
  );
}

function OutcomeNote({ outcome }: { readonly outcome: Outcome | null }) {
  if (!outcome) return null;
  return outcome.kind === "error" ? (
    <FormError>{outcome.text}</FormError>
  ) : (
    <Notice>{outcome.text}</Notice>
  );
}

function MemberTable({
  items,
  ownersKnown,
  onOutcome,
}: {
  readonly items: readonly MemberView[];
  /** Every owner is among the items; else the server says who is the last. */
  readonly ownersKnown: boolean;
  readonly onOutcome: (outcome: Outcome | null) => void;
}) {
  const { t } = useI18n();
  const { client } = useAgentPlatform();
  const queryClient = useQueryClient();
  const role = useRole();
  const [confirming, setConfirming] = useState<MemberView | null>(null);
  // Roles change in 구성원 편집, not in the row (rows only disable).
  const [editing, setEditing] = useState<MemberView | null>(null);
  // The name button that opened 구성원 편집 gets the keyboard back, and a
  // saved role opens its confirmation only once the editor has handed it
  // back, so the confirmation returns there too rather than to <body>.
  const editOpener = useRef<HTMLElement | null>(null);
  const saved = useRef<{ member: MemberView; role: WorkspaceRole } | null>(
    null,
  );
  // A saved role still waits here for the confirmation.
  const [roleChange, setRoleChange] = useState<{
    member: MemberView;
    role: WorkspaceRole;
  } | null>(null);
  const self = useMe()?.user?.id;
  const activeOwners = items.filter(
    (member) => member.role === "owner" && member.disabled_at === null,
  ).length;
  // What the server refuses, or keeps for an owner, the row withholds and
  // says why before anyone asks.
  const withheld = (
    member: MemberView,
    reasons: { self: MessageKey; owner: MessageKey; lastOwner: MessageKey },
  ) =>
    member.user_id === self
      ? t(reasons.self)
      : role === "admin" && member.role === "owner"
        ? t(reasons.owner)
        : ownersKnown && member.role === "owner" && activeOwners === 1
          ? t(reasons.lastOwner)
          : undefined;
  const roleReason = (member: MemberView) =>
    withheld(member, {
      self: "members.roleSelf",
      owner: "members.roleOwnerProtected",
      lastOwner: "members.roleLastOwner",
    });
  const keepReason = (member: MemberView) =>
    withheld(member, {
      self: "members.disableSelf",
      owner: "members.disableOwnerProtected",
      lastOwner: "members.disableLastOwner",
    });
  // A disabled row is never the viewer, and owners never run out while one
  // is live, so only the owner rule applies to bringing it back.
  const enableReason = (member: MemberView) =>
    role === "admin" && member.role === "owner"
      ? t("members.enableOwnerProtected")
      : undefined;

  const settle = async (text: string) => {
    onOutcome({ kind: "notice", text });
    await queryClient.invalidateQueries({ queryKey: queryKeys.members });
  };
  const fail = (
    error: ApiError,
    action: "role" | "disable" | "enable",
    member: MemberView,
  ) =>
    onOutcome({
      kind: "error",
      text: refusal(t, error, role, {
        action,
        member,
        self: member.user_id === self,
      }),
    });

  const changeRole = useMutation<
    MemberView,
    ApiError,
    { member: MemberView; role: WorkspaceRole }
  >({
    mutationFn: ({ member, role: next }) =>
      unwrap(
        client.PATCH("/v1/members/{user_id}", {
          params: { path: { user_id: member.user_id } },
          body: { role: next },
        }),
      ),
    onMutate: () => onOutcome(null),
    onSettled: () => setRoleChange(null),
    onSuccess: (updated) =>
      settle(
        t("members.roleChanged", {
          name: updated.display_name,
          role: roleLabel(t, updated.role),
        }),
      ),
    onError: (error, { member }) => fail(error, "role", member),
  });

  const setAccess = useMutation<
    { member: MemberView; receipt_id: string | null },
    ApiError,
    { member: MemberView; enable: boolean }
  >({
    mutationFn: ({ member, enable }) => {
      const params = {
        params: { path: { user_id: member.user_id } },
        body: {},
      };
      return unwrap(
        enable
          ? client.POST("/v1/members/{user_id}/enable", params)
          : client.POST("/v1/members/{user_id}/disable", params),
      );
    },
    onMutate: () => onOutcome(null),
    onSuccess: async (result) => {
      setConfirming(null);
      const name = result.member.display_name;
      await settle(
        result.member.disabled_at === null
          ? t("members.enabled", { name })
          : t("members.disabled", { name }),
      );
    },
    onError: (error, { member, enable }) => {
      setConfirming(null);
      fail(error, enable ? "enable" : "disable", member);
    },
  });

  if (items.length === 0) {
    return <EmptyState title={t("members.empty")} />;
  }

  return (
    <>
      {/* Below the table's minimum the actions would cover the role badges,
          so it scrolls instead. The padding keeps the opener's focus ring,
          2px outside the row, inside the scroller's clip. */}
      <div className="-m-1 grid overflow-x-auto p-1">
        <div className="rounded-card border bg-card">
          <GridTable
            aria-label={t("members.tableLabel")}
            columns={MEMBER_COLUMNS}
            className={MEMBER_TABLE_MIN}
          >
            <GridTableHeader>
              <GridTableColumnHeader>
                {t("members.column.name")}
              </GridTableColumnHeader>
              <GridTableColumnHeader>
                {t("members.column.role")}
              </GridTableColumnHeader>
              <GridTableColumnHeader align="end">
                {t("members.column.actions")}
              </GridTableColumnHeader>
            </GridTableHeader>
            {items.map((member) => {
              const disabled = member.disabled_at !== null;
              const keepWhy = disabled
                ? enableReason(member)
                : keepReason(member);
              const busy =
                (changeRole.isPending &&
                  changeRole.variables?.member.user_id === member.user_id) ||
                (setAccess.isPending &&
                  setAccess.variables?.member.user_id === member.user_id);
              const button = disabled ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="shrink-0"
                  disabled={busy || keepWhy !== undefined}
                  onClick={() => setAccess.mutate({ member, enable: true })}
                >
                  {t("members.enable")}
                </Button>
              ) : (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="shrink-0"
                  disabled={busy || keepWhy !== undefined}
                  aria-label={t("members.disableFor", {
                    name: member.display_name,
                  })}
                  onClick={() => setConfirming(member)}
                >
                  {t("members.disable")}
                </Button>
              );
              return (
                <GridTableRow
                  key={member.user_id}
                  className="group"
                  data-disabled={disabled}
                >
                  <GridTableCell lines={true}>
                    <GridTableRowOpener
                      aria-label={t("members.editFor", {
                        name: member.display_name,
                      })}
                      onClick={(event) => {
                        editOpener.current = event.currentTarget;
                        setEditing(member);
                      }}
                    />
                    {/* v4 .strong: body text at weight 500, not link blue;
                      blue stays for links that move (→). */}
                    {/* Below md the "you" badge drops to its own line under
                      the name, so the name gets the whole column (QA L-17). */}
                    <span className="grid max-w-full grid-cols-[minmax(0,auto)_auto] items-center gap-y-[var(--ap-row-line-gap)] font-medium text-foreground @max-md:grid-cols-[minmax(0,auto)] group-data-[disabled=true]:text-muted-foreground">
                      <span className="truncate">{member.display_name}</span>
                      {member.user_id === self ? (
                        <Badge
                          variant="gray"
                          className="ms-1.5 @max-md:col-start-1 @max-md:row-start-2 @max-md:ms-0"
                        >
                          {t("members.you")}
                        </Badge>
                      ) : null}
                    </span>
                    <span
                      className="text-muted-foreground text-xs"
                      title={member.email}
                    >
                      {member.email}
                    </span>
                  </GridTableCell>
                  {/* At 390px the actions spill left past their track; stacked
                    badges leave them room. */}
                  <GridTableCell className="flex-wrap gap-1 @max-md:flex-col @max-md:items-start">
                    <Badge variant={member.role === "member" ? "gray" : "blue"}>
                      {roleLabel(t, member.role)}
                    </Badge>
                    {disabled ? (
                      <Badge variant="gray">
                        {t("members.state.disabled")}
                      </Badge>
                    ) : null}
                  </GridTableCell>
                  {/* The button keeps one width as "disable" turns "enable". */}
                  <GridTableCell
                    raised={true}
                    align="end"
                    className="gap-1 [&_[data-slot=button]:not([data-size^=icon])]:min-w-[var(--ap-row-action-min-width)]"
                  >
                    {keepWhy ? (
                      <DisabledReason
                        reason={keepWhy}
                        label={t(
                          disabled ? "members.enableFor" : "members.disableFor",
                          { name: member.display_name },
                        )}
                      >
                        {button}
                      </DisabledReason>
                    ) : (
                      button
                    )}
                  </GridTableCell>
                </GridTableRow>
              );
            })}
          </GridTable>
        </div>
      </div>
      {editing ? (
        <MemberEditDialog
          member={editing}
          reason={
            editing.disabled_at === null
              ? roleReason(editing)
              : t("members.edit.disabledNote")
          }
          busy={changeRole.isPending}
          onClose={() => setEditing(null)}
          onSave={(next) => {
            saved.current = { member: editing, role: next };
            setEditing(null);
          }}
          onClosed={() => {
            if (editOpener.current?.isConnected) editOpener.current.focus();
            if (saved.current) setRoleChange(saved.current);
            saved.current = null;
          }}
        />
      ) : null}
      <ConfirmDialog
        open={confirming !== null}
        onOpenChange={(open) => {
          if (!open) setConfirming(null);
        }}
        title={t("members.disableTitle", {
          name: confirming?.display_name ?? "",
        })}
        consequence={t("members.disableConsequence")}
        confirmLabel={t("members.disable")}
        cancelLabel={t("common.cancel")}
        tone="danger"
        busy={setAccess.isPending}
        onConfirm={() => {
          if (confirming)
            setAccess.mutate({ member: confirming, enable: false });
        }}
      />
      <ConfirmDialog
        open={roleChange !== null}
        onOpenChange={(open) => {
          if (!open) setRoleChange(null);
        }}
        title={t("members.roleChangeTitle", {
          name: roleChange?.member.display_name ?? "",
          role: roleChange ? roleLabel(t, roleChange.role) : "",
        })}
        consequence={
          roleChange?.role === "owner"
            ? t("members.roleChangeOwnerConsequence")
            : t("members.roleChangeConsequence")
        }
        confirmLabel={t("members.roleChangeConfirm")}
        cancelLabel={t("common.cancel")}
        busy={changeRole.isPending}
        onConfirm={() => {
          if (roleChange) changeRole.mutate(roleChange);
        }}
      />
    </>
  );
}

/**
 * 구성원 편집 (v3 MemberEdit): the role, picked here and saved through the
 * same confirmation the row used to raise. What the row would withhold, this
 * shows as the reason and keeps every choice disabled.
 */
function MemberEditDialog({
  member,
  reason,
  busy,
  onClose,
  onSave,
  onClosed,
}: {
  readonly member: MemberView;
  readonly reason: string | undefined;
  readonly busy: boolean;
  readonly onClose: () => void;
  readonly onSave: (role: WorkspaceRole) => void;
  /** After it has closed and would hand focus back; the screen does that. */
  readonly onClosed: () => void;
}) {
  const { t } = useI18n();
  const [role, setRole] = useState<string>(member.role);
  const legendId = useId();
  const reasonId = useId();
  const blocked = reason !== undefined;
  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          onClosed();
        }}
      >
        <DialogHeader>
          <DialogTitle>{t("members.edit.title")}</DialogTitle>
          <DialogDescription>
            {member.display_name} · {member.email}
          </DialogDescription>
        </DialogHeader>
        <FieldSet>
          <FieldLegend id={legendId} variant="label">
            {t("members.column.role")}
          </FieldLegend>
          {blocked ? (
            <FieldDescription id={reasonId}>{reason}</FieldDescription>
          ) : null}
          <RadioGroup
            value={role}
            onValueChange={setRole}
            disabled={blocked || busy}
            aria-labelledby={legendId}
            aria-describedby={blocked ? reasonId : undefined}
          >
            {WORKSPACE_ROLE_VALUES.map((value) => (
              <Field key={value} orientation="horizontal">
                <RadioGroupItem value={value} />
                <FieldLabel>{roleLabel(t, value)}</FieldLabel>
                <FieldDescription>
                  {t(`members.roleHelp.${value}`)}
                </FieldDescription>
              </Field>
            ))}
          </RadioGroup>
        </FieldSet>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button
            type="button"
            disabled={blocked || busy || role === member.role}
            onClick={() => onSave(role as WorkspaceRole)}
          >
            {t("members.edit.save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function InviteList({
  onOutcome,
}: {
  readonly onOutcome: (outcome: Outcome | null) => void;
}) {
  const { t, locale } = useI18n();
  const { client } = useAgentPlatform();
  const queryClient = useQueryClient();
  const role = useRole();
  const invites = useQuery(invitesQuery(client));
  const [revoking, setRevoking] = useState<Invite | null>(null);
  const titleId = useId();

  const revoke = useMutation<unknown, ApiError, Invite>({
    mutationFn: (invite) =>
      unwrap(
        client.DELETE("/v1/invites/{id}", {
          params: { path: { id: invite.id } },
        }),
      ),
    onMutate: () => onOutcome(null),
    onSettled: () => setRevoking(null),
    onSuccess: async (_result, invite) => {
      onOutcome({
        kind: "notice",
        text: t("members.invites.revoked", { email: invite.email }),
      });
      await queryClient.invalidateQueries({ queryKey: queryKeys.invites });
    },
    onError: (error) =>
      onOutcome({ kind: "error", text: refusal(t, error, role) }),
  });

  const pending =
    invites.data?.items.filter((invite) => invite.status === "pending") ?? [];

  return (
    <section className={SECTION} aria-labelledby={titleId}>
      <h2 id={titleId} className={SECTION_TITLE}>
        {t("members.invites.title")}
      </h2>
      {invites.isPending ? (
        <StatusScreen kind="loading" />
      ) : invites.error ? (
        isApiError(invites.error, "FORBIDDEN") ? (
          <FormError>{refusal(t, invites.error, role)}</FormError>
        ) : (
          <LoadFailure
            error={invites.error}
            onRetry={() => void invites.refetch()}
          />
        )
      ) : pending.length === 0 ? (
        <EmptyState title={t("members.invites.empty")} />
      ) : (
        <RowList>
          {pending.map((invite) => (
            <RowListItem key={invite.id}>
              <RowLines>
                <span className={PRIMARY}>{invite.email}</span>
                <span className={SECONDARY}>
                  {roleLabel(t, invite.role)} ·{" "}
                  {t("members.invites.expires", {
                    expires: formatTimestamp(invite.expires_at, locale),
                  })}
                </span>
              </RowLines>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="ml-auto"
                disabled={revoke.isPending}
                aria-label={t("members.invites.revokeFor", {
                  email: invite.email,
                })}
                onClick={() => setRevoking(invite)}
              >
                {t("members.invites.revoke")}
              </Button>
            </RowListItem>
          ))}
        </RowList>
      )}
      <ConfirmDialog
        open={revoking !== null}
        onOpenChange={(open) => {
          if (!open) setRevoking(null);
        }}
        title={t("members.invites.revokeTitle", {
          email: revoking?.email ?? "",
        })}
        consequence={t("members.invites.revokeConsequence")}
        confirmLabel={t("members.invites.revoke")}
        cancelLabel={t("common.cancel")}
        tone="danger"
        busy={revoke.isPending}
        onConfirm={() => {
          if (revoking) revoke.mutate(revoking);
        }}
      />
    </section>
  );
}
