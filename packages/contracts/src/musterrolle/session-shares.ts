import { z } from "zod";

// Who sees a session (design 4.6): its creator alone, the people or teams it
// names, or the whole workspace. Slack DMs start private; channel, web and
// API sessions start workspace-wide.
export const SESSION_SHARE_SCOPE_VALUES = [
  "private",
  "people",
  "team",
  "workspace",
] as const;
export const sessionShareScopeSchema = z.enum(SESSION_SHARE_SCOPE_VALUES);

export type SessionShareScope = z.infer<typeof sessionShareScopeSchema>;
