import { flowJa, formsJa, sessionsJa } from "@werft-ai/react";
import { agentsJa } from "./agents.ts";
import { apiKeysJa } from "./api-keys.ts";
import { authJa } from "./auth.ts";
import { commonJa } from "./common.ts";
import { errorsJa } from "./errors.ts";
import { homeJa } from "./home.ts";
import type { MessageKey } from "./ko.ts";
import { linkedJa } from "./linked.ts";
import { membersJa } from "./members.ts";
import { modelsJa } from "./models.ts";
import { preferencesJa } from "./preferences.ts";
import { shellJa } from "./shell.ts";
import { teamsJa } from "./teams.ts";
import { workspaceJa } from "./workspace.ts";

export const ja: Record<MessageKey, string> = {
  ...commonJa,
  ...shellJa,
  ...authJa,
  ...homeJa,
  ...membersJa,
  ...teamsJa,
  ...agentsJa,
  ...modelsJa,
  ...sessionsJa,
  ...flowJa,
  ...linkedJa,
  ...apiKeysJa,
  ...workspaceJa,
  ...preferencesJa,
  ...errorsJa,
  ...formsJa,
};
