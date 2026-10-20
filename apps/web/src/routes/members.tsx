import type {
  Invite,
  MemberView,
  WorkspaceRole,
} from "@agent-platform/contracts";
import { ConfirmDialog, formatTimestamp } from "@agent-platform/ui";
import { useMutation, useQuery } from "@tanstack/react-query";
import { type FormEvent, useId, useState } from "react";
import { type ApiError, isApiError, unwrap } from "../api/client.ts";
import { invitesQuery, membersQuery, queryKeys } from "../api/queries.ts";
import {
  permissionReason,
  ReasonButton,
  roleLabel,
  useHasPermission,
  usePermissionReason,
  useRole,
  WORKSPACE_ROLE_VALUES,
} from "../auth/guard.tsx";
import { TextField } from "../components/field.tsx";
import { StatusScreen } from "../components/status-screen.tsx";
import { TableScroll } from "../components/table-scroll.tsx";
import { errorKey, type Translate, useI18n } from "../i18n/i18n.tsx";
import { useServices } from "../services.tsx";

// The least authority; anything more is a choice the inviter makes.
const DEFAULT_INVITE_ROLE: WorkspaceRole = "member";

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
  const { client } = useServices();
  const manages = useHasPermission("member.manage");
  const members = useQuery({ ...membersQuery(client), enabled: manages });
  const reason = usePermissionReason("member.manage", members);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const titleId = useId();

  if (!manages) {
    return (
      <div className="web-page">
        <h1 className="web-page__title">{t("members.title")}</h1>
        <p className="web-page__intro">{t("members.withheld")}</p>
      </div>
    );
  }

  return (
    <div className="web-page">
      <h1 className="web-page__title">{t("members.title")}</h1>
      {outcome ? (
        outcome.kind === "error" ? (
          <p className="web-form__error" role="alert">
            {outcome.text}
          </p>
        ) : (
          <output className="web-notice">{outcome.text}</output>
        )
      ) : null}
      <InviteForm
        reason={reason}
        members={members.data?.items ?? []}
        onOutcome={setOutcome}
      />
      <section className="web-section" aria-labelledby={titleId}>
        <h2 id={titleId}>{t("members.listTitle")}</h2>
        {members.isPending ? (
          <StatusScreen kind="loading" />
        ) : members.error ? (
          isApiError(members.error, "FORBIDDEN") ? (
            <StatusScreen kind="forbidden" />
          ) : (
            <p className="web-form__error" role="alert">
              {t(errorKey((members.error as ApiError).code))}
            </p>
          )
        ) : (
          <MemberTable items={members.data.items} onOutcome={setOutcome} />
        )}
      </section>
      {members.isSuccess ? <InviteList onOutcome={setOutcome} /> : null}
    </div>
  );
}

function InviteForm({
  reason,
  members,
  onOutcome,
}: {
  readonly reason: string | undefined;
  readonly members: readonly MemberView[];
  readonly onOutcome: (outcome: Outcome | null) => void;
}) {
  const { t, locale } = useI18n();
  const { client, queryClient } = useServices();
  const role = useRole();
  const [email, setEmail] = useState("");
  const [inviteRole, setInviteRole] =
    useState<WorkspaceRole>(DEFAULT_INVITE_ROLE);
  const [link, setLink] = useState<{ url: string; expires: string } | null>(
    null,
  );
  const titleId = useId();

  const invite = useMutation<
    { invite_token: string; expires_at: string },
    ApiError
  >({
    mutationFn: () =>
      unwrap(
        client.POST("/v1/invites", {
          body: { email: email.trim(), role: inviteRole },
        }),
      ),
    onMutate: () => {
      onOutcome(null);
      setLink(null);
    },
    onSuccess: async (created) => {
      setLink({
        url: `${window.location.origin}/invite/${encodeURIComponent(created.invite_token)}`,
        expires: created.expires_at,
      });
      setEmail("");
      await queryClient.invalidateQueries({ queryKey: queryKeys.invites });
    },
    onError: (error) =>
      onOutcome({ kind: "error", text: refusal(t, error, role) }),
  });

  // Re-inviting someone whose membership is off leads nowhere when their
  // account has no password (Google sign-in only): the invite asks for one.
  // Enabling the membership is the way back for everyone.
  const disabledMatch = members.find(
    (member) =>
      member.disabled_at !== null &&
      member.email.toLowerCase() === email.trim().toLowerCase(),
  );

  const submit = (event: FormEvent) => {
    event.preventDefault();
    invite.mutate();
  };

  return (
    <section className="web-section" aria-labelledby={titleId}>
      <h2 id={titleId}>{t("members.invite.title")}</h2>
      <form className="web-form web-form--inline" onSubmit={submit}>
        <TextField
          label={t("members.invite.email")}
          hint={
            disabledMatch
              ? t("members.invite.disabledHint", {
                  name: disabledMatch.display_name,
                })
              : undefined
          }
          type="email"
          name="email"
          required
          value={email}
          onChange={(event) => setEmail(event.target.value)}
        />
        <label className="web-field">
          <span>{t("members.invite.role")}</span>
          <select
            className="ap-input"
            value={inviteRole}
            onChange={(event) =>
              setInviteRole(event.target.value as WorkspaceRole)
            }
          >
            {WORKSPACE_ROLE_VALUES.map((value) => (
              <option key={value} value={value}>
                {roleLabel(t, value)}
              </option>
            ))}
          </select>
        </label>
        <ReasonButton
          type="submit"
          className="ap-button ap-button--primary"
          reason={reason}
          disabled={invite.isPending}
        >
          {invite.isPending
            ? t("members.invite.submitting")
            : t("members.invite.submit")}
        </ReasonButton>
      </form>
      {link ? (
        <div className="web-invite-link" data-testid="invite-link">
          <label className="web-field">
            <span>{t("members.invite.link")}</span>
            <input
              className="ap-input"
              type="text"
              readOnly
              value={link.url}
              onFocus={(event) => event.target.select()}
            />
          </label>
          <p className="web-field__hint">
            {t("members.invite.linkOnce", {
              expires: formatTimestamp(link.expires, locale),
            })}
          </p>
          <button
            type="button"
            className="ap-button"
            onClick={() => {
              void navigator.clipboard?.writeText(link.url).then(
                () =>
                  onOutcome({
                    kind: "notice",
                    text: t("members.invite.copied"),
                  }),
                () => {},
              );
            }}
          >
            {t("members.invite.copy")}
          </button>
        </div>
      ) : null}
    </section>
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
  const { client, queryClient } = useServices();
  const role = useRole();
  const [confirming, setConfirming] = useState<MemberView | null>(null);

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
    return <p className="web-page__empty">{t("members.empty")}</p>;
  }

  return (
    <>
      <TableScroll label={t("members.tableLabel")}>
        <table className="web-table">
          <thead>
            <tr>
              <th scope="col">{t("members.column.name")}</th>
              <th scope="col">{t("members.column.role")}</th>
              <th scope="col">{t("members.column.state")}</th>
              <th scope="col">{t("members.column.actions")}</th>
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
                <tr key={member.user_id} data-disabled={disabled}>
                  <td>
                    <span className="web-table__primary">
                      {member.display_name}
                    </span>
                    <span className="web-table__secondary">{member.email}</span>
                  </td>
                  <td>
                    <select
                      className="ap-input"
                      aria-label={t("members.roleFor", {
                        name: member.display_name,
                      })}
                      value={member.role}
                      disabled={busy || disabled}
                      onChange={(event) =>
                        changeRole.mutate({
                          member,
                          role: event.target.value as WorkspaceRole,
                        })
                      }
                    >
                      {WORKSPACE_ROLE_VALUES.map((value) => (
                        <option key={value} value={value}>
                          {roleLabel(t, value)}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td>
                    {disabled ? (
                      <>
                        <span>{t("members.state.disabled")}</span>
                        <span className="web-table__secondary">
                          {t("members.enableHint")}
                        </span>
                      </>
                    ) : (
                      t("members.state.active")
                    )}
                  </td>
                  <td>
                    {disabled ? (
                      <button
                        type="button"
                        className="ap-button"
                        disabled={busy}
                        onClick={() =>
                          setAccess.mutate({ member, enable: true })
                        }
                      >
                        {t("members.enable")}
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="ap-button"
                        disabled={busy}
                        aria-label={t("members.disableFor", {
                          name: member.display_name,
                        })}
                        onClick={() => setConfirming(member)}
                      >
                        {t("members.disable")}
                      </button>
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
    </>
  );
}

function InviteList({
  onOutcome,
}: {
  readonly onOutcome: (outcome: Outcome | null) => void;
}) {
  const { t, locale } = useI18n();
  const { client, queryClient } = useServices();
  const role = useRole();
  const invites = useQuery(invitesQuery(client));
  const titleId = useId();

  const revoke = useMutation<unknown, ApiError, Invite>({
    mutationFn: (invite) =>
      unwrap(
        client.DELETE("/v1/invites/{id}", {
          params: { path: { id: invite.id } },
        }),
      ),
    onMutate: () => onOutcome(null),
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
    <section className="web-section" aria-labelledby={titleId}>
      <h2 id={titleId}>{t("members.invites.title")}</h2>
      {invites.isPending ? (
        <StatusScreen kind="loading" />
      ) : invites.error ? (
        <p className="web-form__error" role="alert">
          {refusal(t, invites.error as ApiError, role)}
        </p>
      ) : pending.length === 0 ? (
        <p className="web-page__empty">{t("members.invites.empty")}</p>
      ) : (
        <ul className="web-list">
          {pending.map((invite) => (
            <li key={invite.id} className="web-list__item">
              <span className="web-table__primary">{invite.email}</span>
              <span className="web-table__secondary">
                {roleLabel(t, invite.role)} ·{" "}
                {t("members.invites.expires", {
                  expires: formatTimestamp(invite.expires_at, locale),
                })}
              </span>
              <button
                type="button"
                className="ap-button"
                disabled={revoke.isPending}
                aria-label={t("members.invites.revokeFor", {
                  email: invite.email,
                })}
                onClick={() => revoke.mutate(invite)}
              >
                {t("members.invites.revoke")}
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
