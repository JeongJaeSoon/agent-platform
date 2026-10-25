import { useAgentPlatform } from "../../provider.tsx";
import { AGENT_MAP_MESSAGES, type AgentMapMessages } from "./messages.ts";

/** The provider locale's wording with the host's replacements. */
export function useAgentMapMessages(
  override: Partial<AgentMapMessages> | undefined,
): AgentMapMessages {
  const { locale } = useAgentPlatform();
  return { ...AGENT_MAP_MESSAGES[locale], ...override };
}
