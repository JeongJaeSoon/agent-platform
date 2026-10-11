import type {
  AuthorizationDecision,
  AuthorizationRequest,
} from "@agent-platform/contracts";

/** Where authorize() writes the decisions D8 says to keep. */
export interface DecisionLog {
  record(entry: {
    request: AuthorizationRequest;
    decision: AuthorizationDecision;
  }): Promise<void>;
}

export interface AuditRetentionStore {
  /** False when the workspace does not exist. */
  setAuditRetentionDays(workspaceId: string, days: number): Promise<boolean>;
}
