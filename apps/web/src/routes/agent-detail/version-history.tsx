import type { AgentDetail, AgentVersion } from "@werft-ai/contracts";
import { formatTimestamp, RowLines, RowList, RowListItem } from "@werft-ai/ui";
import { useId, useState } from "react";
import { RevisionDiff } from "../../components/revision-diff.tsx";
import { useI18n } from "../../i18n/i18n.tsx";
import {
  FORM_INLINE,
  PRIMARY,
  SECONDARY,
  SECTION,
  SECTION_TITLE,
} from "./classes.ts";
import { VersionSelect } from "./versions.tsx";

export function VersionHistory({ detail }: { readonly detail: AgentDetail }) {
  const { t, locale } = useI18n();
  const titleId = useId();
  const ordered = [...detail.versions].sort(
    (a, b) => b.version_no - a.version_no,
  );
  const activeVersionId = detail.active_release?.version_id;
  const [afterId, setAfterId] = useState(ordered[0]?.id ?? "");
  const [beforeId, setBeforeId] = useState(
    (activeVersionId && activeVersionId !== ordered[0]?.id
      ? activeVersionId
      : ordered[1]?.id) ?? "",
  );
  const before = ordered.find((version) => version.id === beforeId);
  const after = ordered.find((version) => version.id === afterId);
  const label = (version: AgentVersion) =>
    t("agent.versionLabel", { version: version.version_no });

  return (
    <section className={SECTION} aria-labelledby={titleId}>
      <h2 id={titleId} className={SECTION_TITLE}>
        {t("agent.versions.title")}
      </h2>
      <RowList>
        {ordered.map((version) => (
          <RowListItem key={version.id}>
            <RowLines>
              <span className={PRIMARY}>{label(version)}</span>
              <span className={SECONDARY}>
                {formatTimestamp(version.created_at, locale)}
                {version.id === activeVersionId
                  ? ` · ${t("agent.versions.active")}`
                  : ""}
              </span>
            </RowLines>
          </RowListItem>
        ))}
      </RowList>
      {ordered.length > 1 ? (
        <>
          <div className={FORM_INLINE}>
            <VersionSelect
              label={t("agent.versions.before")}
              versions={ordered}
              value={beforeId}
              onChange={setBeforeId}
            />
            <VersionSelect
              label={t("agent.versions.after")}
              versions={ordered}
              value={afterId}
              onChange={setAfterId}
            />
          </div>
          {before && after ? (
            <RevisionDiff
              before={before.card}
              after={after.card}
              beforeLabel={label(before)}
              afterLabel={label(after)}
            />
          ) : null}
        </>
      ) : null}
    </section>
  );
}
