import type { WebUiCounts } from "./architecture.test.ts";

/**
 * UI that apps/web still draws itself, per file under apps/web/src, rule and
 * count. It only shrinks: a PR that moves a screen onto packages/ui lowers or
 * removes its entry, and nothing is ever added here (see webUiRatchet).
 */
export const webUiAllowlist: WebUiCounts = {
  "auth/guard.tsx": { "legacy-class": 2 },
  "components/agent-admins.tsx": { "legacy-class": 15 },
  "components/agent-card-form.tsx": { "raw-destructive": 1 },
  "components/auth-page.tsx": { "raw-destructive": 1 },
  "components/new-agent-flow.tsx": { "raw-destructive": 1 },
  "components/outcome.tsx": { "legacy-class": 1 },
  "router.tsx": { "legacy-class": 1 },
  "routes/agent-detail/releases.tsx": { "raw-destructive": 1 },
  "routes/agents.tsx": { "legacy-class": 1 },
  "routes/api-keys.tsx": { "raw-destructive": 1 },
  "routes/layout.tsx": { "legacy-class": 1, "raw-destructive": 1 },
  "styles.css": { "legacy-class": 37 },
};
