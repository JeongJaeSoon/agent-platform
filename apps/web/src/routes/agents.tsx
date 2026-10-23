import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { type ApiError, isApiError } from "@werft-ai/client";
import type { Agent } from "@werft-ai/contracts";
import { useAgentPlatform } from "@werft-ai/react";
import {
  Badge,
  Button,
  buttonVariants,
  cn,
  EmptyState,
  formatTimestamp,
  RowLines,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@werft-ai/ui";
import { LayoutGrid, List } from "lucide-react";
import { administeredAgentsQuery, agentsQuery } from "../api/queries.ts";
import {
  permissionReason,
  ReasonButton,
  useHasPermission,
  useMe,
  useRole,
} from "../auth/guard.tsx";
import {
  ADMINISTERED_LIST_LIMIT,
  AdministeredAgents,
} from "../components/agent-admins.tsx";
import { AgentCards } from "../components/agent-cards.tsx";
import { AgentStateBadge } from "../components/agent-state.tsx";
import {
  AGENT_VIEWS,
  type AgentView,
  useAgentView,
} from "../components/agent-view.ts";
import { LoadFailure } from "../components/load-failure.tsx";
import { NewAgentFlow } from "../components/new-agent-flow.tsx";
import { Page } from "../components/page.tsx";
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
  const agents = useQuery(agentsQuery(client));
  // Making an agent needs less than listing them all: a member makes one and
  // becomes its admin.
  const reason = useHasPermission("agent.create")
    ? undefined
    : permissionReason(t, "agent.create", role);
  const failed = agents.isError && !isApiError(agents.error, "FORBIDDEN");

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
      {agents.isPending ? (
        <StatusScreen kind="loading" />
      ) : agents.error ? (
        isApiError(agents.error, "FORBIDDEN") ? (
          <>
            <p className="web-page__intro">{t("agents.listWithheld")}</p>
            <AdministeredAgents showEmpty />
          </>
        ) : (
          <LoadFailure
            error={agents.error}
            onRetry={() => void agents.refetch()}
          />
        )
      ) : (
        <AgentList agents={agents.data.items} />
      )}
    </Page>
  );
}

const VIEW_ICON = { cards: LayoutGrid, table: List } as const;

/** The design's two tabs, each shown as cards or as the table. */
function AgentList({ agents }: { readonly agents: readonly Agent[] }) {
  const { t } = useI18n();
  const { client } = useAgentPlatform();
  const principal = useMe()?.principal;
  const [view, setView] = useAgentView(
    principal?.kind === "user" ? principal.id : undefined,
  );
  const administered = useQuery(administeredAgentsQuery(client));
  // The server stops at this many, so a full page may have left some out.
  const truncated =
    (administered.data?.items.length ?? 0) >= ADMINISTERED_LIST_LIMIT;
  return (
    <Tabs defaultValue="all" className="gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <TabsList>
          <TabsTrigger value="all">
            {t("agents.tabs.all")}
            <Badge variant="gray">{agents.length}</Badge>
          </TabsTrigger>
          <TabsTrigger value="administered">
            {t("agents.tabs.administered")}
            {administered.data ? (
              <Badge variant="gray">
                {truncated
                  ? `${ADMINISTERED_LIST_LIMIT}+`
                  : administered.data.items.length}
              </Badge>
            ) : null}
          </TabsTrigger>
        </TabsList>
        <fieldset className="m-0 inline-flex min-w-0 gap-1 border-0 p-0">
          <legend className="sr-only">{t("agents.view.label")}</legend>
          {AGENT_VIEWS.map((option) => {
            const Icon = VIEW_ICON[option];
            return (
              <Button
                key={option}
                type="button"
                size="sm"
                variant={view === option ? "secondary" : "ghost"}
                aria-pressed={view === option}
                onClick={() => setView(option)}
              >
                <Icon aria-hidden="true" />
                {t(`agents.view.${option}`)}
              </Button>
            );
          })}
        </fieldset>
      </div>
      <TabsContent value="all">
        {agents.length === 0 ? (
          <EmptyState title={t("agents.empty")} />
        ) : (
          <AgentsIn view={view} agents={agents} />
        )}
      </TabsContent>
      <TabsContent value="administered">
        {administered.isPending ? (
          <StatusScreen kind="loading" />
        ) : administered.error ? (
          <LoadFailure
            error={administered.error}
            onRetry={() => void administered.refetch()}
          />
        ) : administered.data.items.length === 0 ? (
          <EmptyState title={t("agentAdmins.mine.empty")} />
        ) : (
          <>
            {truncated ? (
              <p className="m-0 mb-3 text-caption text-muted-foreground">
                {t("agentAdmins.mine.truncated", {
                  count: ADMINISTERED_LIST_LIMIT,
                })}
              </p>
            ) : null}
            <AgentsIn view={view} agents={administered.data.items} />
          </>
        )}
      </TabsContent>
    </Tabs>
  );
}

function AgentsIn({
  view,
  agents,
}: {
  readonly view: AgentView;
  readonly agents: readonly Agent[];
}) {
  return view === "cards" ? (
    <AgentCards agents={agents} />
  ) : (
    <AgentTable agents={agents} />
  );
}

function AgentTable({ agents }: { readonly agents: readonly Agent[] }) {
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
            <TableRow key={agent.id}>
              <TableCell>
                <RowLines>
                  <Link
                    to="/agents/$id"
                    params={{ id: agent.id }}
                    className="font-medium text-primary underline-offset-2 hover:underline [overflow-wrap:anywhere]"
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
