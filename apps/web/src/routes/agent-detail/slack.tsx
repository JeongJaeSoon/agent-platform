import {
  keepPreviousData,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useLocation, useNavigate } from "@tanstack/react-router";
import { type ApiClient, type components, unwrap } from "@werft-ai/client";
import { queryKeysOf } from "@werft-ai/core";
import { useAgentPlatform } from "@werft-ai/react";
import {
  Alert,
  AlertDescription,
  AlertTitle,
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
  Link,
  RowList,
  RowListItem,
  SettingRow,
  SideNav,
  SideNavGroup,
  SideNavLayout,
  SideNavLink,
  Skeleton,
  Switch,
} from "@werft-ai/ui";
import { Copy, Plus } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useMe } from "../../auth/guard.tsx";
import { copyText } from "../../components/copy.ts";
import {
  errorKey,
  type MessageKey,
  type Translate,
  useI18n,
} from "../../i18n/i18n.tsx";
import { useAppServices } from "../../services.tsx";
import { storeOff } from "../workspace-slack.tsx";
import { type Notify, useToast } from "./toast.tsx";
import { useCurrentSection } from "./use-current-section.ts";
import { usePageFits } from "./use-page-fits.ts";

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
// The DM row is an on/off switch, so mention reads as on there.
const dmKey = (dm: Binding | undefined) =>
  !dm
    ? "slack.notConfigured"
    : dm.mode === "mention"
      ? "slack.on"
      : modeKey(dm.mode);

const SECTION = {
  channels: "slack-channels",
  basic: "slack-basic",
  advanced: "slack-advanced",
  danger: "slack-danger",
} as const;
type SectionKey = keyof typeof SECTION;
const SECTION_LABEL = {
  channels: "slack.channels",
  basic: "slack.basic",
  advanced: "slack.advanced",
  danger: "slack.danger",
} as const;
const SLACK_WARNING_KEY = {
  repository_required: {
    title: "slack.repositoryRequired.title",
    body: "slack.repositoryRequired.body",
  },
  profile_unavailable: {
    title: "slack.profileUnavailable.title",
    body: "slack.profileUnavailable.body",
  },
  no_active_release: {
    title: "slack.noActiveRelease.title",
    body: "slack.noActiveRelease.body",
  },
} as const satisfies Record<
  components["schemas"]["GetSlackAppResponse"]["warnings"][number]["code"],
  { title: MessageKey; body: MessageKey }
>;
const SECTION_BOX =
  "flex scroll-mt-4 flex-col gap-[var(--ap-space-block)] outline-none";
const HEADING = "m-0 font-semibold text-body leading-5";
const EVENTS_BADGE = {
  verified: "green",
  pending: "amber",
  failed: "red",
} as const;

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
  if (storeOff(error)) return t("workspace.tokenStoreUnavailable");
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

/** Under the agent's key, so whatever refreshes the agent refreshes these. */
export const slackKey = (client: ApiClient, agentId: string) =>
  [...queryKeysOf(client).agent(agentId), "slack"] as const;

function useSlackState(agentId: string) {
  const { client } = useAgentPlatform();
  const key = slackKey(client, agentId);
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
    queryKey: [...slackKey(client, agentId), "bindings"],
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

function useSlackSettings(agentId: string) {
  const { client } = useAgentPlatform();
  return useQuery({
    queryKey: [...slackKey(client, agentId), "settings"],
    queryFn: () =>
      unwrap(
        client.GET("/v1/agents/{id}/slack/app/settings", {
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
    queryKey: [...slackKey(client, agentId), "channels", query],
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

/**
 * The server joins a public channel once its response is on, so only a
 * private channel waits for `/invite`. The binding's membership wins; a
 * channel not bound or not checked yet falls back to the channel list.
 */
function awaitsInvite(
  binding: Binding | undefined,
  listed: { readonly private?: boolean; readonly member: boolean } | undefined,
): boolean {
  if (binding?.membership)
    return binding.membership.state === "awaiting_invite";
  const isPrivate = binding
    ? binding.surface_kind === "private_channel"
    : listed?.private;
  return Boolean(isPrivate && listed && !listed.member);
}

/** Copies the `/invite` line for a channel the bot has not joined. */
function InviteCopy({
  command,
  notify,
}: {
  readonly command: string;
  readonly notify: Notify;
}) {
  const { t } = useI18n();
  const [manual, setManual] = useState(false);
  const field = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (manual) field.current?.focus();
  }, [manual]);
  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-5 min-w-5 px-1"
        aria-label={t("slack.copyInvite")}
        title={command}
        onClick={() => {
          void copyText(command, field).then((ok) => {
            setManual(!ok);
            notify(t(ok ? "slack.copied" : "slack.copyFailed"));
          });
        }}
      >
        <Copy aria-hidden="true" className="size-3.5 shrink-0" />
      </Button>
      {manual ? (
        <Input
          ref={field}
          readOnly
          value={command}
          size={command.length}
          aria-label={t("slack.inviteCommand")}
          className="h-6 w-auto px-2 font-mono text-caption"
          onFocus={(event) => event.currentTarget.select()}
        />
      ) : null}
    </>
  );
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

function slackState(
  error: unknown,
  identity: object | undefined,
  record:
    | {
        readonly secrets: { readonly slack_bot_token: { configured: boolean } };
      }
    | null
    | undefined,
) {
  return error
    ? "error"
    : identity
      ? "connected"
      : record?.secrets.slack_bot_token.configured
        ? "reinstall"
        : record
          ? "pending"
          : "none";
}

function SlackStatus({ agentId }: { readonly agentId: string }) {
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
  const state = slackState(error, identity, app.data?.slack_app);
  const placeholder = <Skeleton className="h-5 w-24" />;
  const bindingsLost = bindings.isError && !bindings.data;
  const record = app.data?.slack_app;
  // Until a Request URL has gone to Slack there is nothing to verify.
  const unverifiedApp =
    app.data?.events.state === "pending" &&
    app.data.events.url !== null &&
    record?.state === "created"
      ? record.app_id
      : null;
  return (
    <section
      className="flex flex-col gap-[var(--ap-space-block)]"
      aria-label={t("slack.status")}
    >
      {error ? <FieldError>{slackFailure(error, t)}</FieldError> : null}
      {unverifiedApp ? (
        <Alert variant="amber">
          <AlertTitle>{t("slack.eventsPending.title")}</AlertTitle>
          <AlertDescription>
            {t("slack.eventsPending.body")}{" "}
            <Link
              href={`https://api.slack.com/apps/${encodeURIComponent(unverifiedApp)}/app-manifest`}
              target="_blank"
              newTabLabel={t("slack.newTab")}
              underline="always"
            >
              {t("slack.eventsPending.open")}
            </Link>
          </AlertDescription>
        </Alert>
      ) : null}
      <RowList variant="joined">
        <RowListItem className="flex flex-wrap items-center gap-x-4 gap-y-2 text-control">
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
          <span className="flex items-center gap-2">
            <span className="text-muted-foreground">{t("slack.botId")}</span>
            <span className="font-mono text-caption">
              {identity?.bot_user_id ?? "—"}
            </span>
          </span>
          <span className="flex items-center gap-2">
            <span className="text-muted-foreground">
              {t("slack.homeChannel")}
            </span>
            {bindings.isPending || (home && channels.isPending) ? (
              placeholder
            ) : (
              <span>
                {bindingsLost
                  ? "—"
                  : homeName
                    ? `#${homeName}`
                    : home?.external_surface_id
                      ? t("slack.channelId", { id: home.external_surface_id })
                      : t("slack.homeUnset")}
              </span>
            )}
          </span>
          <span className="flex items-center gap-2">
            <span className="text-muted-foreground">
              {t("slack.dmSetting")}
            </span>
            {bindings.isPending ? (
              placeholder
            ) : (
              <span>{bindingsLost ? "—" : t(dmKey(dm))}</span>
            )}
          </span>
        </RowListItem>
      </RowList>
    </section>
  );
}

export function SlackConnect({
  agentId,
  active = true,
  manage = true,
  inPage = false,
  notify,
}: {
  readonly agentId: string;
  readonly active?: boolean;
  readonly manage?: boolean;
  /** Rendered as the side list's Advanced section, below the status strip. */
  readonly inPage?: boolean;
  /** Offers app ID copy and open actions, reporting the copy through it. */
  readonly notify?: Notify;
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
  // At most one: the server reports the first reason sessions would fail.
  const warning = app.data?.warnings[0];
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
  const recheck = useMutation({
    onMutate: () => setNotice(""),
    mutationFn: () =>
      unwrap(
        client.POST("/v1/agents/{id}/slack/app/events/recheck", {
          params: { path: { id: agentId } },
        }),
      ),
    onSuccess: async (read) => {
      setNotice(
        t(
          read.events.state === "verified"
            ? "slack.eventsUrl.done"
            : "slack.eventsUrl.sent",
        ),
      );
      await refresh();
    },
  });
  const error =
    app.error ??
    identities.error ??
    connect.error ??
    remove.error ??
    revoke.error ??
    recheck.error;
  const errorText = error ? slackFailure(error, t) : "";
  if (app.isPending || identities.isPending) return <SlackSkeleton />;
  const busy =
    connect.isPending ||
    remove.isPending ||
    revoke.isPending ||
    recheck.isPending;
  const events = app.data?.events;
  const pending = record?.state === "creating" || record?.state === "deleting";
  const status = slackState(error, identity, record);
  return (
    <>
      <section
        id={SECTION.advanced}
        tabIndex={-1}
        className={SECTION_BOX}
        aria-labelledby={`${SECTION.advanced}-title`}
      >
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 id={`${SECTION.advanced}-title`} className={HEADING}>
            {t(
              inPage || (record && identity)
                ? manage
                  ? "slack.advanced"
                  : "slack.connection"
                : "slack.app",
            )}
          </h2>
          {inPage ? null : (
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
          )}
        </div>
        {warning ? (
          <Alert variant="amber">
            <AlertTitle>{t(SLACK_WARNING_KEY[warning.code].title)}</AlertTitle>
            <AlertDescription>
              {t(SLACK_WARNING_KEY[warning.code].body, {
                profile: "profile_id" in warning ? warning.profile_id : "",
              })}
            </AlertDescription>
          </Alert>
        ) : null}
        {record && (record.app_id || manage) ? (
          <RowList variant="joined">
            {record.app_id ? (
              <SettingRow
                title={t("slack.appId")}
                meta={
                  <span className="font-mono text-caption">
                    {record.app_id}
                  </span>
                }
                actions={
                  notify ? (
                    <>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        aria-label={t("slack.copyAppId")}
                        onClick={() => {
                          const value = record.app_id ?? "";
                          void copyText(value, { current: null }).then((ok) =>
                            notify(
                              t(ok ? "slack.copied" : "slack.copyAppIdFailed"),
                            ),
                          );
                        }}
                      >
                        <Copy aria-hidden="true" strokeWidth={1.5} />
                        {t("slack.copy")}
                      </Button>
                      <Button asChild variant="outline" size="sm">
                        <Link
                          href={`https://api.slack.com/apps/${encodeURIComponent(record.app_id)}`}
                          target="_blank"
                          newTabLabel={t("slack.newTab")}
                          className="text-inherit hover:no-underline"
                        >
                          {t("slack.openInSlack")}
                        </Link>
                      </Button>
                    </>
                  ) : null
                }
              />
            ) : null}
            {!inPage && record.app_id && identity ? (
              <SettingRow
                title={t("slack.botId")}
                meta={
                  <span className="font-mono text-caption">
                    {identity.bot_user_id}
                  </span>
                }
              />
            ) : null}
            {manage ? (
              <SettingRow
                title={t(identity ? "slack.reinstallTitle" : "slack.install")}
                description={t(
                  identity ? "slack.reinstallHint" : "slack.installHint",
                )}
                actions={
                  <>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={
                        busy ||
                        pending ||
                        Boolean(app.error || identities.error)
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
            ) : null}
            {manage &&
            identity &&
            record.state === "created" &&
            events &&
            app.data?.event_url ? (
              <SettingRow
                title={t("slack.eventsUrl.title")}
                description={t("slack.eventsUrl.hint")}
                badge={
                  <Badge
                    variant={
                      events.url === null ? "gray" : EVENTS_BADGE[events.state]
                    }
                  >
                    {t(
                      events.url === null
                        ? "slack.eventsUrl.unsent"
                        : `slack.eventsUrl.${events.state}`,
                    )}
                  </Badge>
                }
                actions={
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={busy || pending}
                    onClick={() => recheck.mutate()}
                  >
                    {recheck.isPending
                      ? t("slack.working")
                      : t("slack.eventsUrl.recheck")}
                  </Button>
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
          <p className="m-0 text-muted-foreground">
            {t("slack.activateFirst")}
          </p>
        ) : null}
        {!record ? (
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
      {manage && record ? (
        <section
          id={SECTION.danger}
          tabIndex={-1}
          className={SECTION_BOX}
          aria-labelledby={`${SECTION.danger}-title`}
        >
          <h2 id={`${SECTION.danger}-title`} className={HEADING}>
            {t("slack.danger")}
          </h2>
          <RowList
            variant="joined"
            className="border-(color:--ap-tone-danger-border)"
          >
            {identity ? (
              <SettingRow
                title={t("slack.revokeTitle")}
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
              title={t("slack.deleteTitle")}
              description={t("slack.deleteWarning")}
              actions={
                <Button
                  type="button"
                  variant="destructive"
                  size="sm"
                  // A delete Slack refused leaves the app "deleting"; asking
                  // again is how it finishes.
                  disabled={
                    busy || record?.state === "creating" || !me?.workspace
                  }
                  onClick={() => setDeleting(true)}
                >
                  {t("slack.delete")}
                </Button>
              }
            />
          </RowList>
        </section>
      ) : null}
    </>
  );
}

function SlackChannels({
  agentId,
  invite,
  notify,
  homeStep = false,
}: {
  readonly agentId: string;
  /** The line to paste in a channel to add the bot. */
  readonly invite: string;
  readonly notify: Notify;
  /** Installed with no home yet: only picking the home is offered. */
  readonly homeStep?: boolean;
}) {
  const { t } = useI18n();
  const { client } = useAgentPlatform();
  const cache = useQueryClient();
  const key = slackKey(client, agentId);
  const [input, setInput] = useState("");
  const [query, setQuery] = useState("");
  const [picking, setPicking] = useState(false);
  const [pickHome, setPickHome] = useState(false);
  const pickerOpener = useRef<HTMLButtonElement | null>(null);
  const [notice, setNotice] = useState("");
  const [names, setNames] = useState<
    Record<string, { readonly name: string; readonly member: boolean }>
  >({});
  useEffect(() => {
    const timer = setTimeout(() => setQuery(input.trim()), 300);
    return () => clearTimeout(timer);
  }, [input]);
  const bindings = useSlackBindings(agentId);
  const channels = useSlackChannels(agentId, query);
  // A new binding takes the saved default; until it is read there is none.
  const settings = useSlackSettings(agentId);
  const defaultMode = settings.data?.default_mode;
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
      if (change.kind === "connect") notify(t("slack.channelConnected"));
      else
        setNotice(
          t(change.kind === "home" ? "slack.homeSaved" : "slack.saved"),
        );
      setPicking(false);
      await cache.invalidateQueries({ queryKey: [...key, "bindings"] });
    },
    onError: (failure, change) => {
      // The picker's FieldError already announces it.
      if (change.kind === "connect")
        notify(slackFailure(failure, t), { silent: true });
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
          page.items.map((item) => [
            item.id,
            { name: item.name, member: item.is_member },
          ]),
        ),
      ),
    }));
  }, [channels.data]);
  const error = bindings.error ?? channels.error ?? update.error;
  const modeFor = (row: Binding | undefined) =>
    // The first home is always in use, even a channel someone switched off.
    row && !(homeStep && row.mode === "off") ? row.mode : defaultMode;
  const connectChannel = (channelId: string) => {
    const row = rows.find((item) => item.external_surface_id === channelId);
    const mode = modeFor(row);
    if (!mode) return;
    update.mutate({
      kind: pickHome ? "home" : "connect",
      body: {
        channel_id: channelId,
        mode,
        home: pickHome || (row?.home ?? false),
        ...(row ? { ceiling: row.ceiling } : {}),
      },
    });
  };
  const change = (row: Binding, mode: Binding["mode"]) => {
    if (!update.isPending)
      update.mutate({
        kind: "reaction",
        body: {
          channel_id: row.external_surface_id,
          mode,
          home: row.home,
          ceiling: row.ceiling,
        },
      });
  };
  return (
    <section
      id={SECTION.channels}
      tabIndex={-1}
      className={SECTION_BOX}
      aria-labelledby={`${SECTION.channels}-title`}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id={`${SECTION.channels}-title`} className={HEADING}>
          {t(homeStep ? "slack.homeStep" : "slack.connectedChannels")}
        </h2>
        {/* Until the bindings load, it is not known which step this is. */}
        {bindings.isPending ? null : (
          <div className="flex flex-wrap justify-end gap-2">
            <Button
              type="button"
              variant={homeStep ? "default" : "outline"}
              size="sm"
              onClick={(event) => {
                pickerOpener.current = event.currentTarget;
                setPickHome(true);
                setPicking(true);
              }}
            >
              {t(homeStep ? "slack.pickHome" : "slack.setHome")}
            </Button>
            {homeStep ? null : (
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
                <Plus aria-hidden="true" strokeWidth={1.5} />
                {t("slack.addChannel")}
              </Button>
            )}
          </div>
        )}
      </div>
      {homeStep ? (
        <p className="m-0 text-control text-muted-foreground">
          {t("slack.homeStepHint")}
        </p>
      ) : null}
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
      {homeStep ? null : bindings.isPending ? (
        <ChannelSkeleton />
      ) : bindings.isError && !bindings.data ? null : rows.length === 0 ? (
        <EmptyState
          title={t("slack.noConnectedChannels")}
          description={t("slack.addChannelHint")}
        />
      ) : (
        <RowList variant="joined" aria-label={t("slack.connectedChannels")}>
          {rows.map((row) => {
            const known = row.external_surface_id
              ? names[row.external_surface_id]
              : undefined;
            const name =
              row.surface_kind === "dm"
                ? t("slack.dm")
                : known
                  ? `#${known.name}`
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
                meta={
                  awaitsInvite(row, known) ? (
                    <span className="flex flex-wrap items-center gap-1">
                      <Badge variant="gray">{t("slack.privateInvite")}</Badge>
                      <InviteCopy command={invite} notify={notify} />
                    </span>
                  ) : undefined
                }
                status={
                  <span className="text-control text-muted-foreground">
                    {t(modeKey(row.mode))}
                  </span>
                }
                actions={
                  <>
                    <span className="flex items-center gap-2">
                      <span aria-hidden="true" className="text-control">
                        {t("slack.inUse")}
                      </span>
                      <Switch
                        aria-label={t("slack.inUseOf", { channel: name })}
                        checked={row.mode !== "off"}
                        aria-disabled={update.isPending}
                        onCheckedChange={(checked) =>
                          // Back in use, a channel waits for a mention until
                          // someone chooses otherwise.
                          change(row, checked ? "mention" : "off")
                        }
                      />
                    </span>
                    <span className="flex items-center gap-2">
                      <span aria-hidden="true" className="text-control">
                        {t("slack.mentionOnly")}
                      </span>
                      <Switch
                        aria-label={t("slack.reaction", { channel: name })}
                        checked={row.mode === "mention"}
                        aria-disabled={update.isPending || row.mode === "off"}
                        onCheckedChange={(checked) => {
                          if (row.mode !== "off")
                            change(row, checked ? "mention" : "ambient");
                        }}
                      />
                    </span>
                  </>
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
            <DialogDescription>{t("slack.joinHintAuto")}</DialogDescription>
          </DialogHeader>
          {(error ?? settings.error) ? (
            <FieldError>{slackFailure(error ?? settings.error, t)}</FieldError>
          ) : null}
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
                      <span className="flex flex-wrap items-center gap-2">
                        <Badge variant={channel.is_private ? "gray" : "green"}>
                          {t(
                            channel.is_private
                              ? "slack.private"
                              : "slack.public",
                          )}
                        </Badge>
                        {awaitsInvite(
                          rows.find(
                            (row) => row.external_surface_id === channel.id,
                          ),
                          {
                            private: channel.is_private,
                            member: channel.is_member,
                          },
                        ) ? (
                          <span className="flex flex-wrap items-center gap-1">
                            <Badge variant="gray">
                              {t("slack.privateInvite")}
                            </Badge>
                            <InviteCopy command={invite} notify={notify} />
                          </span>
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
                          !modeFor(
                            rows.find(
                              (row) => row.external_surface_id === channel.id,
                            ),
                          ) ||
                          channels.isPlaceholderData ||
                          input.trim() !== query ||
                          (!pickHome &&
                            rows.some(
                              (row) => row.external_surface_id === channel.id,
                            ))
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
      title={t("slack.dmSetting")}
      description={t("slack.dmHint")}
      status={
        <span className="text-control text-muted-foreground">
          {bindings.isError && !bindings.data ? "—" : t(dmKey(dm))}
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

function SlackDefaultReaction({ agentId }: { readonly agentId: string }) {
  const { t } = useI18n();
  const { client } = useAgentPlatform();
  const cache = useQueryClient();
  const settings = useSlackSettings(agentId);
  const [notice, setNotice] = useState("");
  const update = useMutation({
    onMutate: async () => {
      setNotice("");
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
          body: { default_mode: checked ? "mention" : "ambient" },
        }),
      ),
    onSuccess: (saved) => {
      cache.setQueryData([...slackKey(client, agentId), "settings"], saved);
      setNotice(
        t("slack.defaultSaved", { mode: t(modeKey(saved.default_mode)) }),
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
  const mention = settings.data?.default_mode === "mention";
  const error = settings.error ?? update.error;
  return (
    <SettingRow
      title={t("slack.defaultReaction")}
      description={t("slack.defaultHint")}
      status={
        <span className="text-control text-muted-foreground">
          {lost
            ? "—"
            : settings.data
              ? t(modeKey(settings.data.default_mode))
              : null}
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
        lost ? null : (
          <Switch
            aria-label={t("slack.defaultMentionOnly")}
            checked={mention}
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

export default function SlackTab({
  agentId,
  slug,
  active,
}: {
  readonly agentId: string;
  /** The app manifest names the bot after it. */
  readonly slug: string;
  readonly active: boolean;
}) {
  const { t } = useI18n();
  const { notify, toast } = useToast();
  const navigate = useNavigate();
  const justInstalled = useLocation({
    select: (location) => location.state.slackInstalled === true,
  });
  useEffect(() => {
    if (!justInstalled) return;
    notify(t("slack.installed"));
    // A reload or Back must not repeat the notice.
    void navigate({
      to: ".",
      search: true,
      replace: true,
      state: ({ slackInstalled: _, ...rest }) => rest,
    });
  }, [justInstalled, notify, navigate, t]);
  const { app, identities } = useSlackState(agentId);
  const bindings = useSlackBindings(agentId);
  const installed =
    identities.data?.items.some((item) => item.status === "active") ?? false;
  // An installed agent picks its home before anything else in the tab. A
  // failed refetch keeps the last data, so the step follows the data.
  const homeStep =
    installed &&
    bindings.data !== undefined &&
    !bindings.data.items.some((binding) => binding.home);
  // The danger zone exists only while there is an app to revoke or delete.
  const keys: readonly SectionKey[] = [
    "channels",
    ...(homeStep ? [] : (["basic"] as const)),
    "advanced",
    ...(app.data?.slack_app ? (["danger"] as const) : []),
  ];
  const [current, setCurrent] = useCurrentSection(
    keys.map((key) => SECTION[key]),
  );
  const jumped = useRef<string>(undefined);
  // With nothing to scroll to, the wide list only takes room from the page.
  const [fits, watchPage] = usePageFits();
  // The list also hides when the window widens past lg while the page fits.
  useLayoutEffect(() => {
    if (!fits) return;
    const leave = () => {
      const nav = document.activeElement?.closest("[data-slot=side-nav]");
      if (!nav || nav.getClientRects().length > 0) return;
      document.getElementById(current ?? "")?.focus({ preventScroll: true });
    };
    leave();
    window.addEventListener("resize", leave);
    return () => window.removeEventListener("resize", leave);
  }, [fits, current]);
  const [wasConnected, setWasConnected] = useState(installed);
  useEffect(() => {
    if (installed) setWasConnected(true);
  }, [installed]);
  if (!installed && !wasConnected) {
    return (
      <div className="flex flex-col gap-8">
        <SlackConnect agentId={agentId} active={active} />
        {toast}
      </div>
    );
  }
  const link = (key: SectionKey) => (
    <SideNavLink
      key={key}
      href={`#${SECTION[key]}`}
      current={current === SECTION[key] ? "location" : undefined}
      onClick={(event) => {
        // Stay off the URL hash: the router owns the location.
        event.preventDefault();
        const target = document.getElementById(SECTION[key]);
        target?.scrollIntoView({
          block: "start",
          behavior: matchMedia("(prefers-reduced-motion: reduce)").matches
            ? "auto"
            : "smooth",
        });
        target?.focus({ preventScroll: true });
        jumped.current = SECTION[key];
        setCurrent(SECTION[key]);
      }}
    >
      {t(SECTION_LABEL[key])}
    </SideNavLink>
  );
  const here = keys.find((key) => SECTION[key] === current);
  return (
    <>
      <SideNavLayout
        nav={
          <SideNav
            aria-label={t("slack.sectionNav")}
            className={fits ? "lg:hidden" : undefined}
            current={here ? t(SECTION_LABEL[here]) : undefined}
            // Folding the list sends focus to its button; take it back to
            // the section the link jumped to.
            onPick={() =>
              document
                .getElementById(jumped.current ?? "")
                ?.focus({ preventScroll: true })
            }
          >
            <SideNavGroup>
              {link("channels")}
              {homeStep ? null : link("basic")}
            </SideNavGroup>
            <SideNavGroup label={t("slack.manage")}>
              {link("advanced")}
              {keys.includes("danger") ? link("danger") : null}
            </SideNavGroup>
          </SideNav>
        }
      >
        <div ref={watchPage} className="flex flex-col gap-8">
          <SlackStatus agentId={agentId} />
          <SlackChannels
            agentId={agentId}
            invite={`/invite @${slug}`}
            notify={notify}
            homeStep={homeStep}
          />
          {homeStep ? null : (
            <section
              id={SECTION.basic}
              tabIndex={-1}
              className={SECTION_BOX}
              aria-labelledby={`${SECTION.basic}-title`}
            >
              <h2 id={`${SECTION.basic}-title`} className={HEADING}>
                {t("slack.basic")}
              </h2>
              <RowList variant="joined">
                <SlackDmSetting agentId={agentId} />
                <SlackDefaultReaction agentId={agentId} />
              </RowList>
            </section>
          )}
          <SlackConnect
            agentId={agentId}
            active={active}
            inPage
            notify={notify}
          />
        </div>
      </SideNavLayout>
      {toast}
    </>
  );
}
