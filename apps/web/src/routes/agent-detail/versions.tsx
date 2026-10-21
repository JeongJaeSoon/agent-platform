import type { AgentDetail, AgentVersion } from "@werft-ai/contracts";
import { useI18n } from "../../i18n/i18n.tsx";

export const latestVersion = (detail: AgentDetail) =>
  detail.versions.reduce<AgentVersion | undefined>(
    (latest, version) =>
      latest && latest.version_no > version.version_no ? latest : version,
    undefined,
  );

export function VersionSelect({
  label,
  versions,
  value,
  onChange,
}: {
  readonly label: string;
  readonly versions: readonly AgentVersion[];
  readonly value: string;
  readonly onChange: (id: string) => void;
}) {
  const { t } = useI18n();
  return (
    <label className="web-field">
      <span>{label}</span>
      <select
        className="ap-input"
        value={value}
        onChange={(event) => onChange(event.target.value)}
      >
        {versions.map((version) => (
          <option key={version.id} value={version.id}>
            {t("agent.versionLabel", { version: version.version_no })}
          </option>
        ))}
      </select>
    </label>
  );
}
