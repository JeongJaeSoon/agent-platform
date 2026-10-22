import { flowEn, formsEn, sessionsEn } from "@werft-ai/react";
import { agentsEn } from "./agents.ts";
import { apiKeysEn } from "./api-keys.ts";
import { authEn } from "./auth.ts";
import { commonEn } from "./common.ts";
import { errorsEn } from "./errors.ts";
import { homeEn } from "./home.ts";
import type { MessageKey } from "./ko.ts";
import { linkedEn } from "./linked.ts";
import { membersEn } from "./members.ts";
import { modelsEn } from "./models.ts";
import { preferencesEn } from "./preferences.ts";
import { shellEn } from "./shell.ts";
import { teamsEn } from "./teams.ts";
import { workspaceEn } from "./workspace.ts";

export const en: Record<MessageKey, string> = {
  ...commonEn,
  ...shellEn,
  ...authEn,
  ...homeEn,
  ...membersEn,
  ...teamsEn,
  ...agentsEn,
  ...modelsEn,
  ...sessionsEn,
  ...flowEn,
  ...linkedEn,
  ...apiKeysEn,
  ...workspaceEn,
  ...preferencesEn,
  ...errorsEn,
  ...formsEn,
};
