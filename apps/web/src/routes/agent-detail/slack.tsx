import {
  keepPreviousData,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { type components, unwrap } from "@werft-ai/client";
import { useAgentPlatform } from "@werft-ai/react";
import {
  Badge,
  Button,
  ConfirmDialog,
  Field,
  FieldError,
  FieldLabel,
  Input,
  Skeleton,
  Switch,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@werft-ai/ui";
import { useEffect, useRef, useState } from "react";
import { useMe } from "../../auth/guard.tsx";
import { errorKey, type Translate, useI18n } from "../../i18n/i18n.tsx";
import { useAppServices } from "../../services.tsx";

type Binding =
  components["schemas"]["ListSlackBindingsResponse"]["items"][number];
type BindingInput = components["schemas"]["PutSlackBindingRequest"];

export function slackFailure(error: unknown, t: Translate): string {
  const code = (error as { code?: string } | null)?.code ?? "INTERNAL_ERROR";
  if (code === "CONFIG_TOKEN_INVALID" || code === "SLACK_LINK_NOT_CONFIGURED")
    return t("slack.error.config");
  if (code === "SLACK_APP_CREATING") return t("slack.error.creating");
  if (code === "AGENT_NOT_ACTIVE") return t("slack.activateFirst");
  if (code === "SLACK_NOT_INSTALLED") return t("slack.error.notInstalled");
  if (code === "SLACK_INSTALL_DENIED") return t("slack.error.denied");
  if (code === "SLACK_INSTALL_STATE_INVALID") return t("slack.error.expired");
  if (code === "SLACK_INSTALL_REJECTED" || code === "SLACK_INSTALL_CONFLICT")
    return t("slack.error.rejected");
  if (code === "CURSOR_EXPIRED") return t("slack.error.cursor");
  return t(errorKey(code));
}

export function SlackSkeleton() {
  return (
    <div className="flex min-h-96 flex-col gap-6" aria-busy="true">
      <Skeleton className="h-10 w-64" />
      <Skeleton className="h-32 w-full" />
      <Skeleton className="h-40 w-full" />
    </div>
  );
}

export function SlackConnect({
  agentId,
  active = true,
}: {
  readonly agentId: string;
  readonly active?: boolean;
}) {
  const { t } = useI18n();
  const { client } = useAgentPlatform();
  const cache = useQueryClient();
  const me = useMe();
  const { leave } = useAppServices();
  const key = ["agents", agentId, "slack"];
  const app = useQuery({
    queryKey: [...key, "app"],
    queryFn: () =>
      unwrap(
        client.GET("/v1/agents/{id}/slack/app", {
          params: { path: { id: agentId } },
        }),
      ),
    staleTime: 30_000,
    retry: false,
  });
  const identities = useQuery({
    queryKey: [...key, "identities"],
    queryFn: () =>
      unwrap(
        client.GET("/v1/agents/{id}/identities", {
          params: { path: { id: agentId } },
        }),
      ),
    staleTime: 30_000,
    retry: false,
  });
  const [notice, setNotice] = useState("");
  const outcome = useRef<HTMLOutputElement>(null);
  useEffect(() => {
    if (notice) outcome.current?.focus();
  }, [notice]);
  const [deleting, setDeleting] = useState(false);
  const [revoking, setRevoking] = useState(false);
  const identity = identities.data?.items.find(
    (item) => item.provider === "slack_bot" && item.status === "active",
  );
  const record = app.data?.slack_app;
  const refresh = () => cache.invalidateQueries({ queryKey: key });
  const connect = useMutation({
    mutationFn: async () => {
      if (!record)
        await unwrap(
          client.POST("/v1/agents/{id}/slack/app", {
            params: { path: { id: agentId } },
            body: { replace_uncertain: false },
          }),
        );
      await refresh();
      return unwrap(
        client.POST("/v1/agents/{id}/slack/install/start", {
          params: { path: { id: agentId } },
        }),
      );
    },
    onSuccess: ({ authorize_url }) => {
      leave(authorize_url);
    },
  });
  const remove = useMutation({
    mutationFn: async () => {
      if (!record || !me?.workspace) return;
      await unwrap(
        client.DELETE("/v1/workspaces/{id}/slack/apps/{app_id}", {
          params: { path: { id: me.workspace.id, app_id: record.id } },
        }),
      );
    },
    onSuccess: async () => {
      setDeleting(false);
      setNotice(t("slack.deleted"));
      await refresh();
    },
  });
  const revoke = useMutation({
    mutationFn: async () => {
      if (!identity) return;
      await unwrap(
        client.DELETE("/v1/agents/{id}/identities/{identity_id}", {
          params: { path: { id: agentId, identity_id: identity.id } },
        }),
      );
    },
    onSuccess: async () => {
      setRevoking(false);
      setNotice(t("slack.revoked"));
      await refresh();
    },
  });
  const error =
    app.error ??
    identities.error ??
    connect.error ??
    remove.error ??
    revoke.error;
  const errorText = error ? slackFailure(error, t) : "";
  if (app.isPending || identities.isPending) return <SlackSkeleton />;
  const busy = connect.isPending || remove.isPending || revoke.isPending;
  const pending = record?.state === "creating" || record?.state === "deleting";
  const status = error
    ? "error"
    : identity
      ? "connected"
      : record?.secrets.slack_bot_token.configured
        ? "reinstall"
        : record
          ? "pending"
          : "none";
  return (
    <section
      className="flex min-h-64 flex-col gap-6"
      aria-label={t("slack.app")}
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="m-0 text-heading-sm">{t("slack.app")}</h2>
        <Badge
          variant={
            status === "connected"
              ? "green"
              : status === "error"
                ? "red"
                : "gray"
          }
        >
          {t(`slack.state.${status}`)}
        </Badge>
      </div>
      <p className="m-0 text-control text-muted-foreground">
        {t("slack.joinHint")}
      </p>
      {record?.app_id ? (
        <p className="m-0 text-control">
          {t("slack.appId")}: <span className="font-mono">{record.app_id}</span>
        </p>
      ) : null}
      <output ref={outcome} tabIndex={-1} aria-live="polite">
        {notice}
      </output>
      {errorText ? (
        <div role="alert">
          <FieldError>{errorText}</FieldError>
        </div>
      ) : null}
      {!active ? (
        <p className="m-0 text-muted-foreground">{t("slack.activateFirst")}</p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        {!app.error && !identities.error ? (
          <Button
            type="button"
            disabled={(!active && !record) || busy || pending}
            onClick={() => connect.mutate()}
          >
            {connect.isPending
              ? t("slack.working")
              : t(
                  identity
                    ? "slack.reinstall"
                    : record
                      ? "slack.install"
                      : "slack.createInstall",
                )}
          </Button>
        ) : null}
        <Button
          type="button"
          variant="outline"
          disabled={busy || app.isFetching || identities.isFetching}
          onClick={() => void refresh()}
        >
          {t("slack.refresh")}
        </Button>
        {identity ? (
          <Button
            type="button"
            variant="outline"
            disabled={busy}
            onClick={() => setRevoking(true)}
          >
            {t("slack.revoke")}
          </Button>
        ) : null}
        {record ? (
          <Button
            type="button"
            variant="outline"
            disabled={busy || pending || !me}
            onClick={() => setDeleting(true)}
          >
            {t("slack.delete")}
          </Button>
        ) : null}
      </div>
      <ConfirmDialog
        open={deleting}
        onOpenChange={setDeleting}
        title={t("slack.delete")}
        consequence={t("slack.deleteWarning")}
        confirmLabel={t("slack.delete")}
        cancelLabel={t("common.cancel")}
        tone="danger"
        busy={remove.isPending}
        onConfirm={() => remove.mutate()}
      >
        {remove.error ? (
          <FieldError>{slackFailure(remove.error, t)}</FieldError>
        ) : null}
      </ConfirmDialog>
      <ConfirmDialog
        open={revoking}
        onOpenChange={setRevoking}
        title={t("slack.revoke")}
        consequence={t("slack.revokeWarning")}
        confirmLabel={t("slack.revoke")}
        cancelLabel={t("common.cancel")}
        tone="danger"
        busy={revoke.isPending}
        onConfirm={() => revoke.mutate()}
      >
        {revoke.error ? (
          <FieldError>{slackFailure(revoke.error, t)}</FieldError>
        ) : null}
      </ConfirmDialog>
    </section>
  );
}

function SlackChannels({ agentId }: { readonly agentId: string }) {
  const { t } = useI18n();
  const { client } = useAgentPlatform();
  const cache = useQueryClient();
  const key = ["agents", agentId, "slack"];
  const [input, setInput] = useState("");
  const [query, setQuery] = useState("");
  const [defaultMention, setDefaultMention] = useState(true);
  const [notice, setNotice] = useState("");
  const [names, setNames] = useState<Record<string, string>>({});
  useEffect(() => {
    const timer = setTimeout(() => setQuery(input.trim()), 300);
    return () => clearTimeout(timer);
  }, [input]);
  const bindings = useQuery({
    queryKey: [...key, "bindings"],
    queryFn: () =>
      unwrap(
        client.GET("/v1/agents/{id}/slack-bindings", {
          params: { path: { id: agentId } },
        }),
      ),
    staleTime: 30_000,
  });
  const channels = useInfiniteQuery({
    queryKey: [...key, "channels", query],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      unwrap(
        client.GET("/v1/agents/{id}/slack/channels", {
          params: {
            path: { id: agentId },
            query: {
              q: query,
              limit: 20,
              ...(pageParam ? { cursor: pageParam } : {}),
            },
          },
        }),
      ),
    getNextPageParam: (last) => last.next_cursor ?? undefined,
    placeholderData: keepPreviousData,
    staleTime: 60_000,
    retry: false,
  });
  const update = useMutation({
    mutationFn: (body: BindingInput) =>
      unwrap(
        client.PUT("/v1/agents/{id}/slack-bindings", {
          params: { path: { id: agentId } },
          body,
        }),
      ),
    onSuccess: async () => {
      setNotice(t("slack.saved"));
      await cache.invalidateQueries({ queryKey: [...key, "bindings"] });
    },
  });
  const rows = bindings.data?.items ?? [];
  const listed = channels.data?.pages.flatMap((page) => page.items) ?? [];
  useEffect(() => {
    if (!channels.data) return;
    setNames((previous) => ({
      ...previous,
      ...Object.fromEntries(
        channels.data.pages.flatMap((page) =>
          page.items.map((item) => [item.id, item.name]),
        ),
      ),
    }));
  }, [channels.data]);
  const error = bindings.error ?? channels.error ?? update.error;
  const change = (row: Binding, checked: boolean) =>
    update.mutate({
      channel_id: row.external_surface_id,
      mode: checked ? "mention" : "off",
      home: row.home,
      ceiling: row.ceiling,
    });
  return (
    <section
      className="flex min-h-96 flex-col gap-6"
      aria-label={t("slack.channels")}
    >
      <h2 className="m-0 text-heading-sm">{t("slack.channels")}</h2>
      <output aria-live="polite">{notice}</output>
      {error ? (
        <div role="alert">
          <FieldError>{slackFailure(error, t)}</FieldError>
        </div>
      ) : null}
      {bindings.isPending ? (
        <SlackSkeleton />
      ) : (
        <ul className="m-0 list-none divide-y p-0">
          {rows.map((row) => {
            const channel = listed.find(
              (item) => item.id === row.external_surface_id,
            );
            const name =
              row.surface_kind === "dm"
                ? t("slack.dm")
                : channel ||
                    (row.external_surface_id && names[row.external_surface_id])
                  ? `#${channel?.name ?? names[row.external_surface_id ?? ""]}`
                  : row.external_surface_id;
            return (
              <li
                key={row.id}
                className="flex min-h-16 items-center justify-between gap-4 py-3"
              >
                <div className="min-w-0">
                  <span className="break-words font-medium">{name}</span>
                  {row.home ? (
                    <Badge className="ml-2" variant="gray">
                      {t("slack.home")}
                    </Badge>
                  ) : null}
                  <div className="mt-1 flex gap-2">
                    <Badge
                      variant={
                        row.surface_kind === "public_channel" ? "green" : "gray"
                      }
                    >
                      {t(
                        row.surface_kind === "private_channel"
                          ? "slack.private"
                          : row.surface_kind === "dm"
                            ? "slack.dm"
                            : "slack.public",
                      )}
                    </Badge>
                    <span className="text-caption text-muted-foreground">
                      {t(row.mode === "off" ? "slack.off" : "slack.mention")}
                    </span>
                    {row.surface_kind === "private_channel" &&
                    row.status !== "ready" ? (
                      <Badge variant="gray">{t("slack.privateInvite")}</Badge>
                    ) : null}
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-3">
                  {row.external_surface_id && !row.home ? (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={update.isPending}
                      onClick={() =>
                        update.mutate({
                          channel_id: row.external_surface_id,
                          mode: row.mode === "off" ? "off" : "mention",
                          home: true,
                          ceiling: row.ceiling,
                        })
                      }
                    >
                      {t("slack.setHome")}
                    </Button>
                  ) : null}
                  <Switch
                    aria-label={t("slack.reaction", { channel: name ?? "" })}
                    checked={row.mode === "mention"}
                    aria-disabled={update.isPending || row.mode === "ambient"}
                    onCheckedChange={(checked) => {
                      if (!update.isPending && row.mode !== "ambient")
                        change(row, checked);
                    }}
                  />
                </div>
              </li>
            );
          })}
        </ul>
      )}
      <div className="flex items-center justify-between gap-4">
        <span>{t("slack.defaultReaction")}</span>
        <Switch
          aria-label={t("slack.defaultReaction")}
          checked={defaultMention}
          onCheckedChange={setDefaultMention}
        />
      </div>
      <Field>
        <FieldLabel>{t("slack.search")}</FieldLabel>
        <Input
          value={input}
          maxLength={80}
          onChange={(event) => setInput(event.target.value)}
        />
      </Field>
      <div aria-busy={channels.isFetching || input.trim() !== query}>
        <ul className="m-0 list-none divide-y p-0">
          {listed.map((channel) => (
            <li
              key={channel.id}
              className="flex min-h-16 items-center justify-between gap-4 py-3"
            >
              <div className="min-w-0">
                <div className="break-words font-medium">#{channel.name}</div>
                <div className="mt-1 flex flex-wrap gap-2">
                  <Badge variant={channel.is_private ? "gray" : "green"}>
                    {t(channel.is_private ? "slack.private" : "slack.public")}
                  </Badge>
                  {!channel.is_member ? (
                    <Badge variant="gray">{t("slack.invite")}</Badge>
                  ) : null}
                </div>
              </div>
              <Button
                type="button"
                variant="outline"
                disabled={
                  update.isPending ||
                  !bindings.isSuccess ||
                  channels.isPlaceholderData ||
                  input.trim() !== query ||
                  rows.some((row) => row.external_surface_id === channel.id)
                }
                onClick={() =>
                  update.mutate({
                    channel_id: channel.id,
                    mode: defaultMention ? "mention" : "off",
                    home: false,
                  })
                }
              >
                {t("slack.add")}
              </Button>
            </li>
          ))}
        </ul>
        {!channels.isPending && listed.length === 0 ? (
          <p>{t("slack.noChannels")}</p>
        ) : null}
        {channels.data?.pages.some((page) => page.stale || page.truncated) ? (
          <p className="text-muted-foreground">{t("slack.partial")}</p>
        ) : null}
        {channels.hasNextPage ? (
          <Button
            type="button"
            variant="outline"
            disabled={channels.isFetching}
            onClick={() => void channels.fetchNextPage()}
          >
            {t("slack.more")}
          </Button>
        ) : null}
        {channels.error ? (
          <Button
            type="button"
            variant="outline"
            onClick={() => void channels.refetch()}
          >
            {t("slack.refresh")}
          </Button>
        ) : null}
      </div>
    </section>
  );
}

export default function SlackTab({
  agentId,
  active,
}: {
  readonly agentId: string;
  readonly active: boolean;
}) {
  const { t } = useI18n();
  const [segment, setSegment] = useState("overview");
  const [channelsOpened, setChannelsOpened] = useState(false);
  return (
    <Tabs
      value={segment}
      onValueChange={(next) => {
        setSegment(next);
        if (next === "channels") setChannelsOpened(true);
      }}
    >
      <TabsList aria-label={t("slack.sections")}>
        <TabsTrigger value="overview">{t("slack.overview")}</TabsTrigger>
        <TabsTrigger value="channels">{t("slack.channels")}</TabsTrigger>
      </TabsList>
      <TabsContent value="overview" forceMount hidden={segment !== "overview"}>
        <SlackConnect agentId={agentId} active={active} />
      </TabsContent>
      <TabsContent value="channels" forceMount hidden={segment !== "channels"}>
        {channelsOpened ? <SlackChannels agentId={agentId} /> : null}
      </TabsContent>
    </Tabs>
  );
}
