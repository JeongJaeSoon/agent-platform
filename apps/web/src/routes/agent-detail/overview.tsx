import type { AgentDetail } from "@werft-ai/contracts";
import { formatTimestamp } from "@werft-ai/ui";
import { type ReactNode, useId } from "react";
import { useI18n } from "../../i18n/i18n.tsx";
import { MUTED, SECTION, SECTION_TITLE } from "./classes.ts";
import { latestVersion } from "./versions.tsx";

const TERM = "m-0 text-muted-foreground text-sm";
const VALUE = "m-0 font-medium [overflow-wrap:anywhere]";

/** What runs now and what is left to do; `toRelease` opens the release tab. */
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
    <section className={SECTION} aria-labelledby={titleId}>
      <h2 id={titleId} className={SECTION_TITLE}>
        {t("agent.tabs.overview")}
      </h2>
      <dl className="m-0 grid gap-x-6 gap-y-2 sm:grid-cols-[max-content_1fr]">
        <dt className={TERM}>{t("agents.slug")}</dt>
        <dd className={VALUE}>{agent.slug}</dd>
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
          <p className={MUTED}>{next}</p>
          {toRelease}
        </>
      ) : (
        <p className={MUTED}>{t("agent.overview.upToDate")}</p>
      )}
    </section>
  );
}
