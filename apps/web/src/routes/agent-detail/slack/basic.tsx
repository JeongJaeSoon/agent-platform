import { useMutation, useQueryClient } from "@tanstack/react-query";
import { unwrap } from "@werft-ai/client";
import { useAgentPlatform } from "@werft-ai/react";
import { FieldError, SettingRow, Switch } from "@werft-ai/ui";
import { useState } from "react";
import { useI18n } from "../../../i18n/i18n.tsx";
import type { Notify } from "../toast.tsx";
import { slackKey, useSlackBindings, useSlackSettings } from "./queries.ts";
import { dmOn, slackFailure } from "./shared.ts";

export function SlackDmSetting({ agentId }: { readonly agentId: string }) {
  const { t } = useI18n();
  const { client } = useAgentPlatform();
  const cache = useQueryClient();
  const key = [...slackKey(client, agentId), "bindings"];
  const bindings = useSlackBindings(agentId);
  const dm = bindings.data?.items.find((row) => row.surface_kind === "dm");
  const [notice, setNotice] = useState("");
  const update = useMutation({
    onMutate: () => setNotice(""),
    mutationFn: (checked: boolean) =>
      unwrap(
        client.PUT("/v1/agents/{id}/slack-bindings", {
          params: { path: { id: agentId } },
          body: {
            channel_id: null,
            mode: checked ? "on" : "off",
            home: false,
            ...(dm ? { ceiling: dm.ceiling } : {}),
          },
        }),
      ),
    onSuccess: async () => {
      await cache.invalidateQueries({ queryKey: key });
      setNotice(t("slack.dmSaved"));
    },
  });
  const unavailable = !bindings.isSuccess || update.isPending;
  const error = bindings.error ?? update.error;
  return (
    <SettingRow
      title={t("slack.dmSetting")}
      description={t("slack.dmHint")}
      status={
        <span className="text-control text-muted-foreground">
          {bindings.isError && !bindings.data
            ? "—"
            : t(dmOn(dm) ? "slack.on" : "slack.off")}
        </span>
      }
      meta={
        <>
          {error ? <FieldError>{slackFailure(error, t)}</FieldError> : null}
          <output
            aria-live="polite"
            className={notice ? "text-control" : "sr-only"}
          >
            {notice}
          </output>
        </>
      }
      control={
        bindings.isError && !bindings.data ? null : (
          <Switch
            aria-label={t("slack.dmSetting")}
            checked={dmOn(dm)}
            aria-disabled={unavailable}
            onCheckedChange={(checked) => {
              if (!unavailable) update.mutate(checked);
            }}
          />
        )
      }
    />
  );
}

export function SlackMentionOnly({
  agentId,
  notify,
}: {
  readonly agentId: string;
  readonly notify: Notify;
}) {
  const { t } = useI18n();
  const { client } = useAgentPlatform();
  const cache = useQueryClient();
  const settings = useSlackSettings(agentId);
  const update = useMutation({
    onMutate: async () => {
      // A read still in flight would land after the save and undo it.
      await cache.cancelQueries({
        queryKey: [...slackKey(client, agentId), "settings"],
      });
    },
    mutationFn: (checked: boolean) =>
      unwrap(
        client.PUT("/v1/agents/{id}/slack/app/settings", {
          params: {
            path: { id: agentId },
            header: { "Idempotency-Key": crypto.randomUUID() },
          },
          body: { mention_only: checked },
        }),
      ),
    onSuccess: (saved) => {
      cache.setQueryData([...slackKey(client, agentId), "settings"], saved);
      notify(
        t(
          saved.mention_only
            ? "slack.mentionOnlySavedOn"
            : "slack.mentionOnlySavedOff",
        ),
      );
    },
    // A read started during the save may hold the old value; drop it and
    // read again now that the save is done.
    onSettled: () =>
      cache.invalidateQueries({
        queryKey: [...slackKey(client, agentId), "settings"],
      }),
  });
  const lost = settings.isError && !settings.data;
  const error = settings.error ?? update.error;
  return (
    <SettingRow
      title={t("slack.mentionOnly")}
      description={t("slack.mentionOnlyHint")}
      status={
        <span className="text-control text-muted-foreground">
          {lost
            ? "—"
            : settings.data
              ? t(settings.data.mention_only ? "slack.on" : "slack.off")
              : null}
        </span>
      }
      meta={
        error ? <FieldError>{slackFailure(error, t)}</FieldError> : undefined
      }
      control={
        lost ? null : (
          <Switch
            aria-label={t("slack.mentionOnly")}
            checked={settings.data?.mention_only ?? false}
            aria-disabled={!settings.isSuccess || update.isPending}
            onCheckedChange={(checked) => {
              if (settings.isSuccess && !update.isPending)
                update.mutate(checked);
            }}
          />
        )
      }
    />
  );
}
