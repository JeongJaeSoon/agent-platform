import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type ApiError, isApiError, unwrap } from "@werft-ai/client";
import type { Invite, MemberView, WorkspaceRole } from "@werft-ai/contracts";
import { useAgentPlatform } from "@werft-ai/react";
import {
  Badge,
  Button,
  ConfirmDialog,
  EmptyState,
  formatTimestamp,
  NativeSelect,
  NativeSelectOption,
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
  const titleId = useId();

  if (!manages) {
    return (
      <Page title={t("members.title")} description={t("members.withheld")} />
    );
  }

  return (
    <Page
      title={t("members.title")}
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
      <section className={SECTION} aria-labelledby={titleId}>
        <h2 id={titleId} className={SECTION_TITLE}>
          {t("members.listTitle")}
        </h2>
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
      </section>
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
  // A picked role waits here for the confirmation; arrowing through the
  // select must not send a role on every step.
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
      <TableContainer label={t("members.tableLabel")}>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead scope="col">{t("members.column.name")}</TableHead>
              <TableHead scope="col">{t("members.column.role")}</TableHead>
              <TableHead scope="col">{t("members.column.state")}</TableHead>
              <TableHead scope="col" variant="actions">
                {t("members.column.actions")}
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.map((member) => {
              const disabled = member.disabled_at !== null;
              const roleWhy = roleReason(member);
              const keepWhy = disabled
                ? enableReason(member)
                : keepReason(member);
              const ids = {
                role: `${reasonId}-${member.user_id}-role`,
                keep: `${reasonId}-${member.user_id}-keep`,
              };
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
                    {/* One line per cell: below the table's width the container scrolls,
                        so every row keeps two lines. */}
                    <RowLines className="whitespace-nowrap">
                      <span className={PRIMARY}>{member.display_name}</span>
                      <span className={SECONDARY}>{member.email}</span>
                    </RowLines>
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center gap-1">
                      <NativeSelect
                        size="sm"
                        className="w-auto"
                        aria-label={t("members.roleFor", {
                          name: member.display_name,
                        })}
                        aria-describedby={
                          roleWhy && !disabled ? ids.role : undefined
                        }
                        value={member.role}
                        disabled={busy || disabled || roleWhy !== undefined}
                        onChange={(event) =>
                          setRoleChange({
                            member,
                            role: event.target.value as WorkspaceRole,
                          })
                        }
                      >
                        {WORKSPACE_ROLE_VALUES.map((value) => (
                          <NativeSelectOption key={value} value={value}>
                            {roleLabel(t, value)}
                          </NativeSelectOption>
                        ))}
                      </NativeSelect>
                      {roleWhy && !disabled ? (
                        <ReasonHint
                          id={ids.role}
                          label={t("members.roleWhy", {
                            name: member.display_name,
                          })}
                          reason={roleWhy}
                        />
                      ) : null}
                    </div>
                  </TableCell>
                  <TableCell>
                    {disabled ? (
                      <RowLines className="items-start whitespace-nowrap">
                        <Badge variant="gray">
                          {t("members.state.disabled")}
                        </Badge>
                        <span className={SECONDARY}>
                          {t("members.enableHint")}
                        </span>
                      </RowLines>
                    ) : (
                      <Badge variant="green">{t("members.state.active")}</Badge>
                    )}
                  </TableCell>
                  <TableCell variant="actions">
                    <div className="flex items-center gap-1">
                      {disabled ? (
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          disabled={busy || keepWhy !== undefined}
                          aria-describedby={keepWhy ? ids.keep : undefined}
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
                          aria-describedby={keepWhy ? ids.keep : undefined}
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
                          id={ids.keep}
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
