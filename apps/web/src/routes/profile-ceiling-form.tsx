import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { type ApiError, type components, unwrap } from "@werft-ai/client";
import type {
  InstallationProfileOptionsResponse,
  PermissionMode,
  ProfileSummary,
  RepositoryMode,
  RuntimeKind,
  WorkspaceProfileChangeResponse,
} from "@werft-ai/contracts";
import { workspaceProfileNameStep } from "@werft-ai/core/forms";
import { useAgentPlatform } from "@werft-ai/react";
import {
  Alert,
  AlertDescription,
  Button,
  buttonVariants,
  Checkbox,
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldLabel,
  FieldLegend,
  FieldSet,
  Input,
  NativeSelect,
  NativeSelectOption,
  Textarea,
} from "@werft-ai/ui";
import { type FormEvent, useId, useState } from "react";
import { queryKeysOf } from "../api/queries.ts";
import { errorKey, useI18n } from "../i18n/i18n.tsx";
import { ChangeReview } from "./profile-editor.tsx";

// The OpenAPI body, whose optional fields take no explicit undefined.
type CeilingRequest = components["schemas"]["CreateInstallationProfileRequest"];

type CeilingField =
  | "name"
  | "connection_id"
  | "runtime_kind"
  | "runtime_version"
  | "models"
  | "model"
  | "title_model"
  | "tools"
  | "permission_mode"
  | "project_settings"
  | "repository_mode"
  | "repository_ids";

const FIELDS: readonly CeilingField[] = [
  "name",
  "connection_id",
  "runtime_kind",
  "runtime_version",
  "models",
  "model",
  "title_model",
  "tools",
  "permission_mode",
  "project_settings",
  "repository_mode",
  "repository_ids",
];

const REPOSITORY_MODES: readonly RepositoryMode[] = [
  "required",
  "optional",
  "none",
];

interface Draft {
  readonly name: string;
  readonly connection_id: string;
  readonly runtime_kind: RuntimeKind;
  readonly runtime_version: string;
  /** One model per line, the way the form holds it. */
  readonly models: string;
  readonly model: string;
  readonly title_model: string;
  readonly tools: string;
  readonly permission_mode: PermissionMode;
  readonly claude_md: boolean;
  readonly repository_mode: RepositoryMode;
  readonly repository_ids: readonly string[];
}

const lines = (text: string) => [
  ...new Set(
    text
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0),
  ),
];

function modesOf(
  options: InstallationProfileOptionsResponse,
  kind: RuntimeKind,
): readonly PermissionMode[] {
  return (
    options.runtimes.find((runtime) => runtime.runtime_kind === kind)
      ?.permission_modes ?? []
  );
}

const opensMode = (
  options: InstallationProfileOptionsResponse,
  mode: PermissionMode,
) => mode !== "bypassPermissions" || options.unattended_allowed;

function draftOf(
  options: InstallationProfileOptionsResponse,
  operators: readonly ProfileSummary[],
  template: ProfileSummary | undefined,
  name: string,
): Draft {
  const runtime =
    template &&
    options.runtimes.some((item) => item.runtime_kind === template.runtime_kind)
      ? template.runtime_kind
      : (options.runtimes[0]?.runtime_kind as RuntimeKind);
  const modes = modesOf(options, runtime).filter((mode) =>
    opensMode(options, mode),
  );
  const mode =
    template && modes.includes(template.permission_mode)
      ? template.permission_mode
      : modes.includes("default")
        ? "default"
        : (modes[0] ?? "default");
  const connection = template?.installation?.connection_id;
  return {
    name,
    connection_id:
      connection && options.connections.some((item) => item.id === connection)
        ? connection
        : (options.connections[0]?.id ?? ""),
    runtime_kind: runtime,
    runtime_version:
      template?.runtime_version ??
      operators.find((item) => item.runtime_kind === runtime)
        ?.runtime_version ??
      "",
    models: template?.models.join("\n") ?? "",
    model: template?.model ?? "",
    title_model: template?.installation?.title_model ?? "",
    tools: template?.tools.join("\n") ?? "",
    permission_mode: mode,
    claude_md: template?.installation?.project_settings.claude_md ?? false,
    repository_mode: template?.repository_mode ?? "required",
    // An id this installation no longer has would only be refused.
    repository_ids: (template?.repository_ids ?? []).filter((id) =>
      options.repositories.some((item) => item.id === id),
    ),
  };
}

/** Where the server's refusal belongs: beside a field, or above the buttons. */
type Refusal =
  | { readonly field: CeilingField; readonly text: string }
  | {
      readonly field: null;
      readonly text: string;
      readonly latestId?: string | undefined;
    };

/**
 * The form for a new installation ceiling: a first version, or with
 * `previous` the next version after it. `template` fills the fields.
 */
export function CeilingForm({
  options,
  operators,
  template,
  previous,
  cancelTo,
  onSaved,
}: {
  readonly options: InstallationProfileOptionsResponse;
  readonly operators: readonly ProfileSummary[];
  readonly template: ProfileSummary | undefined;
  readonly previous: ProfileSummary | undefined;
  readonly cancelTo: string | undefined;
  readonly onSaved: (id: string) => void;
}) {
  const { t } = useI18n();
  const { client } = useAgentPlatform();
  const queryClient = useQueryClient();
  // An imported ceiling has no name; its next version takes a new one.
  const fixedName = previous?.installation?.name ?? null;
  const [initial] = useState(() =>
    draftOf(options, operators, template, fixedName ?? ""),
  );
  const [draft, setDraft] = useState<Draft>(initial);
  const [submitted, setSubmitted] = useState(false);
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const riskId = useId();
  const modelsId = useId();
  const toolsId = useId();

  const modes = modesOf(options, draft.runtime_kind);
  const models = lines(draft.models);
  const tools = lines(draft.tools);
  const model = models.includes(draft.model) ? draft.model : (models[0] ?? "");

  const name = workspaceProfileNameStep.safeParse(draft.name);
  const runtimeVersion = draft.runtime_version.trim();
  const titleModel = draft.title_model.trim();
  const local: Partial<Record<CeilingField, string>> = {
    ...(name.success ? {} : { name: t("profiles.editor.nameInvalid") }),
    ...(runtimeVersion.length === 0 || runtimeVersion.length > 200
      ? { runtime_version: t("profiles.ceiling.runtimeVersionInvalid") }
      : {}),
    ...(models.length === 0
      ? { models: t("profiles.editor.modelsEmpty") }
      : models.length > 32
        ? { models: t("profiles.editor.tooLarge") }
        : models.some((item) => item.length > 200)
          ? { models: t("profiles.editor.tooLong") }
          : {}),
    ...(tools.length > 64
      ? { tools: t("profiles.editor.tooLarge") }
      : tools.some((item) => item.length > 200)
        ? { tools: t("profiles.editor.tooLong") }
        : {}),
    ...(titleModel.length > 200
      ? { title_model: t("profiles.editor.tooLong") }
      : {}),
  };
  const errorOf = (field: CeilingField) =>
    (submitted ? local[field] : undefined) ??
    (refusal?.field === field ? refusal.text : undefined);

  const save = useMutation<
    WorkspaceProfileChangeResponse,
    ApiError,
    CeilingRequest
  >({
    mutationFn: (body) =>
      unwrap(client.POST("/v1/installation-profiles", { body })),
    onMutate: () => setRefusal(null),
    onSuccess: async ({ profile }) => {
      await queryClient.invalidateQueries({
        queryKey: queryKeysOf(client).profiles,
      });
      onSaved(profile.id);
    },
    onError: (failure) => setRefusal(refusalOf(failure)),
  });

  function refusalOf(failure: ApiError): Refusal {
    const details = (failure.details ?? {}) as {
      readonly reason_code?: unknown;
      readonly field?: unknown;
      readonly latest_id?: unknown;
    };
    // A schema issue names its path, `models.3` say.
    const path =
      typeof details.field === "string"
        ? details.field.split(".")[0]
        : undefined;
    const named = FIELDS.find((field) => field === path);
    const beside = (text: string): Refusal =>
      named ? { field: named, text } : { field: null, text };
    switch (details.reason_code) {
      case "unknown_connection":
        return beside(t("profiles.ceiling.error.unknownConnection"));
      case "runtime_not_installed":
        return beside(t("profiles.ceiling.error.runtimeNotInstalled"));
      case "unattended_not_allowed":
        return beside(t("profiles.ceiling.error.unattendedNotAllowed"));
      case "unknown_repository":
        return beside(t("profiles.ceiling.error.unknownRepository"));
      case "model_not_in_models":
        return beside(t("profiles.ceiling.error.modelNotInModels"));
      case "unknown_previous":
        return {
          field: null,
          text: t("profiles.ceiling.error.unknownPrevious"),
        };
      case "invalid_profile":
        return beside(t("profiles.ceiling.error.invalid"));
      case "id_taken":
        return { field: "name", text: t("profiles.ceiling.error.idTaken") };
      case "stale_previous":
        return typeof details.latest_id === "string"
          ? {
              field: null,
              text: t("profiles.ceiling.error.stalePrevious", {
                id: details.latest_id,
              }),
              latestId: details.latest_id,
            }
          : { field: null, text: t("profiles.ceiling.error.noVersion") };
    }
    if (failure.code === "FORBIDDEN")
      return { field: null, text: t("profiles.ceiling.ownerOnly") };
    return { field: null, text: t(errorKey(failure.code)) };
  }

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setSubmitted(true);
    if (save.isPending || !name.success || Object.keys(local).length > 0)
      return;
    const body: CeilingRequest = {
      name: name.data,
      connection_id: draft.connection_id,
      runtime_kind: draft.runtime_kind,
      runtime_version: runtimeVersion,
      model,
      models,
      tools,
      permission_mode: draft.permission_mode,
      project_settings: { claude_md: draft.claude_md },
      repository_mode: draft.repository_mode,
      repository_ids:
        draft.repository_mode === "none" ? [] : [...draft.repository_ids],
    };
    if (titleModel) body.title_model = titleModel;
    if (previous) body.previous_id = previous.id;
    save.mutate(body);
  };

  const set = (patch: Partial<Draft>) => setDraft({ ...draft, ...patch });
  const bypassChosen = draft.permission_mode === "bypassPermissions";
  const bypassClosed =
    modes.includes("bypassPermissions") && !options.unattended_allowed;
  const pending = save.isPending;
  const join = (values: readonly string[]) =>
    values.length === 0 ? t("profiles.noTools") : values.join(", ");

  return (
    <form
      className="flex flex-col gap-[var(--ap-space-block)] rounded-card border bg-card p-4"
      noValidate
      onSubmit={submit}
    >
      <Field>
        <FieldLabel>{t("profiles.editor.name")}</FieldLabel>
        <Input
          name="ceiling-name"
          autoComplete="off"
          maxLength={40}
          value={draft.name}
          readOnly={fixedName !== null || pending}
          aria-invalid={errorOf("name") ? true : undefined}
          onChange={(event) => set({ name: event.target.value })}
        />
        <FieldDescription>
          {name.success
            ? t("profiles.ceiling.preview", {
                name: name.data,
                version:
                  Math.max(
                    0,
                    ...operators
                      .filter((item) => item.installation?.name === name.data)
                      .map((item) => item.installation?.version ?? 0),
                  ) + 1,
              })
            : t("profiles.editor.nameHint")}
        </FieldDescription>
        <FieldError>{errorOf("name")}</FieldError>
      </Field>

      <Field className="w-auto max-w-full">
        <FieldLabel>{t("profiles.ceiling.connection")}</FieldLabel>
        <NativeSelect
          value={draft.connection_id}
          disabled={pending}
          aria-invalid={errorOf("connection_id") ? true : undefined}
          onChange={(event) => set({ connection_id: event.target.value })}
        >
          {options.connections.map((connection) => (
            <NativeSelectOption key={connection.id} value={connection.id}>
              {t("profiles.ceiling.connectionOption", {
                id: connection.id,
                kind: connection.kind,
                billing: t(`profiles.billing.${connection.billing}`),
              })}
            </NativeSelectOption>
          ))}
        </NativeSelect>
        <FieldDescription>
          {t("profiles.ceiling.connectionHint")}
        </FieldDescription>
        <FieldError>{errorOf("connection_id")}</FieldError>
      </Field>

      <div className="flex flex-wrap gap-4">
        <Field className="w-auto max-w-full">
          <FieldLabel>{t("profiles.ceiling.runtime")}</FieldLabel>
          <NativeSelect
            value={draft.runtime_kind}
            disabled={pending}
            aria-invalid={errorOf("runtime_kind") ? true : undefined}
            onChange={(event) => {
              const kind = event.target.value as RuntimeKind;
              const next = modesOf(options, kind);
              set({
                runtime_kind: kind,
                permission_mode: next.includes(draft.permission_mode)
                  ? draft.permission_mode
                  : (next.find((mode) => opensMode(options, mode)) ??
                    draft.permission_mode),
              });
            }}
          >
            {options.runtimes.map((runtime) => (
              <NativeSelectOption
                key={runtime.runtime_kind}
                value={runtime.runtime_kind}
              >
                {runtime.runtime_kind}
              </NativeSelectOption>
            ))}
          </NativeSelect>
          <FieldError>{errorOf("runtime_kind")}</FieldError>
        </Field>
        <Field className="w-auto max-w-full">
          <FieldLabel>{t("profiles.ceiling.runtimeVersion")}</FieldLabel>
          <Input
            name="runtime-version"
            autoComplete="off"
            className="font-mono"
            value={draft.runtime_version}
            readOnly={pending}
            aria-invalid={errorOf("runtime_version") ? true : undefined}
            onChange={(event) => set({ runtime_version: event.target.value })}
          />
          <FieldError>{errorOf("runtime_version")}</FieldError>
        </Field>
      </div>

      <Field>
        <FieldLabel htmlFor={modelsId}>
          {t("profiles.editor.models")}
        </FieldLabel>
        <Textarea
          id={modelsId}
          className="font-mono"
          rows={3}
          value={draft.models}
          readOnly={pending}
          aria-invalid={errorOf("models") ? true : undefined}
          onChange={(event) => set({ models: event.target.value })}
        />
        <FieldDescription>{t("profiles.ceiling.modelsHint")}</FieldDescription>
        <FieldError>{errorOf("models")}</FieldError>
      </Field>

      <div className="flex flex-wrap gap-4">
        <Field className="w-auto max-w-full">
          <FieldLabel>{t("profiles.editor.defaultModel")}</FieldLabel>
          <NativeSelect
            value={model}
            disabled={pending || models.length === 0}
            aria-invalid={errorOf("model") ? true : undefined}
            onChange={(event) => set({ model: event.target.value })}
          >
            {models.map((item) => (
              <NativeSelectOption key={item} value={item}>
                {item}
              </NativeSelectOption>
            ))}
          </NativeSelect>
          <FieldError>{errorOf("model")}</FieldError>
        </Field>
        <Field className="w-auto max-w-full">
          <FieldLabel>{t("profiles.ceiling.titleModel")}</FieldLabel>
          <Input
            name="title-model"
            autoComplete="off"
            className="font-mono"
            value={draft.title_model}
            readOnly={pending}
            aria-invalid={errorOf("title_model") ? true : undefined}
            onChange={(event) => set({ title_model: event.target.value })}
          />
          <FieldDescription>
            {t("profiles.ceiling.titleModelHint")}
          </FieldDescription>
          <FieldError>{errorOf("title_model")}</FieldError>
        </Field>
      </div>

      <Field>
        <FieldLabel htmlFor={toolsId}>{t("profiles.editor.tools")}</FieldLabel>
        <Textarea
          id={toolsId}
          className="font-mono"
          rows={3}
          value={draft.tools}
          readOnly={pending}
          aria-invalid={errorOf("tools") ? true : undefined}
          onChange={(event) => set({ tools: event.target.value })}
        />
        <FieldDescription>{t("profiles.ceiling.toolsHint")}</FieldDescription>
        <FieldError>{errorOf("tools")}</FieldError>
      </Field>

      <Field className="w-auto max-w-full">
        <FieldLabel>{t("profiles.editor.permissionMode")}</FieldLabel>
        <NativeSelect
          value={draft.permission_mode}
          disabled={pending}
          aria-invalid={errorOf("permission_mode") ? true : undefined}
          aria-describedby={bypassChosen ? riskId : undefined}
          onChange={(event) =>
            set({ permission_mode: event.target.value as PermissionMode })
          }
        >
          {modes.map((mode) => (
            <NativeSelectOption
              key={mode}
              value={mode}
              disabled={!opensMode(options, mode)}
            >
              {mode}
            </NativeSelectOption>
          ))}
        </NativeSelect>
        {bypassClosed ? (
          <FieldDescription>
            {t("profiles.ceiling.bypassClosed")}
          </FieldDescription>
        ) : null}
        <FieldError>{errorOf("permission_mode")}</FieldError>
      </Field>
      {bypassChosen ? (
        <Alert id={riskId} variant="amber">
          <AlertDescription>{t("profiles.editor.bypassRisk")}</AlertDescription>
        </Alert>
      ) : null}

      <Field orientation="horizontal">
        <Checkbox
          checked={draft.claude_md}
          disabled={pending}
          onCheckedChange={(checked) => set({ claude_md: checked === true })}
        />
        <FieldContent>
          <FieldLabel>{t("profiles.ceiling.claudeMd")}</FieldLabel>
          <FieldDescription>
            {t("profiles.ceiling.claudeMdHint")}
          </FieldDescription>
        </FieldContent>
      </Field>

      <Field className="w-auto max-w-full">
        <FieldLabel>{t("profiles.ceiling.repositoryMode")}</FieldLabel>
        <NativeSelect
          value={draft.repository_mode}
          disabled={pending}
          aria-invalid={errorOf("repository_mode") ? true : undefined}
          onChange={(event) =>
            set({ repository_mode: event.target.value as RepositoryMode })
          }
        >
          {REPOSITORY_MODES.map((mode) => (
            <NativeSelectOption key={mode} value={mode}>
              {t(`profiles.repository.${mode}`)}
            </NativeSelectOption>
          ))}
        </NativeSelect>
        <FieldError>{errorOf("repository_mode")}</FieldError>
      </Field>

      {draft.repository_mode === "none" ? null : (
        <FieldSet className="gap-3">
          <FieldLegend variant="label" className="mb-0">
            {t("profiles.ceiling.repositories")}
          </FieldLegend>
          <FieldDescription>
            {options.repositories.length === 0
              ? t("profiles.ceiling.noRepositories")
              : t("profiles.ceiling.repositoriesHint")}
          </FieldDescription>
          {options.repositories.map((repository) => (
            <Field key={repository.id} orientation="horizontal">
              <Checkbox
                checked={draft.repository_ids.includes(repository.id)}
                disabled={pending}
                onCheckedChange={(checked) =>
                  set({
                    repository_ids:
                      checked === true
                        ? [...draft.repository_ids, repository.id]
                        : draft.repository_ids.filter(
                            (id) => id !== repository.id,
                          ),
                  })
                }
              />
              <FieldContent>
                <FieldLabel className="font-mono">{repository.id}</FieldLabel>
              </FieldContent>
            </Field>
          ))}
          <FieldError>{errorOf("repository_ids")}</FieldError>
        </FieldSet>
      )}

      {template ? (
        <ChangeReview
          against={template.id}
          rows={[
            {
              id: "connection",
              label: t("profiles.ceiling.connection"),
              before: initial.connection_id,
              after: draft.connection_id,
            },
            {
              id: "runtime",
              label: t("profiles.ceiling.runtime"),
              before: `${initial.runtime_kind} ${initial.runtime_version.trim()}`,
              after: `${draft.runtime_kind} ${runtimeVersion}`,
            },
            {
              id: "models",
              label: t("profiles.editor.models"),
              before: join(lines(initial.models)),
              after: join(models),
            },
            {
              id: "model",
              label: t("profiles.editor.defaultModel"),
              before: initial.model,
              after: model,
            },
            {
              id: "title",
              label: t("profiles.ceiling.titleModel"),
              before: initial.title_model.trim(),
              after: titleModel,
            },
            {
              id: "tools",
              label: t("profiles.editor.tools"),
              before: join(lines(initial.tools)),
              after: join(tools),
            },
            {
              id: "mode",
              label: t("profiles.editor.permissionMode"),
              before: initial.permission_mode,
              after: draft.permission_mode,
            },
            {
              id: "claude-md",
              label: t("profiles.ceiling.claudeMd"),
              before: t(initial.claude_md ? "profiles.on" : "profiles.off"),
              after: t(draft.claude_md ? "profiles.on" : "profiles.off"),
            },
            {
              id: "repository-mode",
              label: t("profiles.ceiling.repositoryMode"),
              before: t(`profiles.repository.${initial.repository_mode}`),
              after: t(`profiles.repository.${draft.repository_mode}`),
            },
            {
              id: "repositories",
              label: t("profiles.ceiling.repositories"),
              before: join([...initial.repository_ids].sort()),
              after: join(
                draft.repository_mode === "none"
                  ? []
                  : [...draft.repository_ids].sort(),
              ),
            },
          ]}
        />
      ) : null}

      {refusal === null || refusal.field !== null ? null : (
        <Alert variant="red" role="alert">
          <AlertDescription>
            {refusal.text}
            {refusal.latestId ? (
              <>
                {" "}
                <Link
                  className="font-medium underline underline-offset-4"
                  to="/profiles/new"
                  search={{
                    kind: "installation",
                    from: refusal.latestId,
                    mode: "version",
                  }}
                >
                  {t("profiles.ceiling.error.openLatest")}
                </Link>
              </>
            ) : null}
          </AlertDescription>
        </Alert>
      )}

      <div className="flex flex-wrap items-center justify-between gap-3 border-t pt-4">
        <FieldDescription>{t("profiles.ceiling.saveNote")}</FieldDescription>
        <div className="flex gap-2">
          {cancelTo === undefined ? (
            <Link
              className={buttonVariants({ variant: "outline" })}
              to="/profiles"
            >
              {t("common.cancel")}
            </Link>
          ) : (
            <Link
              className={buttonVariants({ variant: "outline" })}
              to="/profiles/$profileId"
              params={{ profileId: cancelTo }}
            >
              {t("common.cancel")}
            </Link>
          )}
          {/* aria-disabled, not disabled: Enter on it keeps the focus there. */}
          <Button
            type="submit"
            className="aria-disabled:opacity-50"
            aria-disabled={pending || undefined}
          >
            {pending ? t("profiles.editor.saving") : t("profiles.ceiling.save")}
          </Button>
        </div>
      </div>
    </form>
  );
}
