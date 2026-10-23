import type { WebUiCounts } from "./architecture.test.ts";

/**
 * UI that apps/web still draws itself, per file under apps/web/src, rule and
 * count. It only shrinks: a PR that moves a screen onto packages/ui lowers or
 * removes its entry, and nothing is ever added here (see webUiRatchet).
 */
export const webUiAllowlist: WebUiCounts = {
  "auth/guard.tsx": { "legacy-class": 2 },
  "components/agent-admins.tsx": { "legacy-class": 26 },
  "components/agent-card-form.tsx": {
    "legacy-class": 1,
    "raw-destructive": 1,
  },
  "components/auth-page.tsx": { "link-constant": 1, "raw-destructive": 1 },
  "components/my-teams.tsx": { "link-constant": 1 },
  "components/new-agent-flow.tsx": {
    "legacy-class": 2,
    "raw-destructive": 1,
  },
  "components/outcome.tsx": { "legacy-class": 2 },
  "components/table.tsx": { "raw-table": 1, "shadow-component": 10 },
  "funnel/tanstack-funnel.tsx": { "legacy-class": 1 },
  "router.tsx": { "legacy-class": 1 },
  "routes/agent-detail/releases.tsx": { "raw-destructive": 1 },
  "routes/agents.tsx": { "legacy-class": 1 },
  "routes/api-keys.tsx": { "raw-destructive": 1 },
  "routes/home.tsx": { "link-constant": 1 },
  "routes/layout.tsx": {
    "legacy-class": 1,
    "raw-anchor": 1,
    "raw-destructive": 1,
  },
  "routes/session-outputs.tsx": { "raw-anchor": 1 },
  "styles.css": { "legacy-class": 53 },
};
