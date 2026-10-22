import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type ApiError, isApiError, unwrap } from "@werft-ai/client";
import type { Invite, MemberView, WorkspaceRole } from "@werft-ai/contracts";
import { useAgentPlatform } from "@werft-ai/react";
import {
  Badge,
  Button,
  buttonVariants,
  ConfirmDialog,
  EmptyState,
  formatTimestamp,
  NativeSelect,
  NativeSelectOption,
} from "@werft-ai/ui";
import { useId, useState } from "react";
import { invitesQuery, membersQuery, queryKeys } from "../api/queries.ts";
import {
  permissionReason,
  ReasonButton,
  roleLabel,
  useHasPermission,
  useMe,
  usePermissionReason,
  useRole,
  WORKSPACE_ROLE_VALUES,
} from "../auth/guard.tsx";
import { FormError, NOTICE } from "../components/auth-page.tsx";
import { LoadFailure } from "../components/load-failure.tsx";
import { StatusScreen } from "../components/status-screen.tsx";
import { TableScroll } from "../components/table-scroll.tsx";
import { errorKey, type Translate, useI18n } from "../i18n/i18n.tsx";
import { InviteDialog } from "./invite-dialog.tsx";

const PAGE = "flex flex-col gap-6";
const TITLE = "m-0 font-semibold text-xl";
const SECTION = "flex flex-col gap-3";
const SECTION_TITLE = "m-0 font-semibold text-lg";
const MUTED = "m-0 text-muted-foreground";
const CELL = "border-b p-2 text-left align-top";
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
function refusal(t: Translate, error: ApiError, role: string | undefined) {
  if (error.code === "FORBIDDEN")
    return permissionReason(t, "member.manage", role);
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
      <div className={PAGE}>
        <h1 className={TITLE}>{t("members.title")}</h1>
        <p className={MUTED}>{t("members.withheld")}</p>
      </div>
    );
  }

  return (
    <div className={PAGE}>
      <h1 className={TITLE}>{t("members.title")}</h1>
      {outcome ? (
        outcome.kind === "error" ? (
          <FormError>{outcome.text}</FormError>
        ) : (
          <output className={NOTICE}>{outcome.text}</output>
        )
      ) : null}
      {failed ? null : (
        <div>
          <InviteDialog
            reason={reason}
            members={members.data?.items ?? []}
            refusal={(error, role) => refusal(t, error, role)}
          />
        </div>
      )}
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
    </div>
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
  const activeOwners = items.filter(
    (member) => member.role === "owner" && member.disabled_at === null,
  ).length;
  // The server refuses both; the button says so before anyone asks.
  const keepReason = (member: MemberView) =>
    member.user_id === self
      ? t("members.disableSelf")
      : member.role === "owner" && activeOwners === 1
        ? t("members.disableLastOwner")
        : undefined;

  const settle = async (text: string) => {
    onOutcome({ kind: "notice", text });
    await queryClient.invalidateQueries({ queryKey: queryKeys.members });
  };
  const fail = (error: ApiError) =>
    onOutcome({ kind: "error", text: refusal(t, error, role) });

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
    onError: fail,
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
    onError: (error) => {
      setConfirming(null);
      fail(error);
    },
  });

  if (items.length === 0) {
    return <EmptyState title={t("members.empty")} />;
  }

  return (
    <>
      <TableScroll label={t("members.tableLabel")}>
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr>
              <th scope="col" className={CELL}>
                {t("members.column.name")}
              </th>
              <th scope="col" className={CELL}>
                {t("members.column.role")}
              </th>
              <th scope="col" className={CELL}>
                {t("members.column.state")}
              </th>
              <th scope="col" className={CELL}>
                {t("members.column.actions")}
              </th>
            </tr>
          </thead>
          <tbody>
            {items.map((member) => {
              const disabled = member.disabled_at !== null;
              const busy =
                (changeRole.isPending &&
                  changeRole.variables?.member.user_id === member.user_id) ||
                (setAccess.isPending &&
                  setAccess.variables?.member.user_id === member.user_id);
              return (
                <tr
                  key={member.user_id}
                  className="group"
                  data-disabled={disabled}
                >
                  <td className={CELL}>
                    <span className={PRIMARY}>{member.display_name}</span>
                    <span className={SECONDARY}>{member.email}</span>
                  </td>
                  <td className={CELL}>
                    <NativeSelect
                      size="sm"
                      className="w-auto"
                      aria-label={t("members.roleFor", {
                        name: member.display_name,
                      })}
                      value={member.role}
                      disabled={busy || disabled}
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
                  </td>
                  <td className={CELL}>
                    {disabled ? (
                      <span className="flex flex-col items-start gap-1">
                        <Badge variant="secondary">
                          {t("members.state.disabled")}
                        </Badge>
                        <span className={SECONDARY}>
                          {t("members.enableHint")}
                        </span>
                      </span>
                    ) : (
                      <Badge variant="outline">
                        {t("members.state.active")}
                      </Badge>
                    )}
                  </td>
                  <td className={CELL}>
                    {disabled ? (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={busy}
                        onClick={() =>
                          setAccess.mutate({ member, enable: true })
                        }
                      >
                        {t("members.enable")}
                      </Button>
                    ) : (
                      <ReasonButton
                        className={buttonVariants({
                          variant: "outline",
                          size: "sm",
                        })}
                        reason={keepReason(member)}
                        disabled={busy}
                        aria-label={t("members.disableFor", {
                          name: member.display_name,
                        })}
                        onClick={() => setConfirming(member)}
                      >
                        {t("members.disable")}
                      </ReasonButton>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </TableScroll>
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
        <ul className="m-0 flex list-none flex-col gap-2 p-0">
          {pending.map((invite) => (
            <li
              key={invite.id}
              className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-md border bg-card p-3"
            >
              <span className="flex min-w-0 flex-col">
                <span className={PRIMARY}>{invite.email}</span>
                <span className={SECONDARY}>
                  {roleLabel(t, invite.role)} ·{" "}
                  {t("members.invites.expires", {
                    expires: formatTimestamp(invite.expires_at, locale),
                  })}
                </span>
              </span>
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
            </li>
          ))}
        </ul>
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
