import type {
  AgentCard,
  ListProfilesResponse,
  ProfileSummary,
} from "@agent-platform/contracts";
import type { UseQueryResult } from "@tanstack/react-query";
import { useId } from "react";
import type { ApiError } from "../api/client.ts";
import type { components } from "../api/schema.gen.ts";
import { errorKey, useI18n } from "../i18n/i18n.tsx";
import { TextAreaField, TextField } from "./field.tsx";

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

export function AgentCardFields({
  draft,
  catalog,
  onChange,
}: {
  readonly draft: CardDraft;
  readonly catalog: UseQueryResult<ListProfilesResponse>;
  readonly onChange: (draft: CardDraft) => void;
}) {
  const { t } = useI18n();
  const toolsLegend = useId();
  const set = <K extends keyof CardDraft>(key: K, value: CardDraft[K]) =>
    onChange({ ...draft, [key]: value });
  return (
    <>
      <TextField
        label={t("agentCard.role")}
        hint={t("agentCard.roleHint")}
        required
        maxLength={200}
        value={draft.role}
        onChange={(event) => set("role", event.target.value)}
      />
      <TextAreaField
        label={t("agentCard.instructions")}
        required
        maxLength={20_000}
        rows={8}
        value={draft.instructions}
        onChange={(event) => set("instructions", event.target.value)}
      />
      <TextField
        label={t("agentCard.tone")}
        hint={t("agentCard.optional")}
        maxLength={200}
        value={draft.tone}
        onChange={(event) => set("tone", event.target.value)}
      />
      <label className="web-field">
        <span>{t("agentCard.language")}</span>
        <select
          className="ap-input"
          value={draft.language}
          onChange={(event) =>
            set("language", event.target.value as CardDraft["language"])
          }
        >
          {AGENT_CARD_LANGUAGE_VALUES.map((value) => (
            <option key={value} value={value}>
              {value === "ko" ? "한국어" : "English"}
            </option>
          ))}
        </select>
      </label>
      {catalog.isPending ? (
        <p className="web-page__empty">{t("agentCard.modelsLoading")}</p>
      ) : catalog.error ? (
        <p className="web-form__error" role="alert">
          {t("agentCard.modelsFailed", {
            reason: t(errorKey((catalog.error as ApiError).code)),
          })}
        </p>
      ) : (
        <ModelSelect
          options={modelOptions(catalog.data.items, draft.model)}
          value={draft.model}
          onChange={(model) => set("model", model)}
        />
      )}
      <fieldset className="web-fieldset" aria-labelledby={toolsLegend}>
        <legend id={toolsLegend}>{t("agentCard.tools")}</legend>
        <label className="web-choice">
          <input
            type="radio"
            name="tools-mode"
            checked={draft.toolsMode === "all"}
            onChange={() => set("toolsMode", "all")}
          />
          {t("agentCard.toolsAll")}
        </label>
        <label className="web-choice">
          <input
            type="radio"
            name="tools-mode"
            checked={draft.toolsMode === "list"}
            onChange={() => set("toolsMode", "list")}
          />
          {t("agentCard.toolsList")}
        </label>
        {draft.toolsMode === "list" ? (
          <TextAreaField
            rows={3}
            label={t("agentCard.toolNames")}
            hint={t("agentCard.listHint")}
            value={draft.tools}
            onChange={(event) => set("tools", event.target.value)}
          />
        ) : null}
      </fieldset>
      <TextAreaField
        rows={3}
        label={t("agentCard.forbidden")}
        hint={t("agentCard.forbiddenHint")}
        value={draft.forbidden}
        onChange={(event) => set("forbidden", event.target.value)}
      />
    </>
  );
}

function ModelSelect({
  options,
  value,
  onChange,
}: {
  readonly options: readonly ModelOption[];
  readonly value: string;
  readonly onChange: (model: string) => void;
}) {
  const { t } = useI18n();
  const hintId = useId();
  const warningId = useId();
  const uncataloged = options.some(
    (option) => option.model === value && option.profileIds.length === 0,
  );
  return (
    <div className="web-field">
      <label className="web-field">
        <span>{t("agentCard.model")}</span>
        <select
          className="ap-input"
          required
          value={value}
          aria-describedby={uncataloged ? `${hintId} ${warningId}` : hintId}
          onChange={(event) => onChange(event.target.value)}
        >
          {value === "" ? (
            <option value="" disabled>
              {t("agentCard.modelPick")}
            </option>
          ) : null}
          {options.map((option) => (
            <option key={option.model} value={option.model}>
              {option.profileIds.length === 0
                ? t("agentCard.modelUncataloged", { model: option.model })
                : t("agentCard.modelOption", {
                    model: option.model,
                    profiles: option.profileIds.join(", "),
                  })}
            </option>
          ))}
        </select>
      </label>
      <span id={hintId} className="web-field__hint">
        {t("agentCard.modelHint")}
      </span>
      {uncataloged ? (
        <p id={warningId} className="web-notice">
          {t("agentCard.modelUncatalogedWarning")}
        </p>
      ) : null}
    </div>
  );
}
