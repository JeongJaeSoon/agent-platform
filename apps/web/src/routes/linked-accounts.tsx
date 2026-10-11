import type {
  LinkedAccount,
  SlackLinkCallbackResponse,
  StartSlackLinkResponse,
} from "@agent-platform/contracts";
import { formatTimestamp } from "@agent-platform/ui";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { useEffect, useId, useRef, useState } from "react";
import { type ApiError, unwrap } from "../api/client.ts";
import { linkedAccountsQuery, queryKeys } from "../api/queries.ts";
import { refusalText, useRole } from "../auth/guard.tsx";
import { type Outcome, OutcomeLine } from "../components/outcome.tsx";
import { StatusScreen } from "../components/status-screen.tsx";
import { errorKey, type Translate, useI18n } from "../i18n/i18n.tsx";
import { useServices } from "../services.tsx";

// Refusals whose server message is the product copy written for the person
// linking (contracts LINK_MESSAGES); the page shows those words unchanged.
const LINK_COPY_CODES = new Set([
  "BAD_REQUEST",
  "SLACK_NOT_INSTALLED",
  "LINK_TEAM_MISMATCH",
  "LINK_TAKEN",
  "LINK_EXISTS",
]);

function linkRefusal(
  t: Translate,
  error: ApiError,
  role: string | undefined,
  starting = false,
): string {
  if (LINK_COPY_CODES.has(error.code)) return error.message;
  // Starting never reaches Slack, so its 503 means linking is not set up
  // here; anywhere else it may be Slack briefly out of reach.
  if (starting && error.code === "BACKEND_UNAVAILABLE")
    return t("linked.unavailable");
  if (error.code === "FORBIDDEN")
    return refusalText(t, error, "account.link", role);
  return t(errorKey(error.code));
}

/** The caller's accounts on other services; v1 links Slack only. */
export function LinkedAccountsScreen() {
  const { t } = useI18n();
  const { client, queryClient, leave } = useServices();
  const role = useRole();
  const accounts = useQuery(linkedAccountsQuery(client));
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const titleId = useId();

  const start = useMutation<StartSlackLinkResponse, ApiError>({
    mutationFn: () => unwrap(client.POST("/v1/linked-accounts/slack/start")),
    onMutate: () => setOutcome(null),
    onSuccess: ({ authorize_url }) => leave(authorize_url),
    onError: (error) =>
      setOutcome({ kind: "error", text: linkRefusal(t, error, role, true) }),
  });

  const unlink = useMutation<unknown, ApiError, LinkedAccount>({
    mutationFn: (account) =>
      unwrap(
        client.DELETE("/v1/linked-accounts/{id}", {
          params: { path: { id: account.id } },
        }),
      ),
    onMutate: () => setOutcome(null),
    onSuccess: async () => {
      setOutcome({ kind: "notice", text: t("linked.unlinked") });
      await queryClient.invalidateQueries({
        queryKey: queryKeys.linkedAccounts,
      });
    },
    onError: (error) =>
      setOutcome({ kind: "error", text: linkRefusal(t, error, role) }),
  });

  const live =
    accounts.data?.items.filter((account) => account.status !== "revoked") ??
    [];

  return (
    <div className="web-page">
      <h1 className="web-page__title">{t("linked.title")}</h1>
      <p className="web-page__intro">{t("linked.intro")}</p>
      <OutcomeLine outcome={outcome} />
      <section className="web-section" aria-labelledby={titleId}>
        <h2 id={titleId}>{t("linked.slack")}</h2>
        {accounts.isPending ? (
          <StatusScreen kind="loading" />
        ) : accounts.error ? (
          <p className="web-form__error" role="alert">
            {linkRefusal(t, accounts.error as ApiError, role)}
          </p>
        ) : (
          <SlackAccounts
            accounts={live}
            unlinking={unlink.isPending ? unlink.variables?.id : undefined}
            onUnlink={(account) => unlink.mutate(account)}
          />
        )}
        {/* One link per Slack workspace, so another workspace can still
            be added while one is linked. */}
        {accounts.isSuccess ? (
          <button
            type="button"
            className="ap-button ap-button--primary"
            // Not held after success: back from Slack (bfcache) must be
            // able to start again.
            disabled={start.isPending}
            onClick={() => start.mutate()}
          >
            {start.isPending ? t("linked.starting") : t("linked.connect")}
          </button>
        ) : null}
      </section>
    </div>
  );
}

function SlackAccounts({
  accounts,
  unlinking,
  onUnlink,
}: {
  readonly accounts: readonly LinkedAccount[];
  readonly unlinking: string | undefined;
  readonly onUnlink: (account: LinkedAccount) => void;
}) {
  const { t } = useI18n();
  if (accounts.length === 0) {
    return <p className="web-page__empty">{t("linked.none")}</p>;
  }
  return (
    <ul className="web-list">
      {accounts.map((account) => (
        <li key={account.id} className="web-list__item">
          <span className="web-table__primary">
            {t("linked.slackAccount", {
              user: account.external_user_id,
              team: account.external_tenant,
            })}
          </span>
          <span className="web-table__secondary">
            {account.status === "stale"
              ? t("linked.stale")
              : t("linked.verified", {
                  at: formatTimestamp(account.verified_at),
                })}
          </span>
          <button
            type="button"
            className="ap-button"
            disabled={unlinking === account.id}
            onClick={() => onUnlink(account)}
          >
            {t("linked.unlink")}
          </button>
        </li>
      ))}
    </ul>
  );
}

export interface SlackLinkSearch {
  readonly code?: string;
  readonly state?: string;
}

export function slackLinkSearch(
  search: Record<string, unknown>,
): SlackLinkSearch {
  const pick = (value: unknown) =>
    typeof value === "string" && value.length > 0 ? value : undefined;
  const code = pick(search.code);
  const state = pick(search.state);
  return { ...(code ? { code } : {}), ...(state ? { state } : {}) };
}

/**
 * Where Slack sends the browser back (SLACK_OIDC_REDIRECT_URI). It sits
 * behind the login, so someone whose session ended signs in and lands here
 * again with the same code.
 */
export function SlackLinkCallbackScreen() {
  const { t } = useI18n();
  const { client, queryClient } = useServices();
  const navigate = useNavigate();
  const role = useRole();
  const { code, state } = useSearch({
    from: "/authed/settings/linked-accounts/slack",
  });
  const sent = useRef(false);

  const finish = useMutation<SlackLinkCallbackResponse, ApiError>({
    mutationFn: () =>
      unwrap(
        client.POST("/v1/linked-accounts/slack/callback", {
          body: { code: code ?? "", state: state ?? "" },
        }),
      ),
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: queryKeys.linkedAccounts,
      });
      await navigate({ to: "/settings/linked-accounts", replace: true });
    },
  });

  // Each code and state are good for one exchange.
  useEffect(() => {
    if (sent.current || !code || !state) return;
    sent.current = true;
    finish.mutate();
  }, [code, state, finish]);

  const failure =
    !code || !state
      ? t("linked.cancelled")
      : finish.error
        ? linkRefusal(t, finish.error, role)
        : null;
  return (
    <div className="web-page">
      <h1 className="web-page__title">{t("linked.title")}</h1>
      {failure ? (
        <>
          <p className="web-form__error" role="alert">
            {failure}
          </p>
          <p>
            <Link to="/settings/linked-accounts">{t("linked.back")}</Link>
          </p>
        </>
      ) : (
        <StatusScreen kind="loading" />
      )}
    </div>
  );
}
