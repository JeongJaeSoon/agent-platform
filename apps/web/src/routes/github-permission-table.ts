import type {
  GitHubAppPermissionLevel,
  GitHubAppPermissions,
  GitHubCeiling,
} from "@werft-ai/contracts";

/** The ceiling features the console offers; checks and issues have no work yet. */
export const OFFERED_FEATURES = ["actions", "workflows", "review"] as const;
export type OfferedFeature = (typeof OFFERED_FEATURES)[number];

export const RANK: Record<GitHubAppPermissionLevel, number> = {
  read: 1,
  write: 2,
  admin: 3,
};

/** What every agent's token asks the author App for. */
export const BASE_NEED: GitHubAppPermissions = {
  contents: "write",
  pull_requests: "write",
  metadata: "read",
};

/** What turning a feature on adds to the author App's need. */
export const FEATURE_NEED: Record<
  Exclude<OfferedFeature, "review">,
  GitHubAppPermissions
> = {
  actions: { actions: "write" },
  workflows: { workflows: "write" },
};

/** What the reviewer App's token asks for (contracts githubPermissionsFor "review"). */
export const REVIEW_NEED: GitHubAppPermissions = {
  contents: "read",
  pull_requests: "write",
};

// Rows keep this order inside each status; the rest follow by name.
const ORDER = [
  "contents",
  "pull_requests",
  "metadata",
  "actions",
  "workflows",
] as const;

export type PermissionStatus = "missing" | "short" | "wide" | "ok";

export type PermissionRow = {
  readonly name: string;
  readonly need: GitHubAppPermissionLevel | null;
  readonly app: GitHubAppPermissionLevel | null;
  readonly status: PermissionStatus;
  /** The feature this permission serves, when one does. */
  readonly feature: "base" | Exclude<OfferedFeature, "review"> | null;
};

const STATUS_ORDER: Record<PermissionStatus, number> = {
  missing: 0,
  short: 1,
  wide: 2,
  ok: 3,
};

export function authorNeed(ceiling: GitHubCeiling): GitHubAppPermissions {
  return {
    ...BASE_NEED,
    ...(ceiling.actions ? FEATURE_NEED.actions : {}),
    ...(ceiling.workflows ? FEATURE_NEED.workflows : {}),
  };
}

export function statusOf(
  need: GitHubAppPermissionLevel | null,
  app: GitHubAppPermissionLevel | null,
): PermissionStatus {
  if (need !== null && app === null) return "missing";
  if (need !== null && app !== null && RANK[app] < RANK[need]) return "short";
  if (app !== null && (need === null || RANK[app] > RANK[need])) return "wide";
  return "ok";
}

function featureOf(name: string): PermissionRow["feature"] {
  if (name in BASE_NEED) return "base";
  if (name === "actions" || name === "workflows") return name;
  return null;
}

/**
 * The author App's permissions against what the features turned on need,
 * one row a permission either side names, problems first.
 */
export function permissionRows(
  app: GitHubAppPermissions,
  ceiling: GitHubCeiling,
): PermissionRow[] {
  const need = authorNeed(ceiling);
  const names = new Set([...Object.keys(need), ...Object.keys(app)]);
  const rank = (name: string) => {
    const at = (ORDER as readonly string[]).indexOf(name);
    return at === -1 ? ORDER.length : at;
  };
  return [...names]
    .map((name) => {
      const needed = need[name] ?? null;
      const held = app[name] ?? null;
      return {
        name,
        need: needed,
        app: held,
        status: statusOf(needed, held),
        feature: featureOf(name),
      };
    })
    .sort(
      (a, b) =>
        STATUS_ORDER[a.status] - STATUS_ORDER[b.status] ||
        rank(a.name) - rank(b.name) ||
        a.name.localeCompare(b.name),
    );
}

/** The first permission in `need` the App lacks or holds below it, or null. */
export function firstShortfall(
  need: GitHubAppPermissions,
  app: GitHubAppPermissions | null,
): { name: string; held: GitHubAppPermissionLevel | null } | null {
  if (app === null) return null;
  for (const [name, level] of Object.entries(need)) {
    const held = app[name] ?? null;
    if (held === null || RANK[held] < RANK[level]) return { name, held };
  }
  return null;
}

/** The App asks for more than the installation has accepted so far. */
export function approvalPending(
  app: GitHubAppPermissions | null | undefined,
  installation: GitHubAppPermissions | null | undefined,
): boolean {
  if (!app || !installation) return false;
  return Object.entries(app).some(([name, level]) => {
    const held = installation[name];
    return held === undefined || RANK[level] > RANK[held];
  });
}

/** `owner` of a GitHub clone URL, or null when it is not one. */
export function ownerOf(url: string): string | null {
  try {
    const owner = new URL(url).pathname.split("/")[1];
    return owner ? owner : null;
  } catch {
    return null;
  }
}
