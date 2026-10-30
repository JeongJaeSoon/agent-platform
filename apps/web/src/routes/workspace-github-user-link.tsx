import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type ApiClient, type ApiError, unwrap } from "@werft-ai/client";
import type {
  GitHubSettingsResponse,
  PutGitHubOAuthClientSecretResponse,
} from "@werft-ai/contracts";
import { useAgentPlatform } from "@werft-ai/react";
import {
  Badge,
  Button,
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
  Input,
  RowListItem,
  SettingRow,
  Skeleton,
} from "@werft-ai/ui";
import { Check, Copy } from "lucide-react";
import { type FormEvent, useEffect, useId, useRef, useState } from "react";
import { scopedKey } from "../api/queries.ts";
import { refusalText, useRole } from "../auth/guard.tsx";
import { copyText } from "../components/copy.ts";
import { LoadFailure } from "../components/load-failure.tsx";
import { useI18n } from "../i18n/i18n.tsx";
import { type OnOutcome, SettingsCard } from "./workspace-settings.tsx";
import { storeOff } from "./workspace-slack.tsx";

const ACTION = "min-w-12";

/** One cache for the workspace's GitHub settings, whichever screen reads it. */
export const githubSettingsKey = (client: ApiClient, workspaceId: string) =>
  scopedKey(client, "workspace", workspaceId, "github-settings");

export function githubSettingsQuery(client: ApiClient, workspaceId: string) {
  return {
    queryKey: githubSettingsKey(client, workspaceId),
    queryFn: (): Promise<GitHubSettingsResponse> =>
      unwrap(
        client.GET("/v1/workspaces/{id}/github-settings", {
          params: { path: { id: workspaceId } },
        }),
      ),
    enabled: workspaceId !== "",
  };
}

/** Whether people can link their GitHub account in this workspace. */
export function userLinkReady(settings: GitHubSettingsResponse | undefined) {
  const oauth = settings?.oauth;
  return Boolean(
    oauth?.client_id && oauth.client_secret_set && oauth.callback_url,
  );
}

/**
 * Workspace › GitHub › user linking: what an owner or admin copies into the
 * author App's settings on GitHub, and its client secret. The secret is
 * typed here once and never shown again, not even in part.
 */
export function GitHubUserLinkSection({
  workspaceId,
  onOutcome,
}: {
  readonly workspaceId: string;
  readonly onOutcome: OnOutcome;
}) {
  const { t } = useI18n();
  const { client } = useAgentPlatform();
  const queryClient = useQueryClient();
  const role = useRole();
  const [editing, setEditing] = useState(false);
  const [missing, setMissing] = useState(false);
  const secretId = useId();
  const secretHint = useId();
  const secretRef = useRef<HTMLInputElement>(null);
  const actionRef = useRef<HTMLButtonElement>(null);
  // The App the secret is typed for: a replacement meanwhile is refused.
  const editingFor = useRef<string | null>(null);
  const wasEditing = useRef(false);
  useEffect(() => {
    if (editing) secretRef.current?.focus();
    else if (wasEditing.current && document.activeElement === document.body)
      actionRef.current?.focus();
    wasEditing.current = editing;
  }, [editing]);

  const settings = useQuery(githubSettingsQuery(client, workspaceId));
  const save = useMutation<
    PutGitHubOAuthClientSecretResponse,
    ApiError,
    { clientId: string; secret: string }
  >({
    // The variables hold the secret; keep it nowhere once the attempt ends.
    gcTime: 0,
    mutationFn: ({ clientId, secret }) =>
      unwrap(
        client.PUT("/v1/workspaces/{id}/github-settings/oauth-client-secret", {
          params: { path: { id: workspaceId } },
          body: { client_id: clientId, client_secret: secret },
        }),
      ),
    onMutate: () => onOutcome(null),
    onSuccess: () => {
      setEditing(false);
      onOutcome({ kind: "notice", text: t("githubUserLink.saved") });
      void queryClient.invalidateQueries({
        queryKey: githubSettingsKey(client, workspaceId),
      });
    },
    onError: (error) => {
      onOutcome({
        kind: "error",
        text: storeOff(error)
          ? t("workspace.tokenStoreUnavailable")
          : refusalText(t, error, "workspace.manage", role),
      });
      // Another App by now: show its client id before a secret is typed again.
      if (error.code === "REVISION_CONFLICT") {
        setEditing(false);
        void queryClient.invalidateQueries({
          queryKey: githubSettingsKey(client, workspaceId),
        });
      }
    },
  });

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const input = form.elements.namedItem("client_secret");
    const value = input instanceof HTMLInputElement ? input.value.trim() : "";
    if (value === "") {
      setMissing(true);
      secretRef.current?.focus();
      return;
    }
    setMissing(false);
    const clientId = editingFor.current;
    if (save.isPending || clientId === null) return;
    // Out of the DOM before the request goes, so nothing keeps it after.
    form.reset();
    save.mutate({ clientId, secret: value }, { onSettled: () => save.reset() });
  };

  const oauth = settings.data?.oauth;
  const rows = settings.isPending ? (
    <RowListItem>
      <Skeleton width="50%" />
    </RowListItem>
  ) : settings.isError ? (
    <RowListItem>
      <LoadFailure
        error={settings.error}
        onRetry={() => void settings.refetch()}
      />
    </RowListItem>
  ) : (
    <>
      <SettingRow
        title={t("githubUserLink.clientId")}
        description={
          oauth?.client_id ? undefined : t("githubUserLink.clientIdUnset")
        }
        meta={oauth?.client_id ? <Value text={oauth.client_id} /> : undefined}
      />
      <SettingRow
        title={t("githubUserLink.callback")}
        description={
          oauth?.callback_url ? undefined : t("githubUserLink.callbackUnset")
        }
        meta={
          oauth?.callback_url ? (
            <Value
              text={oauth.callback_url}
              copy={{ label: t("githubUserLink.copyCallback"), onOutcome }}
            />
          ) : undefined
        }
      />
      <SettingRow
        title={t("githubUserLink.secret")}
        badge={
          oauth?.client_secret_set ? (
            <Badge variant="green">{t("githubUserLink.secretSet")}</Badge>
          ) : (
            <Badge>{t("githubUserLink.secretUnset")}</Badge>
          )
        }
        description={t("githubUserLink.secretHint")}
        actions={
          editing || !oauth?.client_id ? undefined : (
            <Button
              ref={actionRef}
              type="button"
              size="sm"
              variant={oauth.client_secret_set ? "outline" : "default"}
              className={ACTION}
              onClick={() => {
                editingFor.current = oauth.client_id;
                setEditing(true);
              }}
            >
              {t(
                oauth?.client_secret_set
                  ? "githubUserLink.replace"
                  : "githubUserLink.enter",
              )}
            </Button>
          )
        }
      />
      {editing ? (
        <RowListItem>
          <form
            className="flex w-full flex-col gap-4"
            noValidate
            onSubmit={submit}
          >
            <Field>
              <FieldLabel htmlFor={secretId}>
                {t("githubUserLink.secret")}
              </FieldLabel>
              <Input
                ref={secretRef}
                id={secretId}
                className="max-w-105"
                name="client_secret"
                type="password"
                autoComplete="off"
                spellCheck={false}
                aria-describedby={secretHint}
                aria-invalid={missing || undefined}
                onChange={() => {
                  if (missing) setMissing(false);
                }}
              />
              <FieldDescription id={secretHint}>
                {t("githubUserLink.secretInputHint")}
              </FieldDescription>
              {missing ? (
                <FieldError>{t("githubUserLink.secretMissing")}</FieldError>
              ) : null}
            </Field>
            <div className="flex flex-wrap items-start justify-end gap-2">
              <Button
                type="button"
                variant="ghost"
                onClick={() => {
                  setMissing(false);
                  setEditing(false);
                }}
              >
                {t("common.cancel")}
              </Button>
              <Button type="submit" aria-disabled={save.isPending || undefined}>
                {t("githubUserLink.save")}
              </Button>
            </div>
          </form>
        </RowListItem>
      ) : null}
    </>
  );

  return (
    <SettingsCard
      title={t("githubUserLink.title")}
      description={t("githubUserLink.intro")}
      rows={rows}
    />
  );
}

/** A value to paste into GitHub, with a copy button when it is a URL to copy. */
function Value({
  text,
  copy,
}: {
  readonly text: string;
  /** Offers copying; the result goes to the screen's outcome line. */
  readonly copy?: { readonly label: string; readonly onOutcome: OnOutcome };
}) {
  const { t } = useI18n();
  const [copied, setCopied] = useState<boolean | null>(null);
  return (
    <span className="inline-flex min-w-0 flex-wrap items-center gap-1">
      <code className="min-w-0 font-mono text-caption text-foreground [overflow-wrap:anywhere]">
        {text}
      </code>
      {copy ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="-my-1 h-6 min-w-6 gap-1 px-1 text-xs"
          aria-label={copy.label}
          onClick={() =>
            void copyText(text, { current: null }).then((ok) => {
              setCopied(ok);
              copy.onOutcome(
                ok
                  ? { kind: "notice", text: t("githubUserLink.copied") }
                  : { kind: "error", text: t("githubUserLink.copyFailed") },
              );
            })
          }
        >
          {copied ? (
            <Check aria-hidden="true" className="size-3.5 shrink-0" />
          ) : (
            <Copy aria-hidden="true" className="size-3.5 shrink-0" />
          )}
          {copied ? <span>{t("githubUserLink.copied")}</span> : null}
        </Button>
      ) : null}
    </span>
  );
}
