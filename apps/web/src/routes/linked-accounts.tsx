import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { type ApiError, isApiError, unwrap } from "@werft-ai/client";
import type {
  LinkedAccount,
  SlackLinkCallbackResponse,
  StartSlackLinkResponse,
} from "@werft-ai/contracts";
import { useAgentPlatform } from "@werft-ai/react";
import {
  Badge,
  Button,
  cn,
  formatTimestamp,
  Page,
  RowLines,
  RowListItem,
  Link as TextLink,
} from "@werft-ai/ui";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { linkedAccountsQuery, queryKeys } from "../api/queries.ts";
import { refusalText, useRole } from "../auth/guard.tsx";
import { FormError, Notice } from "../components/auth-page.tsx";
import { LoadFailure } from "../components/load-failure.tsx";
import type { Outcome } from "../components/outcome.tsx";
import { StatusScreen } from "../components/status-screen.tsx";
import { errorKey, type Translate, useI18n } from "../i18n/i18n.tsx";
import { useAppServices } from "../services.tsx";

// One row per service (console v35): 64px tall, its button as wide as a row action.
const SERVICES =
  "m-0 flex list-none flex-col overflow-hidden rounded-card border bg-card p-0 [&>li+li]:border-t";
const SERVICE_ROW =
  "flex min-h-16 flex-wrap items-center gap-x-3 gap-y-2 px-[var(--ap-row-padding-x)] py-[var(--ap-row-padding-y)]";
const SERVICE_NAME = "m-0 font-semibold text-body";
const SERVICE_BUTTON = "ml-auto min-w-[var(--ap-row-action-min-width)]";
// Lines under a service start where its name does: inset, mark, gap.
const SERVICE_INDENT = "pl-[calc(var(--ap-row-padding-x)+1.5rem+0.75rem)]";
const SERVICE_DETAIL = cn(
  SERVICE_INDENT,
  "border-t pr-[var(--ap-row-padding-x)] py-[var(--ap-row-padding-y)]",
);
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
  const listRef = useRef<HTMLUListElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  // The account whose row holds focus, until focus or a press goes elsewhere.
  // Its row leaving takes focus with it, which fires neither event.
  const focusedRow = useRef<string | null>(null);
  const shownIds = useRef<readonly string[]>([]);
  // Same for the link button, which goes when a link shows up (another tab).
  const startRef = useRef<HTMLButtonElement>(null);
  const focusedStart = useRef(false);

  const live =
    accounts.data?.items.filter((account) => account.status !== "revoked") ??
    [];

  useEffect(() => {
    const track = (event: Event) => {
      const row =
        event.target instanceof Element
          ? event.target.closest<HTMLElement>("li[data-account]")
          : null;
      focusedRow.current =
        row && listRef.current?.contains(row)
          ? (row.dataset.account ?? null)
          : null;
      focusedStart.current =
        startRef.current !== null && event.target === startRef.current;
    };
    const stop = new AbortController();
    for (const type of ["focusin", "pointerdown"]) {
      document.addEventListener(type, track, {
        capture: true,
        signal: stop.signal,
      });
    }
    return () => stop.abort();
  }, []);

  // Focus that fell to the page with its row goes to the nearest row left
  // below it, else above it, else the heading of the emptied list.
  useLayoutEffect(() => {
    // Rows as drawn: a failed reread keeps the data but draws no list.
    const rows = [
      ...(listRef.current?.querySelectorAll<HTMLElement>("li[data-account]") ??
        []),
    ];
    const ids = rows.map((row) => row.dataset.account ?? "");
    const before = shownIds.current;
    shownIds.current = ids;
    if (focusedStart.current && !startRef.current) {
      focusedStart.current = false;
      if (document.activeElement === document.body) {
        (rows[0]?.querySelector("button") ?? headingRef.current)?.focus();
      }
      return;
    }
    const gone = focusedRow.current;
    if (!gone || ids.includes(gone)) return;
    focusedRow.current = null;
    if (document.activeElement !== document.body) return;
    const at = before.indexOf(gone);
    const next = [
      ...before.slice(at + 1),
      ...before.slice(0, Math.max(at, 0)).reverse(),
    ].find((id) => ids.includes(id));
    (next
      ? rows[ids.indexOf(next)]?.querySelector("button")
      : headingRef.current
    )?.focus();
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

  const notice = outcome?.kind === "notice" ? outcome.text : null;

  return (
    <Page
      title={t("linked.title")}
      description={t("linked.intro")}
      width="form"
    >
      {outcome?.kind === "error" ? <FormError>{outcome.text}</FormError> : null}
      {/* Always mounted, so a screen reader hears the notice when it
          changes. */}
      <Notice>{notice}</Notice>
      <ul ref={listRef} className={SERVICES}>
        <SoonService mark="G" name="GitHub" use={t("linked.use.github")} />
        <li>
          <div className={SERVICE_ROW}>
            <ServiceMark>S</ServiceMark>
            <RowLines>
              <span className="flex flex-wrap items-center gap-2">
                <h2
                  ref={headingRef}
                  tabIndex={-1}
                  className={`${SERVICE_NAME} outline-none`}
                >
                  {t("linked.slack")}
                </h2>
                {accounts.isSuccess ? (
                  <Badge variant={live.length > 0 ? "green" : "gray"}>
                    {t(
                      live.length > 0 ? "linked.connected" : "linked.notLinked",
                    )}
                  </Badge>
                ) : null}
              </span>
              <span className={SECONDARY}>{t("linked.use.slack")}</span>
            </RowLines>
            {/* Linked rows offer only unlinking; linking again starts from
                there. */}
            {accounts.isSuccess && live.length === 0 ? (
              <Button
                ref={startRef}
                type="button"
                variant="outline"
                className={SERVICE_BUTTON}
                aria-label={start.isPending ? undefined : t("linked.connect")}
                // Not held after success: back from Slack (bfcache) must be
                // able to start again.
                disabled={start.isPending}
                onClick={() => start.mutate()}
              >
                {start.isPending ? t("linked.starting") : t("linked.link")}
              </Button>
            ) : null}
          </div>
          {accounts.isPending ? (
            <div className={SERVICE_DETAIL}>
              <StatusScreen kind="loading" />
            </div>
          ) : accounts.error ? (
            <div className={SERVICE_DETAIL}>
              {isApiError(accounts.error, "FORBIDDEN") ? (
                <FormError>{linkRefusal(t, accounts.error, role)}</FormError>
              ) : (
                <LoadFailure
                  error={accounts.error}
                  onRetry={() => void accounts.refetch()}
                />
              )}
            </div>
          ) : (
            <SlackAccounts
              accounts={live}
              unlinking={unlink.isPending ? unlink.variables?.id : undefined}
              onUnlink={(account) => unlink.mutate(account)}
            />
          )}
        </li>
        <SoonService
          mark="GW"
          name="Google Workspace"
          use={t("linked.use.google")}
        />
      </ul>
    </Page>
  );
}

function ServiceMark({ children }: { readonly children: string }) {
  return (
    <span
      aria-hidden="true"
      className="grid size-6 shrink-0 place-items-center rounded-control bg-muted font-semibold text-caption text-muted-foreground"
    >
      {children}
    </span>
  );
}

/**
 * A service the console names but cannot link yet: no API behind it, so the
 * row says so and offers nothing to press.
 */
function SoonService({
  mark,
  name,
  use,
}: {
  readonly mark: string;
  readonly name: string;
  readonly use: string;
}) {
  const { t } = useI18n();
  return (
    <li data-soon="true" className={SERVICE_ROW}>
      <ServiceMark>{mark}</ServiceMark>
      <RowLines>
        <span className="flex flex-wrap items-center gap-2">
          <h2 className={SERVICE_NAME}>{name}</h2>
          <Badge variant="gray">{t("linked.soon")}</Badge>
        </span>
        <span className={SECONDARY}>{use}</span>
      </RowLines>
    </li>
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
  // Nothing linked reads from the row's badge; no second empty line.
  if (accounts.length === 0) return null;
  return (
    <ul className="m-0 list-none border-t p-0 [&>li+li]:border-t">
      {accounts.map((account) => (
        <RowListItem
          key={account.id}
          data-account={account.id}
          className={cn(
            SERVICE_INDENT,
            "flex-col items-start sm:flex-row sm:items-center",
          )}
        >
          <RowLines>
            <SlackAccountName account={account} />
            <span className={SECONDARY}>
              {account.status === "stale"
                ? t("linked.stale")
                : t("linked.verified", {
                    at: formatTimestamp(account.verified_at, locale),
                  })}
            </span>
          </RowLines>
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
        </RowListItem>
      ))}
    </ul>
  );
}

/**
 * Names when Slack gave any, with the ids under them; a link made before
 * names were kept shows its ids alone. A missing name falls back to its id.
 */
function SlackAccountName({ account }: { readonly account: LinkedAccount }) {
  const { t } = useI18n();
  const ids = {
    user: account.external_user_id,
    team: account.external_tenant,
  };
  if (
    account.external_user_name === null &&
    account.external_tenant_name === null
  ) {
    return <span className={PRIMARY}>{t("linked.slackAccount", ids)}</span>;
  }
  return (
    <>
      <span className={PRIMARY}>
        {t("linked.slackNamed", {
          user: account.external_user_name ?? ids.user,
          team: account.external_tenant_name ?? ids.team,
        })}
      </span>
      <span className={SECONDARY}>{t("linked.slackIds", ids)}</span>
    </>
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
    <Page title={t("linked.title")} width="form">
      {failure ? (
        <div className="flex flex-col gap-[var(--ap-space-block)]">
          <FormError>{failure}</FormError>
          <p className="m-0">
            <TextLink asChild underline="always">
              <Link to="/settings/linked-accounts">{t("linked.back")}</Link>
            </TextLink>
          </p>
        </div>
      ) : (
        <StatusScreen kind="loading" />
      )}
    </Page>
  );
}
