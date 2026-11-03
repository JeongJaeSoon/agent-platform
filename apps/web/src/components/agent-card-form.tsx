import type { UseQueryResult } from "@tanstack/react-query";
import type { ApiError } from "@werft-ai/client";
import type {
  AgentCard,
  ListProfilesResponse,
  ProfileSummary,
} from "@werft-ai/contracts";
import { AGENT_INSTRUCTIONS_MAX_LENGTH } from "@werft-ai/contracts/agent-card";
import { draftCapabilities, withAgentInstructions } from "@werft-ai/core/forms";
import {
  Alert,
  AlertActions,
  AlertDescription,
  AlertTitle,
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
  NativeSelect,
  NativeSelectOption,
  Skeleton,
  Switch,
  Textarea,
} from "@werft-ai/ui";
import { useEffect, useRef, useState } from "react";
import type { components } from "../api/schema.gen.ts";
import { errorKey, LOCALE_NAMES, useI18n } from "../i18n/i18n.tsx";
import { builtinToolNote } from "../routes/operations-tool-notes.ts";
import { ProfileOptions, pickable } from "./profile-options.tsx";

/** The card languages; agent-card-form.test.ts pins it to the contract. */
export const AGENT_CARD_LANGUAGE_VALUES: readonly AgentCard["language"][] = [
  "ko",
  "en",
];

/** The card as the form holds it. */
export interface CardDraft {
  /**
   * The card's `agent_instructions`, "" for none. Absent from the new-agent
   * flow, which has no field for it, so a save there keeps the card's.
   */
  readonly agentInstructions?: string | undefined;
  readonly language: AgentCard["language"];
  readonly model: string;
  /** `all` = whatever the runtime profile allows (`tools: null`). */
  readonly toolsMode: "all" | "list";
  /** The checked tools; read only in `list` mode. */
  readonly tools: string[];
  /** Only ever shrinks here: the form shows the list and can clear it. */
  readonly forbidden: string[];
}

export const EMPTY_DRAFT: CardDraft = {
  language: "ko",
  model: "",
  toolsMode: "all",
  tools: [],
  forbidden: [],
};

export type ApiCard = components["schemas"]["CreateAgentRequest"]["card"];

export function draftFromCard(card: AgentCard): CardDraft {
  return {
    agentInstructions: card.agent_instructions ?? "",
    language: card.language,
    model: card.model,
    toolsMode: card.capabilities.tools === null ? "all" : "list",
    tools: [...(card.capabilities.tools ?? [])],
    forbidden: [...card.capabilities.forbidden],
  };
}

const isStrings = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string");

// Input kept from before the checklist held each list as one name per line.
const listOf = (value: unknown): string[] | null =>
  isStrings(value)
    ? value
    : typeof value === "string"
      ? value
          .split("\n")
          .map((item) => item.trim())
          .filter(Boolean)
      : null;

/**
 * A draft from input kept across a reload (history.state, sessionStorage),
 * which may predate this form; null when it is not one.
 */
export function cardDraftOf(value: unknown): CardDraft | null {
  if (typeof value !== "object" || value === null) return null;
  const kept = value as Record<keyof CardDraft, unknown>;
  const tools = listOf(kept.tools);
  const forbidden = listOf(kept.forbidden);
  if (
    tools === null ||
    forbidden === null ||
    typeof kept.model !== "string" ||
    !(
      kept.agentInstructions === undefined ||
      typeof kept.agentInstructions === "string"
    ) ||
    !AGENT_CARD_LANGUAGE_VALUES.includes(kept.language as never) ||
    (kept.toolsMode !== "all" && kept.toolsMode !== "list")
  )
    return null;
  // Input kept before the role and instructions fields left the form drops them.
  return {
    ...(kept.agentInstructions === undefined
      ? {}
      : { agentInstructions: kept.agentInstructions as string }),
    language: kept.language as CardDraft["language"],
    model: kept.model,
    toolsMode: kept.toolsMode,
    tools,
    forbidden,
  };
}

/**
 * The card to send. An edit starts from `base` and overwrites only what the
 * form has a field for, so fields without an editor (rules, tool_policy,
 * credential_refs, an earlier role and instructions) survive the save.
 */
export function cardFromDraft(draft: CardDraft, base?: AgentCard): ApiCard {
  const card = withAgentInstructions(
    {
      ...(base ?? { rules: [] }),
      language: draft.language,
      model: draft.model.trim(),
      capabilities: draftCapabilities(draft, base?.capabilities),
    },
    draft.agentInstructions,
  );
  return card as unknown as ApiCard;
}

/** The usable profiles that run `model`: what a release of the card may name. */
export function runningProfiles(
  profiles: readonly ProfileSummary[],
  model: string,
): ProfileSummary[] {
  return profiles.filter(
    (profile) => pickable(profile) && profile.models.includes(model),
  );
}

/**
 * The profiles whose tools the checklist offers, the first being the
 * default: those of `previewable` (the new-agent flow's own releases) when
 * any runs the model, else every one that does, released from the agent's
 * releases tab.
 */
export function previewProfiles(
  profiles: readonly ProfileSummary[],
  model: string,
  previewable: (profile: ProfileSummary) => boolean = pickable,
): ProfileSummary[] {
  const running = runningProfiles(profiles, model);
  const preferred = running.filter(previewable);
  return preferred.length > 0 ? preferred : running;
}

/**
 * The profile the checklist shows and a new release starts from: `wanted`
 * while it is one of `previewProfiles`, else the first of them. The agent
 * detail resolves both through here, so the two cannot name different ones.
 */
export function chosenProfile(
  profiles: readonly ProfileSummary[],
  model: string,
  wanted: string | undefined,
  previewable?: (profile: ProfileSummary) => boolean,
): ProfileSummary | undefined {
  const candidates = previewProfiles(profiles, model, previewable);
  return candidates.find((profile) => profile.id === wanted) ?? candidates[0];
}

/** Of `candidates`, those that allow every tool the draft names. */
export function allowingProfiles(
  candidates: readonly ProfileSummary[],
  draft: Pick<CardDraft, "toolsMode" | "tools">,
): ProfileSummary[] {
  return draft.toolsMode === "all"
    ? [...candidates]
    : candidates.filter((profile) =>
        draft.tools.every((tool) => profile.tools.includes(tool)),
      );
}

/**
 * Whether the save must wait: no profile that runs the model allows the
 * tools chosen, so no release could. A model the catalog does not run is
 * left to the model field, which says so.
 */
export function toolsBlocked(
  profiles: readonly ProfileSummary[],
  draft: CardDraft,
): boolean {
  const running = runningProfiles(profiles, draft.model);
  return running.length > 0 && allowingProfiles(running, draft).length === 0;
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
  for (const profile of profiles.filter(pickable))
    for (const model of profile.models)
      byModel.set(model, [...(byModel.get(model) ?? []), profile.id]);
  const options = [...byModel].map(([model, profileIds]) => ({
    model,
    profileIds,
  }));
  return current === "" || byModel.has(current)
    ? options
    : [...options, { model: current, profileIds: [] }];
}

/**
 * The card around an agent form: a fixed 8px from label to control and from
 * control to hint, so a long hint does not open a wider gap than a short one.
 */
export const AGENT_FORM =
  "flex w-full flex-col gap-4 rounded-card border bg-card p-4 [&_[data-slot=field-description]]:mt-0! [&_[data-slot=field-description]]:text-caption [&_[data-slot=field-label]]:text-control [&_[data-slot=field][data-orientation=vertical]]:gap-2";

/**
 * The fields that show an error: language, tools mode and the read-only
 * forbidden list cannot be wrong.
 */
export const CARD_ERROR_FIELDS = [
  "model",
  "tools",
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
  previewable,
  previewId,
  onPreviewChange,
}: {
  readonly draft: CardDraft;
  readonly catalog: UseQueryResult<ListProfilesResponse>;
  readonly onChange: (draft: CardDraft) => void;
  readonly errors?: CardErrors | undefined;
  /** Which profiles may preview the tools; every usable one by default. */
  readonly previewable?: (profile: ProfileSummary) => boolean;
  /**
   * The profile picked to preview, held by a caller that outlives this form
   * (the new-agent flow, which releases with it); else the form holds it.
   */
  readonly previewId?: string | undefined;
  readonly onPreviewChange?: (profileId: string) => void;
}) {
  const { t } = useI18n();
  const set = <K extends keyof CardDraft>(key: K, value: CardDraft[K]) =>
    onChange({ ...draft, [key]: value });
  return (
    <>
      {catalog.isPending ? (
        <Skeleton label={t("agentCard.modelsLoading")} />
      ) : catalog.error ? (
        <FieldError>
          {t("agentCard.modelsFailed", {
            reason: t(errorKey((catalog.error as ApiError).code)),
          })}
        </FieldError>
      ) : (
        <>
          <ModelSelect
            options={modelOptions(catalog.data.items, draft.model)}
            value={draft.model}
            error={errors.model}
            onChange={(model) => set("model", model)}
          />
          <ToolFields
            draft={draft}
            profiles={catalog.data.items}
            previewable={previewable}
            error={errors.tools}
            onChange={onChange}
            previewId={previewId}
            onPreviewChange={onPreviewChange}
          />
        </>
      )}
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
              {LOCALE_NAMES[value]}
            </NativeSelectOption>
          ))}
        </NativeSelect>
      </Field>
    </>
  );
}

/**
 * The card's agent instructions, appended to the system prompt of sessions
 * a release of it starts. A card's earlier `instructions` never ran; they
 * are shown to be copied in, never moved by themselves (agent-wizard-rework.md
 * item 2).
 */
export function AgentInstructionsField({
  value,
  earlier,
  onChange,
}: {
  readonly value: string;
  readonly earlier: string | undefined;
  readonly onChange: (value: string) => void;
}) {
  const { t } = useI18n();
  return (
    <>
      <Field>
        <FieldLabel>{t("agentCard.agentInstructions")}</FieldLabel>
        <Textarea
          maxLength={AGENT_INSTRUCTIONS_MAX_LENGTH}
          rows={10}
          value={value}
          onChange={(event) => onChange(event.target.value)}
        />
        <FieldDescription>
          {t("agentCard.agentInstructionsHint")}
        </FieldDescription>
      </Field>
      {earlier ? (
        <Alert variant="amber">
          <AlertTitle>{t("agentCard.earlierInstructions")}</AlertTitle>
          <AlertDescription className="line-clamp-4 whitespace-pre-wrap [overflow-wrap:anywhere]">
            {earlier}
          </AlertDescription>
          <AlertActions>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={value === earlier}
              onClick={() => onChange(earlier)}
            >
              {t("agentCard.importEarlier")}
            </Button>
          </AlertActions>
        </Alert>
      ) : null}
    </>
  );
}

const without = (list: readonly string[], item: string) =>
  list.filter((entry) => entry !== item);

/**
 * The tools as one checklist of the preview profile's tools (decision
 * agent-wizard-rework.md 3b). Unchecking is what forbids; the card's
 * `forbidden` is shown only to be cleared.
 */
function ToolFields({
  draft,
  profiles,
  previewable,
  error,
  onChange,
  previewId,
  onPreviewChange,
}: {
  readonly draft: CardDraft;
  readonly profiles: readonly ProfileSummary[];
  readonly previewable: ((profile: ProfileSummary) => boolean) | undefined;
  readonly error: string | undefined;
  readonly onChange: (draft: CardDraft) => void;
  readonly previewId: string | undefined;
  readonly onPreviewChange: ((profileId: string) => void) | undefined;
}) {
  const { t, locale } = useI18n();
  const candidates = previewProfiles(profiles, draft.model, previewable);
  const [ownPick, setOwnPick] = useState<string>();
  const preview = chosenProfile(
    profiles,
    draft.model,
    previewId ?? ownPick,
    previewable,
  );
  // A draft model change can resolve to another profile than the one shared;
  // the shared value follows then, and only then: a pick made in the releases
  // tab that this draft's model cannot show must stay.
  const resolved = preview?.id;
  const modelSeen = useRef(draft.model);
  useEffect(() => {
    if (modelSeen.current === draft.model) return;
    modelSeen.current = draft.model;
    if (resolved !== undefined && resolved !== previewId) {
      onPreviewChange?.(resolved);
    }
  }, [draft.model, resolved, previewId, onPreviewChange]);
  const offered = preview?.tools ?? [];
  const all = draft.toolsMode === "all";
  const outside = all
    ? []
    : draft.tools.filter((tool) => !offered.includes(tool));
  const forbidden = (tool: string) => draft.forbidden.includes(tool);
  const check = (tool: string, on: boolean) =>
    onChange({
      ...draft,
      tools: on
        ? [...without(draft.tools, tool), tool]
        : without(draft.tools, tool),
    });
  const allowing = allowingProfiles(
    runningProfiles(profiles, draft.model),
    draft,
  ).length;
  const blocked = toolsBlocked(profiles, draft);
  return (
    <FieldSet className="gap-3">
      <FieldLegend variant="label">{t("agentCard.tools")}</FieldLegend>
      {candidates.length > 0 ? (
        <Field>
          <FieldLabel>{t("agentCard.previewProfile")}</FieldLabel>
          <NativeSelect
            value={preview?.id ?? ""}
            onChange={(event) => {
              setOwnPick(event.target.value);
              onPreviewChange?.(event.target.value);
            }}
          >
            <ProfileOptions profiles={candidates} />
          </NativeSelect>
          <FieldDescription>
            {t("agentCard.previewProfileHint")}
          </FieldDescription>
        </Field>
      ) : draft.model === "" ? null : (
        <FieldDescription>{t("agentCard.noPreview")}</FieldDescription>
      )}
      <Field orientation="horizontal">
        <Switch
          checked={all}
          onCheckedChange={(on) =>
            onChange({
              ...draft,
              toolsMode: on ? "all" : "list",
              // Turning it off starts from what ran so far: every tool.
              tools:
                on || draft.tools.length > 0
                  ? draft.tools
                  : offered.filter((tool) => !draft.forbidden.includes(tool)),
            })
          }
        />
        <FieldContent>
          <FieldLabel>{t("agentCard.toolsAll")}</FieldLabel>
          <FieldDescription>{t("agentCard.toolsAllHint")}</FieldDescription>
        </FieldContent>
      </Field>
      {offered.map((tool) => (
        <ToolRow
          key={tool}
          tool={tool}
          // A forbidden tool stays off until the list below is cleared.
          note={
            forbidden(tool)
              ? t("agentCard.toolForbidden")
              : builtinToolNote(locale, tool)
          }
          checked={(all || draft.tools.includes(tool)) && !forbidden(tool)}
          disabled={all || forbidden(tool)}
          onCheckedChange={(on) => check(tool, on)}
        />
      ))}
      {outside.map((tool) => (
        <ToolRow
          key={tool}
          tool={tool}
          note={t("agentCard.toolOutside")}
          checked
          onCheckedChange={(on) => {
            if (!on) check(tool, false);
          }}
        />
      ))}
      {candidates.length > 0 ? (
        <FieldDescription>
          {t("agentCard.allowing", { count: allowing })}
        </FieldDescription>
      ) : null}
      <FieldError>{blocked ? t("agentCard.allowingNone") : error}</FieldError>
      {draft.forbidden.length > 0 ? (
        <FieldSet className="gap-2">
          <FieldLegend variant="label" className="mb-0">
            {t("agentCard.forbidden")}
          </FieldLegend>
          <ul className="flex flex-wrap gap-1">
            {draft.forbidden.map((tool) => (
              <li key={tool}>
                <Badge variant="mono">{tool}</Badge>
              </li>
            ))}
          </ul>
          <FieldDescription>{t("agentCard.forbiddenHint")}</FieldDescription>
          <div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => onChange({ ...draft, forbidden: [] })}
            >
              {t("agentCard.forbiddenClear")}
            </Button>
          </div>
        </FieldSet>
      ) : null}
    </FieldSet>
  );
}

function ToolRow({
  tool,
  note,
  checked,
  disabled,
  onCheckedChange,
}: {
  readonly tool: string;
  readonly note: string | undefined;
  readonly checked: boolean;
  readonly disabled?: boolean;
  readonly onCheckedChange: (on: boolean) => void;
}) {
  return (
    <Field orientation="horizontal">
      <Checkbox
        checked={checked}
        disabled={disabled}
        onCheckedChange={(state) => onCheckedChange(state === true)}
      />
      <FieldContent>
        <FieldLabel className="font-mono">{tool}</FieldLabel>
        {note ? <FieldDescription>{note}</FieldDescription> : null}
      </FieldContent>
    </Field>
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
              : option.model}
          </NativeSelectOption>
        ))}
      </NativeSelect>
      <FieldDescription>{t("agentCard.modelHint")}</FieldDescription>
      {uncataloged ? (
        <Alert variant="amber">
          <FieldDescription>
            {t("agentCard.modelUncatalogedWarning")}
          </FieldDescription>
        </Alert>
      ) : null}
      <FieldError>{error}</FieldError>
    </Field>
  );
}
