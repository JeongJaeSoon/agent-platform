// Scalar configuration for the API reference. The committed copy
// (docs/api/index.html, also published to GitHub Pages) has no API behind
// it, so it stays read-only; GET /docs swaps in the interactive one, whose
// requests go to the same origin with the key the reader types.
const BASE_CONFIGURATION = {
  agent: { disabled: true },
  hideClientButton: true,
  isEditable: false,
  showDeveloperTools: "never",
  showToolbar: "never",
  telemetry: false,
  withDefaultFonts: false,
};

const READ_ONLY_CONFIGURATION = {
  ...BASE_CONFIGURATION,
  hideTestRequestButton: true,
};

const INTERACTIVE_CONFIGURATION = {
  ...BASE_CONFIGURATION,
  hideTestRequestButton: false,
  authentication: { preferredSecurityScheme: "bearerApiKey" },
  persistAuth: false,
};

export function htmlAttribute(value: unknown): string {
  return JSON.stringify(value)
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;");
}

export const READ_ONLY_CONFIGURATION_ATTRIBUTE = `data-configuration="${htmlAttribute(READ_ONLY_CONFIGURATION)}"`;
export const INTERACTIVE_CONFIGURATION_ATTRIBUTE = `data-configuration="${htmlAttribute(INTERACTIVE_CONFIGURATION)}"`;
