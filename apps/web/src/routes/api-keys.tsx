import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type ApiError, isApiError, unwrap } from "@werft-ai/client";
import type {
  Agent,
  ApiKeyView,
  CreateApiKeyRequest,
  CreateApiKeyResponse,
  RevokeApiKeyResponse,
  SessionScope,
} from "@werft-ai/contracts";
import { useAgentPlatform } from "@werft-ai/react";
import {
  Badge,
  type BadgeProps,
  Button,
  buttonVariants,
  Checkbox,
  ConfirmDialog,
  EmptyState,
  Field,
  FieldContent,
  FieldDescription,
  FieldLabel,
  FieldLegend,
  FieldSet,
  formatTimestamp,
  Input,
  NativeSelect,
  NativeSelectOption,
} from "@werft-ai/ui";
import { type FormEvent, useEffect, useId, useRef, useState } from "react";
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
import { FormError, NOTICE } from "../components/auth-page.tsx";
import { copyText } from "../components/copy.ts";
import { LoadFailure } from "../components/load-failure.tsx";
import type { Outcome } from "../components/outcome.tsx";
import { StatusScreen } from "../components/status-screen.tsx";
import {
  errorKey,
  type MessageKey,
  type Translate,
  useI18n,
} from "../i18n/i18n.tsx";

const PAGE = "flex flex-col gap-6";
const TITLE = "m-0 font-semibold text-xl";
const SECTION = "flex flex-col gap-3";
const SECTION_TITLE = "m-0 font-semibold text-lg";
const FORM = "flex max-w-xl flex-col items-start gap-4";
const PRIMARY = "block break-words font-semibold";
const SECONDARY =
  "block text-muted-foreground text-xs [overflow-wrap:anywhere]";

type IssueRequest = Pick<CreateApiKeyRequest, "kind" | "scopes"> & {
  agent_id?: string;
  expires_at?: string;
};

// D26: a key bound to an agent never stands in for a person's approval.
const AGENT_KEY_WITHHELD: readonly SessionScope[] = ["sessions:approve"];

const SCOPE_NAME: Record<SessionScope, MessageKey> = {
  "sessions:read": "apiKeys.scope.read",
  "sessions:write": "apiKeys.scope.write",
  "sessions:approve": "apiKeys.scope.approve",
  "sessions:control": "apiKeys.scope.control",
  "sessions:recover": "apiKeys.scope.recover",
};

// What the server lets each scope do (ACTION_SCOPES in packages/platform).
const SCOPE_HINT: Record<SessionScope, MessageKey> = {
  "sessions:read": "apiKeys.scopeHint.read",
  "sessions:write": "apiKeys.scopeHint.write",
  "sessions:approve": "apiKeys.scopeHint.approve",
  "sessions:control": "apiKeys.scopeHint.control",
  "sessions:recover": "apiKeys.scopeHint.recover",
};

// The contract has two kinds; a service key bound to an agent is the third
// the screen names.
type KeyKind = "personal" | "service" | "agent";
const KEY_KINDS: readonly KeyKind[] = ["personal", "service", "agent"];

const kindOf = (key: Pick<ApiKeyView, "kind" | "agent_id">): KeyKind =>
  key.kind === "personal"
    ? "personal"
    : key.agent_id === null
      ? "service"
      : "agent";

const KIND_NAME: Record<KeyKind, MessageKey> = {
  personal: "apiKeys.kind.personal",
  service: "apiKeys.kind.service",
  agent: "apiKeys.kind.agent",
};

const KIND_BADGE: Record<KeyKind, BadgeProps["variant"]> = {
  personal: "default",
  service: "secondary",
  agent: "outline",
};

// Who it acts as, what its issuer leaving does, which sessions it reaches,
// and whether it can approve: auth.ts apiKeyPrincipal, queries.ts
// liveApiKey, policy.ts viewerOf and agent_ceiling, api-key-service.ts.
const KIND_FACTS: Record<KeyKind, readonly MessageKey[]> = {
  personal: [
    "apiKeys.guide.personal.actsAs",
    "apiKeys.guide.personal.issuerLeaves",
    "apiKeys.guide.personal.sessions",
    "apiKeys.guide.personal.approve",
  ],
  service: [
    "apiKeys.guide.service.actsAs",
    "apiKeys.guide.service.issuerLeaves",
    "apiKeys.guide.service.sessions",
    "apiKeys.guide.service.approve",
  ],
  agent: [
    "apiKeys.guide.agent.actsAs",
    "apiKeys.guide.agent.issuerLeaves",
    "apiKeys.guide.agent.sessions",
    "apiKeys.guide.agent.approve",
  ],
};

function KindBadge({ kind }: { readonly kind: KeyKind }) {
  const { t } = useI18n();
  return (
    <Badge variant={KIND_BADGE[kind]} data-kind={kind}>
      {t(KIND_NAME[kind])}
    </Badge>
  );
}

function KeyKindGuide() {
  const { t } = useI18n();
  const titleId = useId();
  return (
    <section className={SECTION} aria-labelledby={titleId}>
      <h2 id={titleId} className={SECTION_TITLE}>
        {t("apiKeys.guideTitle")}
      </h2>
      <div className="grid gap-3 lg:grid-cols-3">
        {KEY_KINDS.map((kind) => (
          <div
            key={kind}
            className="flex flex-col items-start gap-2 rounded-md border p-3"
            data-testid={`guide-${kind}`}
          >
            <KindBadge kind={kind} />
            <ul className="m-0 flex list-disc flex-col gap-1 pl-5 text-sm">
              {KIND_FACTS[kind].map((fact) => (
                <li key={fact}>{t(fact)}</li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </section>
  );
}

function keyRefusal(
  t: Translate,
  error: ApiError,
  permission: ManagedPermission,
  role: string | undefined,
): string {
  // A 403 (SCOPE_NOT_GRANTABLE) falls through: its sentence names scopes.
  if (error.code === "BAD_REQUEST")
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
  const { client } = useAgentPlatform();
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
    <div className={PAGE}>
      <h1 className={TITLE}>{t("apiKeys.title")}</h1>
      {outcome ? (
        outcome.kind === "error" ? (
          <FormError>{outcome.text}</FormError>
        ) : (
          <output className={NOTICE}>{outcome.text}</output>
        )
      ) : null}
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
      <KeyKindGuide />
      <PersonalKeyForm issue={issue} />
      <ServiceKeyForm issue={issue} />
      {keys.isPending ? (
        <StatusScreen kind="loading" />
      ) : keys.error ? (
        isApiError(keys.error, "FORBIDDEN") ? (
          <StatusScreen kind="forbidden" />
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
  return (
    <section
      className="flex max-w-xl flex-col items-start gap-3 rounded-md border bg-card p-4 text-card-foreground"
      data-status="secret"
      aria-label={t("apiKeys.secretTitle")}
    >
      <h2 className={SECTION_TITLE}>{t("apiKeys.secretTitle")}</h2>
      <p className="m-0">
        {t("apiKeys.secretOnce")} {t("apiKeys.keyId", { id: issued.key.id })}
      </p>
      <Field>
        <FieldLabel>{t("apiKeys.secret")}</FieldLabel>
        <Input
          ref={secretRef}
          className="font-mono"
          type="text"
          readOnly
          value={issued.secret}
          onFocus={(event) => event.target.select()}
        />
      </Field>
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          onClick={() => {
            void copyText(issued.secret, secretRef).then((copied) =>
              setCopy(copied ? "copied" : "failed"),
            );
          }}
        >
          {copy === "copied" ? t("apiKeys.copied") : t("apiKeys.copy")}
        </Button>
        <Button type="button" variant="outline" onClick={onDone}>
          {t("apiKeys.secretDone")}
        </Button>
      </div>
      {copy === "failed" ? (
        <FormError>{t("apiKeys.copyFailed")}</FormError>
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
    <FieldSet className="w-full gap-3">
      <FieldLegend variant="label" className="mb-0">
        {t("apiKeys.scopes")}
      </FieldLegend>
      {available.map((scope) => (
        <Field key={scope} orientation="horizontal">
          <Checkbox
            checked={chosen.includes(scope)}
            onCheckedChange={(checked) =>
              onChange(
                checked === true
                  ? [...chosen, scope]
                  : chosen.filter((s) => s !== scope),
              )
            }
          />
          <FieldContent>
            <FieldLabel>
              {t(SCOPE_NAME[scope])} <code className="font-mono">{scope}</code>
            </FieldLabel>
            <FieldDescription>{t(SCOPE_HINT[scope])}</FieldDescription>
            {withheld.includes(scope) ? (
              <FieldDescription>{t("apiKeys.agentNoApprove")}</FieldDescription>
            ) : null}
          </FieldContent>
        </Field>
      ))}
    </FieldSet>
  );
}

interface Issue {
  readonly send: (body: IssueRequest, permission: ManagedPermission) => void;
  /** A request is in flight or an issued secret is still on screen. */
  readonly blocked: boolean;
}

function useIssue(
  onIssued: (result: CreateApiKeyResponse) => void,
  onOutcome: (outcome: Outcome | null) => void,
) {
  const { t } = useI18n();
  const { client } = useAgentPlatform();
  const queryClient = useQueryClient();
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
    <section className={SECTION} aria-labelledby={titleId}>
      <h2 id={titleId} className={SECTION_TITLE}>
        {t("apiKeys.personal")}
      </h2>
      <form className={FORM} onSubmit={submit}>
        <ScopePicker available={held} chosen={scopes} onChange={setScopes} />
        <ExpiryField value={expires} onChange={setExpires} />
        <ReasonButton
          type="submit"
          className={buttonVariants()}
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
    <Field>
      <FieldLabel>{t("apiKeys.expires")}</FieldLabel>
      <Input
        type="date"
        min={today()}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
      <FieldDescription>{t("apiKeys.expiresHint")}</FieldDescription>
    </Field>
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
  const { client } = useAgentPlatform();
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
  const held = useMe()?.scopes ?? [];
  const workspaceWide = useHasPermission("api_key.manage");
  const { agents, pending, error: agentsError } = useBindableAgents();
  const [scopes, setScopes] = useState<SessionScope[]>(["sessions:read"]);
  const [agentId, setAgentId] = useState("");
  const [expires, setExpires] = useState("");
  const titleId = useId();
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

  // Someone who administers no agent has no service key to issue (design 4.1).
  if (!workspaceWide && agents.length === 0 && !agentsError) return null;

  return (
    <section className={SECTION} aria-labelledby={titleId}>
      <h2 id={titleId} className={SECTION_TITLE}>
        {t("apiKeys.service")}
      </h2>
      <form className={FORM} onSubmit={(event) => event.preventDefault()}>
        <ScopePicker
          available={held}
          chosen={scopes}
          onChange={setScopes}
          withheld={AGENT_KEY_WITHHELD}
        />
        <ExpiryField value={expires} onChange={setExpires} />
        {workspaceWide ? (
          <Button
            type="button"
            variant="outline"
            disabled={issue.blocked || grantable(false).length === 0}
            onClick={(event) => send(undefined, event.currentTarget.form)}
          >
            {t("apiKeys.issueWorkspace")}
          </Button>
        ) : null}
        <Field>
          <FieldLabel>{t("apiKeys.agent")}</FieldLabel>
          <NativeSelect
            value={agentId}
            disabled={agents.length === 0}
            onChange={(event) => setAgentId(event.target.value)}
          >
            <NativeSelectOption value="">
              {t("apiKeys.pickAgent")}
            </NativeSelectOption>
            {agents.map((agent) => (
              <NativeSelectOption key={agent.id} value={agent.id}>
                {agent.name}
              </NativeSelectOption>
            ))}
          </NativeSelect>
          <FieldDescription>{t("apiKeys.agentHint")}</FieldDescription>
        </Field>
        <ReasonButton
          className={buttonVariants({ variant: "outline" })}
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

function KeyIdLine({ id }: { readonly id: string }) {
  const { t } = useI18n();
  const [copy, setCopy] = useState<"idle" | "copied" | "failed">("idle");
  return (
    <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
      <span className="text-muted-foreground">{t("apiKeys.idLabel")}</span>
      <code className="font-mono [overflow-wrap:anywhere]">{id}</code>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-6 px-2 text-xs"
        aria-label={t("apiKeys.copyIdFor", { id })}
        onClick={() => {
          // No field to fall back to: the id is plain text to select.
          void copyText(id, { current: null }).then((copied) =>
            setCopy(copied ? "copied" : "failed"),
          );
        }}
      >
        {copy === "copied" ? t("apiKeys.copied") : t("apiKeys.copyId")}
      </Button>
      {copy === "failed" ? (
        <span className="text-destructive" role="alert">
          {t("apiKeys.copyIdFailed")}
        </span>
      ) : null}
    </span>
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
  const { client } = useAgentPlatform();
  const queryClient = useQueryClient();
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
    <section className={SECTION} aria-labelledby={titleId}>
      <h2 id={titleId} className={SECTION_TITLE}>
        {t("apiKeys.listTitle")}
      </h2>
      {items.length === 0 ? (
        <EmptyState title={t("apiKeys.empty")} />
      ) : (
        <ul className="m-0 flex list-none flex-col p-0">
          {items.map((key) => {
            const kind = kindOf(key);
            const agent = agentName(key.agent_id);
            const label =
              agent === null
                ? t(KIND_NAME[kind])
                : `${t(KIND_NAME[kind])} · ${agent}`;
            return (
              <li
                key={key.id}
                className="flex flex-col items-start gap-1 border-b py-3 sm:flex-row sm:items-center sm:gap-3"
                data-revoked={key.revoked_at !== null}
              >
                <span className="flex min-w-0 flex-1 flex-col gap-1">
                  <span className="flex flex-wrap items-center gap-2">
                    <KindBadge kind={kind} />
                    {agent === null ? null : (
                      <span className={PRIMARY}>{agent}</span>
                    )}
                  </span>
                  <KeyIdLine id={key.id} />
                  <span className={SECONDARY}>
                    {key.scopes.map((scope) => t(SCOPE_NAME[scope])).join(", ")}{" "}
                    ·{" "}
                    {t("apiKeys.createdAt", {
                      at: formatTimestamp(key.created_at, locale),
                    })}
                    {key.expires_at
                      ? ` · ${t("apiKeys.expiresAt", { at: formatTimestamp(key.expires_at, locale) })}`
                      : ""}
                  </span>
                  {key.kind === "service" ? (
                    <span className={SECONDARY}>
                      {t("apiKeys.survivesIssuerShort")}
                    </span>
                  ) : null}
                </span>
                {key.revoked_at ? (
                  <Badge variant="secondary">
                    {t("apiKeys.revokedAt", {
                      at: formatTimestamp(key.revoked_at, locale),
                    })}
                  </Badge>
                ) : (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={revoke.isPending}
                    aria-label={t("apiKeys.revokeFor", {
                      key: `${label} (${key.id})`,
                    })}
                    onClick={() => setConfirming(key)}
                  >
                    {t("apiKeys.revoke")}
                  </Button>
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
        title={t("apiKeys.revokeTitle", { id: confirming?.id ?? "" })}
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
