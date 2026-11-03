import {
  queryOptions,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import { type ApiClient, type ApiError, unwrap } from "@werft-ai/client";
import type {
  ListSettingsConnectionsResponse,
  ListSettingsMcpServersResponse,
  ListSettingsRepositoriesResponse,
  SettingsChangeResponse,
  SettingsCredentialView,
  SettingsEntryOrigin,
  SettingsEntryState,
} from "@werft-ai/contracts";
import { useAgentPlatform } from "@werft-ai/react";
import {
  Alert,
  AlertDescription,
  Badge,
  Button,
  ConfirmDialog,
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Field,
  FieldDescription,
  FieldLabel,
  Input,
} from "@werft-ai/ui";
import { type FormEvent, type ReactNode, useState } from "react";
import { queryKeysOf, scopedKey } from "../api/queries.ts";
import {
  type ManagedPermission,
  refusalText,
  useRole,
} from "../auth/guard.tsx";
import { type Translate, useI18n } from "../i18n/i18n.tsx";

export type SettingsKind = "connection" | "mcp" | "repository";

const SEGMENT = {
  connection: "connections",
  mcp: "mcp-servers",
  repository: "repositories",
} as const satisfies Record<SettingsKind, string>;

export const PERMISSION: Record<SettingsKind, ManagedPermission> = {
  connection: "installation.settings.manage",
  mcp: "installation.settings.manage",
  repository: "workspace.manage",
};

const listKey = (client: ApiClient, kind: SettingsKind) =>
  scopedKey(client, "installation-settings", kind);

export function settingsConnectionsQuery(client: ApiClient, enabled = true) {
  return queryOptions({
    queryKey: listKey(client, "connection"),
    queryFn: () =>
      unwrap(
        client.GET("/v1/installation/settings/connections"),
      ) as Promise<ListSettingsConnectionsResponse>,
    enabled,
    retry: false,
  });
}

export function settingsMcpServersQuery(client: ApiClient, enabled = true) {
  return queryOptions({
    queryKey: listKey(client, "mcp"),
    queryFn: () =>
      unwrap(
        client.GET("/v1/installation/settings/mcp-servers"),
      ) as Promise<ListSettingsMcpServersResponse>,
    enabled,
    retry: false,
  });
}

export function settingsRepositoriesQuery(client: ApiClient, enabled = true) {
  return queryOptions({
    queryKey: listKey(client, "repository"),
    queryFn: () =>
      unwrap(
        client.GET("/v1/installation/settings/repositories"),
      ) as Promise<ListSettingsRepositoriesResponse>,
    enabled,
    retry: false,
  });
}

const REASONS = [
  "already_exists",
  "file_entry",
  "not_stored",
  "disabled",
  "invalid_entry",
] as const;

/** The words for a refused settings write: the server's reason first. */
export function settingsRefusal(
  t: Translate,
  error: ApiError,
  kind: SettingsKind,
  role: string | undefined,
): string {
  const reason = (error.details as { reason_code?: unknown } | null)
    ?.reason_code;
  const known = REASONS.find((item) => item === reason);
  if (known === "invalid_entry") {
    return t("settings.error.invalid_entry", { detail: error.message });
  }
  if (known !== undefined) return t(`settings.error.${known}`);
  return refusalText(t, error, PERMISSION[kind], role);
}

/**
 * One settings write, then every screen that reads the settings again:
 * the lists, the model settings' profiles and a new ceiling's options.
 */
export function useSettingsWrite<V>(
  kind: SettingsKind,
  write: (client: ApiClient, variables: V) => Promise<SettingsChangeResponse>,
  handlers: {
    readonly onDone: (answer: SettingsChangeResponse, variables: V) => void;
    readonly onRefused: (text: string) => void;
  },
) {
  const { t } = useI18n();
  const { client } = useAgentPlatform();
  const queryClient = useQueryClient();
  const role = useRole();
  return useMutation<SettingsChangeResponse, ApiError, V>({
    mutationFn: (variables) => write(client, variables),
    onSuccess: async (answer, variables) => {
      handlers.onDone(answer, variables);
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: scopedKey(client, "installation-settings"),
        }),
        queryClient.invalidateQueries({
          queryKey: scopedKey(client, "installation-profile-options"),
        }),
        queryClient.invalidateQueries({
          queryKey: queryKeysOf(client).profiles,
        }),
      ]);
    },
    onError: (error) =>
      handlers.onRefused(settingsRefusal(t, error, kind, role)),
  });
}

export function setCredential(
  client: ApiClient,
  kind: SettingsKind,
  id: string,
  value: string,
): Promise<SettingsChangeResponse> {
  const params = { params: { path: { id } }, body: { value } };
  switch (SEGMENT[kind]) {
    case "connections":
      return unwrap(
        client.POST(
          "/v1/installation/settings/connections/{id}/credential",
          params,
        ),
      );
    case "mcp-servers":
      return unwrap(
        client.POST(
          "/v1/installation/settings/mcp-servers/{id}/credential",
          params,
        ),
      );
    case "repositories":
      return unwrap(
        client.POST(
          "/v1/installation/settings/repositories/{id}/credential",
          params,
        ),
      );
  }
}

export function disableEntry(
  client: ApiClient,
  kind: SettingsKind,
  id: string,
): Promise<SettingsChangeResponse> {
  const params = { params: { path: { id } } };
  switch (SEGMENT[kind]) {
    case "connections":
      return unwrap(
        client.POST(
          "/v1/installation/settings/connections/{id}/disable",
          params,
        ),
      );
    case "mcp-servers":
      return unwrap(
        client.POST(
          "/v1/installation/settings/mcp-servers/{id}/disable",
          params,
        ),
      );
    case "repositories":
      return unwrap(
        client.POST(
          "/v1/installation/settings/repositories/{id}/disable",
          params,
        ),
      );
  }
}

const STATE_BADGE: Record<
  SettingsEntryState,
  "green" | "amber" | "red" | "gray"
> = {
  active: "green",
  needs_value: "amber",
  unresolved: "red",
  disabled: "gray",
  shadowed: "amber",
};

export function StateBadge({ state }: { readonly state: SettingsEntryState }) {
  const { t } = useI18n();
  return (
    <Badge variant={STATE_BADGE[state]}>{t(`settings.state.${state}`)}</Badge>
  );
}

/**
 * A settings table once narrow (860px, its `narrowAt`): the id cell, which
 * then carries the state, and the actions, which wrap rather than go.
 */
export const SETTINGS_NARROW_COLUMNS = "minmax(0,1fr) fit-content(55%)";

/** The state inside the id cell, where a narrow table drops its column. */
export function NarrowState({ state }: { readonly state: SettingsEntryState }) {
  return (
    <span className="hidden [@container(max-width:860px)]:inline-flex">
      <StateBadge state={state} />
    </span>
  );
}

export function OriginBadge({
  origin,
}: {
  readonly origin: SettingsEntryOrigin;
}) {
  const { t } = useI18n();
  return (
    <Badge variant={origin === "file" ? "gray" : "blue"}>
      {t(`settings.origin.${origin}`)}
    </Badge>
  );
}

/** A credential as words: a stored value's last four, or a reference's name. */
export function credentialText(
  t: Translate,
  credential: SettingsCredentialView,
): string {
  switch (credential.source) {
    case "stored":
      return credential.last4 === null
        ? t("settings.credential.storedEmpty")
        : t("settings.credential.stored", { last4: credential.last4 });
    case "external":
      return credential.value_env !== undefined
        ? t("settings.credential.env", { name: credential.value_env })
        : t("settings.credential.secret", {
            name: credential.secret_id ?? "",
          });
    case "none":
      return t("settings.credential.none");
  }
}

/** What the console may do with an entry: never a file's, only disable a reference. */
export function entryActions(entry: {
  readonly origin: SettingsEntryOrigin;
  readonly state: SettingsEntryState;
  readonly credential: SettingsCredentialView;
}): { readonly setValue: boolean; readonly disable: boolean } {
  if (entry.origin === "file" || entry.state === "disabled") {
    return { setValue: false, disable: false };
  }
  return { setValue: entry.credential.source === "stored", disable: true };
}

/** The result line under a settings screen's table. */
export type Outcome = {
  readonly kind: "notice" | "error";
  readonly text: string;
};

export function OutcomeLine({ outcome }: { readonly outcome: Outcome | null }) {
  if (outcome === null) return null;
  return (
    <Alert
      variant={outcome.kind === "error" ? "red" : "default"}
      role={outcome.kind === "error" ? "alert" : "status"}
    >
      <AlertDescription>{outcome.text}</AlertDescription>
    </Alert>
  );
}

/** A form in a dialog that stays open until its request answers. */
export function FormDialog({
  open,
  onOpenChange,
  pending,
  title,
  description,
  error,
  submitLabel,
  pendingLabel,
  onSubmit,
  children,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly pending: boolean;
  readonly title: string;
  readonly description: ReactNode;
  readonly error: string | null;
  readonly submitLabel: string;
  readonly pendingLabel: string;
  readonly onSubmit: (form: FormData) => void;
  readonly children: ReactNode;
}) {
  const { t } = useI18n();
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!pending) onSubmit(new FormData(event.currentTarget));
  };
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (pending) return;
        onOpenChange(next);
      }}
    >
      <DialogContent>
        <form className="flex flex-col gap-4" onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>{description}</DialogDescription>
          </DialogHeader>
          {error === null ? null : (
            <Alert variant="red" role="alert">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          {children}
          <DialogFooter>
            <DialogClose asChild>
              <Button
                type="button"
                variant="outline"
                aria-disabled={pending || undefined}
              >
                {t("common.cancel")}
              </Button>
            </DialogClose>
            <Button type="submit" aria-disabled={pending || undefined}>
              {pending ? pendingLabel : submitLabel}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** A value typed in, sealed at once; the field never shows it back. */
export function SecretInput({
  label,
  name = "value",
}: {
  readonly label: string;
  readonly name?: string;
}) {
  const { t } = useI18n();
  return (
    <Field>
      <FieldLabel>{label}</FieldLabel>
      <Input
        name={name}
        type="password"
        required
        maxLength={8192}
        autoComplete="off"
        spellCheck={false}
      />
      <FieldDescription>{t("settings.valueHint")}</FieldDescription>
    </Field>
  );
}

/**
 * Replacing or disabling one entry from a table's row: the dialogs and the
 * writes they make, opened by `open`.
 */
export function useRowActions(
  kind: SettingsKind,
  onOutcome: (outcome: Outcome | null) => void,
) {
  const { t } = useI18n();
  const [valueFor, setValueFor] = useState<string | null>(null);
  const [disabling, setDisabling] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const value = useSettingsWrite(
    kind,
    (client, input: { id: string; value: string }) =>
      setCredential(client, kind, input.id, input.value),
    {
      onDone: (answer) => {
        setValueFor(null);
        onOutcome({
          kind: "notice",
          text: t("settings.done.value", { id: answer.id }),
        });
      },
      onRefused: setError,
    },
  );
  const disable = useSettingsWrite(
    kind,
    (client, id: string) => disableEntry(client, kind, id),
    {
      onDone: (answer) => {
        setDisabling(null);
        onOutcome({
          kind: "notice",
          text: t("settings.done.disabled", { id: answer.id }),
        });
      },
      onRefused: (text) => {
        setDisabling(null);
        onOutcome({ kind: "error", text });
      },
    },
  );

  const dialogs = (
    <>
      <FormDialog
        open={valueFor !== null}
        onOpenChange={(open) => {
          if (!open) setValueFor(null);
        }}
        pending={value.isPending}
        title={t("settings.setValueTitle", { id: valueFor ?? "" })}
        description={t("settings.setValueDescription")}
        error={error}
        submitLabel={t("settings.save")}
        pendingLabel={t("settings.saving")}
        onSubmit={(form) => {
          if (valueFor === null) return;
          setError(null);
          value.mutate({ id: valueFor, value: String(form.get("value")) });
        }}
      >
        <SecretInput label={t("settings.value")} />
      </FormDialog>
      <ConfirmDialog
        open={disabling !== null}
        onOpenChange={(open) => {
          if (!open) setDisabling(null);
        }}
        title={t("settings.disableTitle", { id: disabling ?? "" })}
        consequence={t("settings.disableConsequence")}
        confirmLabel={t("settings.disable")}
        cancelLabel={t("common.cancel")}
        tone="danger"
        busy={disable.isPending}
        onConfirm={() => {
          if (disabling !== null) disable.mutate(disabling);
        }}
      />
    </>
  );

  return {
    dialogs,
    openValue: (id: string) => {
      setError(null);
      onOutcome(null);
      setValueFor(id);
    },
    openDisable: (id: string) => {
      onOutcome(null);
      setDisabling(id);
    },
    busy: value.isPending || disable.isPending,
  };
}
