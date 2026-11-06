import type { AgentDetail, AgentVersion } from "@werft-ai/contracts";
import {
  Field,
  FieldLabel,
  NativeSelect,
  NativeSelectOption,
} from "@werft-ai/ui";
import { useI18n } from "../../i18n/i18n.tsx";

export const latestVersion = (detail: AgentDetail) =>
  detail.versions.reduce<AgentVersion | undefined>(
    (latest, version) =>
      latest && latest.version_no > version.version_no ? latest : version,
    undefined,
  );

/**
 * The version new sessions run, or the newest one before any release. The
 * highest version number is not the current card: a save whose release was
 * refused is a newer version that nothing runs.
 */
export function shownVersion(detail: AgentDetail) {
  return (
    detail.versions.find(
      (version) => version.id === detail.active_release?.version_id,
    ) ?? latestVersion(detail)
  );
}

/** The version a save is waiting to release, or whose release was refused. */
export const draftVersion = (detail: AgentDetail) =>
  detail.versions.find((version) => version.id === detail.draft?.version_id);

/**
 * The version a next release would take: the saved one waiting for it, or
 * before any release the newest one.
 */
export const nextVersion = (detail: AgentDetail) =>
  draftVersion(detail) ??
  (detail.active_release ? undefined : latestVersion(detail));

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
    <Field className="w-auto">
      <FieldLabel>{label}</FieldLabel>
      <NativeSelect
        value={value}
        onChange={(event) => onChange(event.target.value)}
      >
        {versions.map((version) => (
          <NativeSelectOption key={version.id} value={version.id}>
            {t("agent.versionLabel", { version: version.version_no })}
          </NativeSelectOption>
        ))}
      </NativeSelect>
    </Field>
  );
}
