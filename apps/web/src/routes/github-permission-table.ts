import {
  GITHUB_APP_PERMISSION_GUIDANCE,
  type GitHubAppPermissionLevel,
  type GitHubAppPermissions,
  type GitHubAppRole,
  type GitHubCeiling,
} from "@werft-ai/contracts";

/** The ceiling features the console offers; checks and issues have no work yet. */
export const ROLE_FEATURES = {
  author: ["actions", "workflows"],
  reviewer: ["review"],
} as const satisfies Record<GitHubAppRole, readonly (keyof GitHubCeiling)[]>;
export type OfferedFeature = (typeof ROLE_FEATURES)[GitHubAppRole][number];

export const RANK: Record<GitHubAppPermissionLevel, number> = {
  read: 1,
  write: 2,
  admin: 3,
};

const BASE_NEED: GitHubAppPermissions = {
  contents: "write",
  pull_requests: "write",
  metadata: "read",
};
// contracts githubPermissionsFor "review".
const REVIEW_NEED: GitHubAppPermissions = {
  contents: "read",
  pull_requests: "write",
};

// Rows keep this order whatever the switches do, so nothing moves under
// focus; names outside it follow by name.
const ROW_ORDER = [
  "contents",
  "pull_requests",
  "metadata",
  "actions",
  "workflows",
  "checks",
  "issues",
  "administration",
] as const;

/** The App against what is needed now and what the role's guidance allows. */
export type AppStatus = "missing" | "short" | "beyond" | "unused" | "ok";
/** The installation against the App: a fact apart from AppStatus. */
export type Approval = "approved" | "pending" | "unknown";

/** What a role's App must hold under a ceiling, saved or not. */
export function needOf(
  role: GitHubAppRole,
  ceiling: GitHubCeiling,
): GitHubAppPermissions {
  if (role === "reviewer") return ceiling.review ? REVIEW_NEED : {};
  return {
    ...BASE_NEED,
    ...(ceiling.actions ? { actions: "write" } : {}),
    ...(ceiling.workflows ? { workflows: "write" } : {}),
  };
}

export function appStatusOf(
  role: GitHubAppRole,
  name: string,
  need: GitHubAppPermissionLevel | null,
  held: GitHubAppPermissionLevel | null,
): AppStatus {
  if (need !== null && held === null) return "missing";
  if (need !== null && held !== null && RANK[held] < RANK[need]) return "short";
  const guided = GITHUB_APP_PERMISSION_GUIDANCE[role][name];
  if (held !== null && (guided === undefined || RANK[held] > RANK[guided])) {
    return "beyond";
  }
  if (held !== null && need === null) return "unused";
  return "ok";
}

/** No installation, or approvals GitHub did not give, is never "pending". */
export function approvalOf(
  held: GitHubAppPermissionLevel | null,
  approved: GitHubAppPermissions | null | undefined,
  name: string,
): Approval {
  if (!approved) return "unknown";
  if (held === null) return "approved";
  const level = approved[name];
  return level !== undefined && RANK[level] >= RANK[held]
    ? "approved"
    : "pending";
}

export type PermissionRow = {
  readonly name: string;
  readonly need: GitHubAppPermissionLevel | null;
  readonly app: GitHubAppPermissionLevel | null;
  /** What the installation approved; null when nothing or unread. */
  readonly granted: GitHubAppPermissionLevel | null;
  readonly status: AppStatus;
  readonly approval: Approval;
  /** The App's own gap first; an approval gap shows when the App is fine. */
  readonly badge: AppStatus | "pending";
  /** The unsaved switches change this row's need. */
  readonly changed: boolean;
};

const rank = (name: string) => {
  const at = (ROW_ORDER as readonly string[]).indexOf(name);
  return at === -1 ? ROW_ORDER.length : at;
};

/**
 * One App's permission table: a row for each permission the role needs
 * under `ceiling` or the App holds, read against the installation picked.
 */
export function permissionTable(input: {
  readonly role: GitHubAppRole;
  readonly app: GitHubAppPermissions;
  /** The picked installation's approvals; null with none, or unread. */
  readonly approved: GitHubAppPermissions | null;
  /** The switches as shown: the draft when there is one. */
  readonly ceiling: GitHubCeiling;
  readonly saved: GitHubCeiling;
}): {
  rows: PermissionRow[];
  changed: PermissionRow[];
  /** The installation has not approved all the App asks for. */
  pending: boolean;
} {
  const { role, app, approved } = input;
  const need = needOf(role, input.ceiling);
  const before = needOf(role, input.saved);
  const rows = [...new Set([...Object.keys(need), ...Object.keys(app)])]
    .sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))
    .map((name): PermissionRow => {
      const needed = need[name] ?? null;
      const held = app[name] ?? null;
      const status = appStatusOf(role, name, needed, held);
      const approval = approvalOf(held, approved, name);
      return {
        name,
        need: needed,
        app: held,
        granted: approved?.[name] ?? null,
        status,
        approval,
        badge:
          approval === "pending" && (status === "ok" || status === "unused")
            ? "pending"
            : status,
        changed: needed !== (before[name] ?? null),
      };
    });
  return {
    rows,
    changed: rows.filter((row) => row.changed),
    pending:
      approved !== null &&
      Object.entries(app).some(
        ([name, level]) => approvalOf(level, approved, name) === "pending",
      ),
  };
}

/** What the role needs under `ceiling` that the App lacks or holds below it. */
export function lackingOf(
  role: GitHubAppRole,
  app: GitHubAppPermissions,
  ceiling: GitHubCeiling,
): [string, GitHubAppPermissionLevel][] {
  return Object.entries(needOf(role, ceiling)).filter(([name, level]) => {
    const held = app[name];
    return held === undefined || RANK[held] < RANK[level];
  });
}
