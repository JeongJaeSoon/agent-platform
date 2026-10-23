import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type ApiError, isApiError, unwrap } from "@werft-ai/client";
import type { Invite, MemberView, WorkspaceRole } from "@werft-ai/contracts";
import { useAgentPlatform } from "@werft-ai/react";
import {
  Badge,
  Button,
  ConfirmDialog,
  cn,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  EmptyState,
  Field,
  FieldDescription,
  FieldLabel,
  FieldLegend,
  FieldSet,
  formatTimestamp,
  linkVariants,
  RadioGroup,
  RadioGroupItem,
  RowLines,
  RowList,
  RowListItem,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableHeader,
  TableRow,
} from "@werft-ai/ui";
import { useId, useState } from "react";
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
import { FormError, NOTICE } from "../components/auth-page.tsx";
import { LoadFailure } from "../components/load-failure.tsx";
import { Page } from "../components/page.tsx";
import { ReasonHint } from "../components/reason-hint.tsx";
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
// Console v4 .t-mem: 1.6fr name, 120px role, 1.4fr agents, 1fr last active;
// the actions column is v3's (rows only disable). Agents and last active
// fold away when the table is narrow, as v4's tables do.
const ROLE_COLUMN = "w-[calc(120px+var(--ap-row-padding-x))]";
const WIDE_ONLY = "@max-2xl:hidden";
const ACTIONS = "w-[calc(var(--ap-row-action-min-width)+4rem)]";
const UNMEASURED = "text-muted-foreground text-xs";

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

export function MembersScreen() {
  const { t } = useI18n();
  const { client } = useAgentPlatform();
  const manages = useHasPermission("member.manage");
  const members = useQuery({ ...membersQuery(client), enabled: manages });
  const reason = usePermissionReason("member.manage", members);
  // The list is also the permission probe: when it failed, nobody knows.
  const failed = members.isError && !isApiError(members.error, "FORBIDDEN");
  const [outcome, setOutcome] = useState<Outcome | null>(null);

  if (!manages) {
    return (
      <Page title={t("members.title")} description={t("members.withheld")} />
    );
  }

  return (
    <Page
      title={t("members.title")}
      description={t("members.description")}
      actions={
        failed ? undefined : (
          <InviteDialog
            reason={reason}
            members={members.data?.items ?? []}
            refusal={(error, role) => refusal(t, error, role)}
          />
        )
      }
    >
      {outcome ? (
        outcome.kind === "error" ? (
          <FormError>{outcome.text}</FormError>
        ) : (
          <output className={NOTICE}>{outcome.text}</output>
        )
      ) : null}
      {members.isPending ? (
        <StatusScreen kind="loading" />
      ) : members.error ? (
        isApiError(members.error, "FORBIDDEN") ? (
          <StatusScreen kind="forbidden" />
        ) : (
          <LoadFailure
            error={members.error}
            onRetry={() => void members.refetch()}
          />
        )
      ) : (
        <MemberTable items={members.data.items} onOutcome={setOutcome} />
      )}
      {members.isSuccess ? <InviteList onOutcome={setOutcome} /> : null}
    </Page>
  );
}

function MemberTable({
  items,
  onOutcome,
}: {
  readonly items: readonly MemberView[];
  readonly onOutcome: (outcome: Outcome | null) => void;
}) {
  const { t } = useI18n();
  const { client } = useAgentPlatform();
  const queryClient = useQueryClient();
  const role = useRole();
  const [confirming, setConfirming] = useState<MemberView | null>(null);
  // Roles change in 구성원 편집, not in the row (rows only disable).
  const [editing, setEditing] = useState<MemberView | null>(null);
  // A saved role still waits here for the confirmation.
  const [roleChange, setRoleChange] = useState<{
    member: MemberView;
    role: WorkspaceRole;
  } | null>(null);
  const self = useMe()?.user?.id;
  const reasonId = useId();
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
        : member.role === "owner" && activeOwners === 1
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
      <TableContainer label={t("members.tableLabel")} className="@container">
        {/* Fixed layout so a narrow screen shrinks the name, not the frame:
            the console v4 member table never scrolls sideways. */}
        <Table className="table-fixed">
          <TableHeader>
            <TableRow>
              <TableHead scope="col">{t("members.column.name")}</TableHead>
              <TableHead scope="col" className={ROLE_COLUMN}>
                {t("members.column.role")}
              </TableHead>
              <TableHead scope="col" className={cn(WIDE_ONLY, "w-[28%]")}>
                {t("members.column.agents")}
              </TableHead>
              <TableHead scope="col" className={cn(WIDE_ONLY, "w-[20%]")}>
                {t("members.column.lastActive")}
              </TableHead>
              <TableHead scope="col" variant="actions" className={ACTIONS}>
                {t("members.column.actions")}
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.map((member) => {
              const disabled = member.disabled_at !== null;
              const keepWhy = disabled
                ? enableReason(member)
                : keepReason(member);
              const keepId = `${reasonId}-${member.user_id}-keep`;
              const busy =
                (changeRole.isPending &&
                  changeRole.variables?.member.user_id === member.user_id) ||
                (setAccess.isPending &&
                  setAccess.variables?.member.user_id === member.user_id);
              return (
                <TableRow
                  key={member.user_id}
                  className="group"
                  data-disabled={disabled}
                >
                  <TableCell>
                    <RowLines className="min-w-0">
                      <button
                        type="button"
                        className={cn(
                          linkVariants(),
                          PRIMARY,
                          "flex min-w-0 max-w-full text-left",
                        )}
                        aria-label={t("members.editFor", {
                          name: member.display_name,
                        })}
                        onClick={() => setEditing(member)}
                      >
                        <span className="truncate">{member.display_name}</span>
                        <span aria-hidden="true">&nbsp;›</span>
                      </button>
                      <span className={cn(SECONDARY, "truncate")}>
                        {member.email}
                      </span>
                    </RowLines>
                  </TableCell>
                  <TableCell className={ROLE_COLUMN}>
                    <div className="flex flex-wrap items-center gap-1">
                      <Badge
                        variant={member.role === "member" ? "gray" : "blue"}
                      >
                        {roleLabel(t, member.role)}
                      </Badge>
                      {disabled ? (
                        <Badge variant="gray">
                          {t("members.state.disabled")}
                        </Badge>
                      ) : null}
                    </div>
                  </TableCell>
                  {/* Not in GET /v1/members yet (94S-816); never made up here. */}
                  <TableCell className={cn(WIDE_ONLY, UNMEASURED)}>
                    {t("members.unmeasured")}
                  </TableCell>
                  <TableCell className={cn(WIDE_ONLY, UNMEASURED)}>
                    {t("members.unmeasured")}
                  </TableCell>
                  <TableCell variant="actions" className={ACTIONS}>
                    <div className="flex items-center justify-end gap-1">
                      {disabled ? (
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          disabled={busy || keepWhy !== undefined}
                          aria-describedby={keepWhy ? keepId : undefined}
                          onClick={() =>
                            setAccess.mutate({ member, enable: true })
                          }
                        >
                          {t("members.enable")}
                        </Button>
                      ) : (
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          disabled={busy || keepWhy !== undefined}
                          aria-describedby={keepWhy ? keepId : undefined}
                          aria-label={t("members.disableFor", {
                            name: member.display_name,
                          })}
                          onClick={() => setConfirming(member)}
                        >
                          {t("members.disable")}
                        </Button>
                      )}
                      {keepWhy ? (
                        <ReasonHint
                          id={keepId}
                          label={t(
                            disabled
                              ? "members.enableWhy"
                              : "members.disableWhy",
                            { name: member.display_name },
                          )}
                          reason={keepWhy}
                        />
                      ) : null}
                    </div>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </TableContainer>
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
            setEditing(null);
            setRoleChange({ member: editing, role: next });
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
}: {
  readonly member: MemberView;
  readonly reason: string | undefined;
  readonly busy: boolean;
  readonly onClose: () => void;
  readonly onSave: (role: WorkspaceRole) => void;
}) {
  const { t } = useI18n();
  const [role, setRole] = useState<string>(member.role);
  const legendId = useId();
  const reasonId = useId();
  const blocked = reason !== undefined;
  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent>
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
