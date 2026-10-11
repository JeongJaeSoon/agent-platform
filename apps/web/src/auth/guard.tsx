import type { AuthMeResponse, SessionScope } from "@agent-platform/contracts";
import { useQuery } from "@tanstack/react-query";
import { type ButtonHTMLAttributes, useId } from "react";
import { ApiError } from "../api/client.ts";
import { meQuery } from "../api/queries.ts";
import { StatusScreen } from "../components/status-screen.tsx";
import { useI18n } from "../i18n/i18n.tsx";
import { useServices } from "../services.tsx";

/** The signed-in principal; screens under the authenticated layout only. */
export function useMe(): AuthMeResponse | undefined {
  const { client } = useServices();
  return useQuery(meQuery(client)).data;
}

/**
 * Whether the effective scopes allow an action. This only decides what the
 * page offers; the server decides what happens, and its 403 is shown as is.
 */
export function useCan(scope: SessionScope): boolean {
  return useMe()?.scopes.includes(scope) ?? false;
}

export interface GuardedButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement> {
  readonly scope: SessionScope;
}

/** A button that stays visible but disabled, saying why, without the scope. */
export function GuardedButton({
  scope,
  disabled,
  className = "ap-button",
  children,
  ...rest
}: GuardedButtonProps) {
  const allowed = useCan(scope);
  const { t } = useI18n();
  const reasonId = useId();
  return (
    <span className="web-guarded">
      <button
        type="button"
        {...rest}
        className={className}
        disabled={disabled || !allowed}
        aria-describedby={allowed ? rest["aria-describedby"] : reasonId}
      >
        {children}
      </button>
      {allowed ? null : (
        <span id={reasonId} className="web-guarded__reason">
          {t("guard.missingScope", { scope })}
        </span>
      )}
    </span>
  );
}

/** A 403 the server answered, in its own words under ours. */
export function ForbiddenNotice({ error }: { readonly error: unknown }) {
  const detail = error instanceof ApiError ? error.message : undefined;
  return <StatusScreen kind="forbidden" detail={detail} />;
}
