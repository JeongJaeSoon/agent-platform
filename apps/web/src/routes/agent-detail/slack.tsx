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
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  EmptyState,
  Field,
  FieldError,
  FieldLabel,
  Input,
  KeyValueList,
  RowList,
  RowListItem,
  SettingRow,
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
type BindingChange = {
  readonly body: BindingInput;
  readonly kind: "reaction" | "home" | "connect";
};
const modeKey = (mode: Binding["mode"]) =>
  mode === "ambient"
    ? "slack.ambient"
    : mode === "off"
      ? "slack.off"
      : "slack.mention";

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

function useSlackState(agentId: string) {
  const { client } = useAgentPlatform();
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
  return { app, identities, key };
}

function useSlackBindings(agentId: string) {
  const { client } = useAgentPlatform();
  return useQuery({
    queryKey: ["agents", agentId, "slack", "bindings"],
    queryFn: () =>
      unwrap(
        client.GET("/v1/agents/{id}/slack-bindings", {
          params: { path: { id: agentId } },
        }),
      ),
    staleTime: 30_000,
    retry: false,
  });
}

function useSlackChannels(agentId: string, query: string) {
  const { client } = useAgentPlatform();
  return useInfiniteQuery({
    queryKey: ["agents", agentId, "slack", "channels", query],
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
}

function ChannelSkeleton() {
  const { t } = useI18n();
  return (
    <RowList
      variant="joined"
      aria-busy="true"
      aria-label={t("slack.channelsLoading")}
    >
      {["first", "second"].map((key) => (
        <RowListItem key={key}>
          <div className="flex min-h-[calc(1.25rem+var(--ap-row-line-gap)+1rem)] w-full items-center">
            <Skeleton
              lines={2}
              className="w-full"
              label={t("slack.channelsLoading")}
            />
          </div>
        </RowListItem>
      ))}
    </RowList>
  );
}

function SlackOverview({
  agentId,
  onChannels,
}: {
  readonly agentId: string;
  readonly onChannels: () => void;
}) {
  const { t } = useI18n();
  const { app, identities } = useSlackState(agentId);
  const bindings = useSlackBindings(agentId);
  const channels = useSlackChannels(agentId, "");
  const identity = identities.data?.items.find(
    (item) => item.status === "active",
  );
  const dm = bindings.data?.items.find((row) => row.surface_kind === "dm");
  const home = bindings.data?.items.find((row) => row.home);
  const homeName = channels.data?.pages
    .flatMap((page) => page.items)
    .find((channel) => channel.id === home?.external_surface_id)?.name;
  const error = app.error ?? identities.error ?? bindings.error;
  const state = error
    ? "error"
    : identity
      ? "connected"
      : app.data?.slack_app
        ? "reinstall"
        : "none";
  const placeholder = <Skeleton className="h-5 w-24" />;
  return (
    <div className="flex flex-col gap-[var(--ap-space-block)]">
      {error ? <FieldError>{slackFailure(error, t)}</FieldError> : null}
      <section className="flex flex-col gap-[var(--ap-space-block)]">
        <h2 className="m-0 font-semibold text-body leading-5">
          {t("slack.status")}
        </h2>
        <RowList variant="joined">
          <RowListItem className="grid grid-cols-1 gap-x-6 sm:grid-cols-2">
            <div className="flex min-h-8 items-center gap-2 text-control">
              <span className="text-muted-foreground">
                {t("slack.connection")}:
              </span>
              <span>{t(`slack.state.${state}`)}</span>
            </div>
            <div className="flex min-h-8 items-center gap-2 text-control">
              <span className="text-muted-foreground">{t("slack.dm")}:</span>
              {bindings.isPending ? (
                placeholder
              ) : (
                <span>
                  {bindings.isError && !bindings.data
                    ? "—"
                    : t(dm ? modeKey(dm.mode) : "slack.notConfigured")}
                </span>
              )}
            </div>
          </RowListItem>
        </RowList>
      </section>
      <section className="flex flex-col gap-[var(--ap-space-block)]">
        <h2 className="m-0 font-semibold text-body leading-5">
          {t("slack.connection")}
        </h2>
        <RowList variant="joined">
          <RowListItem>
            <KeyValueList
              variant="grid"
              className="w-full"
              items={[
                {
                  label: t("slack.status"),
                  value: (
                    <Badge
                      variant={
                        state === "connected"
                          ? "green"
                          : state === "error"
                            ? "red"
                            : "gray"
                      }
                    >
                      {t(`slack.state.${state}`)}
                    </Badge>
                  ),
                },
                {
                  label: t("slack.botId"),
                  value: (
                    <span className="font-mono">
                      {identity?.bot_user_id ?? "—"}
                    </span>
                  ),
                },
                {
                  label: t("slack.homeChannel"),
                  value: (
                    <div className="flex flex-col items-start gap-1">
                      {bindings.isPending || (home && channels.isPending) ? (
                        placeholder
                      ) : (
                        <span>
                          {bindings.isError && !bindings.data
                            ? "—"
                            : homeName
                              ? `#${homeName}`
                              : home?.external_surface_id
                                ? t("slack.channelId", {
                                    id: home.external_surface_id,
                                  })
                                : t("slack.homeUnset")}
                        </span>
                      )}
                      <Button
                        type="button"
                        variant="link"
                        size="sm"
                        className="h-auto px-0"
                        aria-label={t("slack.changeHome")}
                        onClick={onChannels}
                      >
                        {t("slack.change")}
                      </Button>
                    </div>
                  ),
                },
              ]}
            />
          </RowListItem>
        </RowList>
      </section>
    </div>
  );
}

export function SlackConnect({
  agentId,
  active = true,
  manage = true,
}: {
  readonly agentId: string;
  readonly active?: boolean;
  readonly manage?: boolean;
}) {
  const { t } = useI18n();
  const { client } = useAgentPlatform();
  const cache = useQueryClient();
  const me = useMe();
  const { leave } = useAppServices();
  const { app, identities, key } = useSlackState(agentId);
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
    onMutate: () => setNotice(""),
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
    onMutate: () => setNotice(""),
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
        <h2 className="m-0 font-semibold text-body leading-5">
          {t(
            record && identity
              ? manage
                ? "slack.advanced"
                : "slack.connection"
              : "slack.app",
          )}
        </h2>
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
        <RowList variant="joined">
          <SettingRow
            title={t("slack.appId")}
            meta={
              <span className="font-mono text-caption">{record.app_id}</span>
            }
          />
          {identity ? (
            <SettingRow
              title={t("slack.botId")}
              meta={
                <span className="font-mono text-caption">
                  {identity.bot_user_id}
                </span>
              }
            />
          ) : null}
        </RowList>
      ) : null}
      <output
        ref={outcome}
        tabIndex={-1}
        aria-live="polite"
        className={notice ? "text-control" : "sr-only"}
      >
        {notice}
      </output>
      {errorText ? (
        <div>
          <FieldError>{errorText}</FieldError>
        </div>
      ) : null}
      {!active ? (
        <p className="m-0 text-muted-foreground">{t("slack.activateFirst")}</p>
      ) : null}
      {manage && record ? (
        <>
          <RowList variant="joined">
            <SettingRow
              title={t(identity ? "slack.reinstall" : "slack.install")}
              actions={
                <>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={
                      busy || pending || Boolean(app.error || identities.error)
                    }
                    onClick={() => connect.mutate()}
                  >
                    {connect.isPending
                      ? t("slack.working")
                      : t(identity ? "slack.reinstall" : "slack.install")}
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={busy || app.isFetching || identities.isFetching}
                    onClick={() => void refresh()}
                  >
                    {t("slack.refresh")}
                  </Button>
                </>
              }
            />
          </RowList>
          <h3 className="m-0 font-semibold text-body leading-5">
            {t("slack.danger")}
          </h3>
          <RowList
            variant="joined"
            className="border-(color:--ap-tone-danger-border)"
          >
            {identity ? (
              <SettingRow
                title={t("slack.revoke")}
                description={t("slack.revokeWarning")}
                actions={
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={busy}
                    onClick={() => setRevoking(true)}
                  >
                    {t("slack.revoke")}
                  </Button>
                }
              />
            ) : null}
            <SettingRow
              title={t("slack.delete")}
              description={t("slack.deleteWarning")}
              actions={
                <Button
                  type="button"
                  variant="destructive"
                  size="sm"
                  disabled={busy || pending || !me?.workspace}
                  onClick={() => setDeleting(true)}
                >
                  {t("slack.delete")}
                </Button>
              }
            />
          </RowList>
        </>
      ) : !record ? (
        <div className="flex flex-wrap gap-2">
          {!app.error && !identities.error ? (
            <Button
              type="button"
              disabled={!active || busy}
              onClick={() => connect.mutate()}
            >
              {connect.isPending
                ? t("slack.working")
                : t("slack.createInstall")}
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
        </div>
      ) : null}
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

function SlackChannels({
  agentId,
  defaultMention,
}: {
  readonly agentId: string;
  readonly defaultMention: boolean;
}) {
  const { t } = useI18n();
  const { client } = useAgentPlatform();
  const cache = useQueryClient();
  const key = ["agents", agentId, "slack"];
  const [input, setInput] = useState("");
  const [query, setQuery] = useState("");
  const [picking, setPicking] = useState(false);
  const [pickHome, setPickHome] = useState(false);
  const pickerOpener = useRef<HTMLButtonElement | null>(null);
  const [notice, setNotice] = useState("");
  const [names, setNames] = useState<Record<string, string>>({});
  useEffect(() => {
    const timer = setTimeout(() => setQuery(input.trim()), 300);
    return () => clearTimeout(timer);
  }, [input]);
  const bindings = useSlackBindings(agentId);
  const channels = useSlackChannels(agentId, query);
  const update = useMutation({
    onMutate: () => setNotice(""),
    mutationFn: ({ body }: BindingChange) =>
      unwrap(
        client.PUT("/v1/agents/{id}/slack-bindings", {
          params: { path: { id: agentId } },
          body,
        }),
      ),
    onSuccess: async (_result, change) => {
      setNotice(
        t(
          change.kind === "home"
            ? "slack.homeSaved"
            : change.kind === "connect"
              ? "slack.channelConnected"
              : "slack.saved",
        ),
      );
      setPicking(false);
      await cache.invalidateQueries({ queryKey: [...key, "bindings"] });
    },
  });
  const rows =
    bindings.data?.items.filter((row) => row.surface_kind !== "dm") ?? [];
  const listed = [
    ...new Map(
      channels.data?.pages.flatMap((page) =>
        page.items.map((item) => [item.id, item] as const),
      ) ?? [],
    ).values(),
  ];
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
  const connectChannel = (channelId: string) => {
    const row = rows.find((item) => item.external_surface_id === channelId);
    update.mutate({
      kind: pickHome ? "home" : "connect",
      body: {
        channel_id: channelId,
        mode: row
          ? row.mode === "off"
            ? "off"
            : "mention"
          : defaultMention
            ? "mention"
            : "off",
        home: pickHome || (row?.home ?? false),
        ...(row ? { ceiling: row.ceiling } : {}),
      },
    });
  };
  const change = (row: Binding, checked: boolean) =>
    update.mutate({
      kind: "reaction",
      body: {
        channel_id: row.external_surface_id,
        mode: checked ? "mention" : "off",
        home: row.home,
        ceiling: row.ceiling,
      },
    });
  return (
    <section
      className="flex min-h-96 flex-col gap-[var(--ap-space-block)]"
      aria-label={t("slack.channels")}
    >
      <p className="m-0 text-control text-muted-foreground">
        {t("slack.joinHint")}
      </p>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="m-0 font-semibold text-body leading-5">
          {t("slack.connectedChannels")}
        </h2>
        <div className="flex flex-wrap justify-end gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={(event) => {
              pickerOpener.current = event.currentTarget;
              setPickHome(true);
              setPicking(true);
            }}
          >
            {t("slack.setHome")}
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={(event) => {
              pickerOpener.current = event.currentTarget;
              setPickHome(false);
              setPicking(true);
            }}
          >
            {t("slack.addChannel")}
          </Button>
        </div>
      </div>
      <output
        aria-live="polite"
        className={notice ? "text-control" : "sr-only"}
      >
        {notice}
      </output>
      {error ? (
        <div>
          <FieldError>{slackFailure(error, t)}</FieldError>
        </div>
      ) : null}
      {bindings.isPending ? (
        <ChannelSkeleton />
      ) : bindings.isError && !bindings.data ? null : rows.length === 0 ? (
        <EmptyState
          title={t("slack.noConnectedChannels")}
          description={t("slack.addChannelHint")}
        />
      ) : (
        <RowList variant="joined" aria-label={t("slack.connectedChannels")}>
          {rows.map((row) => {
            const name =
              row.surface_kind === "dm"
                ? t("slack.dm")
                : row.external_surface_id && names[row.external_surface_id]
                  ? `#${names[row.external_surface_id]}`
                  : t("slack.channelId", { id: row.external_surface_id ?? "" });
            return (
              <SettingRow
                key={row.id}
                title={name}
                badge={
                  row.home ? (
                    <Badge variant="gray">{t("slack.home")}</Badge>
                  ) : undefined
                }
                description={t(
                  row.surface_kind === "private_channel"
                    ? "slack.private"
                    : "slack.public",
                )}
                status={
                  <span className="text-control text-muted-foreground">
                    {t(modeKey(row.mode))}
                  </span>
                }
                control={
                  <Switch
                    aria-label={t("slack.reaction", { channel: name })}
                    checked={row.mode !== "off"}
                    aria-disabled={update.isPending || row.mode === "ambient"}
                    onCheckedChange={(checked) => {
                      if (!update.isPending && row.mode !== "ambient")
                        change(row, checked);
                    }}
                  />
                }
              />
            );
          })}
        </RowList>
      )}
      <Dialog open={picking} onOpenChange={setPicking}>
        <DialogContent
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            pickerOpener.current?.focus();
          }}
        >
          <DialogHeader>
            <DialogTitle>
              {t(pickHome ? "slack.setHome" : "slack.addChannel")}
            </DialogTitle>
            <DialogDescription>{t("slack.joinHint")}</DialogDescription>
          </DialogHeader>
          {error ? <FieldError>{slackFailure(error, t)}</FieldError> : null}
          <Field>
            <FieldLabel>{t("slack.search")}</FieldLabel>
            <Input
              value={input}
              maxLength={80}
              onChange={(event) => setInput(event.target.value)}
            />
          </Field>
          <div
            className="max-h-80 overflow-y-auto"
            aria-busy={channels.isFetching || input.trim() !== query}
          >
            {listed.length > 0 ? (
              <RowList variant="joined">
                {listed.map((channel) => (
                  <SettingRow
                    key={channel.id}
                    title={`#${channel.name}`}
                    description={
                      <span className="flex flex-wrap gap-2">
                        <Badge variant={channel.is_private ? "gray" : "green"}>
                          {t(
                            channel.is_private
                              ? "slack.private"
                              : "slack.public",
                          )}
                        </Badge>
                        {!channel.is_member ? (
                          <Badge variant="gray">
                            {t("slack.privateInvite")}
                          </Badge>
                        ) : null}
                      </span>
                    }
                    actions={
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        aria-label={t(
                          pickHome
                            ? "slack.channelHome"
                            : "slack.channelConnect",
                          {
                            channel: `#${channel.name}`,
                          },
                        )}
                        disabled={
                          update.isPending ||
                          !bindings.isSuccess ||
                          channels.isPlaceholderData ||
                          input.trim() !== query ||
                          (!pickHome &&
                            rows.some(
                              (row) => row.external_surface_id === channel.id,
                            )) ||
                          rows.some(
                            (row) =>
                              row.external_surface_id === channel.id &&
                              row.mode === "ambient",
                          )
                        }
                        onClick={() => connectChannel(channel.id)}
                      >
                        {t(pickHome ? "slack.setHome" : "slack.add")}
                      </Button>
                    }
                  />
                ))}
              </RowList>
            ) : null}
            {channels.isSuccess && listed.length === 0 ? (
              <p>{t("slack.noChannels")}</p>
            ) : null}
            {channels.data?.pages.some(
              (page) => page.stale || page.truncated,
            ) ? (
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
        </DialogContent>
      </Dialog>
    </section>
  );
}

function SlackDmSetting({ agentId }: { readonly agentId: string }) {
  const { t } = useI18n();
  const { client } = useAgentPlatform();
  const cache = useQueryClient();
  const key = ["agents", agentId, "slack", "bindings"];
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
            mode: checked ? "mention" : "off",
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
  const unavailable =
    !bindings.isSuccess || update.isPending || dm?.mode === "ambient";
  const error = bindings.error ?? update.error;
  return (
    <SettingRow
      title={t("slack.dm")}
      description={t("slack.dmHint")}
      status={
        <span className="text-control text-muted-foreground">
          {bindings.isError && !bindings.data
            ? "—"
            : t(dm ? modeKey(dm.mode) : "slack.notConfigured")}
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
            aria-label={t("slack.dm")}
            checked={dm !== undefined && dm.mode !== "off"}
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
  const [settingsOpened, setSettingsOpened] = useState(false);
  const [defaultMention, setDefaultMention] = useState(true);
  const channelsTab = useRef<HTMLButtonElement>(null);
  const { identities } = useSlackState(agentId);
  const installed =
    identities.data?.items.some((item) => item.status === "active") ?? false;
  const [wasConnected, setWasConnected] = useState(installed);
  useEffect(() => {
    if (installed) setWasConnected(true);
  }, [installed]);
  if (!installed && !wasConnected) {
    return <SlackConnect agentId={agentId} active={active} />;
  }
  return (
    <Tabs
      value={segment}
      onValueChange={(next) => {
        setSegment(next);
        if (next === "channels") setChannelsOpened(true);
        if (next === "settings") setSettingsOpened(true);
      }}
    >
      <TabsList aria-label={t("slack.sections")}>
        <TabsTrigger value="overview">{t("slack.overview")}</TabsTrigger>
        <TabsTrigger value="channels" ref={channelsTab}>
          {t("slack.channels")}
        </TabsTrigger>
        <TabsTrigger value="settings">{t("slack.settings")}</TabsTrigger>
      </TabsList>
      <TabsContent value="overview" forceMount hidden={segment !== "overview"}>
        <SlackOverview
          agentId={agentId}
          onChannels={() => {
            setChannelsOpened(true);
            setSegment("channels");
            channelsTab.current?.focus();
          }}
        />
      </TabsContent>
      <TabsContent value="settings" forceMount hidden={segment !== "settings"}>
        {settingsOpened ? (
          <section className="mb-8 flex flex-col gap-[var(--ap-space-block)]">
            <h2 className="m-0 font-semibold text-body leading-5">
              {t("slack.basic")}
            </h2>
            <RowList variant="joined">
              <SlackDmSetting agentId={agentId} />
              <SettingRow
                title={t("slack.defaultReaction")}
                description={t("slack.defaultHint")}
                status={
                  <span className="text-control text-muted-foreground">
                    {t(defaultMention ? "slack.mention" : "slack.off")}
                  </span>
                }
                control={
                  <Switch
                    aria-label={t("slack.defaultReaction")}
                    checked={defaultMention}
                    onCheckedChange={setDefaultMention}
                  />
                }
              />
            </RowList>
          </section>
        ) : null}
        {settingsOpened ? (
          <SlackConnect agentId={agentId} active={active} />
        ) : null}
      </TabsContent>
      <TabsContent value="channels" forceMount hidden={segment !== "channels"}>
        {channelsOpened ? (
          <SlackChannels agentId={agentId} defaultMention={defaultMention} />
        ) : null}
      </TabsContent>
    </Tabs>
  );
}
