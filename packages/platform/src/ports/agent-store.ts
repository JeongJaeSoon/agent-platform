import type {
  Agent,
  AgentCard,
  AgentDetail,
  AgentRelease,
  AgentVersion,
} from "@agent-platform/contracts";
import type { Principal } from "../musterrolle/policy.ts";

/** A release as the service builds it; the store stamps the times. */
export type NewAgentRelease = Omit<
  AgentRelease,
  "created_by" | "created_at" | "approved_by" | "approved_at"
> & { created_by: string };

// Every write re-checks the acting person's membership under a share lock in
// its own transaction; `actor_inactive` is an offboarding that won that race.
type Inactive = { outcome: "actor_inactive" };

export type CreateAgentResult =
  | { outcome: "created"; detail: AgentDetail }
  | { outcome: "slug_taken" }
  | Inactive;

export type UpdateAgentResult =
  | { outcome: "updated"; detail: AgentDetail }
  | { outcome: "not_found" }
  | Inactive;

export type InsertReleaseResult =
  | { outcome: "created" | "exists"; release: AgentRelease }
  | { outcome: "not_found" }
  | Inactive;

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
  | Inactive;

export interface AgentStore {
  list(workspaceId: string, limit: number): Promise<Agent[]>;
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
  /** The agent, version 1 and their receipt in one transaction. */
  create(input: {
    principal: Principal;
    workspaceId: string;
    slug: string;
    name: string;
    card: AgentCard;
    contentSha256: string;
    createdBy: string;
  }): Promise<CreateAgentResult>;
  /**
   * Renames and/or adds a version. A card whose hash matches an existing
   * version of the agent adds nothing.
   */
  update(input: {
    principal: Principal;
    workspaceId: string;
    agentId: string;
    name?: string;
    card?: { card: AgentCard; contentSha256: string };
    updatedBy: string;
  }): Promise<UpdateAgentResult>;
  /**
   * Inserts the release, a `release_created` event and a receipt in one
   * transaction, or returns the row already stored under that id.
   * `not_found` when the version is not the agent's.
   */
  insertRelease(input: {
    principal: Principal;
    workspaceId: string;
    release: NewAgentRelease;
  }): Promise<InsertReleaseResult>;
  /**
   * `UPDATE agents … WHERE activation_revision = expected`, the release's
   * first approval, an `activated` event and a receipt in one transaction.
   */
  activate(input: {
    principal: Principal;
    workspaceId: string;
    agentId: string;
    releaseId: string;
    expectedRevision: number;
    approvedBy: string;
  }): Promise<ActivateResult>;
}
