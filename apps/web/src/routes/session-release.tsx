import type { SessionSummary } from "@werft-ai/contracts";
import { Badge, Code, Section, Text } from "@werft-ai/ui";
import { useI18n } from "../i18n/i18n.tsx";

/**
 * The release the session is pinned to, and whether the agent still runs it
 * for new sessions. Nothing for a session started without an agent.
 */
export function SessionReleaseBlock({
  agent,
}: {
  readonly agent: SessionSummary["agent"];
}) {
  const { t } = useI18n();
  // `!agent`: a server before the field leaves it out rather than null.
  if (!agent) return null;
  return (
    <Section titleAs="h3" title={t("session.release.title")}>
      <div className="flex min-w-0 flex-col gap-1">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <Code className="wrap-anywhere">
            {agent.release_label ??
              t("session.release.version", {
                version: agent.release_version_no,
              })}
          </Code>
          {/* Null from a server before the field: no claim either way. */}
          {agent.release_is_active === true ? (
            <Badge variant="green">{t("session.release.active")}</Badge>
          ) : agent.release_is_active === false ? (
            <Badge variant="amber">{t("session.release.notActive")}</Badge>
          ) : null}
        </div>
        {agent.release_is_active === false ? (
          <Text as="div" variant="meta">
            {t("session.release.notActiveBody")}
          </Text>
        ) : null}
      </div>
    </Section>
  );
}
