import type {
  Agent,
  ApiKeyView,
  CreateApiKeyRequest,
  CreateApiKeyResponse,
  RevokeApiKeyResponse,
  SessionScope,
} from "@agent-platform/contracts";
import { ConfirmDialog, formatTimestamp } from "@agent-platform/ui";
import { useMutation, useQuery } from "@tanstack/react-query";
import { type FormEvent, useEffect, useId, useRef, useState } from "react";
import { type ApiError, isApiError, unwrap } from "../api/client.ts";
import {
  administeredAgentsQuery,
  agentsQuery,
  apiKeysQuery,
  queryKeys,
} from "../api/queries.ts";
import {
  type ManagedPermission,
  permissionReason,
  ReasonButton,
  refusalText,
  useHasPermission,
  useMe,
  useRole,
} from "../auth/guard.tsx";
import { LoadFailure } from "../components/load-failure.tsx";
import { type Outcome, OutcomeLine } from "../components/outcome.tsx";
import { StatusScreen } from "../components/status-screen.tsx";
import { errorKey, type Translate, useI18n } from "../i18n/i18n.tsx";
import { useServices } from "../services.tsx";

type IssueRequest = Pick<CreateApiKeyRequest, "kind" | "scopes"> & {
  agent_id?: string;
  expires_at?: string;
};

// D26: a key bound to an agent never stands in for a person's approval.
const AGENT_KEY_WITHHELD: readonly SessionScope[] = ["sessions:approve"];

// Message keys are `<area>.<element>`, so the scope's colon stays out of them.
const SCOPE_KEY = {
  "sessions:read": "read",
  "sessions:write": "write",
  "sessions:approve": "approve",
  "sessions:control": "control",
  "sessions:recover": "recover",
} as const satisfies Record<SessionScope, string>;

function keyRefusal(
  t: Translate,
  error: ApiError,
  permission: ManagedPermission,
  role: string | undefined,
): string {
  if (error.code === "SCOPE_NOT_GRANTABLE" || error.code === "BAD_REQUEST")
    return `${t(errorKey(error.code))} ${error.message}`;
  return refusalText(t, error, permission, role);
}

/** Today in the browser's time zone, as an `<input type="date">` value. */
function today(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** The end of the chosen day, in the browser's time zone. */
function expiryOf(day: string): string | undefined {
  return day ? new Date(`${day}T23:59:59`).toISOString() : undefined;
}

/**
 * API keys (design 4.2). A personal key acts as the person who made it and
 * stops with them; a service key belongs to the workspace and keeps working
 * after its issuer leaves. One bound to an agent reaches that agent's
 * sessions only, and its issuer is that agent's admin.
 */
export function ApiKeysScreen() {
  const { t } = useI18n();
  const { client } = useServices();
  const keys = useQuery(apiKeysQuery(client));
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [issued, setIssued] = useState<CreateApiKeyResponse | null>(null);
  const onIssued = (result: CreateApiKeyResponse) => {
    setOutcome(null);
    setIssued(result);
  };
  const mutation = useIssue(onIssued, setOutcome);
  // A secret shows once: nothing new is issued until this one is put away.
  const issue: Issue = {
    send: (body, permission) => mutation.mutate({ body, permission }),
    blocked: mutation.isPending || issued !== null,
  };

  return (
    <div className="web-page">
      <h1 className="web-page__title">{t("apiKeys.title")}</h1>
      <OutcomeLine outcome={outcome} />
      {issued ? (
        <IssuedSecret
          issued={issued}
          onDone={() => {
            setIssued(null);
            // Detach the observer so gcTime 0 drops the response too.
            mutation.reset();
          }}
        />
      ) : null}
      <PersonalKeyForm issue={issue} />
      <ServiceKeyForm issue={issue} />
      {keys.isPending ? (
        <StatusScreen kind="loading" />
      ) : keys.error ? (
        isApiError(keys.error, "FORBIDDEN") ? (
          <StatusScreen kind="forbidden" detail={keys.error.message} />
        ) : (
          <LoadFailure error={keys.error} onRetry={() => void keys.refetch()} />
        )
      ) : (
        <KeyList items={keys.data.items} onOutcome={setOutcome} />
      )}
    </div>
  );
}

function IssuedSecret({
  issued,
  onDone,
}: {
  readonly issued: CreateApiKeyResponse;
  readonly onDone: () => void;
}) {
  const { t } = useI18n();
  const [copy, setCopy] = useState<"idle" | "copied" | "failed">("idle");
  const secretRef = useRef<HTMLInputElement>(null);
  // The new key appears above the forms; take focus there so it is not missed.
  useEffect(() => {
    secretRef.current?.focus();
  }, []);
  const copyFailed = () => {
    setCopy("failed");
    secretRef.current?.focus();
  };
  return (
    <section
      className="web-status"
      data-status="secret"
      aria-label={t("apiKeys.secretTitle")}
    >
      <h2 className="web-status__title">{t("apiKeys.secretTitle")}</h2>
      <p className="web-status__body">
        {t("apiKeys.secretOnce")}{" "}
        {t("apiKeys.keyId", { id: shortId(issued.key.id) })}
      </p>
      <label className="web-field">
        <span>{t("apiKeys.secret")}</span>
        <input
          ref={secretRef}
          className="ap-input"
          type="text"
          readOnly
          value={issued.secret}
          onFocus={(event) => event.target.select()}
        />
      </label>
      <div className="web-form web-form--inline">
        <button
          type="button"
          className="ap-button"
          onClick={() => {
            const clipboard = globalThis.navigator?.clipboard;
            if (!clipboard) return copyFailed();
            clipboard
              .writeText(issued.secret)
              .then(() => setCopy("copied"), copyFailed);
          }}
        >
          {copy === "copied" ? t("apiKeys.copied") : t("apiKeys.copy")}
        </button>
        <button type="button" className="ap-button" onClick={onDone}>
          {t("apiKeys.secretDone")}
        </button>
      </div>
      {copy === "failed" ? (
        <p className="web-form__error" role="alert">
          {t("apiKeys.copyFailed")}
        </p>
      ) : null}
    </section>
  );
}

function ScopePicker({
  available,
  chosen,
  onChange,
  withheld = [],
}: {
  readonly available: readonly SessionScope[];
  readonly chosen: readonly SessionScope[];
  readonly onChange: (scopes: SessionScope[]) => void;
  readonly withheld?: readonly SessionScope[];
}) {
  const { t } = useI18n();
  return (
    <fieldset className="web-fieldset">
      <legend>{t("apiKeys.scopes")}</legend>
      {available.map((scope) => {
        return (
          <label key={scope} className="web-check">
            <input
              type="checkbox"
              checked={chosen.includes(scope)}
              onChange={(event) =>
                onChange(
                  event.target.checked
                    ? [...chosen, scope]
                    : chosen.filter((s) => s !== scope),
                )
              }
            />
            <span>
              {t(`apiKeys.scope.${SCOPE_KEY[scope]}`)} <code>{scope}</code>
            </span>
            <span className="web-field__hint">
              {t(`apiKeys.scopeHint.${SCOPE_KEY[scope]}`)}
            </span>
            {withheld.includes(scope) ? (
              <span className="web-field__hint">
                {t("apiKeys.agentNoApprove")}
              </span>
            ) : null}
          </label>
        );
      })}
    </fieldset>
  );
}

interface Issue {
  readonly send: (body: IssueRequest, permission: ManagedPermission) => void;
  /** A request is in flight or an issued secret is still on screen. */
  readonly blocked: boolean;
}

/** Enough of the id to tell keys apart in the list and when revoking. */
function shortId(id: string): string {
  return id.slice(0, 8);
}

function useIssue(
  onIssued: (result: CreateApiKeyResponse) => void,
  onOutcome: (outcome: Outcome | null) => void,
) {
  const { t } = useI18n();
  const { client, queryClient } = useServices();
  const role = useRole();
  return useMutation<
    CreateApiKeyResponse,
    ApiError,
    { body: IssueRequest; permission: ManagedPermission }
  >({
    mutationFn: ({ body }) => unwrap(client.POST("/v1/api-keys", { body })),
    // The response carries the secret; keep it nowhere but the screen.
    gcTime: 0,
    onMutate: () => onOutcome(null),
    onSuccess: async (result) => {
      onIssued(result);
      await queryClient.invalidateQueries({ queryKey: queryKeys.apiKeys });
    },
    onError: (error, { permission }) =>
      onOutcome({
        kind: "error",
        text: keyRefusal(t, error, permission, role),
      }),
  });
}

function PersonalKeyForm({ issue }: { readonly issue: Issue }) {
  const { t } = useI18n();
  const held = useMe()?.scopes ?? [];
  const [scopes, setScopes] = useState<SessionScope[]>(["sessions:read"]);
  const [expires, setExpires] = useState("");
  const titleId = useId();
  const role = useRole();
  const reason = useHasPermission("api_key.manage_own")
    ? undefined
    : permissionReason(t, "api_key.manage_own", role);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const expiresAt = expiryOf(expires);
    issue.send(
      {
        kind: "personal",
        scopes: scopes.filter((scope) => held.includes(scope)),
        ...(expiresAt ? { expires_at: expiresAt } : {}),
      },
      "api_key.manage_own",
    );
  };

  return (
    <section className="web-section" aria-labelledby={titleId}>
      <h2 id={titleId}>{t("apiKeys.personal")}</h2>
      <p className="web-field__hint">{t("apiKeys.personalHint")}</p>
      <form className="web-form" onSubmit={submit}>
        <ScopePicker available={held} chosen={scopes} onChange={setScopes} />
        <ExpiryField value={expires} onChange={setExpires} />
        <ReasonButton
          type="submit"
          className="ap-button ap-button--primary"
          reason={reason}
          disabled={
            issue.blocked ||
            scopes.filter((scope) => held.includes(scope)).length === 0
          }
        >
          {t("apiKeys.issuePersonal")}
        </ReasonButton>
      </form>
    </section>
  );
}

function ExpiryField({
  value,
  onChange,
}: {
  readonly value: string;
  readonly onChange: (value: string) => void;
}) {
  const { t } = useI18n();
  return (
    <label className="web-field">
      <span>{t("apiKeys.expires")}</span>
      <input
        className="ap-input"
        type="date"
        min={today()}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
      <span className="web-field__hint">{t("apiKeys.expiresHint")}</span>
    </label>
  );
}

/**
 * The agents this person may bind a key to: every agent for an owner or
 * admin, the ones they administer for anyone else (design 4.1).
 */
function useBindableAgents(): {
  readonly agents: readonly Agent[];
  readonly pending: boolean;
  readonly error: ApiError | null;
} {
  const { client } = useServices();
  const everywhere = useHasPermission("api_key.manage");
  const all = useQuery({ ...agentsQuery(client), enabled: everywhere });
  const mine = useQuery({
    ...administeredAgentsQuery(client),
    enabled: !everywhere,
  });
  const source = everywhere ? all : mine;
  return {
    agents: source.data?.items ?? [],
    pending: source.isPending,
    error: (source.error as ApiError | null) ?? null,
  };
}

function ServiceKeyForm({ issue }: { readonly issue: Issue }) {
  const { t } = useI18n();
  const role = useRole();
  const held = useMe()?.scopes ?? [];
  const workspaceWide = useHasPermission("api_key.manage");
  const { agents, pending, error: agentsError } = useBindableAgents();
  const [scopes, setScopes] = useState<SessionScope[]>(["sessions:read"]);
  const [agentId, setAgentId] = useState("");
  const [expires, setExpires] = useState("");
  const titleId = useId();
  const agentFieldId = useId();
  const chosenAgent = agents.find((agent) => agent.id === agentId);

  // What each kind would actually carry; the buttons judge by these.
  const grantable = (forAgent: boolean) =>
    scopes.filter(
      (scope) =>
        held.includes(scope) &&
        (!forAgent || !AGENT_KEY_WITHHELD.includes(scope)),
    );
  const agentScopes = grantable(true);

  // These buttons are not submits, so the expiry min is checked here; the
  // browser explains it on the field.
  const send = (agent: Agent | undefined, form: HTMLFormElement | null) => {
    if (expires !== "" && expires < today()) {
      form?.reportValidity();
      return;
    }
    const expiresAt = expiryOf(expires);
    const granted = grantable(agent !== undefined);
    issue.send(
      {
        kind: "service",
        scopes: granted,
        ...(agent ? { agent_id: agent.id } : {}),
        ...(expiresAt ? { expires_at: expiresAt } : {}),
      },
      "api_key.manage",
    );
  };

  const agentReason = agentsError
    ? t(errorKey(agentsError.code))
    : agents.length === 0 && !pending
      ? t("apiKeys.noAgents")
      : chosenAgent && agentScopes.length === 0
        ? t("apiKeys.agentNeedsScope")
        : undefined;

  return (
    <section className="web-section" aria-labelledby={titleId}>
      <h2 id={titleId}>{t("apiKeys.service")}</h2>
      <p className="web-notice" data-testid="survives-issuer">
        {t("apiKeys.survivesIssuer")}
      </p>
      <form className="web-form" onSubmit={(event) => event.preventDefault()}>
        <ScopePicker
          available={held}
          chosen={scopes}
          onChange={setScopes}
          withheld={AGENT_KEY_WITHHELD}
        />
        <ExpiryField value={expires} onChange={setExpires} />
        <ReasonButton
          className="ap-button"
          reason={
            workspaceWide
              ? undefined
              : permissionReason(t, "api_key.manage", role)
          }
          disabled={issue.blocked || grantable(false).length === 0}
          onClick={(event) => send(undefined, event.currentTarget.form)}
        >
          {t("apiKeys.issueWorkspace")}
        </ReasonButton>
        <label className="web-field" htmlFor={agentFieldId}>
          <span>{t("apiKeys.agent")}</span>
          <select
            id={agentFieldId}
            className="ap-input"
            value={agentId}
            disabled={agents.length === 0}
            onChange={(event) => setAgentId(event.target.value)}
          >
            <option value="">{t("apiKeys.pickAgent")}</option>
            {agents.map((agent) => (
              <option key={agent.id} value={agent.id}>
                {agent.name}
              </option>
            ))}
          </select>
          <span className="web-field__hint">{t("apiKeys.agentHint")}</span>
        </label>
        <ReasonButton
          className="ap-button"
          reason={agentReason}
          disabled={issue.blocked || !chosenAgent || agentScopes.length === 0}
          onClick={(event) => send(chosenAgent, event.currentTarget.form)}
        >
          {t("apiKeys.issueAgent")}
        </ReasonButton>
      </form>
    </section>
  );
}

function KeyList({
  items,
  onOutcome,
}: {
  readonly items: readonly ApiKeyView[];
  readonly onOutcome: (outcome: Outcome | null) => void;
}) {
  const { t, locale } = useI18n();
  const { client, queryClient } = useServices();
  const role = useRole();
  const { agents } = useBindableAgents();
  const [confirming, setConfirming] = useState<ApiKeyView | null>(null);
  const titleId = useId();

  const revoke = useMutation<RevokeApiKeyResponse, ApiError, ApiKeyView>({
    mutationFn: (key) =>
      unwrap(
        client.DELETE("/v1/api-keys/{id}", {
          params: { path: { id: key.id } },
        }),
      ),
    onMutate: () => onOutcome(null),
    onSuccess: async () => {
      setConfirming(null);
      onOutcome({ kind: "notice", text: t("apiKeys.revoked") });
      await queryClient.invalidateQueries({ queryKey: queryKeys.apiKeys });
    },
    onError: (error, key) => {
      setConfirming(null);
      onOutcome({
        kind: "error",
        text: keyRefusal(
          t,
          error,
          key.kind === "personal" ? "api_key.manage_own" : "api_key.manage",
          role,
        ),
      });
    },
  });

  const agentName = (id: string | null) =>
    id === null ? null : (agents.find((agent) => agent.id === id)?.name ?? id);

  return (
    <section className="web-section" aria-labelledby={titleId}>
      <h2 id={titleId}>{t("apiKeys.listTitle")}</h2>
      {items.length === 0 ? (
        <p className="web-page__empty">{t("apiKeys.empty")}</p>
      ) : (
        <ul className="web-list">
          {items.map((key) => {
            const label =
              key.kind === "personal"
                ? t("apiKeys.kind.personal")
                : key.agent_id === null
                  ? t("apiKeys.kind.workspace")
                  : t("apiKeys.kind.agent", {
                      agent: agentName(key.agent_id) ?? "",
                    });
            return (
              <li
                key={key.id}
                className="web-list__item"
                data-revoked={key.revoked_at !== null}
              >
                <span className="web-table__primary">{label}</span>
                <span className="web-table__secondary">
                  {t("apiKeys.keyId", { id: shortId(key.id) })} ·{" "}
                  {key.scopes
                    .map((scope) => t(`apiKeys.scope.${SCOPE_KEY[scope]}`))
                    .join(", ")}{" "}
                  ·{" "}
                  {t("apiKeys.createdAt", {
                    at: formatTimestamp(key.created_at, locale),
                  })}
                  {key.expires_at
                    ? ` · ${t("apiKeys.expiresAt", { at: formatTimestamp(key.expires_at, locale) })}`
                    : ""}
                </span>
                {key.kind === "service" ? (
                  <span className="web-table__secondary">
                    {t("apiKeys.survivesIssuerShort")}
                  </span>
                ) : null}
                {key.revoked_at ? (
                  <span className="web-badge" data-tone="pending">
                    {t("apiKeys.revokedAt", {
                      at: formatTimestamp(key.revoked_at, locale),
                    })}
                  </span>
                ) : (
                  <button
                    type="button"
                    className="ap-button"
                    disabled={revoke.isPending}
                    aria-label={t("apiKeys.revokeFor", {
                      key: `${label} (${shortId(key.id)})`,
                    })}
                    onClick={() => setConfirming(key)}
                  >
                    {t("apiKeys.revoke")}
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
      <ConfirmDialog
        open={confirming !== null}
        onOpenChange={(open) => {
          if (!open) setConfirming(null);
        }}
        title={t("apiKeys.revokeTitle", {
          id: confirming ? shortId(confirming.id) : "",
        })}
        consequence={t("apiKeys.revokeConsequence")}
        confirmLabel={t("apiKeys.revoke")}
        cancelLabel={t("common.cancel")}
        tone="danger"
        busy={revoke.isPending}
        onConfirm={() => {
          if (confirming) revoke.mutate(confirming);
        }}
      />
    </section>
  );
}
