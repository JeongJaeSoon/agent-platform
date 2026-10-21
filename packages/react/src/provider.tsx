import type { ApiClient } from "@agent-platform/client";
import { createContext, type ReactNode, useContext, useMemo } from "react";
import {
  defaultMessages,
  type Locale,
  type ModuleMessageKey,
  type ModuleMessages,
} from "./messages/index.ts";

/** A place a module links to; the host app turns it into its own URL. */
export type LinkTarget = { readonly to: "session"; readonly id: string };

export type RenderLink = (
  link: LinkTarget & { readonly children: ReactNode },
) => ReactNode;

export interface AgentPlatformProviderProps {
  /** Made by the host app; the modules never build one. */
  readonly client: ApiClient;
  readonly locale: Locale;
  /** Replaces the default wording key by key. */
  readonly messages?: Partial<Record<ModuleMessageKey, string>>;
  readonly renderLink: RenderLink;
  readonly children: ReactNode;
}

export interface AgentPlatform {
  readonly client: ApiClient;
  readonly locale: Locale;
  /** The locale's default messages with the host's replacements applied. */
  readonly messages: ModuleMessages;
  readonly renderLink: RenderLink;
}

const AgentPlatformContext = createContext<AgentPlatform | null>(null);

/**
 * What every hook and block of this package reads. It sits inside the host's
 * QueryClientProvider, which owns the cache.
 */
export function AgentPlatformProvider({
  client,
  locale,
  messages,
  renderLink,
  children,
}: AgentPlatformProviderProps) {
  const value = useMemo<AgentPlatform>(
    () => ({
      client,
      locale,
      messages: { ...defaultMessages[locale], ...messages },
      renderLink,
    }),
    [client, locale, messages, renderLink],
  );
  return <AgentPlatformContext value={value}>{children}</AgentPlatformContext>;
}

export function useAgentPlatform(): AgentPlatform {
  const value = useContext(AgentPlatformContext);
  if (!value) throw new Error("useAgentPlatform outside AgentPlatformProvider");
  return value;
}
