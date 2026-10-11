import type { Principal } from "../musterrolle/policy.ts";

export type IdentityUser = {
  id: string;
  email: string;
  passwordHash: string;
  displayName: string;
  createdAt: Date;
  disabledAt: Date | null;
};

export type IdentityWorkspace = {
  id: string;
  slug: string;
  name: string;
  settings: unknown;
  createdAt: Date;
};

export type MembershipRole = "owner" | "member";

export type BootstrapInput = {
  userId: string;
  email: string;
  passwordHash: string;
  displayName: string;
  workspaceId: string;
  workspaceSlug: string;
  workspaceName: string;
  /** sha256 of the BOOTSTRAP_TOKEN presented; recorded as spent. */
  bootstrapTokenHash: Uint8Array;
  /** The recovery receipt's id, used only when an owner is recovered. */
  receiptId: string;
};

/**
 * `recovered`: no live owner remained, so the owner was added to (or
 * restored in) the existing workspace instead of creating one.
 */
export type BootstrapResult = {
  user: IdentityUser;
  workspace: IdentityWorkspace;
  recovered: boolean;
};

export type IssuePasswordResetInput = {
  id: string;
  workspaceId: string;
  userId: string;
  issuedBy: string;
  /** The issuer's hash their current password was just checked against. */
  issuerPasswordHash: string;
  tokenHash: Uint8Array;
  ttlMs: number;
  receiptId: string;
};

/**
 * `not_found`: the target is not a live member of the workspace.
 * `issuer_changed`: the issuer stopped being a live owner, or their password
 * changed, after it was checked. `owner_elsewhere`: the target owns another
 * workspace, which this workspace's owner has no say over.
 */
export type IssuePasswordResetResult =
  | { outcome: "issued"; expiresAt: Date }
  | { outcome: "not_found" }
  | { outcome: "issuer_changed" }
  | { outcome: "owner_elsewhere" };

export type ConsumePasswordResetInput = {
  tokenHash: Uint8Array;
  passwordHash: string;
  receiptId: string;
};

export type LiveMembership = {
  workspaceId: string;
  role: MembershipRole;
};

export type ResolvedWebSession = {
  sessionId: string;
  userId: string;
  email: string;
  displayName: string;
  workspaceId: string;
  role: MembershipRole;
  expiresAt: Date;
};

export interface IdentityStore {
  /** Owners whose account and membership are both enabled. */
  countLiveOwners(): Promise<number>;
  bootstrap(input: BootstrapInput): Promise<BootstrapResult>;
  /** Record a BOOTSTRAP_TOKEN as spent without using it. */
  retireBootstrapToken(tokenHash: Uint8Array): Promise<void>;
  issuePasswordReset(
    input: IssuePasswordResetInput,
  ): Promise<IssuePasswordResetResult>;
  /**
   * Null when the token is unknown, used, revoked or expired, or the user's
   * account or membership in the link's workspace is disabled.
   */
  consumePasswordReset(
    input: ConsumePasswordResetInput,
  ): Promise<{ userId: string; workspaceId: string } | null>;
  findUserForLogin(email: string): Promise<IdentityUser | null>;
  findLiveMembership(userId: string): Promise<LiveMembership | null>;
  findWorkspace(workspaceId: string): Promise<IdentityWorkspace | null>;
  /**
   * Null when the account was disabled or its password changed after
   * `verifiedPasswordHash` was checked.
   */
  createWebSession(input: {
    id: string;
    userId: string;
    verifiedPasswordHash: string;
    tokenHash: Uint8Array;
    ttlMs: number;
    userAgent: string | null;
    maxLive: number;
  }): Promise<{ expiresAt: Date } | null>;
  resolveWebSession(tokenHash: Uint8Array): Promise<ResolvedWebSession | null>;
  renewWebSession(
    sessionId: string,
    ttlMs: number,
    renewAfterMs: number,
  ): Promise<Date | null>;
  revokeWebSession(tokenHash: Uint8Array): Promise<void>;
}

export class BootstrapDoneError extends Error {
  constructor() {
    super("Bootstrap has already been completed");
    this.name = "BootstrapDoneError";
  }
}

export class BootstrapTokenSpentError extends Error {
  constructor() {
    super("This BOOTSTRAP_TOKEN has already been used");
    this.name = "BootstrapTokenSpentError";
  }
}

export type InviteRecord = {
  id: string;
  workspaceId: string;
  email: string;
  role: MembershipRole;
  invitedBy: string;
  /** Judged on the database clock when the row was read. */
  status: "pending" | "accepted" | "revoked" | "expired";
  expiresAt: Date;
  acceptedAt: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
};

export type MemberRecord = {
  userId: string;
  email: string;
  displayName: string;
  role: MembershipRole;
  /** The membership's or the account's, whichever ended first. */
  disabledAt: Date | null;
  createdAt: Date;
};

/**
 * The caller of a management write. Its person is re-checked as a live owner
 * of `workspaceId` under the write's own locks; the receipt is written under
 * its partition with its actor.
 */
export type ActingOwner = {
  principal: Principal;
  workspaceId: string;
  userId: string;
};

export type CreateInviteResult =
  | { outcome: "created"; invite: InviteRecord }
  | { outcome: "already_member" }
  | { outcome: "actor_inactive" };

export type RevokeInviteResult =
  | { outcome: "revoked" | "already_revoked" }
  | { outcome: "not_found" | "accepted" | "actor_inactive" };

export type ChangeRoleResult =
  | { outcome: "changed"; member: MemberRecord }
  | { outcome: "not_found" | "last_owner" | "actor_inactive" };

/** What redeeming a token would do, read before any password is hashed. */
export type InvitePeek =
  | {
      outcome: "pending";
      email: string;
      /** Null when no account has this email. */
      existingUser: { id: string; passwordHash: string } | null;
    }
  | { outcome: "expired" | "used" | "unknown" };

export type AcceptInviteInput = {
  tokenHash: Uint8Array;
  /**
   * The account the peek saw: its id and the hash the caller's password was
   * verified against, or the hash of the password for a new account.
   */
  account:
    | { kind: "existing"; userId: string; verifiedPasswordHash: string }
    | {
        kind: "new";
        userId: string;
        passwordHash: string;
        displayName: string;
      };
  session: {
    id: string;
    tokenHash: Uint8Array;
    ttlMs: number;
    userAgent: string | null;
    maxLive: number;
  };
  receiptId: string;
};

export type AcceptInviteResult =
  | {
      outcome: "accepted";
      userId: string;
      workspaceId: string;
      role: MembershipRole;
      sessionExpiresAt: Date;
    }
  | { outcome: "expired" | "used" }
  /** The account changed between the peek and the write; ask again. */
  | { outcome: "account_changed" };

export interface InviteStore {
  /** Revokes the address's live invite, if any, in the same transaction. */
  createInvite(input: {
    id: string;
    actor: ActingOwner;
    email: string;
    role: MembershipRole;
    tokenHash: Uint8Array;
    ttlMs: number;
    receiptId: string;
  }): Promise<CreateInviteResult>;
  listInvites(workspaceId: string, limit: number): Promise<InviteRecord[]>;
  revokeInvite(input: {
    id: string;
    actor: ActingOwner;
    receiptId: string;
  }): Promise<RevokeInviteResult>;
  peekInvite(tokenHash: Uint8Array): Promise<InvitePeek>;
  acceptInvite(input: AcceptInviteInput): Promise<AcceptInviteResult>;
  listMembers(workspaceId: string): Promise<MemberRecord[]>;
  changeMemberRole(input: {
    userId: string;
    role: MembershipRole;
    actor: ActingOwner;
    receiptId: string;
  }): Promise<ChangeRoleResult>;
}
