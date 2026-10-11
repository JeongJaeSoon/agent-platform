import type { SessionStatus } from "@agent-platform/contracts";
import type { Principal } from "../musterrolle/policy.ts";

export type OffboardResult =
  | {
      outcome: "offboarded";
      revokedWebSessions: number;
      revokedPersonalKeys: number;
      sessionsAwaitingTakeover: number;
    }
  | { outcome: "not_found" };

export type TakeoverRecord = {
  sessionId: string;
  departedUserId: string;
  status: SessionStatus;
  createdAt: Date;
  takeoverRequiredAt: Date;
};

export type TakeOverResult =
  | { outcome: "taken_over"; receiptId: string }
  | { outcome: "not_found" }
  | { outcome: "not_awaiting" };

export interface MemberStore {
  /**
   * In one transaction: the membership disabled, every web session of the
   * user revoked, their personal keys in the workspace revoked, and every
   * open session they asked for marked as awaiting takeover.
   */
  offboard(input: {
    workspaceId: string;
    userId: string;
  }): Promise<OffboardResult>;
  listAwaitingTakeover(
    workspaceId: string,
    limit: number,
  ): Promise<TakeoverRecord[]>;
  takeOver(input: {
    principal: Principal;
    workspaceId: string;
    sessionId: string;
    newRequesterId: string;
  }): Promise<TakeOverResult>;
}
