import type {
  AdmissionState,
  CheckpointBlockReason,
  CreateSessionResponse,
  ListSessionsQuery,
  ListTurnsQuery,
  PostSessionMessageResponse,
  Receipt,
  SessionDetail,
  SessionSummary,
  SseEvent,
  TurnDetail,
  TurnSummary,
} from "@agent-platform/contracts";
import type { Principal } from "../authorization/policy.ts";

// Checked inside the acceptance transaction, after an idempotent replay has
// been answered: a replay is never refused for a limit (94S-131).
export type InputLimits = {
  queuedInputLimitPerSession: number;
  storageLimitBytes: number;
};

// Why an input was not queued although nothing else was wrong with it.
// queue_full: the session already holds its limit of queued turns.
// storage_exhausted: the message would take retained content past the
// installation's limit.
export type InputLimitRefusal = { outcome: "queue_full" | "storage_exhausted" };

export type AcceptSessionInput = {
  principal: Principal;
  idempotencyKey: string;
  payloadHash: string;
  profileId: string;
  // null when the catalog no longer lists the profile/repository: a replay
  // of an earlier acceptance must still succeed, a new request must not.
  repository: { id: string; url: string; branch: string } | null;
  message: string;
  limits: InputLimits;
};

export type AcceptSessionResult =
  | { outcome: "accepted" | "replayed"; response: CreateSessionResponse }
  | { outcome: "conflict" | "unsupported" }
  | InputLimitRefusal;

export type AppendMessageInput = {
  principal: Principal;
  sessionId: string;
  idempotencyKey: string;
  payloadHash: string;
  message: string;
  limits: InputLimits;
};

export type AppendMessageResult =
  | { outcome: "accepted" | "replayed"; response: PostSessionMessageResponse }
  | { outcome: "conflict" | "not_found" }
  // The session exists but its admission state does not take new input.
  | { outcome: "rejected"; admissionState: Exclude<AdmissionState, "active"> }
  // The session cannot be checkpointed (blocking pending reason): a turn run
  // now could never be reported as durably finished, so none is accepted.
  | { outcome: "checkpoint_unavailable"; reason: CheckpointBlockReason }
  | InputLimitRefusal;

// Storage rows carry profile_id; the service resolves runtime from the catalog.
export type SessionRecord = Omit<SessionSummary, "runtime"> & {
  profile_id: string | null;
};
export type SessionDetailRecord = Omit<SessionDetail, "runtime"> & {
  profile_id: string | null;
  // What the session has spent; the service turns it into `attention`
  // against the current limit, so a changed limit applies at once.
  cost_usd: number;
};

export interface SessionUnitOfWork {
  acceptInputAtomic(input: AcceptSessionInput): Promise<AcceptSessionResult>;
  appendInputAtomic(input: AppendMessageInput): Promise<AppendMessageResult>;
}
export type InputAcceptance = Pick<
  SessionUnitOfWork,
  "acceptInputAtomic" | "appendInputAtomic"
>;

export interface SessionReader {
  listSessions(
    ownerId: string,
    query: ListSessionsQuery,
  ): Promise<{ items: SessionRecord[]; next_cursor: string | null }>;
  getSession(
    ownerId: string,
    sessionId: string,
  ): Promise<SessionDetailRecord | null>;
  // null when the session is not visible to the owner.
  listTurns(
    ownerId: string,
    sessionId: string,
    query: ListTurnsQuery,
  ): Promise<{ items: TurnSummary[]; next_cursor: string | null } | null>;
  // null when the session or the turn is not visible to the owner.
  getTurn(
    ownerId: string,
    sessionId: string,
    turnId: string,
  ): Promise<TurnDetail | null>;
  // null when the receipt does not exist or belongs to another owner.
  getReceipt(ownerId: string, receiptId: string): Promise<Receipt | null>;
  // Events after the cursor in session order: at most `limit` rows and,
  // past the first row, at most `maxBytes` of payload, so one page never
  // holds more memory than that whatever the history looks like. `more` is
  // false only when the page reached the high-watermark; a page cut short by
  // either bound says true so the caller keeps replaying instead of waiting.
  // null when the session is not visible to the owner.
  readEvents(
    ownerId: string,
    sessionId: string,
    query: ReadEventsQuery,
  ): Promise<EventPage | null>;
}

export type ReadEventsQuery = {
  after?: string;
  limit: number;
  maxBytes: number;
};

export type EventPage = {
  items: SseEvent[];
  more: boolean;
};
