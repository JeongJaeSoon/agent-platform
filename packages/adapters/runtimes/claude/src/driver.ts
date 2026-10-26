import type { SessionEvent } from "@werft-ai/contracts";
import type {
  AgentInput,
  CheckpointLeaseGrant,
  CheckpointPreparation,
  NativeSdkMessage,
} from "@werft-ai/runtime-core";

export type NativeEnvelope = {
  correlation_id: string;
  message: NativeSdkMessage;
  schema_version: "sdk-envelope/v1";
  sdk_version: string;
};

export type AgentFrame = {
  envelope: NativeEnvelope;
  events: SessionEvent[];
  /**
   * The input uuids the driver says this frame is for, read only when its
   * native message names none, as a scripted engine's messages do.
   */
  inputs?: readonly string[];
};

export type PermissionRequest = {
  input: Record<string, unknown>;
  requestId: string;
  signal: AbortSignal;
  tool: string;
  toolUseId: string;
};

export type PermissionDecision =
  | { behavior: "allow"; updatedInput?: Record<string, unknown> }
  | { behavior: "deny"; message: string; interrupt?: boolean };

export type RuntimeHooks = {
  onPermission(request: PermissionRequest): Promise<PermissionDecision>;
};

export type DriverMode =
  | { mode: "new"; resume?: undefined }
  | { mode: "resume"; resume: string };

export type DriverConfig = DriverMode & {
  correlationId: string;
  cwd: string;
  home: string;
  /**
   * The most this run may spend, in USD, as the engine estimates it. It
   * counts from zero for every run, resumed ones included.
   */
  maxBudgetUsd?: number;
  maxTurns?: number;
  model: string;
  tools: string[];
};

/**
 * One engine execution as a driver runs it: frames, and permission requests
 * through `RuntimeHooks`. Iterating `events()` a second time throws.
 */
export interface DriverRun extends AsyncIterable<AgentFrame> {
  abort(): void;
  close(): void;
  events(): AsyncIterable<AgentFrame>;
  finishInput(): void;
  holdsInput(uuid: string): Promise<boolean>;
  ready(): Promise<void>;
  interrupt(): Promise<{ stillQueued: string[] }>;
  leaseCheckpoint(): Promise<CheckpointLeaseGrant>;
  prepareCheckpoint(): Promise<CheckpointPreparation>;
  send(input: AgentInput): void;
}
