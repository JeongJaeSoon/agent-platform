import type { TurnEventMessage } from "@werft-ai/contracts";
import type { ModuleMessageKey } from "../messages/index.ts";
import { useAgentPlatform } from "../provider.tsx";

export type BlockText = (
  key: ModuleMessageKey,
  vars?: Readonly<Record<string, string | number>>,
) => string;

export function useBlockText() {
  const { messages, locale } = useAgentPlatform();
  const t: BlockText = (key, vars = {}) =>
    messages[key].replace(/\{(\w+)\}/g, (whole, name: string) =>
      Object.hasOwn(vars, name) ? String(vars[name]) : whole,
    );
  const formatMessage = ({ key, params }: TurnEventMessage) => t(key, params);
  return { t, formatMessage, locale };
}
