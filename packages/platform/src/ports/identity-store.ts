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
  tokenHash: Uint8Array;
  ttlMs: number;
};

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
  /** Null when the user is not a live member of the workspace. */
  issuePasswordReset(
    input: IssuePasswordResetInput,
  ): Promise<{ expiresAt: Date } | null>;
  /** Null when the token is unknown, used, revoked or expired. */
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
