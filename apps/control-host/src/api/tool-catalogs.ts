import type { ToolCatalogs } from "@werft-ai/platform";
import {
  installedToolCatalogs,
  toolCatalogFor,
} from "@werft-ai/runtime-codecs";

/** The built-in tool catalogs this image's runtimes support, which a profile's deny names. */
export const installedToolCatalogView: ToolCatalogs = {
  all: installedToolCatalogs,
  for: (runtimeKind, runtimeVersion) =>
    toolCatalogFor(installedToolCatalogs, runtimeKind, runtimeVersion),
};
