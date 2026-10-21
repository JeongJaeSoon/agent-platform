import type { ApiError } from "@agent-platform/client";
import type {
  AgentCard,
  ListProfilesResponse,
  ProfileSummary,
} from "@agent-platform/contracts";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
  FieldLegend,
  FieldSet,
  Input,
  NativeSelect,
  NativeSelectOption,
  RadioGroup,
  RadioGroupItem,
  Textarea,
} from "@agent-platform/ui";
import type { UseQueryResult } from "@tanstack/react-query";
import { useId } from "react";
import type { components } from "../api/schema.gen.ts";
import { errorKey, useI18n } from "../i18n/i18n.tsx";

/** The card languages; agent-card-form.test.ts pins it to the contract. */
export const AGENT_CARD_LANGUAGE_VALUES: readonly AgentCard["language"][] = [
  "ko",
  "en",
];

/** The card as the form holds it: every field a string the inputs can edit. */
export interface CardDraft {
  readonly role: string;
  readonly instructions: string;
  readonly tone: string;
  readonly language: AgentCard["language"];
  readonly model: string;
  /** `all` = whatever the runtime profile allows (`tools: null`). */
  readonly toolsMode: "all" | "list";
  readonly tools: string;
  readonly forbidden: string;
}

export const EMPTY_DRAFT: CardDraft = {
  role: "",
  instructions: "",
  tone: "",
  language: "ko",
  model: "",
  toolsMode: "all",
  tools: "",
  forbidden: "",
};

// One name per line: the contract lets a tool name hold spaces and commas.
const splitList = (text: string) =>
  text
    .split("\n")
    .map((item) => item.trim())
    .filter(Boolean);

/**
 * The card as openapi-fetch's body types accept it. They turn a property
 * whose only type is null into `mcp?: never`, so a correct card (the server
 * requires `mcp: null`) does not type-check without this one cast.
 */
type ApiCard = Omit<
  components["schemas"]["CreateAgentRequest"]["card"],
  "capabilities"
> & {
  capabilities: Omit<
    components["schemas"]["CreateAgentRequest"]["card"]["capabilities"],
    "mcp"
  >;
};

export function draftFromCard(card: AgentCard): CardDraft {
  return {
    role: card.role,
    instructions: card.instructions,
    tone: card.tone ?? "",
    language: card.language,
    model: card.model,
    toolsMode: card.capabilities.tools === null ? "all" : "list",
    tools: (card.capabilities.tools ?? []).join("\n"),
    forbidden: card.capabilities.forbidden.join("\n"),
  };
}

/**
 * The card to send. An edit starts from `base` and overwrites only what the
 * form has a field for, so fields without an editor yet (rules, tool_policy,
 * credential_refs) survive the save.
 */
export function cardFromDraft(draft: CardDraft, base?: AgentCard): ApiCard {
  const { tone: _baseTone, ...kept } = base ?? { rules: [] };
  const card = {
    ...kept,
    role: draft.role.trim(),
    instructions: draft.instructions,
    ...(draft.tone.trim() ? { tone: draft.tone.trim() } : {}),
    language: draft.language,
    model: draft.model.trim(),
    capabilities: {
      ...base?.capabilities,
      tools: draft.toolsMode === "all" ? null : splitList(draft.tools),
      mcp: null,
      forbidden: splitList(draft.forbidden),
    },
  };
  return card as unknown as ApiCard;
}

export interface ModelOption {
  readonly model: string;
  /** The profiles that run it; empty for a model the catalog does not have. */
  readonly profileIds: readonly string[];
}

/**
 * One option per catalog model. A current model the catalog lacks stays as
 * the last option, so a card saved without touching the field keeps it.
 */
export function modelOptions(
  profiles: readonly ProfileSummary[],
  current: string,
): ModelOption[] {
  const byModel = new Map<string, string[]>();
  for (const profile of profiles)
    byModel.set(profile.model, [
      ...(byModel.get(profile.model) ?? []),
      profile.id,
    ]);
  const options = [...byModel].map(([model, profileIds]) => ({
    model,
    profileIds,
  }));
  return current === "" || byModel.has(current)
    ? options
    : [...options, { model: current, profileIds: [] }];
}

/** The fields that show an error: language and tools mode cannot be wrong. */
export const CARD_ERROR_FIELDS = [
  "role",
  "instructions",
  "tone",
  "model",
  "tools",
  "forbidden",
] as const satisfies readonly (keyof CardDraft)[];

/** A message per card field, from a form that validates the card. */
export type CardErrors = Partial<
  Record<(typeof CARD_ERROR_FIELDS)[number], string>
>;

export function AgentCardFields({
  draft,
  catalog,
  onChange,
  errors = {},
}: {
  readonly draft: CardDraft;
  readonly catalog: UseQueryResult<ListProfilesResponse>;
  readonly onChange: (draft: CardDraft) => void;
  readonly errors?: CardErrors | undefined;
}) {
  const { t } = useI18n();
  const toolsLegend = useId();
  const set = <K extends keyof CardDraft>(key: K, value: CardDraft[K]) =>
    onChange({ ...draft, [key]: value });
  return (
    <>
      <Field>
        <FieldLabel>{t("agentCard.role")}</FieldLabel>
        <Input
          required
          maxLength={200}
          value={draft.role}
          onChange={(event) => set("role", event.target.value)}
        />
        <FieldDescription>{t("agentCard.roleHint")}</FieldDescription>
        <FieldError>{errors.role}</FieldError>
      </Field>
      <Field>
        <FieldLabel>{t("agentCard.instructions")}</FieldLabel>
        <Textarea
          required
          maxLength={20_000}
          rows={8}
          value={draft.instructions}
          onChange={(event) => set("instructions", event.target.value)}
        />
        <FieldError>{errors.instructions}</FieldError>
      </Field>
      <Field>
        <FieldLabel>{t("agentCard.tone")}</FieldLabel>
        <Input
          maxLength={200}
          value={draft.tone}
          onChange={(event) => set("tone", event.target.value)}
        />
        <FieldDescription>{t("agentCard.optional")}</FieldDescription>
        <FieldError>{errors.tone}</FieldError>
      </Field>
      <Field>
        <FieldLabel>{t("agentCard.language")}</FieldLabel>
        <NativeSelect
          value={draft.language}
          onChange={(event) =>
            set("language", event.target.value as CardDraft["language"])
          }
        >
          {AGENT_CARD_LANGUAGE_VALUES.map((value) => (
            <NativeSelectOption key={value} value={value}>
              {value === "ko" ? "한국어" : "English"}
            </NativeSelectOption>
          ))}
        </NativeSelect>
      </Field>
      {catalog.isPending ? (
        <p className="text-muted-foreground text-sm">
          {t("agentCard.modelsLoading")}
        </p>
      ) : catalog.error ? (
        <p className="text-destructive text-sm" role="alert">
          {t("agentCard.modelsFailed", {
            reason: t(errorKey((catalog.error as ApiError).code)),
          })}
        </p>
      ) : (
        <ModelSelect
          options={modelOptions(catalog.data.items, draft.model)}
          value={draft.model}
          error={errors.model}
          onChange={(model) => set("model", model)}
        />
      )}
      <FieldSet className="gap-3">
        <FieldLegend id={toolsLegend} variant="label">
          {t("agentCard.tools")}
        </FieldLegend>
        <RadioGroup
          aria-labelledby={toolsLegend}
          value={draft.toolsMode}
          onValueChange={(mode) =>
            set("toolsMode", mode as CardDraft["toolsMode"])
          }
        >
          <Field orientation="horizontal">
            <RadioGroupItem value="all" />
            <FieldLabel>{t("agentCard.toolsAll")}</FieldLabel>
          </Field>
          <Field orientation="horizontal">
            <RadioGroupItem value="list" />
            <FieldLabel>{t("agentCard.toolsList")}</FieldLabel>
          </Field>
        </RadioGroup>
        {draft.toolsMode === "list" ? (
          <Field>
            <FieldLabel>{t("agentCard.toolNames")}</FieldLabel>
            <Textarea
              rows={3}
              value={draft.tools}
              onChange={(event) => set("tools", event.target.value)}
            />
            <FieldDescription>{t("agentCard.listHint")}</FieldDescription>
            <FieldError>{errors.tools}</FieldError>
          </Field>
        ) : null}
      </FieldSet>
      <Field>
        <FieldLabel>{t("agentCard.forbidden")}</FieldLabel>
        <Textarea
          rows={3}
          value={draft.forbidden}
          onChange={(event) => set("forbidden", event.target.value)}
        />
        <FieldDescription>{t("agentCard.forbiddenHint")}</FieldDescription>
        <FieldError>{errors.forbidden}</FieldError>
      </Field>
    </>
  );
}

function ModelSelect({
  options,
  value,
  error,
  onChange,
}: {
  readonly options: readonly ModelOption[];
  readonly value: string;
  readonly error: string | undefined;
  readonly onChange: (model: string) => void;
}) {
  const { t } = useI18n();
  const uncataloged = options.some(
    (option) => option.model === value && option.profileIds.length === 0,
  );
  return (
    <Field>
      <FieldLabel>{t("agentCard.model")}</FieldLabel>
      <NativeSelect
        required
        value={value}
        onChange={(event) => onChange(event.target.value)}
      >
        {value === "" ? (
          <NativeSelectOption value="" disabled>
            {t("agentCard.modelPick")}
          </NativeSelectOption>
        ) : null}
        {options.map((option) => (
          <NativeSelectOption key={option.model} value={option.model}>
            {option.profileIds.length === 0
              ? t("agentCard.modelUncataloged", { model: option.model })
              : t("agentCard.modelOption", {
                  model: option.model,
                  profiles: option.profileIds.join(", "),
                })}
          </NativeSelectOption>
        ))}
      </NativeSelect>
      <FieldDescription>{t("agentCard.modelHint")}</FieldDescription>
      {uncataloged ? (
        <FieldDescription className="web-notice">
          {t("agentCard.modelUncatalogedWarning")}
        </FieldDescription>
      ) : null}
      <FieldError>{error}</FieldError>
    </Field>
  );
}
