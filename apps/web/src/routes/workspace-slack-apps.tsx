import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { unwrap } from "@werft-ai/client";
import type { ListWorkspaceSlackAppsResponse } from "@werft-ai/contracts";
import { useAgentPlatform } from "@werft-ai/react";
import {
  Badge,
  cn,
  EmptyState,
  formatTimestamp,
  linkVariants,
  RowLines,
  SettingRow,
  Skeleton,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@werft-ai/ui";
import { scopedKey } from "../api/queries.ts";
import {
  permissionReason,
  useHasPermission,
  useMe,
  useRole,
} from "../auth/guard.tsx";
import { LoadFailure } from "../components/load-failure.tsx";
import { useI18n } from "../i18n/i18n.tsx";
import { SettingsCard, WorkspacePage } from "./workspace-settings.tsx";

type MadeApp = ListWorkspaceSlackAppsResponse["items"][number];

/** Workspace › Slack apps the console made: their state, changed elsewhere. */
export function WorkspaceSlackAppsScreen() {
  const { t } = useI18n();
  const { client } = useAgentPlatform();
  const role = useRole();
  const workspaceId = useMe()?.workspace?.id ?? "";
  const canManage = useHasPermission("workspace.manage");
  const apps = useQuery({
    queryKey: scopedKey(client, "workspace", workspaceId, "slack-apps"),
    queryFn: () =>
      unwrap(
        client.GET("/v1/workspaces/{id}/slack/apps", {
          params: { path: { id: workspaceId } },
        }),
      ),
    enabled: workspaceId !== "" && canManage,
  });

  return (
    <WorkspacePage page="slack-apps">
      <SettingsCard
        title={t("workspace.slackApps")}
        description={t("workspace.slackAppsHint")}
        rows={
          !canManage ? (
            <SettingRow
              title={t("workspace.slackApps")}
              description={permissionReason(t, "workspace.manage", role)}
            />
          ) : undefined
        }
      >
        {!canManage ? null : apps.isPending ? (
          <Skeleton width="50%" />
        ) : apps.isError ? (
          <LoadFailure error={apps.error} onRetry={() => void apps.refetch()} />
        ) : apps.data.items.length === 0 ? (
          <EmptyState size="sm" title={t("workspace.slackAppsEmpty")} />
        ) : (
          <AppTable items={apps.data.items} />
        )}
      </SettingsCard>
    </WorkspacePage>
  );
}

function AppTable({ items }: { readonly items: readonly MadeApp[] }) {
  const { t, locale } = useI18n();
  return (
    <div className="@container overflow-hidden rounded-card border bg-card">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead scope="col">{t("workspace.slackAppsApp")}</TableHead>
            <TableHead scope="col" className={WIDE}>
              {t("workspace.slackAppsAgent")}
            </TableHead>
            <TableHead scope="col" className={FIT}>
              {t("workspace.slackAppsState")}
            </TableHead>
            <TableHead scope="col" className={cn(FIT, WIDE, "text-right")}>
              {t("workspace.slackAppsUpdated")}
            </TableHead>
            <TableHead scope="col" className={FIT}>
              <span className="sr-only">{t("workspace.slackAppsMore")}</span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {items.map((item) => {
            const name = item.agent
              ? t("workspace.slackAppsAgentApp", { name: item.agent.name })
              : t("workspace.slackAppsLinkApp");
            return (
              <TableRow key={item.slack_app.id}>
                <TableCell>
                  <RowLines>
                    <span className="font-medium [overflow-wrap:anywhere]">
                      {name}
                    </span>
                    <span className="font-mono text-caption text-muted-foreground">
                      {item.slack_app.app_id ?? t("workspace.slackAppsNoId")}
                    </span>
                    {/* Plain text: the row's details link already opens the agent. */}
                    <span className="text-caption text-muted-foreground @[560px]:hidden">
                      {item.agent?.name ?? t("workspace.slackAppsNoAgent")}
                      {" · "}
                      {formatTimestamp(item.slack_app.updated_at, locale)}
                    </span>
                  </RowLines>
                </TableCell>
                <TableCell className={cn(WIDE, "text-muted-foreground")}>
                  {item.agent ? (
                    <Link
                      to="/agents/$id"
                      params={{ id: item.agent.id }}
                      className={linkVariants()}
                    >
                      {item.agent.name}
                    </Link>
                  ) : (
                    t("workspace.slackAppsNoAgent")
                  )}
                </TableCell>
                <TableCell className={FIT}>
                  <AppState item={item} />
                </TableCell>
                <TableCell
                  className={cn(
                    FIT,
                    WIDE,
                    "text-right text-caption text-muted-foreground",
                  )}
                >
                  <time dateTime={item.slack_app.updated_at}>
                    {formatTimestamp(item.slack_app.updated_at, locale)}
                  </time>
                </TableCell>
                <TableCell className={FIT}>
                  {item.agent ? (
                    <Link
                      to="/agents/$id"
                      params={{ id: item.agent.id }}
                      search={{ tab: "slack" }}
                      className={linkVariants()}
                    >
                      {t("workspace.slackAppsMore")}
                      <span className="sr-only">: {name}</span>
                    </Link>
                  ) : null}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}

function AppState({ item }: { readonly item: MadeApp }) {
  const { t } = useI18n();
  const { state } = item.slack_app;
  const connected =
    state === "created" && (item.agent === null || item.agent.installed);
  return (
    <RowLines>
      {state === "creating" ? (
        <Badge>{t("workspace.slackAppsCreating")}</Badge>
      ) : state === "deleting" ? (
        <Badge variant="red">{t("workspace.slackAppsDeleting")}</Badge>
      ) : connected ? (
        <Badge variant="green">{t("workspace.slackAppsConnected")}</Badge>
      ) : (
        <Badge>{t("workspace.slackAppsNotInstalled")}</Badge>
      )}
      {connected ? (
        <span className="text-caption text-muted-foreground">
          {item.agent ? `@${item.agent.slug}` : "Sign in with Slack"}
        </span>
      ) : null}
    </RowLines>
  );
}

// Shrinks the column to its content so the app column takes the rest.
const FIT = "w-px whitespace-nowrap";
// Below 560px the agent and time fold into the app cell.
const WIDE = "hidden @[560px]:table-cell";
