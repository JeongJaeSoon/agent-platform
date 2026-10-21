import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type ApiError, unwrap } from "@werft-ai/client";
import type { AgentCard, AgentDetail, AgentVersion } from "@werft-ai/contracts";
import { useAgentPlatform } from "@werft-ai/react";
import { type FormEvent, type ReactNode, useId, useState } from "react";
import { profilesQuery, queryKeys } from "../../api/queries.ts";
import { useRole } from "../../auth/guard.tsx";
import {
  AgentCardFields,
  type CardDraft,
  cardFromDraft,
  draftFromCard,
} from "../../components/agent-card-form.tsx";
import { TextField } from "../../components/field.tsx";
import type { Outcome } from "../../components/outcome.tsx";
import { useI18n } from "../../i18n/i18n.tsx";
import { agentRefusal } from "../agents.tsx";
import { latestVersion } from "./versions.tsx";

export function CardEditor({
  detail,
  result,
  onOutcome,
  onSaved,
}: {
  readonly detail: AgentDetail;
  readonly result: ReactNode;
  readonly onOutcome: (outcome: Outcome | null) => void;
  /** The version the save resolved to, which the release form then offers. */
  readonly onSaved: (versionId: string) => void;
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
  const dirty =
    edit.name !== edit.baseName ||
    JSON.stringify(edit.draft) !==
      JSON.stringify(base ? draftFromCard(base.card) : null);
  const stale = (latest?.id ?? null) !== edit.seenLatestId;
  if ((stale || detail.agent.name !== edit.baseName) && !dirty)
    setEdit(startEdit(detail));
  const setName = (name: string) => setEdit((e) => ({ ...e, name }));
  const setDraft = (draft: CardDraft) => setEdit((e) => ({ ...e, draft }));
  const { name, draft } = edit;
  const catalog = useQuery(profilesQuery(client));
  const titleId = useId();

  const save = useMutation<AgentDetail, ApiError, Edit>({
    mutationFn: ({ baseName, name, draft }) =>
      unwrap(
        client.PATCH("/v1/agents/{id}", {
          params: {
            path: { id: detail.agent.id },
          },
          body: {
            // Only a name the user changed: sending the one the edit started
            // from would undo a rename made elsewhere since.
            ...(name.trim() !== baseName ? { name: name.trim() } : {}),
            ...(draft ? { card: cardFromDraft(draft, base?.card) } : {}),
          },
        }),
      ) as Promise<AgentDetail>,
    onMutate: () => onOutcome(null),
    onSuccess: async (updated, submitted) => {
      // The server keeps one version per card content, so the card just saved
      // may be an older version rather than the highest one.
      const saved = savedVersion(detail, updated, submitted);
      if (saved) onSaved(saved.id);
      const isNew =
        saved !== undefined && !detail.versions.some((v) => v.id === saved.id);
      onOutcome({
        kind: "notice",
        text: isNew
          ? t("agent.saved", { version: saved.version_no })
          : saved && saved.id !== submitted.baseId
            ? t("agent.savedExisting", { version: saved.version_no })
            : t("agent.savedNoChange"),
      });
      // Input typed while the request was in flight stays; it is now an edit
      // of the version just saved.
      setEdit((current) =>
        sameEdit(current, submitted)
          ? startEdit(updated, saved)
          : {
              ...current,
              baseId: saved?.id ?? null,
              seenLatestId: latestVersion(updated)?.id ?? null,
              baseName: updated.agent.name,
            },
      );
      queryClient.setQueryData(queryKeys.agent(detail.agent.id), updated);
      await queryClient.invalidateQueries({
        queryKey: queryKeys.agents,
        exact: true,
      });
    },
    onError: (error) =>
      onOutcome({ kind: "error", text: agentRefusal(t, error, role) }),
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    save.mutate(edit);
  };

  return (
    <section className="web-section" aria-labelledby={titleId}>
      <h2 id={titleId}>{t("agent.card.title")}</h2>
      <p className="web-page__empty">{t("agent.card.intro")}</p>
      {stale && latest ? (
        <div className="web-notice">
          <output>
            {t("agent.card.stale", { version: latest.version_no })}
          </output>
          <button
            type="button"
            className="ap-button"
            onClick={() => setEdit(startEdit(detail))}
          >
            {t("agent.card.takeLatest")}
          </button>
        </div>
      ) : null}
      <form className="web-form web-form--wide" onSubmit={submit}>
        <TextField
          label={t("agents.name")}
          required
          maxLength={120}
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
        {draft ? (
          <AgentCardFields
            draft={draft}
            catalog={catalog}
            onChange={setDraft}
          />
        ) : null}
        <button
          type="submit"
          className="ap-button ap-button--primary"
          disabled={save.isPending || (draft !== null && !catalog.isSuccess)}
        >
          {save.isPending ? t("agent.card.saving") : t("agent.card.save")}
        </button>
      </form>
      {result}
    </section>
  );
}

interface Edit {
  readonly baseId: string | null;
  /** The newest version when the edit started; a newer one means another save. */
  readonly seenLatestId: string | null;
  readonly baseName: string;
  readonly name: string;
  readonly draft: CardDraft | null;
}

const sameEdit = (a: Edit, b: Edit) =>
  a.name === b.name && JSON.stringify(a.draft) === JSON.stringify(b.draft);

function startEdit(detail: AgentDetail, from?: AgentVersion): Edit {
  const latest = latestVersion(detail);
  const base = from ?? latest;
  return {
    baseId: base?.id ?? null,
    seenLatestId: latest?.id ?? null,
    baseName: detail.agent.name,
    name: detail.agent.name,
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
