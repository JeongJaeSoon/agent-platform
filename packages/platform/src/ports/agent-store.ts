import type {
  AgentCard,
  AgentDetail,
  AgentRelease,
  AgentSummary,
  AgentVersion,
  CountAgentsResponse,
  ListAgentsQuery,
  ListAgentsResponse,
  WorkspaceRole,
} from "@werft-ai/contracts";
import type { OutsideAgentAccess, Principal } from "../musterrolle/policy.ts";
import type { SessionViewer } from "./session-share-store.ts";

/** Who lists agents, and what the workspace lets members outside one see. */
export interface AgentReader {
  userId: string;
  outsideAccess: OutsideAgentAccess;
}

/** A release as the service builds it; the store stamps the times. */
export type NewAgentRelease = Omit<
  AgentRelease,
  | "created_by"
  | "created_at"
  | "approved_by"
  | "approved_at"
  | "label"
  | "activated_at"
  | "deactivated_at"
> & { created_by: string };

// Every write re-checks the acting person's membership under a share lock in
// its own transaction; `actor_inactive` is an offboarding that won that race.
// A change to an existing agent also re-checks, under the agent row's lock,
// the right to make it: `outranked` is a demotion or a managing-team change
// that won it.
type Inactive = { outcome: "actor_inactive" };
type Outranked = { outcome: "outranked" };

/** Roles holding the right outright; anyone else must administer the agent. */
type ManagerRoles = { managerRoles: readonly WorkspaceRole[] };

export type CreateAgentResult =
  | { outcome: "created"; detail: AgentDetail }
  | { outcome: "slug_taken" | "team_not_found" | "team_not_allowed" }
  | Inactive;

export type UpdateAgentResult =
  | { outcome: "updated"; detail: AgentDetail }
  | { outcome: "not_found" }
  | Inactive
  | Outranked;

export type InsertReleaseResult =
  | { outcome: "created" | "exists"; release: AgentRelease }
  | { outcome: "not_found" | "github_settings_exist" }
  | Inactive
  | Outranked;

export type ActivateResult =
  | {
      outcome: "activated";
      revision: number;
      previousReleaseId: string | null;
      receiptId: string;
    }
  | { outcome: "unchanged"; revision: number; previousReleaseId: null }
  | { outcome: "conflict"; activeReleaseId: string | null; revision: number }
  | { outcome: "not_found" }
  | Inactive
  | Outranked;

export interface AgentStore {
  /**
   * One page, oldest first, of the agents `reader` may read (agent.read),
   * narrowed by `q` and `ids`; a malformed cursor throws
   * InvalidCursorError. `include` is the service's.
   */
  list(
    workspaceId: string,
    query: ListAgentsQuery,
    reader: AgentReader,
  ): Promise<ListAgentsResponse>;
  /**
   * The list summary of each agent named whose settings `viewer` may read
   * (agent.settings_read), keyed by id, read for the whole page at once; any
   * other id is left out.
   */
  summaries(
    workspaceId: string,
    agentIds: readonly string[],
    viewer: SessionViewer,
  ): Promise<Map<string, AgentSummary>>;
  /** What `list` holds for `reader` read to the end, and how many of it they administer. */
  count(
    workspaceId: string,
    reader: AgentReader,
  ): Promise<CountAgentsResponse["counts"]>;
  get(workspaceId: string, agentId: string): Promise<AgentDetail | null>;
  findVersion(
    workspaceId: string,
    agentId: string,
    versionId: string,
  ): Promise<AgentVersion | null>;
  findRelease(
    workspaceId: string,
    releaseId: string,
  ): Promise<AgentRelease | null>;
  /**
   * Whether a release of the agent made after this one has ever been
   * activated: going back to this one is then a rollback.
   */
  releaseSuperseded(
    workspaceId: string,
    agentId: string,
    releaseId: string,
  ): Promise<boolean>;
  /** The agent, version 1 and their receipt in one transaction. */
  create(input: {
    principal: Principal;
    workspaceId: string;
    slug: string;
    name: string;
    description?: string;
    /**
     * `managerRoles` name any live team; anyone else only a team they are
     * in, re-read under share locks.
     */
    managingTeam: { id: string } & ManagerRoles;
    card: AgentCard;
    contentSha256: string;
    createdBy: string;
  }): Promise<CreateAgentResult>;
  /**
   * Renames, describes and/or adds a version. A card whose hash matches an
   * existing version of the agent adds nothing.
   */
  update(
    input: ManagerRoles & {
      principal: Principal;
      workspaceId: string;
      agentId: string;
      name?: string;
      /** `null` clears it. */
      description?: string | null;
      card?: { card: AgentCard; contentSha256: string };
      updatedBy: string;
    },
  ): Promise<UpdateAgentResult>;
  /**
   * Inserts the release, a `release_created` event and a receipt in one
   * transaction, or returns the row already stored under that id.
   * `not_found` when the version is not the agent's.
   */
  insertRelease(
    input: ManagerRoles & {
      principal: Principal;
      workspaceId: string;
      release: NewAgentRelease;
      /**
       * The request carried `github`: `github_settings_exist` instead of a
       * release when the agent has a settings row, judged under the lock.
       */
      refuseGitHubWhenSettings?: boolean;
    },
  ): Promise<InsertReleaseResult>;
  /** Whether the agent has an `agent_github_settings` row. */
  hasGitHubSettings(agentId: string): Promise<boolean>;
  /**
   * `UPDATE agents … WHERE activation_revision = expected`, the release's
   * first approval, an `activated` event and a receipt in one transaction.
   */
  activate(
    input: ManagerRoles & {
      principal: Principal;
      workspaceId: string;
      agentId: string;
      releaseId: string;
      expectedRevision: number;
      approvedBy: string;
    },
  ): Promise<ActivateResult>;
}
