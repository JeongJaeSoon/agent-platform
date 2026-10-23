import type { SecretPurpose, WorkspaceRole } from "@werft-ai/contracts";
import type { Principal } from "../musterrolle/policy.ts";

/**
 * Who a secret belongs to: the workspace itself (the App Configuration
 * Token) or one Slack app of it (that app's signing secret, client secret
 * and bot token).
 */
export type SecretOwner =
  | { kind: "workspace" }
  | { kind: "slack_app"; id: string };

export type SecretSlot = {
  workspaceId: string;
  owner: SecretOwner;
  purpose: SecretPurpose;
};

/** The owner as stored and bound into the ciphertext's AAD. */
export function secretOwnerRef(owner: SecretOwner): string {
  return owner.kind === "workspace"
    ? "workspace"
    : `slack_app:${owner.id.toLowerCase()}`;
}

/** Everything about a stored secret except its value. */
export type SecretSummary = {
  last4: string;
  secretVersion: number;
  updatedAt: Date;
  /** The console user who last set it; null for a value the server wrote. */
  updatedBy: { userId: string; displayName: string } | null;
};

/**
 * A write made by a person through the API: their role is re-read under
 * lock against `roles`, and a receipt naming the purpose and last four
 * characters is written in the same transaction.
 */
export type SecretAudit = {
  principal: Principal;
  receiptId: string;
  roles: readonly WorkspaceRole[];
};

export type PutSecretResult =
  | { outcome: "stored"; summary: SecretSummary }
  | { outcome: "actor_inactive" | "outranked" | "workspace_not_found" };

export type DeleteSecretResult =
  | { outcome: "deleted"; last4: string }
  | { outcome: "not_found" | "actor_inactive" | "outranked" };

/**
 * Encrypted runtime secrets (AES-256-GCM under the master key). Values go in
 * and, for server code only, come out; nothing here hands a value to a
 * route. One value per slot: a put replaces it under a new version.
 */
export interface SecretStore {
  describe(slot: SecretSlot): Promise<SecretSummary | null>;
  /** The value, for the server's own Slack calls; null when none is set. */
  get(slot: SecretSlot): Promise<string | null>;
  put(
    slot: SecretSlot,
    value: string,
    options?: { audit?: SecretAudit },
  ): Promise<PutSecretResult>;
  /**
   * Replaces the value with what `next` makes of the current one, holding
   * the row locked meanwhile so two rotations never both use one refresh
   * token. Null when no value is set.
   */
  rotate(
    slot: SecretSlot,
    next: (current: string) => Promise<string>,
  ): Promise<SecretSummary | null>;
  delete(
    slot: SecretSlot,
    options?: { audit?: SecretAudit },
  ): Promise<DeleteSecretResult>;
}
