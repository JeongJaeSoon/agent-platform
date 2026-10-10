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
  countUsers(): Promise<number>;
  bootstrap(input: BootstrapInput): Promise<{
    user: IdentityUser;
    workspace: IdentityWorkspace;
  }>;
  findUserForLogin(email: string): Promise<IdentityUser | null>;
  findLiveMembership(userId: string): Promise<LiveMembership | null>;
  findWorkspace(workspaceId: string): Promise<IdentityWorkspace | null>;
  createWebSession(input: {
    id: string;
    userId: string;
    tokenHash: Uint8Array;
    ttlMs: number;
    userAgent: string | null;
    maxLive: number;
  }): Promise<{ expiresAt: Date }>;
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
