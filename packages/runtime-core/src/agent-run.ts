import type { SessionEvent } from "@agent-platform/contracts";

import type { AgentInput } from "./agent-runtime.ts";
import type { CheckpointPreparation } from "./checkpoint.ts";

export type NativeSdkMessage = {
  [key: string]: unknown;
  type: string;
};

export type NativeEnvelope = {
  correlation_id: string;
  message: NativeSdkMessage;
  schema_version: "sdk-envelope/v1";
  sdk_version: string;
};

export type AgentFrame = {
  envelope: NativeEnvelope;
  events: SessionEvent[];
};

/**
 * Handle for one engine execution. It may serve several turns; it is not the
 * durable Turn row the platform stores. Frames are a single-consumer stream:
 * iterating `events()` (or the run itself) a second time throws, so the host
 * fans out to observers instead of subscribing twice.
 */
export interface AgentRun extends AsyncIterable<AgentFrame> {
  abort(): void;
  close(): void;
  events(): AsyncIterable<AgentFrame>;
  finishInput(): void;
  interrupt(): Promise<{ stillQueued: string[] }>;
  prepareCheckpoint(): Promise<CheckpointPreparation>;
  send(input: AgentInput): void;
}
