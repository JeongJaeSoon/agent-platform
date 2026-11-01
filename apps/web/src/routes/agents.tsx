import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { type ApiError, isApiError } from "@werft-ai/client";
import type {
  Agent,
  AgentListItem,
  CountAgentsResponse,
} from "@werft-ai/contracts";
import { useAgentPlatform } from "@werft-ai/react";
import { ListToolbar, ListViewSwitch } from "@werft-ai/react/components";
import {
  Button,
  buttonVariants,
  cn,
  EmptyState,
  formatTimestamp,
  Page,
  RowLines,
  SegmentedControl,
  SegmentedControlItem,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@werft-ai/ui";
import { LayoutGrid, List } from "lucide-react";
import { useRef, useState } from "react";
import {
  administeredAgentsQuery,
  agentCountsQuery,
  agentPagesQuery,
} from "../api/queries.ts";
import {
  permissionReason,
  useHasPermission,
  useMe,
  useRole,
} from "../auth/guard.tsx";
import { ReasonButton } from "../auth/reason-button.tsx";
import {
  ADMINISTERED_LIST_LIMIT,
  AdministeredAgents,
} from "../components/agent-admins.tsx";
import { AgentCards } from "../components/agent-cards.tsx";
import { AgentStateBadge, agentState } from "../components/agent-state.tsx";
import {
  AGENT_VIEWS,
  type AgentView,
  useAgentView,
} from "../components/agent-view.ts";
import { LoadFailure } from "../components/load-failure.tsx";
import { NewAgentFlow } from "../components/new-agent-flow.tsx";
import { PagedListFooter } from "../components/paged-list-footer.tsx";
import { OPENS_ROW, TABLE_ROW_LINK } from "../components/row-link.ts";
import { SEARCH_MAX, useSearchTerm } from "../components/search-term.ts";
import { SlackActionLink } from "../components/slack-action-link.tsx";
import { StatusScreen } from "../components/status-screen.tsx";
import { errorKey, type Translate, useI18n } from "../i18n/i18n.tsx";

// The release check's model refusal (release-ids.ts), as "<field>: <message>".
const MODEL_REFUSAL =
  /^card\.model: model (.+) is not the model of runtime profile (.+)$/;

/**
 * What a refused agent action says: a 403 in the words of the disabled
 * button, a model mismatch in our words, any other capability the profile
 * does not have with the server's reason.
 */
export function agentRefusal(
  t: Translate,
  error: ApiError,
  role: string | undefined,
): string {
  if (error.code === "FORBIDDEN")
    return permissionReason(t, "agent.manage", role);
  // Only making an agent answers this: its slug is taken.
  if (error.code === "ALREADY_EXISTS") return t("agents.slugTaken");
  if (error.code === "PROFILE_BLOCKED") {
    const details = error.details as {
      readonly reason_code?: unknown;
      readonly profile_id?: unknown;
    } | null;
    if (typeof details?.profile_id === "string")
      return t(
        details.reason_code === "base_blocked"
          ? "agent.releases.baseProfileBlocked"
          : "agent.releases.profileBlocked",
        { profile: details.profile_id },
      );
  }
  const model =
    error.code === "UNSUPPORTED_CAPABILITY"
      ? MODEL_REFUSAL.exec(error.message)
      : null;
  if (model)
    return t("agent.releases.modelRefused", {
      card: model[1] ?? "",
      profile: model[2] ?? "",
    });
  if (error.code === "UNSUPPORTED_CAPABILITY" || error.code === "BAD_REQUEST")
    return `${t(errorKey(error.code))} ${error.message}`;
  return t(errorKey(error.code));
}

export function AgentsScreen() {
  const { t } = useI18n();
  const { client } = useAgentPlatform();
  const navigate = useNavigate();
  const role = useRole();
  // The counts answer the same callers as the list, so they also say
  // whether the caller may list agents at all.
  const counts = useQuery(agentCountsQuery(client));
  // Making an agent needs less than listing them all: a member makes one and
  // becomes its admin.
  const reason = useHasPermission("agent.create")
    ? undefined
    : permissionReason(t, "agent.create", role);
  const failed = counts.isError && !isApiError(counts.error, "FORBIDDEN");

  return (
    <Page
      title={t("agents.title")}
      description={t("agents.intro")}
      actions={
        failed ? undefined : (
          <ReasonButton
            className={buttonVariants()}
            reason={reason}
            onClick={() => void navigate({ to: "/agents/new" })}
          >
            {t("agents.new")}
          </ReasonButton>
        )
      }
    >
      {counts.isPending ? (
        <StatusScreen kind="loading" />
      ) : counts.error ? (
        isApiError(counts.error, "FORBIDDEN") ? (
          <>
            <p className="web-page__intro">{t("agents.listWithheld")}</p>
            <AdministeredAgents showEmpty />
          </>
        ) : (
          <LoadFailure
            error={counts.error}
            onRetry={() => void counts.refetch()}
          />
        )
      ) : (
        <AgentList counts={counts.data.counts} />
      )}
    </Page>
  );
}

const VIEW_ICON = { cards: LayoutGrid, table: List } as const;

/**
 * The design's two lists, each shown as cards or as the table: every agent
 * a page at a time and searched on the server, or the ones the caller
 * administers, which the server caps and the page searches itself.
 */
function AgentList({
  counts,
}: {
  readonly counts: CountAgentsResponse["counts"];
}) {
  const { t } = useI18n();
  const { client } = useAgentPlatform();
  const principal = useMe()?.principal;
  const [view, setView] = useAgentView(
    principal?.kind === "user" ? principal.id : undefined,
  );
  const [scope, setScope] = useState<"all" | "administered">("all");
  const [query, setQuery] = useState("");
  const q = useSearchTerm(query);
  const pages = useInfiniteQuery({
    ...agentPagesQuery(client, q),
    enabled: scope === "all",
  });
  const administered = useQuery(administeredAgentsQuery(client));
  // The server stops at this many, so a full page may have left some out.
  const truncated =
    (administered.data?.items.length ?? 0) >= ADMINISTERED_LIST_LIMIT;
  const search = useRef<HTMLInputElement>(null);
  // The clear button goes away with the empty result, so focus returns to
  // the field it emptied.
  const clear = () => {
    setQuery("");
    search.current?.focus();
  };
  const shown =
    scope === "all"
      ? pages.data?.pages.flatMap((page) => page.items)
      : administered.data?.items.filter((agent) =>
          matchesAgentQuery(agent, query),
        );
  return (
    <div className="flex flex-col gap-4">
      <ListToolbar
        filter={
          <SegmentedControl
            aria-label={t("agents.tabs.label")}
            size="toolbar"
            value={scope}
            onValueChange={(next) => setScope(next as typeof scope)}
          >
            <SegmentedControlItem value="all" count={counts.all}>
              {t("agents.tabs.all")}
            </SegmentedControlItem>
            <SegmentedControlItem
              value="administered"
              count={counts.administered}
            >
              {t("agents.tabs.administered")}
            </SegmentedControlItem>
          </SegmentedControl>
        }
        view={
          <ListViewSwitch
            aria-label={t("agents.view.label")}
            value={view}
            onValueChange={setView}
            options={AGENT_VIEWS.map((option) => ({
              value: option,
              label: t(`agents.view.${option}`),
              icon: VIEW_ICON[option],
            }))}
          />
        }
        search={{
          ref: search,
          type: "search",
          "aria-label": t("agents.search"),
          placeholder: t("agents.search"),
          maxLength: SEARCH_MAX,
          value: query,
          onChange: (event) => setQuery(event.target.value),
        }}
      />
      {/* Outside the lists, so switching category or state keeps the same
          live region and a screen reader hears each new count. */}
      <output className="sr-only">
        {query.trim() === "" || shown === undefined
          ? ""
          : t("agents.shown", { count: shown.length })}
      </output>
      {scope === "all" ? (
        counts.all === 0 ? (
          <EmptyState title={t("agents.empty")} />
        ) : pages.isPending ? (
          <StatusScreen kind="loading" />
        ) : pages.error && !shown?.length ? (
          <LoadFailure
            error={pages.error}
            onRetry={() => void pages.refetch()}
          />
        ) : (
          <div className="flex flex-col gap-4">
            <AgentsIn view={view} agents={shown ?? []} onClear={clear} />
            <PagedListFooter list={pages} />
          </div>
        )
      ) : administered.isPending ? (
        <StatusScreen kind="loading" />
      ) : administered.error ? (
        <LoadFailure
          error={administered.error}
          onRetry={() => void administered.refetch()}
        />
      ) : administered.data.items.length === 0 ? (
        <EmptyState title={t("agentAdmins.mine.empty")} />
      ) : (
        <div>
          {truncated ? (
            <p className="m-0 mb-3 text-caption text-muted-foreground">
              {t("agentAdmins.mine.truncated", {
                count: ADMINISTERED_LIST_LIMIT,
              })}
            </p>
          ) : null}
          <AgentsIn view={view} agents={shown ?? []} onClear={clear} />
        </div>
      )}
    </div>
  );
}

/**
 * Name or slug, ignoring case, as the list API's `q` matches; for the
 * administered list, which takes no query.
 */
function matchesAgentQuery(agent: Agent, query: string) {
  const needle = query.trim().toLowerCase();
  return (
    needle === "" ||
    agent.name.toLowerCase().includes(needle) ||
    agent.slug.toLowerCase().includes(needle)
  );
}

function AgentsIn({
  view,
  agents,
  onClear,
}: {
  readonly view: AgentView;
  /** The list after the search. */
  readonly agents: readonly AgentListItem[];
  readonly onClear: () => void;
}) {
  const { t } = useI18n();
  if (agents.length === 0) {
    return (
      <EmptyState
        title={t("agents.noMatch")}
        description={t("agents.noMatchHint")}
        action={
          <Button type="button" variant="outline" size="sm" onClick={onClear}>
            {t("agents.clearSearch")}
          </Button>
        }
      />
    );
  }
  return view === "cards" ? (
    <AgentCards agents={agents} />
  ) : (
    <AgentTable agents={agents} />
  );
}

function AgentTable({ agents }: { readonly agents: readonly AgentListItem[] }) {
  const { t, locale } = useI18n();
  return (
    <div className="@container overflow-hidden rounded-card border bg-card">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead scope="col">{t("agents.column.agent")}</TableHead>
            <TableHead scope="col" className={cn(FIT, LAST_WHEN_NARROW)}>
              {t("agents.column.state")}
            </TableHead>
            <TableHead scope="col" className={cn(FIT, WIDE, "text-right")}>
              {t("agents.column.updated")}
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {agents.map((agent) => (
            <TableRow
              key={agent.id}
              inactive={agentState(agent) === "archived"}
              className={OPENS_ROW}
            >
              <TableCell>
                <RowLines>
                  <Link
                    to="/agents/$id"
                    params={{ id: agent.id }}
                    className={cn(
                      "font-medium text-link underline-offset-2 hover:underline [overflow-wrap:anywhere]",
                      TABLE_ROW_LINK,
                    )}
                  >
                    {agent.name}
                  </Link>
                  <span className="font-mono text-caption text-muted-foreground [overflow-wrap:anywhere]">
                    <span className="sr-only">{t("agents.slug")} </span>
                    {agent.slug}
                  </span>
                  <span className="text-caption text-muted-foreground @[480px]:hidden">
                    {t("agents.updated", {
                      at: formatTimestamp(agent.updated_at, locale),
                    })}
                  </span>
                  <SlackActionLink agent={agent} />
                </RowLines>
              </TableCell>
              <TableCell className={cn(FIT, LAST_WHEN_NARROW)}>
                <AgentStateBadge agent={agent} />
              </TableCell>
              <TableCell
                className={cn(
                  FIT,
                  WIDE,
                  "text-right text-caption text-muted-foreground",
                )}
              >
                <time dateTime={agent.updated_at}>
                  {formatTimestamp(agent.updated_at, locale)}
                </time>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

// Shrinks the column to its content so the name column takes the rest.
const FIT = "w-px whitespace-nowrap";
const WIDE = "hidden @[480px]:table-cell";
// The hidden time column is still the DOM's last cell, so below 480px the
// state cell takes the outer inset itself.
const LAST_WHEN_NARROW =
  "pr-[var(--ap-row-padding-x)] @[480px]:pr-[calc(var(--ap-row-padding-x)/2)]";

export { agentState } from "../components/agent-state.tsx";

/**
 * A blank card, made in steps. One-line hiring (a model drafting the card)
 * is 94S-156's and adds its button here when it lands.
 */
export function NewAgentScreen() {
  const { t } = useI18n();
  const role = useRole();
  const refuse = (error: unknown) =>
    isApiError(error) ? agentRefusal(t, error, role) : t(errorKey("UNKNOWN"));
  return (
    <Page title={t("agents.newTitle")} description={t("agents.newIntro")}>
      <NewAgentFlow refuse={refuse} />
    </Page>
  );
}
