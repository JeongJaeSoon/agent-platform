import type { SessionStatus } from "@agent-platform/contracts";
import type { Principal } from "../musterrolle/policy.ts";

export type OffboardResult =
  | {
      outcome: "offboarded";
      revokedWebSessions: number;
      revokedPersonalKeys: number;
      sessionsAwaitingTakeover: number;
    }
  // No live membership of that user in this workspace.
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
  // The session is not waiting for one: never was, or someone took it first.
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
  /** The new requester is `principal.actor.userId`; the receipt names them. */
  takeOver(input: {
    principal: Principal;
    workspaceId: string;
    sessionId: string;
    newRequesterId: string;
  }): Promise<TakeOverResult>;
}
