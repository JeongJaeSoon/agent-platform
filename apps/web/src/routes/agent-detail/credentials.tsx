import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type ApiError, isApiError, unwrap } from "@werft-ai/client";
import {
  type AgentDetail,
  activationCredentialUnboundDetailsSchema,
  type CreateCredentialBindingResponse,
  type CredentialBindingView,
  type RevokeCredentialBindingResponse,
} from "@werft-ai/contracts";
import { useAgentPlatform } from "@werft-ai/react";
import { ConfirmDialog } from "@werft-ai/ui";
import { type ReactNode, type RefObject, useId, useState } from "react";
import { queryKeys } from "../../api/queries.ts";
import { permissionReason, useRole } from "../../auth/guard.tsx";
import { LoadFailure } from "../../components/load-failure.tsx";
import type { Outcome } from "../../components/outcome.tsx";
import { StatusScreen } from "../../components/status-screen.tsx";
import { type Translate, useI18n } from "../../i18n/i18n.tsx";
import { agentRefusal } from "../agents.tsx";
import { latestVersion } from "./versions.tsx";

/** Under the agent's key, so whatever refreshes the agent refreshes these. */
const bindingsKey = (agentId: string) =>
  [...queryKeys.agent(agentId), "credential-bindings"] as const;

/**
 * The credential names an agent may use (design 4.4, D11). There is no
 * free-text field on purpose: a lowercase token pasted as a "name" would pass
 * the name pattern and reach the cache and the screen. Only names the cards
 * or the server already hold can be bound.
 */
export function Credentials({
  detail,
  missing,
  titleRef,
  result,
  onOutcome,
}: {
  readonly detail: AgentDetail;
  /** Names a refused activation reported as unbound. */
  readonly missing: readonly string[];
  /** Focused when another section sends the person here. */
  readonly titleRef: RefObject<HTMLHeadingElement | null>;
  readonly result: ReactNode;
  readonly onOutcome: (outcome: Outcome | null) => void;
}) {
  const { t } = useI18n();
  const { client } = useAgentPlatform();
  const queryClient = useQueryClient();
  const role = useRole();
  const titleId = useId();
  const agentId = detail.agent.id;
  const [revoking, setRevoking] = useState<CredentialBindingView | null>(null);

  const bindings = useQuery({
    queryKey: bindingsKey(agentId),
    queryFn: () =>
      unwrap(
        client.GET("/v1/agents/{id}/credential-bindings", {
          params: { path: { id: agentId } },
        }),
      ),
    retry: false,
  });

  const refused = (error: ApiError) =>
    error.code === "CREDENTIAL_REF_IN_USE"
      ? t("agent.credentials.inUse")
      : agentRefusal(t, error, role);

  const bind = useMutation<CreateCredentialBindingResponse, ApiError, string>({
    mutationFn: (ref) =>
      unwrap(
        client.POST("/v1/agents/{id}/credential-bindings", {
          params: { path: { id: agentId } },
          body: { credential_ref: ref },
        }),
      ),
    onMutate: () => onOutcome(null),
    onSuccess: async (answer) => {
      onOutcome({
        kind: "notice",
        text: t(
          answer.created
            ? "agent.credentials.bound"
            : "agent.credentials.alreadyBound",
          { name: answer.binding.credential_ref },
        ),
      });
      await queryClient.invalidateQueries({ queryKey: bindingsKey(agentId) });
    },
    onError: (error) => onOutcome({ kind: "error", text: refused(error) }),
  });

  const revoke = useMutation<
    RevokeCredentialBindingResponse,
    ApiError,
    CredentialBindingView
  >({
    mutationFn: (binding) =>
      unwrap(
        client.DELETE("/v1/agents/{id}/credential-bindings/{binding_id}", {
          params: { path: { id: agentId, binding_id: binding.id } },
        }),
      ),
    onMutate: () => onOutcome(null),
    // The dialog closes first and the result comes after the refetch: the
    // row whose button opened the dialog is gone by then, and a result
    // focused while the dialog still held focus would be lost.
    onSuccess: async (answer) => {
      setRevoking(null);
      await queryClient.invalidateQueries({ queryKey: bindingsKey(agentId) });
      onOutcome({
        kind: "notice",
        text: t("agent.credentials.revoked", {
          name: answer.binding.credential_ref,
        }),
      });
    },
    onError: (error) => {
      setRevoking(null);
      onOutcome({ kind: "error", text: refused(error) });
    },
  });

  const active = (bindings.data?.items ?? []).filter(
    (binding) => binding.revoked_at === null,
  );
  const bound = new Set(active.map((binding) => binding.credential_ref));
  const unbound = namedRefs(detail, missing).filter((ref) => !bound.has(ref));
  const busy = bind.isPending || revoke.isPending;

  return (
    <section className="web-section" aria-labelledby={titleId}>
      <h2 id={titleId} ref={titleRef} tabIndex={-1}>
        {t("agent.credentials.title")}
      </h2>
      <p className="web-page__empty">{t("agent.credentials.intro")}</p>
      {bindings.isPending ? (
        <StatusScreen kind="loading" />
      ) : bindings.error ? (
        isApiError(bindings.error, "FORBIDDEN") ? (
          <p className="web-guarded__reason">
            {permissionReason(t, "agent.manage", role)}
          </p>
        ) : (
          <LoadFailure
            error={bindings.error}
            onRetry={() => void bindings.refetch()}
          />
        )
      ) : (
        <>
          {unbound.length > 0 ? (
            <ul
              className="web-list"
              aria-label={t("agent.credentials.unboundList")}
            >
              {unbound.map((ref) => (
                <li
                  key={ref}
                  className="web-list__item"
                  data-missing={missing.includes(ref)}
                >
                  <span>
                    <span className="web-table__primary">{ref}</span>
                    <span className="web-table__secondary">
                      {missing.includes(ref)
                        ? t("agent.credentials.neededToActivate")
                        : t("agent.credentials.namedByCard")}
                    </span>
                  </span>
                  <button
                    type="button"
                    className="ap-button"
                    disabled={busy}
                    aria-label={t("agent.credentials.bindFor", { name: ref })}
                    onClick={() => bind.mutate(ref)}
                  >
                    {t("agent.credentials.bind")}
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
          {active.length === 0 ? (
            <p className="web-page__empty">
              {t(
                unbound.length === 0
                  ? "agent.credentials.noneNamed"
                  : "agent.credentials.empty",
              )}
            </p>
          ) : (
            <ul
              className="web-list"
              aria-label={t("agent.credentials.boundList")}
            >
              {active.map((binding) => (
                <li key={binding.id} className="web-list__item">
                  <span>
                    <span className="web-table__primary">
                      {binding.credential_ref}
                    </span>
                    <span className="web-table__secondary">
                      {t("agent.credentials.running", {
                        count: binding.running_sessions,
                      })}
                    </span>
                  </span>
                  <button
                    type="button"
                    className="ap-button"
                    disabled={busy}
                    aria-label={t("agent.credentials.revokeFor", {
                      name: binding.credential_ref,
                    })}
                    onClick={() => setRevoking(binding)}
                  >
                    {t("agent.credentials.revoke")}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
      {result}
      <ConfirmDialog
        open={revoking !== null}
        onOpenChange={(open) => {
          if (!open) setRevoking(null);
        }}
        title={t("agent.credentials.revokeTitle", {
          name: revoking?.credential_ref ?? "",
        })}
        consequence={revokeConsequence(t, revoking)}
        confirmLabel={t("agent.credentials.revoke")}
        cancelLabel={t("common.cancel")}
        tone="danger"
        busy={revoke.isPending}
        onConfirm={() => {
          if (revoking) revoke.mutate(revoking);
        }}
      />
    </section>
  );
}

/**
 * The names a 409 CREDENTIAL_UNBOUND from activation reports, an empty list
 * when its details are not the shape the contract promises, or null for any
 * other error.
 */
export function unboundRefs(error: ApiError): readonly string[] | null {
  if (error.code !== "CREDENTIAL_UNBOUND") return null;
  const details = activationCredentialUnboundDetailsSchema.safeParse(
    error.details,
  );
  return details.success ? details.data.missing : [];
}

/** Why activation stopped, with the way to the step that fixes it. */
export function CredentialUnbound({
  missing,
  onGo,
}: {
  readonly missing: readonly string[];
  readonly onGo: () => void;
}) {
  const { t } = useI18n();
  return (
    <section className="web-status" data-status="conflict" role="alert">
      <h3 className="web-status__title">{t("agent.unbound.title")}</h3>
      <p className="web-status__body">
        {missing.length > 0
          ? t("agent.unbound.body", { names: missing.join(", ") })
          : t("agent.unbound.bodyUnnamed")}
      </p>
      <button type="button" className="ap-button" onClick={onGo}>
        {t("agent.unbound.go")}
      </button>
    </section>
  );
}

/** What the agent's cards name, the newest first, then what activation found missing. */
function namedRefs(detail: AgentDetail, missing: readonly string[]) {
  const activeVersion = detail.versions.find(
    (version) => version.id === detail.active_release?.version_id,
  );
  return [
    ...new Set([
      ...missing,
      ...(latestVersion(detail)?.card.capabilities.credential_refs ?? []),
      ...(activeVersion?.card.capabilities.credential_refs ?? []),
    ]),
  ];
}

function revokeConsequence(
  t: Translate,
  binding: CredentialBindingView | null,
): string {
  const next = t("agent.credentials.revokeConsequence");
  return binding !== null && binding.running_sessions > 0
    ? `${next} ${t("agent.credentials.revokeRunning", { count: binding.running_sessions })}`
    : next;
}
