import type { AgentCard } from "@agent-platform/contracts";
import { useId } from "react";
import type { components } from "../api/schema.gen.ts";
import { useI18n } from "../i18n/i18n.tsx";
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

const splitList = (text: string) =>
  text
    .split(/[\s,]+/)
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
    tools: (card.capabilities.tools ?? []).join(", "),
    forbidden: card.capabilities.forbidden.join(", "),
  };
}

/**
 * The card to send. Rules have no editor yet, so an edit carries the ones
 * the card already had rather than dropping them.
 */
export function cardFromDraft(draft: CardDraft, base?: AgentCard): ApiCard {
  const card: components["schemas"]["CreateAgentRequest"]["card"] = {
    role: draft.role.trim(),
    instructions: draft.instructions,
    ...(draft.tone.trim() ? { tone: draft.tone.trim() } : {}),
    language: draft.language,
    model: draft.model.trim(),
    capabilities: {
      tools: draft.toolsMode === "all" ? null : splitList(draft.tools),
      mcp: null,
      forbidden: splitList(draft.forbidden),
    },
    rules: base?.rules ?? [],
  };
  return card as unknown as ApiCard;
}

export function AgentCardFields({
  draft,
  onChange,
}: {
  readonly draft: CardDraft;
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
      <TextField
        label={t("agentCard.model")}
        hint={t("agentCard.modelHint")}
        required
        maxLength={128}
        value={draft.model}
        onChange={(event) => set("model", event.target.value)}
      />
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
          <TextField
            label={t("agentCard.toolNames")}
            hint={t("agentCard.listHint")}
            value={draft.tools}
            onChange={(event) => set("tools", event.target.value)}
          />
        ) : null}
      </fieldset>
      <TextField
        label={t("agentCard.forbidden")}
        hint={t("agentCard.forbiddenHint")}
        value={draft.forbidden}
        onChange={(event) => set("forbidden", event.target.value)}
      />
    </>
  );
}
