import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { type ApiError, isApiError, unwrap } from "@werft-ai/client";
import type {
  LinkedAccount,
  SlackLinkCallbackResponse,
  StartSlackLinkResponse,
} from "@werft-ai/contracts";
import { useAgentPlatform } from "@werft-ai/react";
import { Button, EmptyState, formatTimestamp } from "@werft-ai/ui";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { linkedAccountsQuery, queryKeys } from "../api/queries.ts";
import { refusalText, useRole } from "../auth/guard.tsx";
import { FormError, NOTICE } from "../components/auth-page.tsx";
import { LoadFailure } from "../components/load-failure.tsx";
import type { Outcome } from "../components/outcome.tsx";
import { StatusScreen } from "../components/status-screen.tsx";
import { errorKey, type Translate, useI18n } from "../i18n/i18n.tsx";
import { useAppServices } from "../services.tsx";

const PAGE = "flex flex-col gap-6";
const TITLE = "m-0 font-semibold text-xl";
const SECTION = "flex flex-col gap-3";
const SECTION_TITLE = "m-0 font-semibold text-lg";
const HINT = "m-0 text-muted-foreground";
const PRIMARY = "block break-words font-semibold";
const SECONDARY =
  "block text-muted-foreground text-xs [overflow-wrap:anywhere]";

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
): string {
  if (LINK_COPY_CODES.has(error.code)) return error.message;
  // Slack briefly out of reach is worth another try; linking not set up on
  // this installation never is.
  if (error.code === "BACKEND_UNAVAILABLE" && !error.retryable)
    return t("linked.unavailable");
  if (error.code === "FORBIDDEN")
    return refusalText(t, error, "account.link", role);
  return t(errorKey(error.code));
}

/** The caller's accounts on other services; v1 links Slack only. */
export function LinkedAccountsScreen() {
  const { t } = useI18n();
  const { client } = useAgentPlatform();
  const queryClient = useQueryClient();
  const { leave } = useAppServices();
  const role = useRole();
  const accounts = useQuery(linkedAccountsQuery(client));
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const titleId = useId();
  const sectionRef = useRef<HTMLElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  // The account being unlinked, its neighbours nearest first (those below,
  // then those above) when the request started, and whether focus is still
  // on its row, until the row leaves the list.
  const unlinked = useRef<{
    id: string;
    neighbours: readonly string[];
    held: boolean;
    stop: AbortController;
  } | null>(null);

  const live =
    accounts.data?.items.filter((account) => account.status !== "revoked") ??
    [];

  useEffect(() => () => unlinked.current?.stop.abort(), []);

  // The pressed button leaves with its row and focus falls to the page. It
  // goes to the nearest row left below, else above, else the heading of the
  // emptied list.
  useLayoutEffect(() => {
    const gone = unlinked.current;
    if (!gone || live.some((account) => account.id === gone.id)) return;
    unlinked.current = null;
    gone.stop.abort();
    if (!gone.held || document.activeElement !== document.body) return;
    const ids = live.map(({ id }) => id);
    const next = gone.neighbours.find((id) => ids.includes(id));
    const buttons =
      sectionRef.current?.querySelectorAll<HTMLElement>("li button") ?? [];
    (next ? buttons[ids.indexOf(next)] : headingRef.current)?.focus();
  });

  const start = useMutation<StartSlackLinkResponse, ApiError>({
    mutationFn: () => unwrap(client.POST("/v1/linked-accounts/slack/start")),
    onMutate: () => setOutcome(null),
    onSuccess: ({ authorize_url }) => leave(authorize_url),
    onError: (error) =>
      setOutcome({ kind: "error", text: linkRefusal(t, error, role) }),
  });

  const unlink = useMutation<unknown, ApiError, LinkedAccount>({
    mutationFn: (account) =>
      unwrap(
        client.DELETE("/v1/linked-accounts/{id}", {
          params: { path: { id: account.id } },
        }),
      ),
    onMutate: (account) => {
      setOutcome(null);
      unlinked.current?.stop.abort();
      const ids = live.map(({ id }) => id);
      const index = ids.indexOf(account.id);
      const row = sectionRef.current?.querySelectorAll("li")[index];
      const gone = {
        id: account.id,
        neighbours: [
          ...ids.slice(index + 1),
          ...ids.slice(0, Math.max(index, 0)).reverse(),
        ],
        held: row?.contains(document.activeElement) ?? false,
        stop: new AbortController(),
      };
      unlinked.current = gone;
      // Focus moved anywhere outside the row meanwhile is left where it went.
      const away = (event: Event) => {
        if (event.target instanceof Node && row?.contains(event.target)) return;
        gone.held = false;
        gone.stop.abort();
      };
      for (const type of ["focusin", "pointerdown"]) {
        document.addEventListener(type, away, {
          capture: true,
          signal: gone.stop.signal,
        });
      }
    },
    onSuccess: async () => {
      setOutcome({ kind: "notice", text: t("linked.unlinked") });
      await queryClient.invalidateQueries({
        queryKey: queryKeys.linkedAccounts,
      });
    },
    onError: (error, account) => {
      // A later unlink of another row keeps its own record.
      if (unlinked.current?.id === account.id) {
        unlinked.current.stop.abort();
        unlinked.current = null;
      }
      setOutcome({ kind: "error", text: linkRefusal(t, error, role) });
    },
  });

  const notice = outcome?.kind === "notice" ? outcome.text : null;

  return (
    <div className={PAGE}>
      <h1 className={TITLE}>{t("linked.title")}</h1>
      <p className={HINT}>{t("linked.intro")}</p>
      {outcome?.kind === "error" ? <FormError>{outcome.text}</FormError> : null}
      {/* Always mounted, so a screen reader hears the notice when it
          changes; out of the flow while empty. */}
      <output className={notice ? NOTICE : "sr-only"}>{notice}</output>
      <section ref={sectionRef} className={SECTION} aria-labelledby={titleId}>
        <h2
          ref={headingRef}
          id={titleId}
          tabIndex={-1}
          className={`${SECTION_TITLE} outline-none`}
        >
          {t("linked.slack")}
        </h2>
        {accounts.isPending ? (
          <StatusScreen kind="loading" />
        ) : accounts.error ? (
          isApiError(accounts.error, "FORBIDDEN") ? (
            <FormError>{linkRefusal(t, accounts.error, role)}</FormError>
          ) : (
            <LoadFailure
              error={accounts.error}
              onRetry={() => void accounts.refetch()}
            />
          )
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
          <Button
            type="button"
            className="self-start"
            // Not held after success: back from Slack (bfcache) must be
            // able to start again.
            disabled={start.isPending}
            onClick={() => start.mutate()}
          >
            {start.isPending ? t("linked.starting") : t("linked.connect")}
          </Button>
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
  const { t, locale } = useI18n();
  if (accounts.length === 0) {
    return <EmptyState title={t("linked.none")} />;
  }
  return (
    <ul className="m-0 flex list-none flex-col p-0">
      {accounts.map((account) => (
        <li
          key={account.id}
          className="flex flex-col items-start gap-1 border-b py-3 sm:flex-row sm:items-center sm:gap-3"
        >
          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className={PRIMARY}>
              {t("linked.slackAccount", {
                user: account.external_user_id,
                team: account.external_tenant,
              })}
            </span>
            <span className={SECONDARY}>
              {account.status === "stale"
                ? t("linked.stale")
                : t("linked.verified", {
                    at: formatTimestamp(account.verified_at, locale),
                  })}
            </span>
          </span>
          <Button
            type="button"
            variant="outline"
            size="sm"
            // Not `disabled` while it runs: Chrome takes focus off a disabled
            // button, and a refused unlink would leave the keyboard lost.
            aria-disabled={unlinking === account.id || undefined}
            className="aria-disabled:opacity-50"
            onClick={() => {
              if (unlinking !== account.id) onUnlink(account);
            }}
          >
            {t("linked.unlink")}
          </Button>
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
  const { client } = useAgentPlatform();
  const queryClient = useQueryClient();
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
    <div className={PAGE}>
      <h1 className={TITLE}>{t("linked.title")}</h1>
      {failure ? (
        <>
          <FormError>{failure}</FormError>
          <p className="m-0">
            <Link to="/settings/linked-accounts">{t("linked.back")}</Link>
          </p>
        </>
      ) : (
        <StatusScreen kind="loading" />
      )}
    </div>
  );
}
