import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type ApiError, unwrap } from "@werft-ai/client";
import type { AgentCard, AgentDetail, AgentVersion } from "@werft-ai/contracts";
import { AGENT_DESCRIPTION_MAX_LENGTH } from "@werft-ai/contracts/agent-card";
import { useAgentPlatform } from "@werft-ai/react";
import {
  Alert,
  AlertActions,
  Button,
  Field,
  FieldDescription,
  FieldLabel,
  FieldLegend,
  FieldSet,
  Input,
  Section,
  Textarea,
} from "@werft-ai/ui";
import {
  type FormEvent,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  agentListsFilter,
  profilesQuery,
  queryKeysOf,
} from "../../api/queries.ts";
import { useRole } from "../../auth/guard.tsx";
import {
  AGENT_FORM,
  AgentCardFields,
  AgentInstructionsField,
  type CardDraft,
  cardFromDraft,
  draftFromCard,
  toolsBlocked,
} from "../../components/agent-card-form.tsx";
import type { Outcome } from "../../components/outcome.tsx";
import { SECTION_BODY } from "../../components/section-body.ts";
import { useI18n } from "../../i18n/i18n.tsx";
import { agentRefusal } from "../agents.tsx";
import { latestVersion } from "./versions.tsx";

export function CardEditor({
  detail,
  result,
  onOutcome,
  onSaved,
  onClose,
}: {
  readonly detail: AgentDetail;
  readonly result: ReactNode;
  readonly onOutcome: (outcome: Outcome | null) => void;
  /** The version the save resolved to, which the release form then offers. */
  readonly onSaved: (versionId: string) => void;
  /**
   * Back to the read-only card: on cancel, or after a save nothing was typed
   * after. Only a cancel hands the keyboard back; a save's result takes it.
   */
  readonly onClose: (cancelled: boolean) => void;
}) {
  const { t } = useI18n();
  const { client } = useAgentPlatform();
  const queryClient = useQueryClient();
  const role = useRole();
  const latest = latestVersion(detail);
  // The edit is tied to the version it started from, not to whatever a
  // background refetch last brought in, so unsaved input is never replaced.
  const [edit, setEdit] = useState(() => startEdit(detail));
  const base = detail.versions.find((v) => v.id === edit.baseId);
  const cardChanged = (e: Edit) =>
    e.draft !== null &&
    JSON.stringify(e.draft) !==
      JSON.stringify(base ? draftFromCard(base.card) : null);
  const dirty =
    edit.name !== edit.baseName ||
    edit.description !== edit.baseDescription ||
    cardChanged(edit);
  const stale = (latest?.id ?? null) !== edit.seenLatestId;
  if (
    (stale ||
      detail.agent.name !== edit.baseName ||
      descriptionOf(detail) !== edit.baseDescription) &&
    !dirty
  )
    setEdit(startEdit(detail));
  const setName = (name: string) => setEdit((e) => ({ ...e, name }));
  const setDescription = (description: string) =>
    setEdit((e) => ({ ...e, description }));
  const setDraft = (draft: CardDraft) => setEdit((e) => ({ ...e, draft }));
  const { name, description, draft } = edit;
  const catalog = useQuery(profilesQuery(client));
  const latestEdit = useRef(edit);
  latestEdit.current = edit;
  const title = useRef<HTMLHeadingElement>(null);
  // The editor replaces the button that opened it.
  useEffect(() => title.current?.focus(), []);

  const save = useMutation<AgentDetail, ApiError, Submitted>({
    mutationFn: ({
      baseName,
      baseDescription,
      name,
      description,
      draft,
      sendsCard,
    }) =>
      unwrap(
        client.PATCH("/v1/agents/{id}", {
          params: {
            path: { id: detail.agent.id },
          },
          body: {
            // Only what the user changed: sending the value the edit started
            // from would undo a change made elsewhere since.
            ...(name.trim() !== baseName ? { name: name.trim() } : {}),
            ...(description.trim() !== baseDescription
              ? { description: description.trim() }
              : {}),
            // Name and description alone change the row, not the version.
            ...(sendsCard && draft
              ? { card: cardFromDraft(draft, base?.card) }
              : {}),
          },
        }),
      ) as Promise<AgentDetail>,
    onMutate: () => onOutcome(null),
    onSuccess: async (updated, submitted) => {
      // The server keeps one version per card content, so the card just saved
      // may be an older version rather than the highest one.
      const saved = submitted.sendsCard
        ? savedVersion(detail, updated, submitted)
        : undefined;
      if (saved) onSaved(saved.id);
      const isNew =
        saved !== undefined && !detail.versions.some((v) => v.id === saved.id);
      onOutcome({
        kind: "notice",
        text: !submitted.sendsCard
          ? t("agent.identitySaved")
          : isNew
            ? t("agent.saved", { version: saved.version_no })
            : saved && saved.id !== submitted.baseId
              ? t("agent.savedExisting", { version: saved.version_no })
              : t("agent.savedNoChange"),
      });
      if (sameEdit(latestEdit.current, submitted)) onClose(false);
      // Input typed while the request was in flight stays; it is now an edit
      // of the version just saved, or of the one it started from when only
      // the row changed.
      const now =
        saved ?? updated.versions.find((v) => v.id === submitted.baseId);
      setEdit((current) =>
        sameEdit(current, submitted)
          ? startEdit(updated, now)
          : {
              ...current,
              baseId: now?.id ?? null,
              seenLatestId: latestVersion(updated)?.id ?? null,
              // An untouched field follows the server, so a change made
              // elsewhere is not sent back as the user's on the next save.
              baseName: updated.agent.name,
              name:
                current.name.trim() === current.baseName
                  ? updated.agent.name
                  : current.name,
              baseDescription: descriptionOf(updated),
              description:
                current.description.trim() === current.baseDescription
                  ? descriptionOf(updated)
                  : current.description,
            },
      );
      queryClient.setQueryData(
        queryKeysOf(client).agent(detail.agent.id),
        updated,
      );
      await queryClient.invalidateQueries(agentListsFilter(client));
    },
    onError: (error) =>
      onOutcome({ kind: "error", text: agentRefusal(t, error, role) }),
  });

  // A save with nothing changed still sends the card, which the server
  // answers with the same version, as a request needs some field.
  const sendsCard =
    cardChanged(edit) ||
    (edit.name.trim() === edit.baseName &&
      edit.description.trim() === edit.baseDescription);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    save.mutate({ ...edit, sendsCard });
  };

  return (
    <Section
      title={t("agent.card.title")}
      titleProps={{ ref: title, tabIndex: -1, className: "outline-none" }}
      description={t("agent.card.intro")}
    >
      <div className={SECTION_BODY}>
        {stale && latest ? (
          <Alert variant="amber">
            <output>
              {t("agent.card.stale", { version: latest.version_no })}
            </output>
            <AlertActions>
              <Button
                type="button"
                variant="outline"
                onClick={() => setEdit(startEdit(detail))}
              >
                {t("agent.card.takeLatest")}
              </Button>
            </AlertActions>
          </Alert>
        ) : null}
        <form className={AGENT_FORM} onSubmit={submit}>
          <FieldSet className="gap-4">
            <FieldLegend>{t("agent.card.identity")}</FieldLegend>
            <FieldDescription>{t("agent.card.identityHint")}</FieldDescription>
            <Field>
              <FieldLabel>{t("agents.name")}</FieldLabel>
              <Input
                required
                maxLength={120}
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            </Field>
            <Field>
              <FieldLabel>{t("agents.description")}</FieldLabel>
              <Textarea
                maxLength={AGENT_DESCRIPTION_MAX_LENGTH}
                rows={3}
                value={description}
                onChange={(event) => setDescription(event.target.value)}
              />
            </Field>
          </FieldSet>
          {draft ? (
            <FieldSet className="gap-4">
              <FieldLegend>{t("agent.card.run")}</FieldLegend>
              <FieldDescription>{t("agent.card.runHint")}</FieldDescription>
              <AgentInstructionsField
                value={draft.agentInstructions ?? ""}
                earlier={base?.card.instructions}
                onChange={(agentInstructions) =>
                  setDraft({ ...draft, agentInstructions })
                }
              />
              <AgentCardFields
                draft={draft}
                catalog={catalog}
                onChange={setDraft}
              />
            </FieldSet>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <Button
              type="submit"
              disabled={
                save.isPending ||
                // A save of the name or description alone sends no card,
                // so the run settings' checks do not hold it back.
                (draft !== null &&
                  sendsCard &&
                  (!catalog.isSuccess ||
                    toolsBlocked(catalog.data.items, draft)))
              }
            >
              {save.isPending ? t("agent.card.saving") : t("agent.card.save")}
            </Button>
            <Button
              type="button"
              variant="ghost"
              disabled={save.isPending}
              onClick={() => {
                onOutcome(null);
                onClose(true);
              }}
            >
              {t("common.cancel")}
            </Button>
          </div>
        </form>
        {result}
      </div>
    </Section>
  );
}

interface Edit {
  readonly baseId: string | null;
  /** The newest version when the edit started; a newer one means another save. */
  readonly seenLatestId: string | null;
  readonly baseName: string;
  readonly baseDescription: string;
  readonly name: string;
  readonly description: string;
  readonly draft: CardDraft | null;
}

interface Submitted extends Edit {
  /** Whether the card differs from its base; else only the row is saved. */
  readonly sendsCard: boolean;
}

const sameEdit = (a: Edit, b: Edit) =>
  a.name === b.name &&
  a.description === b.description &&
  JSON.stringify(a.draft) === JSON.stringify(b.draft);

const descriptionOf = (detail: AgentDetail) => detail.agent.description ?? "";
function startEdit(detail: AgentDetail, from?: AgentVersion): Edit {
  const latest = latestVersion(detail);
  const base = from ?? latest;
  return {
    baseId: base?.id ?? null,
    seenLatestId: latest?.id ?? null,
    baseName: detail.agent.name,
    baseDescription: descriptionOf(detail),
    name: detail.agent.name,
    description: descriptionOf(detail),
    draft: base ? draftFromCard(base.card) : null,
  };
}

function savedVersion(
  before: AgentDetail,
  after: AgentDetail,
  submitted: Edit,
): AgentVersion | undefined {
  const baseCard = before.versions.find((v) => v.id === submitted.baseId)?.card;
  // Both sides go through the same normalisation the request did, rules
  // included, so a card that only differs in what the server trims matches.
  const normal = (draft: CardDraft, card?: AgentCard) =>
    JSON.stringify(cardFromDraft(draft, card));
  const sent = submitted.draft ? normal(submitted.draft, baseCard) : null;
  const matching = after.versions.filter(
    (version) => normal(draftFromCard(version.card), version.card) === sent,
  );
  return (
    latestVersion({ ...after, versions: matching }) ?? latestVersion(after)
  );
}
