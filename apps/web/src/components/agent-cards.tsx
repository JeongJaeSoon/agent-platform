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
  Badge,
  Card,
  CardAction,
  CardContent,
  CardFooter,
  CardHeader,
  CardTitle,
  cn,
  Link,
  Skeleton,
} from "@werft-ai/ui";
import { ArrowRight } from "lucide-react";
import type { ReactNode } from "react";
import { agentAdminsQuery, agentQuery } from "../api/queries.ts";
import { useI18n } from "../i18n/i18n.tsx";
import { credentialBindingsQuery } from "../routes/agent-detail/credentials.tsx";
import { AgentStateBadge, agentState } from "./agent-state.tsx";
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
const CARD_STALE_MS = 60_000;

function AgentCardItem({ agent }: { readonly agent: Agent }) {
  const { client } = useAgentPlatform();
  const [ref, seen] = useSeen<HTMLLIElement>();
  // A card scrolled past stays subscribed; without a stale time, coming
  // back to the window would read all three again for every card seen.
  const options = { enabled: seen, staleTime: CARD_STALE_MS };
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
        {/* Two lines whether read or not, so the card never grows as it loads. */}
        <div className="h-[2lh] text-body">
          <Detail query={detail} lines={2}>
            {card ? <p className="m-0 line-clamp-2">{card.role}</p> : null}
          </Detail>
        </div>
        <div className="flex flex-col gap-1 rounded-control bg-muted px-3 py-2">
          <span className="text-caption text-muted-foreground">
            {t("agentCard.instructions")}
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
          <Fact term={t("agents.cards.waiting")}>
            <Unmeasured />
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
          <Fact term={t("agents.cards.skills")}>
            <Unmeasured />
          </Fact>
        </dl>
      </CardContent>
      <CardFooter className="justify-between gap-3 border-t pt-4 text-control">
        <span className="min-w-0 truncate text-muted-foreground">
          {t("agent.tabs.admins")}{" "}
          <Detail query={admins} inline>
            {admins.data
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
    // One row like every other value; the clipped names are still read out,
    // and the detail screen lists them in full.
    <span className="flex gap-1 overflow-hidden [justify-content:safe_flex-end]">
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
      className="grid size-8 flex-none place-items-center rounded-control bg-active font-semibold text-caption text-muted-foreground"
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
