import type { AgentDetail } from "@agent-platform/contracts";
import { formatTimestamp } from "@agent-platform/ui";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { type FormEvent, useId, useState } from "react";
import { type ApiError, isApiError, unwrap } from "../api/client.ts";
import { agentsQuery, profilesQuery, queryKeys } from "../api/queries.ts";
import {
  permissionReason,
  ReasonButton,
  usePermissionReason,
  useRole,
} from "../auth/guard.tsx";
import { AdministeredAgents } from "../components/agent-admins.tsx";
import {
  AgentCardFields,
  type CardDraft,
  cardFromDraft,
  EMPTY_DRAFT,
} from "../components/agent-card-form.tsx";
import { slugInput, TextField } from "../components/field.tsx";
import { LoadFailure } from "../components/load-failure.tsx";
import { StatusScreen } from "../components/status-screen.tsx";
import { errorKey, type Translate, useI18n } from "../i18n/i18n.tsx";
import { useServices } from "../services.tsx";

// The release check's model refusal (release-ids.ts), as "<field>: <message>".
const MODEL_REFUSAL =
  /^card\.model: model (.+) is not the model of runtime profile (.+)$/;

/**
 * What a refused agent action says: a 403 in the words of the disabled
 * button, a model mismatch in our words, any other capability the profile
 * does not have with the server's reason.
 */
export function agentRefusal(
  t: Translate,
  error: ApiError,
  role: string | undefined,
): string {
  if (error.code === "FORBIDDEN")
    return `${permissionReason(t, "agent.manage", role)} ${error.message}`;
  const model =
    error.code === "UNSUPPORTED_CAPABILITY"
      ? MODEL_REFUSAL.exec(error.message)
      : null;
  if (model)
    return t("agent.releases.modelRefused", {
      card: model[1] ?? "",
      profile: model[2] ?? "",
    });
  if (error.code === "UNSUPPORTED_CAPABILITY" || error.code === "BAD_REQUEST")
    return `${t(errorKey(error.code))} ${error.message}`;
  return t(errorKey(error.code));
}

export function AgentsScreen() {
  const { t, locale } = useI18n();
  const { client } = useServices();
  const navigate = useNavigate();
  const agents = useQuery(agentsQuery(client));
  const reason = usePermissionReason("agent.manage", agents);
  // The list is also the permission probe: when it failed, nobody knows.
  const failed = agents.isError && !isApiError(agents.error, "FORBIDDEN");

  return (
    <div className="web-page">
      <div className="web-page__head">
        <h1 className="web-page__title">{t("agents.title")}</h1>
        {failed ? null : (
          <ReasonButton
            className="ap-button ap-button--primary"
            reason={reason}
            onClick={() => void navigate({ to: "/agents/new" })}
          >
            {t("agents.new")}
          </ReasonButton>
        )}
      </div>
      {agents.isPending ? (
        <StatusScreen kind="loading" />
      ) : agents.error ? (
        isApiError(agents.error, "FORBIDDEN") ? (
          <>
            <StatusScreen kind="forbidden" detail={agents.error.message} />
            <AdministeredAgents showEmpty />
          </>
        ) : (
          <LoadFailure
            error={agents.error}
            onRetry={() => void agents.refetch()}
          />
        )
      ) : agents.data.items.length === 0 ? (
        <p className="web-page__empty">{t("agents.empty")}</p>
      ) : (
        <ul className="web-list">
          {agents.data.items.map((agent) => (
            <li key={agent.id} className="web-list__item">
              <span>
                <Link
                  to="/agents/$id"
                  params={{ id: agent.id }}
                  className="web-table__primary"
                >
                  {agent.name}
                </Link>
                <span className="web-table__secondary">
                  {t("agents.slugLine", { slug: agent.slug })} ·{" "}
                  {t("agents.updated", {
                    at: formatTimestamp(agent.updated_at, locale),
                  })}
                </span>
              </span>
              <span className="web-badge" data-tone={agentTone(agent)}>
                {agent.active_release_id === null
                  ? t("agents.state.notReleased")
                  : t(`agents.status.${agent.status}`)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function agentTone(agent: {
  status: string;
  active_release_id: string | null;
}): string {
  if (agent.active_release_id === null) return "pending";
  return agent.status === "active" ? "ok" : "muted";
}

const SLUG_MAX = 64;

/**
 * The slug a name suggests; a name without Latin letters or digits suggests
 * nothing and leaves the field to the person.
 */
export function slugFromName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .slice(0, SLUG_MAX)
    .replace(/-+$/, "");
}

/**
 * A blank card. One-line hiring (a model drafting the card) is 94S-156's
 * and adds its button here when it lands.
 */
export function NewAgentScreen() {
  const { t } = useI18n();
  const { client, queryClient } = useServices();
  const navigate = useNavigate();
  const role = useRole();
  const [name, setName] = useState("");
  // Null until the person edits the slug; till then it follows the name.
  const [typedSlug, setTypedSlug] = useState<string | null>(null);
  const slug = typedSlug ?? slugFromName(name);
  const [draft, setDraft] = useState<CardDraft>(EMPTY_DRAFT);
  const catalog = useQuery(profilesQuery(client));
  const titleId = useId();

  const create = useMutation<AgentDetail, ApiError>({
    mutationFn: () =>
      unwrap(
        client.POST("/v1/agents", {
          body: {
            slug: slug.trim(),
            name: name.trim(),
            card: cardFromDraft(draft),
          },
        }),
      ) as Promise<AgentDetail>,
    onSuccess: async (detail) => {
      queryClient.setQueryData(queryKeys.agent(detail.agent.id), detail);
      await queryClient.invalidateQueries({
        queryKey: queryKeys.agents,
        exact: true,
      });
      await navigate({
        to: "/agents/$id",
        params: { id: detail.agent.id },
        search: { notice: "created" },
      });
    },
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    create.mutate();
  };

  return (
    <div className="web-page">
      <h1 className="web-page__title" id={titleId}>
        {t("agents.newTitle")}
      </h1>
      <p className="web-page__empty">{t("agents.newIntro")}</p>
      <form
        className="web-form web-form--wide"
        aria-labelledby={titleId}
        onSubmit={submit}
      >
        <TextField
          label={t("agents.name")}
          required
          maxLength={120}
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
        <TextField
          label={t("agents.slug")}
          hint={t("agents.slugHint")}
          required
          {...slugInput(t("field.slugFormat"))}
          value={slug}
          onChange={(event) => setTypedSlug(event.target.value)}
        />
        <AgentCardFields draft={draft} catalog={catalog} onChange={setDraft} />
        {create.error ? (
          <p className="web-form__error" role="alert">
            {agentRefusal(t, create.error, role)}
          </p>
        ) : null}
        <button
          type="submit"
          className="ap-button ap-button--primary"
          disabled={create.isPending || !catalog.isSuccess}
        >
          {create.isPending ? t("agents.creating") : t("agents.create")}
        </button>
      </form>
    </div>
  );
}
