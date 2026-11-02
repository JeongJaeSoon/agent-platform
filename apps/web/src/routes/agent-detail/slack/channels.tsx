import { useMutation, useQueryClient } from "@tanstack/react-query";
import { unwrap } from "@werft-ai/client";
import { useAgentPlatform } from "@werft-ai/react";
import {
  Badge,
  Button,
  CopyButton,
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
  RowList,
  RowListItem,
  SettingRow,
  Skeleton,
  Switch,
} from "@werft-ai/ui";
import { Plus } from "lucide-react";
import { type RefObject, useEffect, useId, useRef, useState } from "react";
import { useI18n } from "../../../i18n/i18n.tsx";
import type { Notify } from "../toast.tsx";
import { slackKey, useSlackBindings, useSlackChannels } from "./queries.ts";
import {
  type Binding,
  type BindingChange,
  HEADING,
  RECHECK_ID,
  SECTION,
  SECTION_BOX,
  slackFailure,
} from "./shared.ts";

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
      <CopyButton
        value={command}
        variant="ghost"
        size="sm"
        className="h-5 min-w-5 px-1"
        aria-label={t("slack.copyInvite")}
        title={command}
        icon="copy"
        iconClassName="size-3.5 shrink-0"
        fallbackField={field}
        onResult={(ok) => {
          setManual(!ok);
          notify(t(ok ? "slack.copied" : "slack.copyFailed"));
        }}
      />
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

export function SlackChannels({
  agentId,
  invite,
  notify,
  homeStep = false,
  locked = false,
}: {
  readonly agentId: string;
  /** The line to paste in a channel to add the bot. */
  readonly invite: string;
  readonly notify: Notify;
  /** Installed with no home yet: only picking the home is offered. */
  readonly homeStep?: boolean;
  /** Slack has not checked the Request URL, so no channel would hear the bot. */
  readonly locked?: boolean;
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
  const lockAction = useRef<HTMLButtonElement>(null);
  // A lock that arrives with the picker open closes it; it sits outside inert.
  useEffect(() => {
    if (locked) setPicking(false);
  }, [locked]);
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
  const connectChannel = (channelId: string) => {
    if (locked) return;
    const row = rows.find((item) => item.external_surface_id === channelId);
    update.mutate({
      kind: pickHome ? "home" : "connect",
      body: {
        channel_id: channelId,
        // The first home is always in use, even a channel someone switched off.
        mode: row && !homeStep ? row.mode : "on",
        home: pickHome || (row?.home ?? false),
        ...(row ? { ceiling: row.ceiling } : {}),
      },
    });
  };
  const change = (row: Binding, mode: Binding["mode"]) => {
    if (!update.isPending && !locked)
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
      <div className="grid">
        <div
          inert={locked}
          className={`col-start-1 row-start-1 flex flex-col gap-[var(--ap-space-block)]${locked ? " invisible" : ""}`}
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
                      : t("slack.channelId", {
                          id: row.external_surface_id ?? "",
                        });
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
                          <Badge variant="gray">
                            {t("slack.privateInvite")}
                          </Badge>
                          <InviteCopy command={invite} notify={notify} />
                        </span>
                      ) : undefined
                    }
                    actions={
                      <span className="flex items-center gap-2">
                        <span aria-hidden="true" className="text-control">
                          {t("slack.inUse")}
                        </span>
                        <Switch
                          aria-label={t("slack.inUseOf", { channel: name })}
                          checked={row.mode !== "off"}
                          aria-disabled={update.isPending}
                          onCheckedChange={(checked) =>
                            change(row, checked ? "on" : "off")
                          }
                        />
                      </span>
                    }
                  />
                );
              })}
            </RowList>
          )}
        </div>
        {locked ? <ChannelsLock action={lockAction} /> : null}
      </div>
      <Dialog open={picking} onOpenChange={setPicking}>
        <DialogContent
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            (locked ? lockAction : pickerOpener).current?.focus();
          }}
        >
          <DialogHeader>
            <DialogTitle>
              {t(pickHome ? "slack.setHome" : "slack.addChannel")}
            </DialogTitle>
            <DialogDescription>{t("slack.joinHintAuto")}</DialogDescription>
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

/** Covers the channels, pointing to the advanced section's Recheck. */
function ChannelsLock({
  action,
}: {
  readonly action: RefObject<HTMLButtonElement | null>;
}) {
  const { t } = useI18n();
  const titleId = useId();
  return (
    // biome-ignore lint/a11y/useSemanticElements: a fieldset groups form controls, this is a notice with one button
    <div
      role="group"
      aria-labelledby={titleId}
      className="col-start-1 row-start-1 flex flex-col items-center justify-center gap-2 rounded-card border border-(color:--ap-tone-caution-border) bg-background p-4 text-center"
    >
      <p id={titleId} className="m-0 font-semibold text-control">
        {t("slack.channelsLocked.title")}
      </p>
      <p className="m-0 max-w-prose text-control text-muted-foreground">
        {t("slack.channelsLocked.body")}
      </p>
      <Button
        ref={action}
        type="button"
        variant="outline"
        size="sm"
        onClick={() => {
          const target =
            document.getElementById(RECHECK_ID) ??
            document.getElementById(SECTION.advanced);
          target?.scrollIntoView({
            block: "center",
            behavior: matchMedia("(prefers-reduced-motion: reduce)").matches
              ? "auto"
              : "smooth",
          });
          target?.focus({ preventScroll: true });
        }}
      >
        {t("slack.channelsLocked.action")}
      </Button>
    </div>
  );
}
