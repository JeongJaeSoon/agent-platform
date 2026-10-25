import { type ApiError, isApiError } from "@werft-ai/client";
import type {
  AuthMeResponse,
  AuthorizationAction,
  SessionScope,
  WorkspaceRole,
} from "@werft-ai/contracts";
import { useMe as useMeQuery } from "@werft-ai/react";
import { cn, Tooltip, TooltipContent, TooltipTrigger } from "@werft-ai/ui";
import type { ButtonHTMLAttributes } from "react";
import {
  errorKey,
  isMessageKey,
  type Translate,
  useI18n,
} from "../i18n/i18n.tsx";

/** The roles a member can be given; client.test.ts pins it to the contract. */
export const WORKSPACE_ROLE_VALUES: readonly WorkspaceRole[] = [
  "owner",
  "admin",
  "member",
];

const BELOW_OWNER = WORKSPACE_ROLE_VALUES.filter((value) => value !== "owner");

/**
 * The roles the signed-in user may give someone, by invite or role change.
 * packages/db/src/invites.ts refuses owner from anyone but an owner
 * (owner_protected).
 */
export function useGrantableRoles(): readonly WorkspaceRole[] {
  return useRole() === "owner" ? WORKSPACE_ROLE_VALUES : BELOW_OWNER;
}

/** The signed-in principal; screens under the authenticated layout only. */
export function useMe(): AuthMeResponse | undefined {
  return useMeQuery().data;
}

/**
 * Whether the effective scopes allow an action. This only decides what the
 * page offers; the server decides what happens, and its 403 is shown as is.
 */
/** The signed-in user's role; an API key principal has none. */
export function useRole(): string | undefined {
  const principal = useMe()?.principal;
  return principal?.kind === "user" ? principal.role : undefined;
}

/**
 * Whether the signed-in role holds a management action on the workspace, as
 * the server's role table says (/v1/auth/me). Only for hiding a menu whose
 * whole screen needs it; an agent's admin holds more on that agent.
 */
export function useHasPermission(action: AuthorizationAction): boolean {
  return useMe()?.permissions.includes(action) ?? false;
}

export function useCan(scope: SessionScope): boolean {
  return useMe()?.scopes.includes(scope) ?? false;
}

export interface GuardedButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement> {
  readonly scope: SessionScope;
}

/** A button that stays visible but disabled, saying why, without the scope. */
export function GuardedButton({ scope, ...rest }: GuardedButtonProps) {
  const allowed = useCan(scope);
  const { t } = useI18n();
  return (
    <ReasonButton
      {...rest}
      reason={allowed ? undefined : t("guard.missingScope", { scope })}
    />
  );
}

export interface ReasonButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** Why the action is unavailable; the button is inert while it is set. */
  readonly reason: string | undefined;
}

/**
 * The shape every withheld action takes: still on the page at its own width,
 * inert, and saying why on hover, focus or a tap, described by the reason so
 * a screen reader hears it. aria-disabled, not disabled: a disabled button
 * takes neither the pointer nor focus, so its reason could not be shown.
 */
export function ReasonButton({
  reason,
  disabled,
  className = "ap-button",
  onClick,
  children,
  ...rest
}: ReasonButtonProps) {
  const withheld = reason !== undefined;
  // One tree either way: a reason that clears, as a permission check
  // answering, must not remount the button under the pointer or the focus.
  return (
    <Tooltip {...(!withheld && { open: false })}>
      <TooltipTrigger asChild={true}>
        <button
          type="button"
          {...rest}
          {...(withheld && {
            "aria-disabled": true,
            // A DialogTrigger around it would announce a dialog it never opens.
            "aria-haspopup": undefined,
            "aria-expanded": undefined,
            "aria-controls": undefined,
          })}
          className={cn(
            className,
            "aria-disabled:cursor-not-allowed aria-disabled:opacity-45",
          )}
          disabled={withheld ? undefined : disabled}
          onClick={(event) => {
            if (!withheld) return onClick?.(event);
            // Left alone, so a tap still pins the reason; a submit button
            // would also submit, from here or from Enter in a field.
            if (event.currentTarget.type === "submit") event.preventDefault();
          }}
        >
          {children}
        </button>
      </TooltipTrigger>
      <TooltipContent side="top">{reason}</TooltipContent>
    </Tooltip>
  );
}

/**
 * Management powers the server checks by role, not by session scope: the
 * ones a screen withholds, each with words in the catalog (`permission.*`).
 */
export type ManagedPermission = Extract<
  AuthorizationAction,
  | "member.manage"
  | "team.manage"
  | "agent.create"
  | "agent.manage"
  | "agent.admin.manage"
  | "api_key.manage"
  | "api_key.manage_own"
  | "audit_retention.manage"
  | "workspace.manage"
  | "session.control"
  | "account.link"
>;

/**
 * Why a management action is withheld, or undefined when it is not.
 *
 * The answer comes from the server: `probe` is the screen's own list query,
 * which needs the same permission, so a role this page has never heard of
 * still gets its buttons the moment the server lets it list. The role from
 * /v1/auth/me only names who is asking in the reason. A refused mutation
 * shows the same sentence through `permissionReason`.
 */
export function usePermissionReason(
  permission: ManagedPermission,
  probe: { readonly isSuccess: boolean; readonly error: unknown },
): string | undefined {
  const { t } = useI18n();
  const role = useRole();
  if (probe.isSuccess) return undefined;
  if (isApiError(probe.error, "FORBIDDEN"))
    return permissionReason(t, permission, role);
  return t("guard.checking");
}

export function permissionReason(
  t: Translate,
  permission: ManagedPermission,
  role: string | undefined,
): string {
  const named = t(`permission.${permission}`);
  return role === undefined
    ? t("guard.missingPermission", { permission: named })
    : t("guard.missingPermissionAs", {
        permission: named,
        role: roleLabel(t, role),
      });
}

/** A role's name; one this build has no words for is shown as the server sent it. */
export function roleLabel(t: Translate, role: string): string {
  const key = `role.${role}`;
  return isMessageKey(key) ? t(key) : role;
}

/**
 * What a refused management call says: a 403 reads like the reason on the
 * disabled button. The server's sentence is English and names the action's
 * identifier, so it stays off the page.
 */
export function refusalText(
  t: Translate,
  error: ApiError,
  permission: ManagedPermission,
  role: string | undefined,
): string {
  if (error.code === "FORBIDDEN") return permissionReason(t, permission, role);
  return t(errorKey(error.code));
}
