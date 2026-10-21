import { agentsKo } from "./agents.ts";
import { apiKeysKo } from "./api-keys.ts";
import { authKo } from "./auth.ts";
import { commonKo } from "./common.ts";
import { errorsKo } from "./errors.ts";
import { homeKo } from "./home.ts";
import { linkedKo } from "./linked.ts";
import { membersKo } from "./members.ts";
import { modelsKo } from "./models.ts";
import { sessionsKo } from "./sessions.ts";
import { shellKo } from "./shell.ts";
import { teamsKo } from "./teams.ts";
import { workspaceKo } from "./workspace.ts";

/**
 * The message catalog's source of truth, spread together from one file per
 * area; a new key goes in its area's file, never here. Keys are
 * `<screen>.<element>`; shared words live under `common.*`, status screens
 * under `status.<kind>.*` and error guidance under `error.<API error code>`.
 * `{name}` is a variable. Every other locale is typed against these keys, so
 * a key added to an area's Korean object and not translated fails the
 * typecheck.
 */
export const ko = {
  ...commonKo,
  ...shellKo,
  ...authKo,
  ...homeKo,
  ...membersKo,
  ...teamsKo,
  ...agentsKo,
  ...modelsKo,
  ...sessionsKo,
  ...linkedKo,
  ...apiKeysKo,
  ...workspaceKo,
  ...errorsKo,
} as const;

export type MessageKey = keyof typeof ko;
