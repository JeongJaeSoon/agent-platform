import {
  type ListProfilesResponse,
  listProfilesResponseSchema,
} from "@agent-platform/contracts";
import { isUnmetered, type SessionCatalog } from "@agent-platform/platform";
import { type ApiRouter, apiRoute, jsonWithSchema } from "../app.ts";

/** Picked field by field: a profile also holds its provider credential. */
export function listProfiles(catalog: SessionCatalog): ListProfilesResponse {
  return {
    items: Object.entries(catalog.profiles)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([id, profile]) => ({
        id,
        model: profile.model,
        tools: [...profile.tools],
        runtime_kind: profile.runtime_kind,
        runtime_version: profile.runtime_version,
        billing: isUnmetered(profile) ? "none" : "metered",
      })),
  };
}

export function registerProfileRoutes(
  router: ApiRouter,
  catalog: SessionCatalog,
) {
  // The catalog does not change while the API runs.
  const body = listProfiles(catalog);
  apiRoute(router, "listProfiles", (context) =>
    Promise.resolve(jsonWithSchema(context, listProfilesResponseSchema, body)),
  );
}
