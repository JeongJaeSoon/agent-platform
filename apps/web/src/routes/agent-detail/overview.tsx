import { useQuery } from "@tanstack/react-query";
import { Link as RouterLink } from "@tanstack/react-router";
import type { AgentDetail } from "@werft-ai/contracts";
import { useAgentPlatform } from "@werft-ai/react";
import {
  Badge,
  Button,
  Card,
  cn,
  formatTimestamp,
  Link,
  Skeleton,
} from "@werft-ai/ui";
import { Check, Copy } from "lucide-react";
import { type ReactNode, useId, useState } from "react";
import { copyText } from "../../components/copy.ts";
import { OutcomeLine } from "../../components/outcome.tsx";
import { useI18n } from "../../i18n/i18n.tsx";
import { credentialBindingsQuery } from "./credentials.tsx";
import { latestVersion } from "./versions.tsx";

// Console v4: section head 28px tall, 12px above its body.
const SECTION = "flex min-w-0 flex-col gap-3";
const SECTION_HEAD = "flex min-h-7 items-center justify-between gap-3";
const SECTION_TITLE = "m-0 font-semibold text-body leading-5";
const META = "m-0 text-caption text-muted-foreground";
const TERM = "m-0 text-muted-foreground";
const VALUE = "m-0 min-w-0 [overflow-wrap:anywhere]";

/** The version new sessions run, or the newest one before any release. */
export function shownVersion(detail: AgentDetail) {
  return (
    detail.versions.find(
      (version) => version.id === detail.active_release?.version_id,
    ) ?? latestVersion(detail)
  );
}

/** The overview's figures: what runs and what is newest. */
export function AgentGlance({ detail }: { readonly detail: AgentDetail }) {
  const { t, locale } = useI18n();
  const { agent } = detail;
  const latest = latestVersion(detail);
  const active = detail.versions.find(
    (version) => version.id === detail.active_release?.version_id,
  );
  return (
    <ul
      aria-label={t("agent.glance.label")}
      className="m-0 grid list-none grid-cols-1 items-stretch gap-4 p-0 @[720px]:grid-cols-2"
    >
      <Figure
        label={t("agent.glance.active")}
        value={
          active && agent.active_release_id
            ? t("agent.versionLabel", { version: active.version_no })
            : t("agent.glance.none")
        }
        muted={!active}
        note={
          detail.active_release
            ? t("agent.glance.activeNote", {
                profile: detail.active_release.runtime_profile_id,
              })
            : t("agent.overview.notActive")
        }
      />
      <Figure
        label={t("agent.glance.latest")}
        value={
          latest
            ? t("agent.versionLabel", { version: latest.version_no })
            : t("agent.glance.none")
        }
        muted={!latest}
        note={
          latest
            ? `${formatTimestamp(latest.created_at, locale)} · ${
                active && latest.id !== active.id
                  ? t("agent.overview.newerVersion", {
                      latest: latest.version_no,
                      active: active.version_no,
                    })
                  : active
                    ? t("agent.overview.upToDate")
                    : t("agent.glance.latestDraft")
              }`
            : t("agent.noActive")
        }
      />
    </ul>
  );
}

function Figure({
  label,
  value,
  muted,
  note,
}: {
  readonly label: string;
  readonly value: string;
  readonly muted: boolean;
  readonly note: string;
}) {
  return (
    <li className="min-w-0">
      <Card className="h-full gap-3 p-4">
        <p className="m-0 flex items-center gap-2 text-control text-muted-foreground">
          {label}
        </p>
        <p
          className={cn(
            "m-0 font-semibold text-number tabular-nums tracking-[-0.5px]",
            muted && "text-muted-foreground",
          )}
        >
          {value}
        </p>
        <p className={META}>{note}</p>
      </Card>
    </li>
  );
}

type StepState = "done" | "todo";

/**
 * What stands between the agent and new sessions: credentials, a release,
 * the activation. The first open step offers the release tab, where all
 * three are done.
 */
export function AgentReadiness({
  detail,
  toRelease,
}: {
  readonly detail: AgentDetail;
  readonly toRelease: ReactNode;
}) {
  const { t } = useI18n();
  const titleId = useId();
  const { client } = useAgentPlatform();
  const bindings = useQuery(credentialBindingsQuery(client, detail.agent.id));
  const { agent } = detail;
  const latest = latestVersion(detail);
  const active = detail.versions.find(
    (version) => version.id === detail.active_release?.version_id,
  );
  const refs = [
    ...new Set([
      ...(latest?.card.capabilities.credential_refs ?? []),
      ...(active?.card.capabilities.credential_refs ?? []),
    ]),
  ];
  const bound = new Set(
    (bindings.data?.items ?? [])
      .filter((binding) => binding.revoked_at === null)
      .map((binding) => binding.credential_ref),
  );
  const missing = refs.filter((ref) => !bound.has(ref));

  const credentials: {
    state: StepState | "unknown";
    desc: ReactNode;
  } =
    refs.length === 0
      ? { state: "done", desc: t("agent.ready.credentialsNone") }
      : bindings.isPending
        ? {
            state: "unknown",
            desc: <Skeleton lines={1} label={t("status.loading.title")} />,
          }
        : bindings.error
          ? { state: "unknown", desc: t("agent.ready.credentialsUnknown") }
          : missing.length === 0
            ? {
                state: "done",
                desc: t("agent.ready.credentialsBound", {
                  count: refs.length,
                }),
              }
            : {
                state: "todo",
                desc: t("agent.ready.credentialsMissing", {
                  names: missing.join(", "),
                }),
              };
  const released = detail.releases.length > 0;
  const upToDate =
    agent.active_release_id !== null &&
    latest !== undefined &&
    active !== undefined &&
    latest.id === active.id;
  // A paused or archived agent starts no session whatever its release, and
  // no screen changes the status, so its step offers nothing to press.
  const runnable = agent.status === "active";
  const steps = [
    {
      key: "credentials",
      title: t("agent.ready.credentials"),
      state: credentials.state,
      desc: credentials.desc,
    },
    {
      key: "release",
      title: t("agent.ready.release"),
      state: released ? "done" : "todo",
      desc: released
        ? t("agent.ready.releaseDone", { count: detail.releases.length })
        : t("agent.ready.releaseTodo"),
    },
    {
      key: "activate",
      title: t("agent.ready.activate"),
      state: upToDate && runnable ? "done" : "todo",
      desc: !runnable
        ? t("agent.ready.notRunnable", {
            status: t(`agents.status.${agent.status}`),
          })
        : agent.active_release_id === null
          ? t("agent.overview.notActive")
          : latest && active && latest.id !== active.id
            ? t("agent.overview.newerVersion", {
                latest: latest.version_no,
                active: active.version_no,
              })
            : t("agent.overview.upToDate"),
    },
  ] as const;
  const firstOpen = steps.findIndex((step) => step.state === "todo");
  const ready = firstOpen === -1 && credentials.state === "done";

  return (
    <section className={SECTION} aria-labelledby={titleId}>
      <div className={SECTION_HEAD}>
        <h2 id={titleId} className={SECTION_TITLE}>
          {t("agent.ready.title")}
        </h2>
        <Badge variant={ready ? "green" : "amber"}>
          {ready ? t("agent.ready.on") : t("agent.ready.todo")}
        </Badge>
      </div>
      <Card className="gap-0 p-4">
        <ol className="m-0 flex list-none flex-col p-0">
          {steps.map((step, index) => (
            <li
              key={step.key}
              data-state={step.state}
              className="flex min-w-0 items-center gap-3 border-t py-3 first:border-t-0 first:pt-0 last:pb-0"
            >
              <span
                aria-hidden="true"
                className={cn(
                  "grid size-6 flex-none place-items-center rounded-full border font-semibold text-caption",
                  step.state === "done"
                    ? "border-[var(--ap-tone-success-border)] bg-[var(--ap-tone-success-bg)] text-[var(--ap-tone-success-fg)]"
                    : "border-[var(--ap-color-border-strong)] text-muted-foreground",
                )}
              >
                {step.state === "done" ? (
                  <Check className="size-3.5" />
                ) : (
                  index + 1
                )}
              </span>
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="font-medium text-control">
                  {step.title}
                  <span className="sr-only">
                    {" "}
                    {step.state === "done"
                      ? t("agent.ready.stepDone")
                      : step.state === "todo"
                        ? t("agent.ready.stepTodo")
                        : ""}
                  </span>
                </span>
                <span className={META}>{step.desc}</span>
              </div>
              {index === firstOpen && (step.key !== "activate" || runnable)
                ? toRelease
                : null}
            </li>
          ))}
        </ol>
      </Card>
    </section>
  );
}

/** The design's recent sessions; the API cannot pick an agent's sessions yet. */
export function AgentRecentSessions() {
  const { t } = useI18n();
  const titleId = useId();
  return (
    <section className={SECTION} aria-labelledby={titleId}>
      <div className={SECTION_HEAD}>
        <h2 id={titleId} className={SECTION_TITLE}>
          {t("agent.sessions.title")}
        </h2>
      </div>
      <Card className="items-center gap-2 px-4 py-6 text-center text-control">
        <p className="m-0 font-semibold text-body">
          {t("agent.sessions.unavailable")}
        </p>
        <p className="m-0 text-muted-foreground">
          {t("agent.sessions.unavailableBody")}{" "}
          <Link asChild>
            <RouterLink to="/sessions">{t("agent.sessions.all")}</RouterLink>
          </Link>
        </p>
      </Card>
    </section>
  );
}

/** The card tab's read-only half: the card in words, and as sent. */
export function CardSummary({ detail }: { readonly detail: AgentDetail }) {
  const { t } = useI18n();
  const titleId = useId();
  const rawId = useId();
  const [copied, setCopied] = useState<boolean | null>(null);
  const version = shownVersion(detail);
  const card = version?.card;
  const live = version !== undefined && version.id === active(detail)?.id;
  const none = t("agent.panel.none");
  const names = (items: readonly string[]) =>
    items.length === 0 ? (
      none
    ) : (
      <span className="inline-flex flex-wrap gap-1">
        {items.map((item) => (
          <Badge key={item} variant="gray" className="font-mono font-normal">
            {item}
          </Badge>
        ))}
      </span>
    );
  const raw = card ? JSON.stringify(card, null, 2) : "";

  return (
    <div className="grid grid-cols-1 items-stretch gap-4 @[720px]:grid-cols-2">
      <section
        className="flex min-w-0 flex-col gap-3 rounded-card border bg-card p-4 text-card-foreground"
        aria-labelledby={titleId}
      >
        <div className="flex items-start justify-between gap-2">
          <div className="flex min-w-0 flex-col gap-0.5">
            <h2 id={titleId} className={SECTION_TITLE}>
              {t("agent.card.summaryTitle")}
            </h2>
            <span className={META}>
              {!live
                ? t("agent.card.subDraft")
                : detail.agent.status === "active"
                  ? t("agent.card.subActive")
                  : t("agent.card.subStopped", {
                      status: t(`agents.status.${detail.agent.status}`),
                    })}
            </span>
          </div>
          {version ? (
            <Badge variant="gray" className="font-mono font-normal">
              {t("agent.versionLabel", { version: version.version_no })}
            </Badge>
          ) : null}
        </div>
        <dl className="m-0 grid grid-cols-1 items-baseline gap-x-4 gap-y-1 text-control sm:grid-cols-[140px_minmax(0,1fr)] sm:gap-y-2">
          <dt className={TERM}>{t("agents.name")}</dt>
          <dd className={VALUE}>{detail.agent.name}</dd>
          <dt className={TERM}>{t("agents.slug")}</dt>
          <dd className={`${VALUE} font-mono text-caption`}>
            {detail.agent.slug}
          </dd>
          {card ? (
            <>
              <dt className={TERM}>{t("agentCard.role")}</dt>
              <dd className={VALUE}>{card.role}</dd>
              <dt className={TERM}>{t("agentCard.instructions")}</dt>
              <dd className={`${VALUE} line-clamp-3`}>{card.instructions}</dd>
              <dt className={TERM}>{t("agentCard.model")}</dt>
              <dd className={`${VALUE} font-mono text-caption`}>
                {card.model}
              </dd>
              <dt className={TERM}>{t("agentCard.language")}</dt>
              <dd className={VALUE}>
                {card.language === "ko" ? "한국어" : "English"}
              </dd>
              <dt className={TERM}>{t("agentCard.tools")}</dt>
              <dd className={VALUE}>
                {card.capabilities.tools === null
                  ? t("agentCard.toolsAll")
                  : names(card.capabilities.tools)}
              </dd>
              <dt className={TERM}>{t("agentCard.forbidden")}</dt>
              <dd className={VALUE}>{names(card.capabilities.forbidden)}</dd>
              <dt className={TERM}>{t("agents.cards.mcp")}</dt>
              <dd className={VALUE}>
                {names(
                  (card.capabilities.mcp ?? []).map((server) => server.server),
                )}
              </dd>
              <dt className={TERM}>{t("agents.cards.credentials")}</dt>
              <dd className={VALUE}>
                {names(card.capabilities.credential_refs ?? [])}
              </dd>
            </>
          ) : null}
        </dl>
        {card ? null : (
          <p className={`${META} text-control`}>{t("agent.noActive")}</p>
        )}
      </section>
      {card ? (
        <section
          className="flex min-w-0 flex-col gap-3 rounded-card border bg-card p-4 text-card-foreground"
          aria-labelledby={rawId}
        >
          <div className="flex items-start justify-between gap-2">
            <div className="flex min-w-0 flex-col gap-0.5">
              <h2 id={rawId} className={SECTION_TITLE}>
                {t("agent.card.raw")}
              </h2>
              <span className={META}>{t("agent.card.rawSub")}</span>
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                void copyText(raw, { current: null }).then(setCopied);
              }}
            >
              {copied ? (
                <Check aria-hidden="true" className="size-3.5" />
              ) : (
                <Copy aria-hidden="true" className="size-3.5" />
              )}
              {copied ? t("agent.card.copied") : t("agent.card.copy")}
            </Button>
          </div>
          <OutcomeLine
            outcome={
              copied === false
                ? { kind: "error", text: t("agent.card.copyFailed") }
                : null
            }
          />
          <pre className="m-0 flex-1 overflow-auto whitespace-pre-wrap rounded-control border bg-muted px-3 py-2 font-mono text-caption leading-[1.6] [overflow-wrap:anywhere]">
            {raw}
          </pre>
        </section>
      ) : null}
    </div>
  );
}

function active(detail: AgentDetail) {
  return detail.versions.find(
    (version) => version.id === detail.active_release?.version_id,
  );
}
