import type {
  OpaqueCursor,
  PostSessionAnswerRequest,
  SessionEvent,
  SessionMessage,
} from "@agent-platform/contracts";

export type QueuePayload = SessionMessage | PostSessionAnswerRequest;

export type EnqueueInput = {
  sessionId: string;
  turnId?: number;
  payload: QueuePayload;
};

export type QueueDelivery = {
  id: number;
  sessionId: string;
  turnId: number | null;
  payload: QueuePayload;
  ack(): Promise<void>;
  release(): Promise<void>;
};

export type PublishInput = {
  sessionId: string;
  event: SessionEvent["event"];
  data: unknown;
};

export type SubscribeInput = {
  sessionId: string;
  after?: OpaqueCursor;
  signal?: AbortSignal;
  pollIntervalMs?: number;
};

export type LeaseCommand =
  | { action: "heartbeat"; podId: string; now?: Date }
  | { action: "expired"; ttlMs: number; now?: Date }
  | { action: "release"; podId: string };

export type LeaseResult =
  | { action: "heartbeat"; podId: string }
  | { action: "expired"; podIds: string[] }
  | { action: "release"; released: boolean };

export interface QueueBackend {
  enqueue(input: EnqueueInput): Promise<number>;
  consume(
    sessionId: string,
    consumerId: string,
    visibilityTimeoutMs?: number,
  ): Promise<QueueDelivery | null>;
  publish(input: PublishInput): Promise<SessionEvent>;
  subscribe(input: SubscribeInput): AsyncIterable<SessionEvent>;
  lease(command: LeaseCommand): Promise<LeaseResult>;
}

export { enqueueWithin } from "@agent-platform/db";
export { PostgresQueue } from "./postgres.ts";
export { RedisQueueStub } from "./redis.ts";
