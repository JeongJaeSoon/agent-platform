import { useMutation, useQueryClient } from "@tanstack/react-query";
import { type ApiError, unwrap } from "@werft-ai/client";
import type {
  CreateWorkspaceProfileRequest,
  ProfileSummary,
  WorkspaceProfileChangeResponse,
} from "@werft-ai/contracts";
import {
  NARROWER_PERMISSION_MODES,
  workspaceProfileNameStep,
  workspaceProfileStep,
} from "@werft-ai/core/forms";
import { useAgentPlatform } from "@werft-ai/react";
import {
  Alert,
  AlertDescription,
  Badge,
  Button,
  Checkbox,
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldLabel,
  FieldLegend,
  FieldSet,
  Input,
  KeyValueList,
  NativeSelect,
  NativeSelectOption,
  Section,
} from "@werft-ai/ui";
import { type FormEvent, useState } from "react";
import { queryKeysOf } from "../api/queries.ts";
import { refusalText, useRole } from "../auth/guard.tsx";
import { useI18n } from "../i18n/i18n.tsx";

export type EditorStart =
  | { readonly mode: "new"; readonly base: ProfileSummary }
  | {
      readonly mode: "version" | "remake";
      readonly from: ProfileSummary;
      readonly base: ProfileSummary;
    };

type Draft = Omit<CreateWorkspaceProfileRequest, "name"> & {
  readonly name: string;
};

const fromBase = (base: ProfileSummary, name: string): Draft => ({
  name,
  base_profile_id: base.id,
  model: base.model,
  models: [base.model],
  tools: base.tools,
  permission_mode: base.permission_mode,
});

function fromVersion(from: ProfileSummary, base: ProfileSummary): Draft {
  const models = from.models.filter((model) => base.models.includes(model));
  const modes = NARROWER_PERMISSION_MODES[base.permission_mode];
  return {
    name: from.workspace?.name ?? "",
    base_profile_id: base.id,
    model: models.includes(from.model) ? from.model : (models[0] ?? base.model),
    models: models.length > 0 ? models : [base.model],
    tools: from.tools.filter((tool) => base.tools.includes(tool)),
    permission_mode: modes.includes(from.permission_mode)
      ? from.permission_mode
      : base.permission_mode,
  };
}

export function ProfileEditor({
  start,
  operators,
  nextId,
  onSaved,
  onCancel,
}: {
  readonly start: EditorStart;
  readonly operators: readonly ProfileSummary[];
  /** The id a save under `name` would get. */
  readonly nextId: (name: string) => string;
  readonly onSaved: (id: string) => void;
  readonly onCancel: () => void;
}) {
  const { t } = useI18n();
  const { client } = useAgentPlatform();
  const queryClient = useQueryClient();
  const role = useRole();
  const fixed = start.mode !== "new";
  const [draft, setDraft] = useState<Draft>(() =>
    start.mode === "new"
      ? fromBase(start.base, "")
      : fromVersion(start.from, start.base),
  );
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const base = operators.find((item) => item.id === draft.base_profile_id);

  const name = workspaceProfileNameStep.safeParse(draft.name);
  const nameError = name.success ? undefined : t("profiles.editor.nameInvalid");
  const modelsError =
    draft.models.length === 0 ? t("profiles.editor.modelsEmpty") : undefined;

  const save = useMutation<
    WorkspaceProfileChangeResponse,
    ApiError,
    CreateWorkspaceProfileRequest
  >({
    mutationFn: (body) =>
      unwrap(client.POST("/v1/workspace-profiles", { body })),
    onMutate: () => setError(null),
    onSuccess: async ({ profile }) => {
      await queryClient.invalidateQueries({
        queryKey: queryKeysOf(client).profiles,
      });
      onSaved(profile.id);
    },
    onError: (failure) => setError(saveRefusal(failure)),
  });

  function saveRefusal(failure: ApiError): string {
    const reason = (failure.details as { reason_code?: unknown } | null)
      ?.reason_code;
    if (reason === "unknown_base") return t("profiles.error.unknownBase");
    if (reason === "widens_base") return t("profiles.error.widens");
    if (failure.code === "REVISION_CONFLICT")
      return t("profiles.error.versionTaken");
    return refusalText(t, failure, "workspace.manage", role);
  }

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setSubmitted(true);
    if (save.isPending || !name.success || modelsError) return;
    // The operator catalog has no such caps; the request does.
    const request = workspaceProfileStep.safeParse({
      ...draft,
      name: name.data,
    });
    if (!request.success) {
      setError(t("profiles.editor.tooLarge"));
      return;
    }
    save.mutate(request.data);
  };

  const toggle = (list: readonly string[], item: string, on: boolean) =>
    on ? [...list, item] : list.filter((other) => other !== item);
  const setModels = (models: readonly string[]) =>
    setDraft({
      ...draft,
      models: [...models],
      model: models.includes(draft.model) ? draft.model : (models[0] ?? ""),
    });

  const title =
    start.mode === "new"
      ? t("profiles.editor.createTitle")
      : t(
          start.mode === "version"
            ? "profiles.editor.versionTitle"
            : "profiles.editor.remakeTitle",
          { name: start.from.workspace?.name ?? start.from.id },
        );

  return (
    <Section title={title} description={t("profiles.editor.description")}>
      <form
        className="flex flex-col gap-[var(--ap-space-block)] rounded-card border bg-card p-4"
        noValidate
        onSubmit={submit}
      >
        {fixed ? null : (
          <Field className="w-auto max-w-full">
            <FieldLabel>{t("profiles.editor.base")}</FieldLabel>
            <NativeSelect
              value={draft.base_profile_id}
              disabled={save.isPending}
              onChange={(event) => {
                const next = operators.find(
                  (item) => item.id === event.target.value,
                );
                if (next) setDraft(fromBase(next, draft.name));
              }}
            >
              {operators.map((item) => (
                <NativeSelectOption key={item.id} value={item.id}>
                  {item.id}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </Field>
        )}
        {base ? <BaseSummary base={base} /> : null}

        <Alert variant="blue">
          <AlertDescription>
            {t("profiles.editor.autoRulesNote")}
          </AlertDescription>
        </Alert>

        <Field>
          <FieldLabel>{t("profiles.editor.name")}</FieldLabel>
          <Input
            name="profile-name"
            autoComplete="off"
            maxLength={40}
            value={draft.name}
            readOnly={fixed || save.isPending}
            onChange={(event) =>
              setDraft({ ...draft, name: event.target.value })
            }
          />
          <FieldDescription>
            {name.success
              ? t("profiles.editor.preview", {
                  id: nextId(name.data),
                })
              : t("profiles.editor.nameHint")}
          </FieldDescription>
          <FieldError>{submitted ? nameError : undefined}</FieldError>
        </Field>

        {base ? (
          <>
            <FieldSet className="gap-3">
              <FieldLegend variant="label" className="mb-0">
                {t("profiles.editor.models")}
              </FieldLegend>
              <FieldDescription>
                {t("profiles.editor.modelsHint")}
              </FieldDescription>
              {base.models.map((model) => (
                <Field key={model} orientation="horizontal">
                  <Checkbox
                    checked={draft.models.includes(model)}
                    disabled={save.isPending}
                    onCheckedChange={(checked) =>
                      setModels(toggle(draft.models, model, checked === true))
                    }
                  />
                  <FieldContent>
                    <FieldLabel className="font-mono">{model}</FieldLabel>
                  </FieldContent>
                </Field>
              ))}
              <FieldError>{submitted ? modelsError : undefined}</FieldError>
            </FieldSet>

            {draft.models.length > 1 ? (
              <Field className="w-auto max-w-full">
                <FieldLabel>{t("profiles.editor.defaultModel")}</FieldLabel>
                <NativeSelect
                  value={draft.model}
                  disabled={save.isPending}
                  onChange={(event) =>
                    setDraft({ ...draft, model: event.target.value })
                  }
                >
                  {draft.models.map((model) => (
                    <NativeSelectOption key={model} value={model}>
                      {model}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
              </Field>
            ) : null}

            <FieldSet className="gap-3">
              <FieldLegend variant="label" className="mb-0">
                {t("profiles.editor.tools")}
              </FieldLegend>
              <FieldDescription>
                {base.tools.length === 0
                  ? t("profiles.noTools")
                  : t("profiles.editor.toolsHint")}
              </FieldDescription>
              {base.tools.map((tool) => (
                <Field key={tool} orientation="horizontal">
                  <Checkbox
                    checked={draft.tools.includes(tool)}
                    disabled={save.isPending}
                    onCheckedChange={(checked) =>
                      setDraft({
                        ...draft,
                        tools: toggle(draft.tools, tool, checked === true),
                      })
                    }
                  />
                  <FieldContent>
                    <FieldLabel className="font-mono">{tool}</FieldLabel>
                  </FieldContent>
                </Field>
              ))}
            </FieldSet>

            <Field className="w-auto max-w-full">
              <FieldLabel>{t("profiles.editor.permissionMode")}</FieldLabel>
              <NativeSelect
                value={draft.permission_mode}
                disabled={save.isPending}
                onChange={(event) =>
                  setDraft({
                    ...draft,
                    permission_mode: event.target
                      .value as Draft["permission_mode"],
                  })
                }
              >
                {NARROWER_PERMISSION_MODES[base.permission_mode].map((mode) => (
                  <NativeSelectOption key={mode} value={mode}>
                    {mode}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
              <FieldDescription>
                {t("profiles.editor.modeHint")}
              </FieldDescription>
            </Field>
          </>
        ) : null}

        <Field className="w-auto max-w-full">
          <div className="flex items-center gap-2">
            <FieldLabel>{t("profiles.editor.scriptCeiling")}</FieldLabel>
            <Badge variant="gray">{t("profiles.editor.scriptLater")}</Badge>
          </div>
          <NativeSelect disabled value="none" onChange={() => undefined}>
            <NativeSelectOption value="none">
              {t("profiles.editor.scriptNone")}
            </NativeSelectOption>
          </NativeSelect>
          <FieldDescription>{t("profiles.editor.scriptHint")}</FieldDescription>
        </Field>

        {error === null ? null : (
          <Alert variant="red" role="alert">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        <div className="flex flex-wrap items-center justify-between gap-3 border-t pt-4">
          <p className="m-0 text-caption text-muted-foreground">
            {t("profiles.editor.saveNote")}
          </p>
          <div className="flex gap-2">
            <Button
              type="button"
              variant="outline"
              className="aria-disabled:opacity-50"
              aria-disabled={save.isPending || undefined}
              onClick={() => {
                if (!save.isPending) onCancel();
              }}
            >
              {t("common.cancel")}
            </Button>
            {/* aria-disabled, not disabled: Enter on it keeps the focus there. */}
            <Button
              type="submit"
              className="aria-disabled:opacity-50"
              aria-disabled={save.isPending || undefined}
            >
              {save.isPending
                ? t("profiles.editor.saving")
                : t("profiles.editor.save")}
            </Button>
          </div>
        </div>
      </form>
    </Section>
  );
}

function BaseSummary({ base }: { readonly base: ProfileSummary }) {
  const { t } = useI18n();
  return (
    <div className="flex flex-col gap-2 rounded-card border bg-muted/40 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-medium text-body">
          {t("profiles.editor.baseHeading", { id: base.id })}
        </span>
        <Badge variant="gray">{t("profiles.editor.managedInSettings")}</Badge>
      </div>
      <KeyValueList
        items={[
          {
            id: "engine",
            label: t("profiles.editor.engineModel"),
            value: t("profiles.editor.engineModelValue", {
              version: base.runtime_version,
              model: base.models.join(", "),
            }),
          },
          {
            id: "mode",
            label: t("profiles.editor.permissionMode"),
            value: <span className="font-mono">{base.permission_mode}</span>,
          },
          {
            id: "tools",
            label: t("profiles.editor.tools"),
            value:
              base.tools.length === 0 ? (
                t("profiles.noTools")
              ) : (
                <span className="flex flex-wrap gap-1">
                  {base.tools.map((tool) => (
                    <Badge key={tool} variant="mono">
                      {tool}
                    </Badge>
                  ))}
                </span>
              ),
          },
        ]}
      />
    </div>
  );
}
