import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { type ApiError, isApiError } from "@werft-ai/client";
import type { Agent } from "@werft-ai/contracts";
import { useAgentPlatform } from "@werft-ai/react";
import {
  Badge,
  type BadgeProps,
  buttonVariants,
  cn,
  formatTimestamp,
} from "@werft-ai/ui";
import { agentsQuery } from "../api/queries.ts";
import {
  permissionReason,
  ReasonButton,
  useHasPermission,
  useRole,
} from "../auth/guard.tsx";
import { AdministeredAgents } from "../components/agent-admins.tsx";
import { LoadFailure } from "../components/load-failure.tsx";
import { NewAgentFlow } from "../components/new-agent-flow.tsx";
import { Page } from "../components/page.tsx";
import { StatusScreen } from "../components/status-screen.tsx";
import {
  RowLines,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../components/table.tsx";
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
  const { t, locale } = useI18n();
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
      // The top bar's "new" makes an agent; who may not, sees why here.
      actions={
        failed || reason === undefined ? undefined : (
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
      ) : agents.data.items.length === 0 ? (
        <p className="web-page__empty">{t("agents.empty")}</p>
      ) : (
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
              {agents.data.items.map((agent) => (
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
      )}
    </Page>
  );
}

// Shrinks the column to its content so the name column takes the rest.
const FIT = "w-px whitespace-nowrap";
const WIDE = "hidden @[480px]:table-cell";
// The hidden time column is still the DOM's last cell, so below 480px the
// state cell takes the outer inset itself.
const LAST_WHEN_NARROW =
  "pr-[var(--ap-row-padding-x)] @[480px]:pr-[calc(var(--ap-row-padding-x)/2)]";

type AgentState = "draft" | Agent["status"];
type AgentSummary = Pick<Agent, "status" | "active_release_id">;

/** An agent never released is a draft, whatever its status; archived wins. */
export function agentState(agent: AgentSummary): AgentState {
  if (agent.status === "archived") return "archived";
  return agent.active_release_id === null ? "draft" : agent.status;
}

const STATE_VARIANT = {
  draft: "gray",
  active: "green",
  paused: "gray",
  archived: "gray",
} as const satisfies Record<AgentState, BadgeProps["variant"]>;

function AgentStateBadge({ agent }: { readonly agent: AgentSummary }) {
  const { t } = useI18n();
  const state = agentState(agent);
  return (
    <Badge
      variant={STATE_VARIANT[state]}
      data-state={state}
      className={state === "archived" ? "text-muted-foreground" : undefined}
    >
      {state === "draft"
        ? t("agents.state.draft")
        : t(`agents.status.${state}`)}
    </Badge>
  );
}

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
