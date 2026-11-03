import {
  exportSettingsResponseSchema,
  importSettingsQuerySchema,
  importSettingsResponseSchema,
  settingsDocumentSchema,
} from "@werft-ai/contracts";
import type { SettingsDocumentService } from "@werft-ai/platform";
import {
  type ApiRouter,
  apiRoute,
  jsonWithSchema,
  parseJsonBody,
} from "../app.ts";
import { mapped, requireQuery } from "./errors.ts";

export function registerInstallationSettingsRoutes(
  router: ApiRouter,
  settings: Pick<SettingsDocumentService, "export" | "import">,
) {
  apiRoute(router, "exportInstallationSettings", async (context) => {
    const exported = await mapped(() => settings.export(context.get("caller")));
    return jsonWithSchema(context, exportSettingsResponseSchema, exported);
  });

  apiRoute(router, "importInstallationSettings", async (context) => {
    const query = requireQuery(context, importSettingsQuerySchema);
    const document = await parseJsonBody(context, settingsDocumentSchema);
    const imported = await mapped(() =>
      settings.import(context.get("caller"), document, {
        dryRun: query.dry_run === "true",
      }),
    );
    return jsonWithSchema(context, importSettingsResponseSchema, imported);
  });
}
