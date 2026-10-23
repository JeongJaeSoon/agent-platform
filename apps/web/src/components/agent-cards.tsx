import { type UseQueryResult, useQueries } from "@tanstack/react-query";
import { Link as RouterLink } from "@tanstack/react-router";
import type {
  Agent,
  AgentAdminsView,
  AgentDetail,
  ListCredentialBindingsResponse,
} from "@werft-ai/contracts";
import { useAgentPlatform } from "@werft-ai/react";
import {
  Badge,
  Card,
  CardAction,
  CardContent,
  CardFooter,
  CardHeader,
  CardTitle,
  Link,
  Skeleton,
} from "@werft-ai/ui";
import { ArrowRight } from "lucide-react";
import type { ReactNode } from "react";
import { agentAdminsQuery, agentQuery } from "../api/queries.ts";
import { useI18n } from "../i18n/i18n.tsx";
import { credentialBindingsQuery } from "../routes/agent-detail/credentials.tsx";
import { AgentStateBadge, agentState } from "./agent-state.tsx";

/**
 * The list has no card fields, so each card reads three more resources:
 * the agent, its admins and its credential bindings. Past this many agents
 * the cards show only what the list holds, so a large workspace does not
 * fire hundreds of requests to draw one screen.
 */
export const CARD_DETAIL_LIMIT = 12;

/** The design's cards: what each agent is and what it still needs. */
export function AgentCards({ agents }: { readonly agents: readonly Agent[] }) {
  const { t } = useI18n();
  const { client } = useAgentPlatform();
  const detailed = agents.slice(0, CARD_DETAIL_LIMIT);
  const details = useQueries({
    queries: detailed.map((agent) => agentQuery(client, agent.id)),
  });
  const admins = useQueries({
    queries: detailed.map((agent) => agentAdminsQuery(client, agent.id)),
  });
  const bindings = useQueries({
    queries: detailed.map((agent) => credentialBindingsQuery(client, agent.id)),
  });
  return (
    <>
      {agents.length > CARD_DETAIL_LIMIT ? (
        <p className="m-0 text-caption text-muted-foreground">
          {t("agents.cards.limited", { count: CARD_DETAIL_LIMIT })}
        </p>
      ) : null}
      <ul className="m-0 grid list-none grid-cols-1 gap-4 p-0 md:grid-cols-2 xl:grid-cols-3">
        {agents.map((agent, index) => (
          <li key={agent.id} className="flex">
            <AgentCard
              agent={agent}
              detail={details[index]}
              admins={admins[index]}
              bindings={bindings[index]}
            />
          </li>
        ))}
      </ul>
    </>
  );
}

function AgentCard({
  agent,
  detail,
  admins,
  bindings,
}: {
  readonly agent: Agent;
  readonly detail: UseQueryResult<AgentDetail> | undefined;
  readonly admins: UseQueryResult<AgentAdminsView> | undefined;
  readonly bindings: UseQueryResult<ListCredentialBindingsResponse> | undefined;
}) {
  const { t } = useI18n();
  const data = detail?.data;
  // The version people talk to, or the newest draft before any release.
  const version =
    data?.versions.find((v) => v.id === data.active_release?.version_id) ??
    data?.versions.at(-1);
  const card = version?.card;
  const released = agentState(agent) === "active" && version !== undefined;

  return (
    <Card className="w-full" data-agent={agent.slug}>
      <CardHeader>
        <div className="flex min-w-0 items-center gap-3">
          <AgentAvatar name={agent.name} />
          <div className="flex min-w-0 flex-col gap-1">
            <CardTitle className="[overflow-wrap:anywhere]">
              <Link asChild>
                <RouterLink to="/agents/$id" params={{ id: agent.id }}>
                  {agent.name}
                </RouterLink>
              </Link>
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
        <Detail query={detail} lines={2}>
          {card ? <p className="m-0 text-body">{card.role}</p> : null}
        </Detail>
        <div className="flex flex-col gap-1 rounded-control bg-muted px-3 py-2">
          <span className="text-caption text-muted-foreground">
            {t("agentCard.instructions")}
          </span>
          <Detail query={detail} lines={2}>
            {card ? (
              <p className="m-0 line-clamp-2 text-control [overflow-wrap:anywhere]">
                {card.instructions}
              </p>
            ) : null}
          </Detail>
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
          <Fact term={t("agents.cards.waiting")}>
            <Unmeasured />
          </Fact>
          <Fact term={t("agents.cards.credentials")}>
            {/* What the card asks for and what is bound: both must answer. */}
            <Detail query={[detail, bindings]}>
              {bindings?.data && card ? (
                <CredentialNeed
                  refs={card.capabilities.credential_refs ?? []}
                  bound={bindings.data.items
                    .filter((binding) => binding.revoked_at === null)
                    .map((binding) => binding.credential_ref)}
                />
              ) : null}
            </Detail>
          </Fact>
          <Fact term={t("agents.cards.skills")}>
            <Unmeasured />
          </Fact>
        </dl>
      </CardContent>
      <CardFooter className="justify-between gap-3 border-t pt-4 text-control">
        <span className="min-w-0 text-muted-foreground [overflow-wrap:anywhere]">
          {t("agent.tabs.admins")}{" "}
          <Detail query={admins}>
            {admins?.data
              ? adminNames(admins.data, t("agent.panel.none"))
              : null}
          </Detail>
        </span>
        <Link asChild className="inline-flex shrink-0 items-center gap-1">
          <RouterLink to="/agents/$id" params={{ id: agent.id }}>
            <span className="sr-only">{agent.name} </span>
            {t("agents.cards.open")}
            <ArrowRight aria-hidden="true" className="size-4" />
          </RouterLink>
        </Link>
      </CardFooter>
    </Card>
  );
}

type Read = UseQueryResult<unknown> | undefined;

/**
 * One value read per agent: a placeholder while it loads, a dash when it
 * failed or past the limit, so a slow or refused answer never breaks the card.
 */
function Detail({
  query,
  lines = 1,
  children,
}: {
  readonly query: Read | readonly Read[];
  readonly lines?: number;
  readonly children: ReactNode;
}) {
  const { t } = useI18n();
  const queries: readonly Read[] = Array.isArray(query) ? query : [query];
  if (queries.some((q) => q === undefined || q.isError))
    return (
      <span className="text-muted-foreground">
        <span aria-hidden="true">—</span>
        <span className="sr-only">{t("agents.cards.unavailable")}</span>
      </span>
    );
  if (queries.some((q) => q?.isPending))
    return <Skeleton lines={lines} label={t("status.loading.title")} />;
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
      <dd className="m-0 min-w-0 text-right [overflow-wrap:anywhere]">
        {children}
      </dd>
    </>
  );
}

/** What the API does not report yet: said so, never a made-up value. */
function Unmeasured() {
  const { t } = useI18n();
  return (
    <span className="text-muted-foreground">
      {t("agents.cards.unmeasured")}
    </span>
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
    <span className="inline-flex flex-wrap justify-end gap-1">
      {names.map((name) => (
        <Badge key={name} variant="gray" className="font-mono">
          {name}
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
  if (refs.length === 0) return <>{t("agents.cards.credentialsNone")}</>;
  const missing = refs.filter((ref) => !bound.includes(ref)).length;
  return missing > 0 ? (
    <Badge variant="red">
      {t("agents.cards.credentialsMissing", { count: missing })}
    </Badge>
  ) : (
    t("agents.cards.credentialsBound", { count: refs.length })
  );
}

function adminNames(view: AgentAdminsView, none: string) {
  const names = [
    ...view.users.map((user) => user.display_name ?? user.email),
    ...view.teams.map((team) => team.name),
  ];
  return names.length === 0 ? none : names.join(", ");
}

/**
 * The design's 32px square initials mark (console v4 `.avatar.lg.sq`).
 * Stands in until @werft-ai/ui has an Avatar.
 */
export function AgentAvatar({ name }: { readonly name: string }) {
  return (
    <span
      aria-hidden="true"
      className="grid size-8 flex-none place-items-center rounded-control bg-accent font-semibold text-caption text-muted-foreground"
    >
      {initials(name)}
    </span>
  );
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
