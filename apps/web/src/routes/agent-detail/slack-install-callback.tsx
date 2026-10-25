import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Link,
  useNavigate,
  useParams,
  useSearch,
} from "@tanstack/react-router";
import { unwrap } from "@werft-ai/client";
import { useAgentPlatform } from "@werft-ai/react";
import { Button } from "@werft-ai/ui";
import { useEffect, useRef } from "react";
import { Page } from "../../components/page.tsx";
import { useI18n } from "../../i18n/i18n.tsx";
import { slackFailure } from "./slack.tsx";
import { useToast } from "./toast.tsx";

declare module "@tanstack/react-router" {
  interface HistoryState {
    /** The Slack tab announces a finished install once. */
    readonly slackInstalled?: boolean;
  }
}

export function SlackInstallCallback() {
  const { id } = useParams({ from: "/authed/agents/$id/slack/callback" });
  const search = useSearch({ from: "/authed/agents/$id/slack/callback" });
  const { t } = useI18n();
  const { client } = useAgentPlatform();
  const cache = useQueryClient();
  const navigate = useNavigate();
  const started = useRef(false);
  const { notify, toast } = useToast();
  const complete = useMutation({
    mutationFn: () =>
      unwrap(
        client.POST("/v1/slack/install/complete", {
          body: {
            agent_id: id,
            state: search.state,
            ...(search.code ? { code: search.code } : {}),
            ...(search.error ? { error: search.error } : {}),
          },
        }),
      ),
    onSuccess: async (result) => {
      await cache.invalidateQueries({ queryKey: ["agents", id, "slack"] });
      if (result.finalized && result.warnings.length === 0)
        await navigate({
          to: "/agents/$id",
          params: { id },
          search: { tab: "slack" },
          state: (previous) => ({ ...previous, slackInstalled: true }),
          replace: true,
        });
      else notify(t("slack.installed"));
    },
    onError: (failure) => notify(slackFailure(failure, t)),
  });
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    complete.mutate();
    window.history.replaceState(
      window.history.state,
      "",
      window.location.pathname,
    );
  }, [complete.mutate]);
  return (
    <Page title={t("slack.install")}>
      <output aria-live="polite">
        {complete.error
          ? slackFailure(complete.error, t)
          : complete.data?.warnings.some(
                (warning) => warning.code === "reinstall_required",
              )
            ? t("slack.state.reinstall")
            : complete.data &&
                (!complete.data.finalized || complete.data.warnings.length > 0)
              ? t("slack.verifyNeeded")
              : t("slack.working")}
      </output>
      {complete.error || complete.data ? (
        <Button asChild variant="outline">
          <Link to="/agents/$id" params={{ id }} search={{ tab: "slack" }}>
            {t("slack.app")}
          </Link>
        </Button>
      ) : null}
      {toast}
    </Page>
  );
}
