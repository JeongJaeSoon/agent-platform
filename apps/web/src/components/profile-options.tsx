import type { ProfileSummary } from "@werft-ai/contracts";
import { NativeSelectOptGroup, NativeSelectOption } from "@werft-ai/ui";
import { useI18n } from "../i18n/i18n.tsx";

export const pickable = (profile: ProfileSummary) =>
  profile.source === "operator" || profile.workspace?.state === "usable";

export function ProfileOptions({
  profiles,
  label,
}: {
  readonly profiles: readonly ProfileSummary[];
  readonly label: (profile: ProfileSummary) => string;
}) {
  const { t } = useI18n();
  const operators = profiles.filter((item) => item.source === "operator");
  const versions = profiles.filter((item) => item.source === "workspace");
  const option = (profile: ProfileSummary) => (
    <NativeSelectOption
      key={profile.id}
      value={profile.id}
      disabled={!pickable(profile)}
    >
      {pickable(profile) || profile.workspace === undefined
        ? label(profile)
        : `${label(profile)} · ${t(`profiles.state.${profile.workspace.state}`)}`}
    </NativeSelectOption>
  );
  if (versions.length === 0) return operators.map(option);
  return (
    <>
      <NativeSelectOptGroup label={t("profiles.operator.title")}>
        {operators.map(option)}
      </NativeSelectOptGroup>
      <NativeSelectOptGroup label={t("profiles.workspace.title")}>
        {versions.map(option)}
      </NativeSelectOptGroup>
    </>
  );
}
