import type { AgentDetail } from "@werft-ai/contracts";
import { formatTimestamp } from "@werft-ai/ui";
import { type ReactNode, useId } from "react";
import { useI18n } from "../../i18n/i18n.tsx";
import { MUTED } from "./classes.ts";
import { latestVersion } from "./versions.tsx";

const PANEL_CARD =
  "flex min-w-0 flex-col gap-3 rounded-card border bg-card p-4";
const PANEL_TITLE = "m-0 font-semibold text-body leading-5";
// The label column fits its words, so a value never sits across the page
// from its label when the panel spans the full width.
const FACTS =
  "m-0 grid grid-cols-[max-content_minmax(0,1fr)] gap-x-4 gap-y-2 text-control";
const TERM = "m-0 text-muted-foreground";
const VALUE = "m-0 font-medium [overflow-wrap:anywhere]";

/**
 * The side panel's account of what runs now and what is left to do;
 * `toRelease` opens the release tab.
 */
export function Overview({
  detail,
  releaseLabel,
  children: toRelease,
}: {
  readonly detail: AgentDetail;
  readonly releaseLabel: (releaseId: string | null) => string;
  readonly children: ReactNode;
}) {
  const { t, locale } = useI18n();
  const titleId = useId();
  const { agent } = detail;
  const latest = latestVersion(detail);
  const activeVersion = detail.versions.find(
    (version) => version.id === detail.active_release?.version_id,
  );
  const next =
    agent.active_release_id === null
      ? t("agent.overview.notActive")
      : latest && activeVersion && latest.id !== activeVersion.id
        ? t("agent.overview.newerVersion", {
            latest: latest.version_no,
            active: activeVersion.version_no,
          })
        : null;

  return (
    <section className={PANEL_CARD} aria-labelledby={titleId}>
      <h2 id={titleId} className={PANEL_TITLE}>
        {t("agent.panel.summary")}
      </h2>
      <dl className={FACTS}>
        <dt className={TERM}>{t("agents.slug")}</dt>
        <dd className={`${VALUE} font-mono text-caption`}>{agent.slug}</dd>
        <dt className={TERM}>{t("agent.overview.active")}</dt>
        <dd className={VALUE}>{releaseLabel(agent.active_release_id)}</dd>
        <dt className={TERM}>{t("agent.overview.latest")}</dt>
        <dd className={VALUE}>
          {latest
            ? `${t("agent.versionLabel", { version: latest.version_no })} · ${formatTimestamp(latest.created_at, locale)}`
            : t("agent.noActive")}
        </dd>
      </dl>
      {next ? (
        <>
          <p className={`${MUTED} text-control`}>{next}</p>
          {toRelease}
        </>
      ) : (
        <p className={`${MUTED} text-control`}>
          {t("agent.overview.upToDate")}
        </p>
      )}
    </section>
  );
}

/** The overview tab: what the newest card asks of the agent, read-only. */
export function CardSummary({ detail }: { readonly detail: AgentDetail }) {
  const { t } = useI18n();
  const titleId = useId();
  const card = latestVersion(detail)?.card;
  return (
    <section className={PANEL_CARD} aria-labelledby={titleId}>
      <h2 id={titleId} className={PANEL_TITLE}>
        {t("agent.tabs.overview")}
      </h2>
      {card ? (
        <dl className="m-0 grid grid-cols-1 gap-x-4 gap-y-1 text-control sm:grid-cols-[140px_minmax(0,1fr)] sm:gap-y-3">
          <dt className={TERM}>{t("agentCard.role")}</dt>
          <dd className={VALUE}>{card.role}</dd>
          <dt className={TERM}>{t("agentCard.model")}</dt>
          <dd className={`${VALUE} font-mono text-caption`}>{card.model}</dd>
          <dt className={TERM}>{t("agentCard.language")}</dt>
          <dd className={VALUE}>
            {card.language === "ko" ? "한국어" : "English"}
          </dd>
          <dt className={TERM}>{t("agentCard.tools")}</dt>
          <dd className={VALUE}>
            {card.capabilities.tools === null
              ? t("agentCard.toolsAll")
              : card.capabilities.tools.join(", ") || t("agent.panel.none")}
          </dd>
          <dt className={TERM}>{t("agentCard.forbidden")}</dt>
          <dd className={VALUE}>
            {card.capabilities.forbidden.join(", ") || t("agent.panel.none")}
          </dd>
        </dl>
      ) : (
        <p className={`${MUTED} text-control`}>{t("agent.noActive")}</p>
      )}
    </section>
  );
}
