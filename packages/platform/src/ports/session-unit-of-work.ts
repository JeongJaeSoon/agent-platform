import type {
  CreateSessionResponse,
  ListSessionsQuery,
  SessionDetail,
  SessionSummary,
} from "@agent-platform/contracts";
import type { Principal } from "../authorization/policy.ts";

export type AcceptSessionInput = {
  principal: Principal;
  idempotencyKey: string;
  payloadHash: string;
  profileId: string;
  repository: { id: string; url: string; branch: string };
  message: string;
};

export type AcceptSessionResult =
  | { outcome: "accepted" | "replayed"; response: CreateSessionResponse }
  | { outcome: "conflict" };

// Storage rows carry profile_id; the service resolves runtime from the catalog.
export type SessionRecord = Omit<SessionSummary, "runtime"> & {
  profile_id: string | null;
};
export type SessionDetailRecord = Omit<SessionDetail, "runtime"> & {
  profile_id: string | null;
};

export interface SessionUnitOfWork {
  acceptInputAtomic(input: AcceptSessionInput): Promise<AcceptSessionResult>;
}
export type InputAcceptance = Pick<SessionUnitOfWork, "acceptInputAtomic">;

export interface SessionReader {
  listSessions(
    ownerId: string,
    query: ListSessionsQuery,
  ): Promise<{ items: SessionRecord[]; next_cursor: string | null }>;
  getSession(
    ownerId: string,
    sessionId: string,
  ): Promise<SessionDetailRecord | null>;
}
