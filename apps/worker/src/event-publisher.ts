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
  /**
   * Told the moment a write is refused for good, so the host stops the engine
   * then instead of at the end of the turn — an owner-loss refusal especially.
   */
  onFailed?: (error: unknown) => void;
  maxBatchSize?: number;
  now?: () => Date;
  retryDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
};

const DEFAULT_MAX_BATCH_SIZE = 32;
const DEFAULT_RETRY_DELAY_MS = 500;
// Far more calls than one turn waits on at once.
const TOOL_USES_REMEMBERED = 1_000;

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
  private readonly onFailed: (error: unknown) => void;
  private readonly maxBatchSize: number;
  private readonly now: () => Date;
  private readonly retryDelayMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly queue: Queued[] = [];
  private acceptedThroughValue = 0;
  private draining: Promise<void> | undefined;
  private failure: unknown;
  private nextSequence = 1;
  /** Set while a turn boundary is being committed: nothing past it is sent. */
  private heldAfter: number | undefined;
  // The sequence each recent tool call was numbered under, newest last,
  // and the callbacks waiting for one to be numbered or stored.
  private readonly toolUseSequences = new Map<string, number>();
  private waiters: (() => void)[] = [];

  constructor(options: EventPublisherOptions) {
    this.gateway = options.gateway;
    this.scope = options.scope;
    this.onFailed = options.onFailed ?? (() => {});
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
      const toolUseId = toolUseIdOf(event);
      if (toolUseId !== null) {
        this.toolUseSequences.delete(toolUseId);
        this.toolUseSequences.set(toolUseId, this.nextSequence - 1);
        // Calls nobody asked about are forgotten oldest first.
        if (this.toolUseSequences.size > TOOL_USES_REMEMBERED) {
          const [oldest] = this.toolUseSequences.keys();
          if (oldest !== undefined) this.toolUseSequences.delete(oldest);
        }
      }
    }
    this.wake();
    this.kick();
  }

  /**
   * Resolves once the tool call with this id is stored, or rejects once
   * `waitMs` has passed without it, or the stream has failed. The engine can
   * ask to use a tool before the frame carrying the call reaches `publish`,
   * and whatever is written about the request must follow the call in the
   * stream. Each numbered call answers one wait, so an id the engine uses
   * again waits for its own frame.
   */
  async toolUseStored(toolUseId: string, waitMs: number): Promise<void> {
    // A stream that already failed stores nothing more, whatever came first.
    if (this.failure !== undefined) throw this.failure;
    const deadline = performance.now() + waitMs;
    let sequence = this.toolUseSequences.get(toolUseId);
    while (sequence === undefined) {
      if (this.failure !== undefined) throw this.failure;
      if (!(await this.progress(deadline))) {
        throw new Error(
          `The tool call ${toolUseId} did not reach the event stream within ${waitMs}ms`,
        );
      }
      sequence = this.toolUseSequences.get(toolUseId);
    }
    this.toolUseSequences.delete(toolUseId);
    while (this.acceptedThroughValue < sequence) {
      if (this.failure !== undefined) throw this.failure;
      if (!(await this.progress(deadline))) {
        throw new Error(
          `The tool call ${toolUseId} was not stored within ${waitMs}ms`,
        );
      }
    }
  }

  // Waits for the next publish, acknowledgement or failure; false once the
  // deadline passes first.
  private progress(deadline: number): Promise<boolean> {
    const left = deadline - performance.now();
    if (left <= 0) return Promise.resolve(false);
    return new Promise<boolean>((resolve) => {
      const wake = () => {
        clearTimeout(timer);
        resolve(true);
      };
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((waiter) => waiter !== wake);
        resolve(false);
      }, left);
      this.waiters.push(wake);
    });
  }

  private wake(): void {
    for (const wake of this.waiters.splice(0)) wake();
  }

  /** Drops the undelivered tail: used when this attempt stops owning the session. */
  abandon(reason: string): void {
    this.failure ??= new Error(`Events were abandoned: ${reason}`);
    this.queue.length = 0;
    this.wake();
  }

  /**
   * Freezes the stream at what has been numbered so far and returns that
   * number. A finalize has to name the exact end of the durable stream, and
   * the engine keeps emitting after its result, so anything published from
   * here on waits in the queue until `release`.
   */
  hold(): number {
    this.heldAfter ??= this.published;
    return this.heldAfter;
  }

  release(): void {
    if (this.heldAfter === undefined) return;
    this.heldAfter = undefined;
    this.kick();
  }

  /**
   * Resolves once everything that may be sent is durable — everything, or up
   * to the hold — or rejects with what stopped it.
   */
  async idle(): Promise<void> {
    while (this.sendable() || this.draining !== undefined) {
      if (this.failure !== undefined) throw this.failure;
      await this.draining;
      if (this.draining === undefined && this.sendable()) this.kick();
    }
    if (this.failure !== undefined) throw this.failure;
  }

  private sendable(): boolean {
    const head = this.queue[0];
    if (head === undefined) return false;
    return (
      this.heldAfter === undefined ||
      head.event.source_sequence <= this.heldAfter
    );
  }

  private kick(): void {
    if (this.draining !== undefined || this.failure !== undefined) return;
    this.draining = this.drain().finally(() => {
      this.draining = undefined;
    });
  }

  private async drain(): Promise<void> {
    while (this.sendable()) {
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
        this.wake();
      } catch (error) {
        if (!isRetryable(error)) {
          this.failure = error;
          this.onFailed(error);
          this.wake();
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
      if (
        this.heldAfter !== undefined &&
        entry.event.source_sequence > this.heldAfter
      ) {
        break;
      }
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

// The id of the tool call a projected `tool_use` event carries: the mapper
// puts one content block in each.
function toolUseIdOf(event: SessionEvent): string | null {
  if (event.event !== "tool_use") return null;
  const content = (event.data.message as { content?: unknown }).content;
  const block = Array.isArray(content) ? content[0] : undefined;
  const id = (block as { id?: unknown } | undefined)?.id;
  return typeof id === "string" ? id : null;
}
