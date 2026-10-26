import { type UseQueryResult, useQuery } from "@tanstack/react-query";
import { Link as RouterLink } from "@tanstack/react-router";
import type {
  Agent,
  AgentAdminsView,
  AgentDetail,
  AgentListItem,
  AgentSummary,
  ListCredentialBindingsResponse,
} from "@werft-ai/contracts";
import { useAgentPlatform } from "@werft-ai/react";
import {
  Avatar,
  avatarInitials,
  avatarTone,
  Badge,
  Card,
  CardAction,
  CardContent,
  CardFooter,
  CardHeader,
  CardTitle,
  cn,
  linkVariants,
  Skeleton,
  StatusDot,
  Text,
} from "@werft-ai/ui";
import { ArrowRight } from "lucide-react";
import type { ReactNode } from "react";
import { agentAdminsQuery, agentQuery } from "../api/queries.ts";
import { useI18n } from "../i18n/i18n.tsx";
import { credentialBindingsQuery } from "../routes/agent-detail/credentials.tsx";
import { AgentStateBadge, agentState } from "./agent-state.tsx";
import { OPENS_ROW, ROW_LINK } from "./row-link.ts";
import { useSeen } from "./seen.ts";

/** The design's cards: what each agent is and what it still needs. */
export function AgentCards({
  agents,
}: {
  readonly agents: readonly AgentListItem[];
}) {
  return (
    <ul className="m-0 grid list-none grid-cols-1 gap-4 p-0 md:grid-cols-2 xl:grid-cols-3">
      {agents.map((agent) => (
        <AgentCardItem key={agent.id} agent={agent} />
      ))}
    </ul>
  );
}

/** One value a card shows, read with the list or on its own. */
type Part<T> = Pick<UseQueryResult<T>, "data" | "isError" | "isPending">;

interface Facts {
  /** The version people talk to, or the newest draft before any release. */
  readonly version: AgentSummary["version"] | undefined;
  readonly runtime_profile_id: string | null;
}

function ready<T>(data: T): Part<T> {
  return { data, isError: false, isPending: false };
}

function AgentCardItem({ agent }: { readonly agent: AgentListItem }) {
  const summary = agent.summary;
  if (!summary) return <ReadingCard agent={agent} />;
  return (
    <li className="flex">
      <AgentCard
        agent={agent}
        facts={ready({
          version: summary.version,
          runtime_profile_id: summary.runtime_profile_id,
        })}
        bound={ready(summary.bound_credential_refs)}
        admins={ready(summary.admins)}
      />
    </li>
  );
}

/**
 * A list without summaries (the agents a person administers) has no card
 * fields, so each card reads three more resources: the agent, its admins and
 * its credential bindings. Only a card that has come into view reads them,
 * so a long list does not fire three requests per agent to draw one screen.
 * The keys are the detail screen's, so opening an agent reuses what its card
 * read.
 */
function ReadingCard({ agent }: { readonly agent: Agent }) {
  const { client } = useAgentPlatform();
  const [ref, seen] = useSeen<HTMLLIElement>();
  // A card scrolled past stays subscribed, so coming back to the window or
  // the network would read all three again for every card seen.
  const options = {
    enabled: seen,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  };
  const facts = useQuery({
    ...agentQuery(client, agent.id),
    ...options,
    select: factsOf,
  });
  const admins = useQuery({
    ...agentAdminsQuery(client, agent.id),
    ...options,
    select: adminNames,
  });
  const bound = useQuery({
    ...credentialBindingsQuery(client, agent.id),
    ...options,
    select: liveRefs,
  });
  return (
    <li ref={ref} className="flex">
      <AgentCard agent={agent} facts={facts} bound={bound} admins={admins} />
    </li>
  );
}

function factsOf(data: AgentDetail): Facts {
  const version =
    data.versions.find((v) => v.id === data.active_release?.version_id) ??
    data.versions.at(-1);
  return {
    version: version && {
      version_no: version.version_no,
      role: version.card.role,
      instructions: version.card.instructions,
      mcp_servers: (version.card.capabilities.mcp ?? []).map((m) => m.server),
      credential_refs: version.card.capabilities.credential_refs ?? [],
    },
    runtime_profile_id: data.active_release?.runtime_profile_id ?? null,
  };
}

function liveRefs(page: ListCredentialBindingsResponse) {
  return page.items
    .filter((binding) => binding.revoked_at === null)
    .map((binding) => binding.credential_ref);
}

function adminNames(view: AgentAdminsView) {
  return [
    ...view.users.map((user) => user.display_name ?? user.email),
    ...view.teams.map((team) => team.name),
  ];
}

function AgentCard({
  agent,
  facts,
  bound,
  admins,
}: {
  readonly agent: Agent;
  readonly facts: Part<Facts>;
  readonly bound: Part<readonly string[]>;
  readonly admins: Part<readonly string[]>;
}) {
  const { t } = useI18n();
  const version = facts.data?.version;
  const released = agentState(agent) === "active" && version !== undefined;

  return (
    <Card className={cn("w-full", OPENS_ROW)} data-agent={agent.slug}>
      <CardHeader>
        <div className="flex min-w-0 items-center gap-3">
          <AgentAvatar name={agent.name} />
          <div className="flex min-w-0 flex-col gap-1">
            <CardTitle className="[overflow-wrap:anywhere]">
              <RouterLink
                to="/agents/$id"
                params={{ id: agent.id }}
                className={cn("text-foreground no-underline", ROW_LINK)}
              >
                {agent.name}
              </RouterLink>
            </CardTitle>
            <Text
              as="span"
              variant="sub"
              mono
              truncate
              title={agent.slug}
              // Above the card's stretched link, so the hover reaches the title.
              className="relative z-1"
            >
              <span className="sr-only">{t("agents.slug")} </span>
              {agent.slug}
            </Text>
          </div>
        </div>
        <CardAction>
          {released ? (
            <Badge variant="green" data-state="active">
              {t("agents.cards.released", { version: version.version_no })}
            </Badge>
          ) : (
            <AgentStateBadge agent={agent} />
          )}
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-1 flex-col gap-3">
        {/* Two lines whether read or not, so the card never grows as it loads. */}
        <div className="h-[2lh] text-control">
          <Detail query={facts} lines={2}>
            {version ? (
              <p className="m-0 line-clamp-2">{version.role}</p>
            ) : null}
          </Detail>
        </div>
        <div className="flex flex-col gap-1 rounded-control bg-muted px-3 py-2">
          <span className="text-caption text-muted-foreground">
            {t("agents.cards.instructions")}
          </span>
          <div className="h-[2lh] text-control">
            <Detail query={facts} lines={2}>
              {version ? (
                <p className="m-0 line-clamp-2 [overflow-wrap:anywhere]">
                  {version.instructions}
                </p>
              ) : null}
            </Detail>
          </div>
        </div>
        <dl className="m-0 grid grid-cols-[minmax(0,auto)_minmax(0,1fr)] gap-x-4 gap-y-2 text-control">
          <Fact term={t("agents.cards.profile")}>
            <Detail query={facts}>
              {facts.data
                ? (facts.data.runtime_profile_id ??
                  t("agents.cards.notReleased"))
                : null}
            </Detail>
          </Fact>
          <Fact term={t("agents.cards.mcp")}>
            <Detail query={facts}>
              {facts.data ? (
                <Names
                  names={version?.mcp_servers ?? []}
                  none={t("agent.panel.none")}
                />
              ) : null}
            </Detail>
          </Fact>
          <Fact term={t("agents.cards.credentials")}>
            {/* What the card asks for and what is bound: both must answer. */}
            <Detail query={[facts, bound]}>
              {bound.data && version ? (
                <CredentialNeed
                  refs={version.credential_refs}
                  bound={bound.data}
                />
              ) : null}
            </Detail>
          </Fact>
        </dl>
      </CardContent>
      <CardFooter className="justify-between gap-3 border-t pt-4 text-control">
        <span className="min-w-0 truncate text-muted-foreground">
          {t("agents.cards.admins")}{" "}
          <Detail query={admins} inline>
            {admins.data
              ? admins.data.length === 0
                ? t("agent.panel.none")
                : admins.data.join(", ")
              : null}
          </Detail>
        </span>
        {/* The card's name link opens it; this only says so, once. */}
        <span
          aria-hidden="true"
          className={cn(
            linkVariants(),
            "inline-flex shrink-0 items-center gap-1",
          )}
        >
          {t("agents.cards.open")}
          <ArrowRight className="size-4" />
        </span>
      </CardFooter>
    </Card>
  );
}

type Read = Part<unknown>;

/**
 * One value read per agent: a placeholder until it is read, a dash when it
 * failed, so a slow or refused answer never breaks the card.
 */
function Detail({
  query,
  lines = 1,
  inline = false,
  children,
}: {
  readonly query: Read | readonly Read[];
  readonly lines?: number;
  /** In a line of text, where a block placeholder would add a line. */
  readonly inline?: boolean;
  readonly children: ReactNode;
}) {
  const { t } = useI18n();
  const queries: readonly Read[] = Array.isArray(query) ? query : [query];
  if (queries.some((q) => q.isError))
    return (
      <span className="text-muted-foreground">
        <span aria-hidden="true">—</span>
        <span className="sr-only">{t("agents.cards.unavailable")}</span>
      </span>
    );
  if (queries.some((q) => q.isPending))
    return (
      // As tall as the lines of text it stands for, not its thinner bars.
      <span
        className={cn(
          "items-center",
          inline ? "inline-flex w-24 align-top" : "flex",
        )}
        style={{ height: `${lines}lh` }}
      >
        <Skeleton
          className="w-full"
          lines={lines}
          label={t("status.loading.title")}
        />
      </span>
    );
  return <>{children}</>;
}

function Fact({
  term,
  children,
}: {
  readonly term: string;
  readonly children: ReactNode;
}) {
  return (
    <>
      <dt className="text-muted-foreground">{term}</dt>
      {/* One line, at least a badge tall, whether read or not. */}
      <dd className="m-0 min-h-5 min-w-0 truncate text-right">{children}</dd>
    </>
  );
}

function Names({
  names,
  none,
}: {
  readonly names: readonly string[];
  readonly none: string;
}) {
  if (names.length === 0) return <>{none}</>;
  return (
    // A card names one MCP server today; a long name is cut, not pushed off
    // the card, and reads in full on hover and to a screen reader. The chip
    // sits above the card's link so the hover reaches its title.
    <span className="flex flex-wrap justify-end gap-1">
      {names.map((name) => (
        <Badge
          key={name}
          variant="gray"
          className="relative z-1 min-w-0 max-w-full shrink font-mono"
          title={name}
        >
          <span className="truncate">{name}</span>
        </Badge>
      ))}
    </span>
  );
}

/**
 * Which names the card asks for and no live binding holds. Whether a bound
 * credential still works is not reported, so a bound one is "connected", not
 * "healthy".
 */
export function CredentialNeed({
  refs,
  bound,
}: {
  readonly refs: readonly string[];
  readonly bound: readonly string[];
}) {
  const { t } = useI18n();
  const missing = refs.filter((ref) => !bound.includes(ref)).length;
  return (
    <span className="inline-flex items-center gap-2">
      <StatusDot status={missing > 0 ? "failed" : "done"} />
      {refs.length === 0
        ? t("agents.cards.credentialsNone")
        : missing > 0
          ? t("agents.cards.credentialsMissing", { count: missing })
          : t("agents.cards.credentialsBound", { count: refs.length })}
    </span>
  );
}

/** The design's 32px square initials mark, one colour per name. */
export function AgentAvatar({ name }: { readonly name: string }) {
  return (
    <Avatar
      size="lg"
      shape="square"
      tone={avatarTone(name)}
      initials={avatarInitials(name)}
    />
  );
}
