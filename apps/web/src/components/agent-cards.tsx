import { type UseQueryResult, useQuery } from "@tanstack/react-query";
import { Link as RouterLink } from "@tanstack/react-router";
import type {
  Agent,
  AgentAdminsView,
  AgentDetail,
  ListCredentialBindingsResponse,
} from "@werft-ai/contracts";
import { useAgentPlatform } from "@werft-ai/react";
import {
  Avatar,
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
export function AgentCards({ agents }: { readonly agents: readonly Agent[] }) {
  return (
    <ul className="m-0 grid list-none grid-cols-1 gap-4 p-0 md:grid-cols-2 xl:grid-cols-3">
      {agents.map((agent) => (
        <AgentCardItem key={agent.id} agent={agent} />
      ))}
    </ul>
  );
}

/**
 * The list has no card fields, so each card reads three more resources:
 * the agent, its admins and its credential bindings. Only a card that has
 * come into view reads them, so a long list does not fire three requests per
 * agent to draw one screen. The keys are the detail screen's, so opening an
 * agent reuses what its card read.
 */
function AgentCardItem({ agent }: { readonly agent: Agent }) {
  const { client } = useAgentPlatform();
  const [ref, seen] = useSeen<HTMLLIElement>();
  // A card scrolled past stays subscribed, so coming back to the window or
  // the network would read all three again for every card seen.
  const options = {
    enabled: seen,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  };
  const detail = useQuery({ ...agentQuery(client, agent.id), ...options });
  const admins = useQuery({
    ...agentAdminsQuery(client, agent.id),
    ...options,
  });
  const bindings = useQuery({
    ...credentialBindingsQuery(client, agent.id),
    ...options,
  });
  return (
    <li ref={ref} className="flex">
      <AgentCard
        agent={agent}
        detail={detail}
        admins={admins}
        bindings={bindings}
      />
    </li>
  );
}

function AgentCard({
  agent,
  detail,
  admins,
  bindings,
}: {
  readonly agent: Agent;
  readonly detail: UseQueryResult<AgentDetail>;
  readonly admins: UseQueryResult<AgentAdminsView>;
  readonly bindings: UseQueryResult<ListCredentialBindingsResponse>;
}) {
  const { t } = useI18n();
  const data = detail.data;
  // The version people talk to, or the newest draft before any release.
  const version =
    data?.versions.find((v) => v.id === data.active_release?.version_id) ??
    data?.versions.at(-1);
  const card = version?.card;
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
            <span className="font-mono text-caption text-muted-foreground [overflow-wrap:anywhere]">
              <span className="sr-only">{t("agents.slug")} </span>
              {agent.slug}
            </span>
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
          <Detail query={detail} lines={2}>
            {card ? <p className="m-0 line-clamp-2">{card.role}</p> : null}
          </Detail>
        </div>
        <div className="flex flex-col gap-1 rounded-control bg-muted px-3 py-2">
          <span className="text-caption text-muted-foreground">
            {t("agents.cards.instructions")}
          </span>
          <div className="h-[2lh] text-control">
            <Detail query={detail} lines={2}>
              {card ? (
                <p className="m-0 line-clamp-2 [overflow-wrap:anywhere]">
                  {card.instructions}
                </p>
              ) : null}
            </Detail>
          </div>
        </div>
        <dl className="m-0 grid grid-cols-[minmax(0,auto)_minmax(0,1fr)] gap-x-4 gap-y-2 text-control">
          <Fact term={t("agents.cards.profile")}>
            <Detail query={detail}>
              {data
                ? (data.active_release?.runtime_profile_id ??
                  t("agents.cards.notReleased"))
                : null}
            </Detail>
          </Fact>
          <Fact term={t("agents.cards.mcp")}>
            <Detail query={detail}>
              {data ? (
                <Names
                  names={(card?.capabilities.mcp ?? []).map((m) => m.server)}
                  none={t("agent.panel.none")}
                />
              ) : null}
            </Detail>
          </Fact>
          <Fact term={t("agents.cards.credentials")}>
            {/* What the card asks for and what is bound: both must answer. */}
            <Detail query={[detail, bindings]}>
              {bindings.data && card ? (
                <CredentialNeed
                  refs={card.capabilities.credential_refs ?? []}
                  bound={bindings.data.items
                    .filter((binding) => binding.revoked_at === null)
                    .map((binding) => binding.credential_ref)}
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
              ? adminNames(admins.data, t("agent.panel.none"))
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

type Read = UseQueryResult<unknown>;

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
function CredentialNeed({
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

function adminNames(view: AgentAdminsView, none: string) {
  const names = [
    ...view.users.map((user) => user.display_name ?? user.email),
    ...view.teams.map((team) => team.name),
  ];
  return names.length === 0 ? none : names.join(", ");
}

/** The design's 32px square initials mark, one colour per name. */
export function AgentAvatar({ name }: { readonly name: string }) {
  return (
    <Avatar
      size="lg"
      shape="square"
      tone={avatarTone(name)}
      initials={initials(name)}
    />
  );
}

/** The same name gets the same colour on every screen and visit. */
export function avatarTone(key: string): 1 | 2 | 3 | 4 {
  let sum = 0;
  for (const char of key) sum += char.codePointAt(0) ?? 0;
  return ((sum % 4) + 1) as 1 | 2 | 3 | 4;
}

/** Up to two letters: the first of the first two words, or the first two. */
export function initials(name: string) {
  const words = name.trim().split(/\s+/).filter(Boolean);
  const letters =
    words.length > 1
      ? [...(words[0] ?? "")]
          .slice(0, 1)
          .concat([...(words[1] ?? "")].slice(0, 1))
      : [...(words[0] ?? "")].slice(0, 2);
  return letters.join("").toUpperCase();
}
