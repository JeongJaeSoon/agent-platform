import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
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
  cn,
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
import {
  ArrowLeft,
  Check,
  CircleAlert,
  Clock,
  Copy,
  Info,
  KeyRound,
  Plus,
  TriangleAlert,
} from "lucide-react";
import {
  type FormEvent,
  type RefObject,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
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

// A settings column, not the full content width: one key per row reads
// better narrow (GitHub's token list).
const PAGE = "mx-auto flex w-full max-w-[52.5rem] flex-col gap-6";
// Title, a rule 16px above the intro, then the page's 24px gap.
const HEAD = "flex flex-col gap-4";
const HEAD_RULE = "border-b pb-3";
const INTRO = "m-0 text-muted-foreground text-sm";
const TITLE = "m-0 font-semibold text-xl";
const SECTION_TITLE = "m-0 font-semibold text-lg";
const META = "text-muted-foreground text-xs";
const ICON = "size-3.5 shrink-0";

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
type ApiKeyKind = ApiKeyView["kind"];

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

/** Each screen of keys: its route, the kinds it lists and its words. */
const SCREEN = {
  personal: {
    list: "/settings/api-keys",
    create: "/settings/api-keys/new",
    kinds: ["personal"],
    title: "apiKeys.mineTitle",
    intro: "apiKeys.mineIntro",
    newTitle: "apiKeys.newPersonalTitle",
    empty: "apiKeys.emptyMine",
  },
  service: {
    list: "/settings/api-keys/service",
    create: "/settings/api-keys/service/new",
    kinds: ["service", "agent"],
    title: "apiKeys.service",
    intro: "apiKeys.serviceIntro",
    newTitle: "apiKeys.newServiceTitle",
    empty: "apiKeys.emptyService",
  },
} as const satisfies Record<
  ApiKeyKind,
  {
    list: string;
    create: string;
    kinds: readonly KeyKind[];
    title: MessageKey;
    intro: MessageKey;
    newTitle: MessageKey;
    empty: MessageKey;
  }
>;

function KindBadge({ kind }: { readonly kind: KeyKind }) {
  const { t } = useI18n();
  return (
    <Badge variant={KIND_BADGE[kind]} data-kind={kind}>
      {t(KIND_NAME[kind])}
    </Badge>
  );
}

function KeyKindGuide({ kinds }: { readonly kinds: readonly KeyKind[] }) {
  const { t } = useI18n();
  const titleId = useId();
  return (
    <section
      className="flex flex-col gap-3 rounded-md border bg-muted p-4 text-sm"
      aria-labelledby={titleId}
    >
      <h2
        id={titleId}
        className="m-0 flex items-center gap-2 font-semibold text-sm"
      >
        <Info aria-hidden="true" className="size-4 shrink-0" />
        {t("apiKeys.guideTitle")}
      </h2>
      {kinds.map((kind) => (
        <div
          key={kind}
          className="flex flex-col items-start gap-2"
          data-testid={`guide-${kind}`}
        >
          <KindBadge kind={kind} />
          <ul className="m-0 flex list-disc flex-col gap-1 pl-5">
            {KIND_FACTS[kind].map((fact) => (
              <li key={fact}>{t(fact)}</li>
            ))}
          </ul>
        </div>
      ))}
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

const SOON_MS = 7 * 24 * 60 * 60 * 1000;

function expiryState(
  expiresAt: string | null,
): "none" | "later" | "soon" | "expired" {
  if (expiresAt === null) return "none";
  const left = new Date(expiresAt).getTime() - Date.now();
  return left <= 0 ? "expired" : left <= SOON_MS ? "soon" : "later";
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

/**
 * Whether this person issues service keys at all: an owner or admin for the
 * workspace, an agent's admin for that agent (design 4.1). While the agents
 * load it is not yet known, and the service screen stays out of the way.
 */
function useIssuesServiceKeys(): boolean {
  const workspaceWide = useHasPermission("api_key.manage");
  const { agents, error } = useBindableAgents();
  return workspaceWide || agents.length > 0 || error !== null;
}

/** Why this person cannot make a key of this kind, if they cannot. */
function useCreateReason(kind: ApiKeyKind): string | undefined {
  const { t } = useI18n();
  const role = useRole();
  const own = useHasPermission("api_key.manage_own");
  const service = useIssuesServiceKeys();
  if (kind === "personal")
    return own ? undefined : permissionReason(t, "api_key.manage_own", role);
  return service ? undefined : t("apiKeys.noAgents");
}

function KeyScreenNav({ current }: { readonly current: ApiKeyKind }) {
  const { t } = useI18n();
  const service = useIssuesServiceKeys();
  if (!service && current === "personal") return null;
  return (
    <nav aria-label={t("apiKeys.nav")} className="flex gap-1 border-b">
      {(["personal", "service"] as const).map((kind) => (
        <Link
          key={kind}
          to={SCREEN[kind].list}
          aria-current={kind === current ? "page" : undefined}
          className={cn(
            "-mb-px border-transparent border-b-2 px-3 py-2 text-muted-foreground text-sm no-underline!",
            "hover:text-foreground",
            "aria-[current=page]:border-foreground aria-[current=page]:font-semibold aria-[current=page]:text-foreground",
          )}
        >
          {t(SCREEN[kind].title)}
        </Link>
      ))}
    </nav>
  );
}

/**
 * API keys (design 4.2), one screen per kind laid out like GitHub's tokens:
 * a narrow list, a separate page to make one, the secret shown once. A
 * personal key acts as the person who made it and stops with them; a service
 * key belongs to the workspace and keeps working after its issuer leaves.
 */
function KeysScreen({ kind }: { readonly kind: ApiKeyKind }) {
  const { t } = useI18n();
  const { client } = useAgentPlatform();
  const navigate = useNavigate();
  const keys = useQuery(apiKeysQuery(client));
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const screen = SCREEN[kind];
  const reason = useCreateReason(kind);

  return (
    <div className={PAGE}>
      <KeyScreenNav current={kind} />
      <div className={HEAD}>
        <div
          className={cn(
            HEAD_RULE,
            "flex flex-wrap items-center justify-between gap-3",
          )}
        >
          <h1 className={TITLE}>{t(screen.title)}</h1>
          <ReasonButton
            className={buttonVariants()}
            reason={reason}
            onClick={() => void navigate({ to: screen.create })}
          >
            <Plus aria-hidden="true" className="size-4" />
            {t("apiKeys.new")}
          </ReasonButton>
        </div>
        <p className={INTRO}>{t(screen.intro)}</p>
      </div>
      {outcome ? (
        outcome.kind === "error" ? (
          <FormError>{outcome.text}</FormError>
        ) : (
          <output className={NOTICE}>{outcome.text}</output>
        )
      ) : null}
      {keys.isPending ? (
        <StatusScreen kind="loading" />
      ) : keys.error ? (
        isApiError(keys.error, "FORBIDDEN") ? (
          <StatusScreen kind="forbidden" />
        ) : (
          <LoadFailure error={keys.error} onRetry={() => void keys.refetch()} />
        )
      ) : (
        <KeyList
          items={keys.data.items.filter((key) => key.kind === kind)}
          empty={t(screen.empty)}
          onOutcome={setOutcome}
        />
      )}
      <KeyKindGuide kinds={screen.kinds} />
    </div>
  );
}

export function ApiKeysScreen() {
  return <KeysScreen kind="personal" />;
}

export function ServiceKeysScreen() {
  return <KeysScreen kind="service" />;
}

function CopyButton({
  value,
  label,
  field,
  onResult,
}: {
  readonly value: string;
  readonly label: string;
  /** A field to select by hand when the clipboard refuses. */
  readonly field?: RefObject<HTMLInputElement | null>;
  readonly onResult: (copied: boolean) => void;
}) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      className="h-6 gap-1 px-1.5 text-xs"
      aria-label={label}
      onClick={() => {
        void copyText(value, field ?? { current: null }).then((ok) => {
          setCopied(ok);
          onResult(ok);
        });
      }}
    >
      {copied ? (
        <Check aria-hidden="true" className={ICON} />
      ) : (
        <Copy aria-hidden="true" className={ICON} />
      )}
      {copied ? <span>{t("apiKeys.copied")}</span> : null}
    </Button>
  );
}

function KeyIdMeta({ id }: { readonly id: string }) {
  const { t } = useI18n();
  const [failed, setFailed] = useState(false);
  return (
    <span className="inline-flex min-w-0 items-center gap-1">
      <span>{t("apiKeys.idLabel")}</span>
      <code className="min-w-0 font-mono text-foreground [overflow-wrap:anywhere]">
        {id}
      </code>
      <CopyButton
        value={id}
        label={t("apiKeys.copyIdFor", { id })}
        onResult={(ok) => setFailed(!ok)}
      />
      {failed ? (
        <span className="text-destructive" role="alert">
          {t("apiKeys.copyIdFailed")}
        </span>
      ) : null}
    </span>
  );
}

/** Expiry, or revocation, in the state tokens: a key that never ends warns. */
function ExpiryMeta({
  expiresAt,
  revokedAt,
}: {
  readonly expiresAt: string | null;
  readonly revokedAt: string | null;
}) {
  const { t, locale } = useI18n();
  const state = revokedAt ? "revoked" : expiryState(expiresAt);
  if (state === "later" && expiresAt)
    return (
      <span>
        {t("apiKeys.expiresAt", { at: formatTimestamp(expiresAt, locale) })}
      </span>
    );
  const danger = state === "expired" || state === "revoked";
  const text =
    state === "revoked" && revokedAt
      ? t("apiKeys.revokedAt", { at: formatTimestamp(revokedAt, locale) })
      : state === "none" || !expiresAt
        ? t("apiKeys.noExpiry")
        : t(state === "expired" ? "apiKeys.expiredAt" : "apiKeys.expiresSoon", {
            at: formatTimestamp(expiresAt, locale),
          });
  return (
    <span
      data-tone={danger ? "danger" : "caution"}
      data-expiry={state}
      className="inline-flex items-center gap-1 font-medium text-[var(--ap-tone-fg)]"
    >
      {danger ? (
        <CircleAlert aria-hidden="true" className={ICON} />
      ) : (
        <Clock aria-hidden="true" className={ICON} />
      )}
      {text}
    </span>
  );
}

function KeyList({
  items,
  empty,
  onOutcome,
}: {
  readonly items: readonly ApiKeyView[];
  readonly empty: string;
  readonly onOutcome: (outcome: Outcome | null) => void;
}) {
  const { t, locale } = useI18n();
  const { client } = useAgentPlatform();
  const queryClient = useQueryClient();
  const role = useRole();
  const { agents } = useBindableAgents();
  const [confirming, setConfirming] = useState<ApiKeyView | null>(null);

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

  if (items.length === 0) {
    return (
      <div className="flex flex-col items-center gap-2 rounded-md border px-4 py-10 text-center text-muted-foreground text-sm">
        <KeyRound aria-hidden="true" className="size-5" />
        <p className="m-0">{empty}</p>
      </div>
    );
  }

  return (
    <>
      <ul
        className="m-0 flex list-none flex-col rounded-md border p-0"
        aria-label={t("apiKeys.listTitle")}
      >
        {items.map((key) => {
          const kind = kindOf(key);
          const agent = agentName(key.agent_id);
          const label =
            agent === null
              ? t(KIND_NAME[kind])
              : `${t(KIND_NAME[kind])} · ${agent}`;
          const scopes = key.scopes
            .map((scope) => t(SCOPE_NAME[scope]))
            .join(", ");
          const approves = key.scopes.includes("sessions:approve");
          return (
            <li
              key={key.id}
              className="flex min-h-12 flex-col items-start gap-2 border-b px-4 py-3 last:border-b-0 sm:flex-row sm:items-center sm:gap-3"
              data-revoked={key.revoked_at !== null}
            >
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="break-words font-semibold text-sm leading-5">
                    {agent === null ? scopes : `${agent} · ${scopes}`}
                  </span>
                  <KindBadge kind={kind} />
                  <Badge variant="outline" data-approve={approves}>
                    {t(approves ? "apiKeys.approveYes" : "apiKeys.approveNo")}
                  </Badge>
                </div>
                <div
                  className={cn(
                    META,
                    "flex flex-wrap items-center gap-x-3 gap-y-1 leading-4",
                  )}
                >
                  <KeyIdMeta id={key.id} />
                  <span>
                    {t("apiKeys.createdAt", {
                      at: formatTimestamp(key.created_at, locale),
                    })}
                  </span>
                  <ExpiryMeta
                    expiresAt={key.expires_at}
                    revokedAt={key.revoked_at}
                  />
                </div>
                {key.kind === "service" ? (
                  <span className={META}>
                    {t("apiKeys.survivesIssuerShort")}
                  </span>
                ) : null}
              </div>
              {key.revoked_at ? null : (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  data-tone="danger"
                  className="shrink-0 border-[var(--ap-tone-border)] text-[var(--ap-tone-fg)] hover:bg-[var(--ap-tone-bg)] hover:text-[var(--ap-tone-fg)]"
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
    </>
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
      <div>
        <Input
          type="date"
          className="w-auto"
          min={today()}
          value={value}
          onChange={(event) => onChange(event.target.value)}
        />
      </div>
      <FieldDescription>{t("apiKeys.expiresHint")}</FieldDescription>
    </Field>
  );
}

function useIssue(
  permission: ManagedPermission,
  onOutcome: (outcome: Outcome | null) => void,
) {
  const { t } = useI18n();
  const { client } = useAgentPlatform();
  const queryClient = useQueryClient();
  const role = useRole();
  return useMutation<CreateApiKeyResponse, ApiError, IssueRequest>({
    mutationFn: (body) => unwrap(client.POST("/v1/api-keys", { body })),
    // The response carries the secret; keep it nowhere but the screen.
    gcTime: 0,
    onMutate: () => onOutcome(null),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: queryKeys.apiKeys }),
    onError: (error) =>
      onOutcome({
        kind: "error",
        text: keyRefusal(t, error, permission, role),
      }),
  });
}

/**
 * Making a key is a page of its own; once made, the same page shows the
 * secret in its place. It lives in this page's state only, so leaving,
 * going back or reloading drops it, and nothing new is issued from here
 * while it shows.
 */
function NewKeyScreen({ kind }: { readonly kind: ApiKeyKind }) {
  const { t } = useI18n();
  const screen = SCREEN[kind];
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const issue = useIssue(
    kind === "personal" ? "api_key.manage_own" : "api_key.manage",
    setOutcome,
  );
  const issued = issue.data;

  return (
    <div className={PAGE}>
      <div className={HEAD}>
        <div className={cn(HEAD_RULE, "flex flex-col items-start gap-2")}>
          <Link
            to={screen.list}
            className="inline-flex items-center gap-1 text-muted-foreground text-sm no-underline! hover:text-foreground"
          >
            <ArrowLeft aria-hidden="true" className="size-4" />
            {t(screen.title)}
          </Link>
          <h1 className={TITLE}>{t(screen.newTitle)}</h1>
        </div>
        <p className={INTRO}>{t(screen.intro)}</p>
      </div>
      {outcome?.kind === "error" ? <FormError>{outcome.text}</FormError> : null}
      {issued ? (
        <IssuedSecret issued={issued} listTo={screen.list} />
      ) : kind === "personal" ? (
        <PersonalKeyForm
          busy={issue.isPending}
          send={(body) => issue.mutate(body)}
        />
      ) : (
        <ServiceKeyForm
          busy={issue.isPending}
          send={(body) => issue.mutate(body)}
        />
      )}
    </div>
  );
}

export function NewApiKeyScreen() {
  return <NewKeyScreen kind="personal" />;
}

export function NewServiceKeyScreen() {
  return <NewKeyScreen kind="service" />;
}

function IssuedSecret({
  issued,
  listTo,
}: {
  readonly issued: CreateApiKeyResponse;
  readonly listTo: string;
}) {
  const { t } = useI18n();
  const [failed, setFailed] = useState(false);
  const secretRef = useRef<HTMLInputElement>(null);
  const kind = kindOf(issued.key);
  // The form it replaces held focus; put it on the value so it is not missed.
  useEffect(() => {
    secretRef.current?.focus();
  }, []);
  return (
    <section
      className="flex flex-col gap-4 rounded-md border p-4"
      data-status="secret"
      aria-label={t("apiKeys.secretTitle")}
    >
      <div className="flex flex-wrap items-center gap-2">
        <h2 className={SECTION_TITLE}>{t("apiKeys.createdTitle")}</h2>
        <KindBadge kind={kind} />
      </div>
      <div
        data-tone="caution"
        className="flex items-start gap-2 rounded-md border border-[var(--ap-tone-border)] bg-[var(--ap-tone-bg)] p-3 text-[var(--ap-tone-fg)] text-sm"
      >
        <TriangleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
        <p className="m-0">{t("apiKeys.secretOnce")}</p>
      </div>
      <Field>
        <FieldLabel>{t("apiKeys.secret")}</FieldLabel>
        <div className="flex items-center gap-2">
          <Input
            ref={secretRef}
            className="min-w-0 flex-1 font-mono"
            type="text"
            readOnly
            value={issued.secret}
            onFocus={(event) => event.target.select()}
          />
          <SecretCopyButton
            secret={issued.secret}
            field={secretRef}
            onResult={(ok) => setFailed(!ok)}
          />
        </div>
      </Field>
      {failed ? <FormError>{t("apiKeys.copyFailed")}</FormError> : null}
      <p className={cn(META, "m-0 [overflow-wrap:anywhere]")}>
        {t("apiKeys.keyId", { id: issued.key.id })}
      </p>
      <div>
        <Link
          to={listTo}
          data-slot="button"
          className={buttonVariants({ variant: "outline" })}
        >
          {t("apiKeys.toList")}
        </Link>
      </div>
    </section>
  );
}

function SecretCopyButton({
  secret,
  field,
  onResult,
}: {
  readonly secret: string;
  readonly field: RefObject<HTMLInputElement | null>;
  readonly onResult: (copied: boolean) => void;
}) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  return (
    <Button
      type="button"
      className="shrink-0"
      onClick={() => {
        void copyText(secret, field).then((ok) => {
          setCopied(ok);
          onResult(ok);
        });
      }}
    >
      {copied ? (
        <Check aria-hidden="true" className="size-4" />
      ) : (
        <Copy aria-hidden="true" className="size-4" />
      )}
      {copied ? t("apiKeys.copied") : t("apiKeys.copy")}
    </Button>
  );
}

interface FormProps {
  readonly busy: boolean;
  readonly send: (body: IssueRequest) => void;
}

const FORM = "flex flex-col items-start gap-5 rounded-md border p-4";

function FormFoot({
  listTo,
  reason,
  disabled,
}: {
  readonly listTo: string;
  readonly reason?: string | undefined;
  readonly disabled: boolean;
}) {
  const { t } = useI18n();
  return (
    <div className="flex w-full flex-wrap items-start gap-2 border-t pt-4">
      <ReasonButton
        type="submit"
        className={buttonVariants()}
        reason={reason}
        disabled={disabled}
      >
        {t("apiKeys.generate")}
      </ReasonButton>
      <Link
        to={listTo}
        data-slot="button"
        className={buttonVariants({ variant: "outline" })}
      >
        {t("common.cancel")}
      </Link>
    </div>
  );
}

function PersonalKeyForm({ busy, send }: FormProps) {
  const held = useMe()?.scopes ?? [];
  const [scopes, setScopes] = useState<SessionScope[]>(["sessions:read"]);
  const [expires, setExpires] = useState("");
  const reason = useCreateReason("personal");
  const granted = scopes.filter((scope) => held.includes(scope));

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const expiresAt = expiryOf(expires);
    send({
      kind: "personal",
      scopes: granted,
      ...(expiresAt ? { expires_at: expiresAt } : {}),
    });
  };

  return (
    <form className={FORM} onSubmit={submit}>
      <ScopePicker available={held} chosen={scopes} onChange={setScopes} />
      <ExpiryField value={expires} onChange={setExpires} />
      <FormFoot
        listTo={SCREEN.personal.list}
        reason={reason}
        disabled={busy || granted.length === 0}
      />
    </form>
  );
}

// The target select's value for a key bound to no agent.
const WORKSPACE = "workspace";

function ServiceKeyForm({ busy, send }: FormProps) {
  const { t } = useI18n();
  const held = useMe()?.scopes ?? [];
  const workspaceWide = useHasPermission("api_key.manage");
  const { agents, pending, error: agentsError } = useBindableAgents();
  const [scopes, setScopes] = useState<SessionScope[]>(["sessions:read"]);
  const [target, setTarget] = useState(workspaceWide ? WORKSPACE : "");
  const [expires, setExpires] = useState("");
  const chosenAgent = agents.find((agent) => agent.id === target);
  const forAgent = target !== WORKSPACE;

  // What the key would actually carry; the button judges by these.
  const granted = scopes.filter(
    (scope) =>
      held.includes(scope) &&
      (!forAgent || !AGENT_KEY_WITHHELD.includes(scope)),
  );

  const reason = agentsError
    ? t(errorKey(agentsError.code))
    : !workspaceWide && agents.length === 0 && !pending
      ? t("apiKeys.noAgents")
      : chosenAgent && granted.length === 0
        ? t("apiKeys.agentNeedsScope")
        : undefined;

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    // The browser blocks a past date before submitting; a test DOM may not.
    if (expires !== "" && expires < today()) {
      event.currentTarget.reportValidity();
      return;
    }
    const expiresAt = expiryOf(expires);
    send({
      kind: "service",
      scopes: granted,
      ...(chosenAgent ? { agent_id: chosenAgent.id } : {}),
      ...(expiresAt ? { expires_at: expiresAt } : {}),
    });
  };

  return (
    <form className={FORM} onSubmit={submit}>
      <Field>
        <FieldLabel>{t("apiKeys.target")}</FieldLabel>
        {/* The field stretches its children; a block keeps the select its own width. */}
        <div>
          <NativeSelect
            value={target}
            disabled={!workspaceWide && agents.length === 0}
            onChange={(event) => setTarget(event.target.value)}
          >
            {workspaceWide ? (
              <NativeSelectOption value={WORKSPACE}>
                {t("apiKeys.targetWorkspace")}
              </NativeSelectOption>
            ) : (
              <NativeSelectOption value="">
                {t("apiKeys.pickAgent")}
              </NativeSelectOption>
            )}
            {agents.map((agent) => (
              <NativeSelectOption key={agent.id} value={agent.id}>
                {agent.name}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </div>
        <FieldDescription>{t("apiKeys.agentHint")}</FieldDescription>
      </Field>
      <ScopePicker
        available={held}
        chosen={scopes}
        onChange={setScopes}
        withheld={AGENT_KEY_WITHHELD}
      />
      <ExpiryField value={expires} onChange={setExpires} />
      <FormFoot
        listTo={SCREEN.service.list}
        reason={reason}
        disabled={
          busy ||
          granted.length === 0 ||
          (forAgent && chosenAgent === undefined)
        }
      />
    </form>
  );
}
