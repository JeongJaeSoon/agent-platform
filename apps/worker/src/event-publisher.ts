import {
  type SessionEvent,
  type WorkerEvent,
  type WorkerScope,
  workerEventSchema,
} from "@agent-platform/contracts";
import type { WorkerGatewayClient } from "@agent-platform/runtime-core";

import { isRetryable } from "./gateway-client.ts";

type Queued = { event: WorkerEvent; turnId: string | null };

export type EventPublisherOptions = {
  gateway: Pick<WorkerGatewayClient, "appendEvents">;
  /** The fence as it stands now; the turn id moves with the turn loop. */
  scope: () => WorkerScope;
  maxBatchSize?: number;
  now?: () => Date;
  retryDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
};

const DEFAULT_MAX_BATCH_SIZE = 32;
const DEFAULT_RETRY_DELAY_MS = 500;

/**
 * Turns projected frames into the attempt's durable event stream.
 *
 * `source_sequence` is per attempt, not per turn, and the gateway refuses an
 * event whose predecessor is not stored yet — so numbers are assigned when an
 * event is queued, batches go out strictly in order, and nothing is dropped
 * until the gateway has acknowledged it. Frames keep arriving while a batch is
 * in flight, which is where the batching comes from.
 */
export class EventPublisher {
  private readonly gateway: Pick<WorkerGatewayClient, "appendEvents">;
  private readonly scope: () => WorkerScope;
  private readonly maxBatchSize: number;
  private readonly now: () => Date;
  private readonly retryDelayMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly queue: Queued[] = [];
  private acceptedThroughValue = 0;
  private draining: Promise<void> | undefined;
  private failure: unknown;
  private nextSequence = 1;

  constructor(options: EventPublisherOptions) {
    this.gateway = options.gateway;
    this.scope = options.scope;
    this.maxBatchSize = options.maxBatchSize ?? DEFAULT_MAX_BATCH_SIZE;
    this.now = options.now ?? (() => new Date());
    this.retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
    this.sleep = options.sleep ?? ((ms: number) => Bun.sleep(ms));
  }

  /** The highest contiguous sequence the gateway says it has stored. */
  get acceptedThrough(): number {
    return this.acceptedThroughValue;
  }

  /** Sequence numbers handed out so far, acknowledged or not. */
  get published(): number {
    return this.nextSequence - 1;
  }

  publish(events: SessionEvent[], turnId: string | null): void {
    if (this.failure !== undefined) return;
    const occurredAt = this.now().toISOString();
    for (const event of events) {
      // The projection's own `id` is a per-frame cursor, not this stream's;
      // the gateway assigns the public cursor when it stores the event.
      const { id: _cursor, ...payload } = event;
      this.queue.push({
        event: workerEventSchema.parse({
          ...payload,
          occurred_at: occurredAt,
          source_sequence: this.nextSequence,
        }),
        turnId,
      });
      this.nextSequence += 1;
    }
    this.kick();
  }

  /** Drops the undelivered tail: used when this attempt stops owning the session. */
  abandon(reason: string): void {
    this.failure ??= new Error(`Events were abandoned: ${reason}`);
    this.queue.length = 0;
  }

  /** Resolves once everything queued is durable, or rejects with what stopped it. */
  async idle(): Promise<void> {
    while (this.queue.length > 0 || this.draining !== undefined) {
      if (this.failure !== undefined) throw this.failure;
      await this.draining;
      if (this.draining === undefined && this.queue.length > 0) this.kick();
    }
    if (this.failure !== undefined) throw this.failure;
  }

  private kick(): void {
    if (this.draining !== undefined || this.failure !== undefined) return;
    this.draining = this.drain().finally(() => {
      this.draining = undefined;
    });
  }

  private async drain(): Promise<void> {
    while (this.queue.length > 0) {
      const batch = this.leadingBatch();
      try {
        const response = await this.gateway.appendEvents({
          ...this.scope(),
          turn_id: batch[0]?.turnId ?? null,
          batch_key: this.batchKey(batch),
          events: batch.map((entry) => entry.event),
        });
        this.acceptedThroughValue = response.accepted_through;
        this.queue.splice(0, batch.length);
      } catch (error) {
        if (!isRetryable(error)) {
          this.failure = error;
          return;
        }
        // The same batch_key and the same sequences: a replay of what already
        // landed is a no-op, so resending is always the safe move.
        await this.sleep(this.retryDelayMs);
      }
    }
  }

  /** The longest run of queued events that share one turn, capped by batch size. */
  private leadingBatch(): Queued[] {
    const head = this.queue[0];
    if (head === undefined) return [];
    const batch: Queued[] = [];
    for (const entry of this.queue) {
      if (entry.turnId !== head.turnId) break;
      if (batch.length >= this.maxBatchSize) break;
      batch.push(entry);
    }
    return batch;
  }

  private batchKey(batch: Queued[]): string {
    const first = batch[0]?.event.source_sequence ?? 0;
    const last = batch.at(-1)?.event.source_sequence ?? 0;
    return `${this.scope().attempt_id}:${first}-${last}`;
  }
}
