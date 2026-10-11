<<<<<<< HEAD
import type { SessionScope, WorkspaceRole } from "@agent-platform/contracts";
=======
import type { SessionScope } from "@agent-platform/contracts";
>>>>>>> origin/feature/musterrolle
import type { Principal } from "../musterrolle/policy.ts";

export type WorkspaceKey = {
  id: string;
  workspaceId: string;
  kind: "personal" | "service";
  /** A service key that reaches this agent's sessions and nothing else. */
  agentId: string | null;
  /** Who issued it; null on keys from before the API issued them. */
  createdByUserId: string | null;
  scopes: SessionScope[];
  createdAt: Date;
  expiresAt: Date | null;
  revokedAt: Date | null;
};

export type IssueKeyInput = {
  principal: Principal;
  id: string;
  workspaceId: string;
  keyHash: Uint8Array;
  kind: WorkspaceKey["kind"];
  agentId: string | null;
  createdByUserId: string;
  scopes: readonly SessionScope[];
  expiresAt: Date | null;
  receiptId: string;
<<<<<<< HEAD
  /**
   * The roles that may issue this key, re-read under the issuer's
   * membership lock along with the scope ceiling of the role they hold
   * then; a key bound to an agent may also come from its admins.
   */
  issuerRoles: readonly WorkspaceRole[];
=======
>>>>>>> origin/feature/musterrolle
};

export type IssueKeyResult =
  | { outcome: "issued"; key: WorkspaceKey }
<<<<<<< HEAD
  | {
      outcome:
        | "actor_inactive"
        | "agent_not_found"
        | "outranked"
        | "scope_not_grantable";
    };

export type RevokeKeyResult =
  | { outcome: "revoked" | "already_revoked"; key: WorkspaceKey }
  | { outcome: "not_found" | "actor_inactive" | "outranked" };

/**
 * Which keys a list shows: the caller's own personal keys, plus every
 * service key while their current role is one of `allServiceKeysFor`, or
 * else the service keys of the agents they administer.
 */
export type KeyListFilter = {
  personalOf: string;
  allServiceKeysFor: readonly WorkspaceRole[];
=======
  | { outcome: "actor_inactive" | "agent_not_found" };

export type RevokeKeyResult =
  | { outcome: "revoked" | "already_revoked"; key: WorkspaceKey }
  | { outcome: "not_found" | "actor_inactive" };

/**
 * Which keys a list shows: the caller's own personal keys, plus every
 * service key, the service keys of the agents they administer, or none.
 */
export type KeyListFilter = {
  personalOf: string;
  service: "all" | "administered" | "none";
>>>>>>> origin/feature/musterrolle
};

export interface WorkspaceKeyStore {
  issue(input: IssueKeyInput): Promise<IssueKeyResult>;
  find(workspaceId: string, keyId: string): Promise<WorkspaceKey | null>;
  list(
    workspaceId: string,
    filter: KeyListFilter,
    limit: number,
  ): Promise<WorkspaceKey[]>;
  revoke(input: {
    principal: Principal;
    workspaceId: string;
    keyId: string;
    receiptId: string;
<<<<<<< HEAD
    /**
     * The roles that may revoke this key, re-read as on issue; a key bound
     * to an agent may also go by its admins.
     */
    revokerRoles: readonly WorkspaceRole[];
=======
>>>>>>> origin/feature/musterrolle
  }): Promise<RevokeKeyResult>;
}
