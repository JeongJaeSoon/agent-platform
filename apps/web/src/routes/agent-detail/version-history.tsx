import type { AgentDetail, AgentVersion } from "@werft-ai/contracts";
import {
  formatTimestamp,
  Heading,
  RowLines,
  RowList,
  RowListItem,
  Text,
} from "@werft-ai/ui";
import { ChevronRight } from "lucide-react";
import { useId, useState } from "react";
import { RevisionDiff } from "../../components/revision-diff.tsx";
import { useI18n } from "../../i18n/i18n.tsx";
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
    // Folded: the card tab leads with the card, not its past.
    <details
      className="group flex flex-col gap-[var(--werft-space-block)]"
      aria-labelledby={titleId}
    >
      <summary className="flex min-h-7 cursor-pointer list-none items-center gap-2 rounded-control [&::-webkit-details-marker]:hidden">
        <ChevronRight
          aria-hidden="true"
          className="size-4 text-muted-foreground transition-transform group-open:rotate-90"
        />
        <Heading id={titleId}>{t("agent.versions.title")}</Heading>
        <Text as="span" variant="meta">
          {ordered.length}
        </Text>
      </summary>
      <RowList>
        {ordered.map((version) => (
          <RowListItem key={version.id}>
            <RowLines>
              <Text as="span" weight="medium" className="block break-words">
                {label(version)}
              </Text>
              <Text
                as="span"
                variant="meta"
                className="block [overflow-wrap:anywhere]"
              >
                {formatTimestamp(version.created_at, locale)}
                {version.id === activeVersionId
                  ? ` · ${t("agent.versions.active")}`
                  : ""}
              </Text>
            </RowLines>
          </RowListItem>
        ))}
      </RowList>
      {ordered.length > 1 ? (
        <>
          <div className="flex flex-wrap items-start gap-3">
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
    </details>
  );
}
