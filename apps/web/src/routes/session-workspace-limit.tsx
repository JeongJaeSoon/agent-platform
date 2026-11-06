import type { SessionDetail } from "@werft-ai/contracts";
import { Text } from "@werft-ai/ui";
import { useI18n } from "../i18n/i18n.tsx";

export function SessionWorkspaceLimit({
  mode,
}: {
  readonly mode: SessionDetail["workspace_limit_mode"];
}) {
  const { t } = useI18n();
  return (
    <Text as="div" variant="meta">
      {t("session.workspaceLimit.line", {
        bytes: t(`session.workspaceLimit.${mode?.bytes ?? "unknown"}`),
        inodes: t(`session.workspaceLimit.${mode?.inodes ?? "unknown"}`),
      })}
    </Text>
  );
}
