import type {
  AgentInput,
  AgentRun,
  AnswerResult,
  ApprovalAnswer,
  CheckpointLeaseGrant,
  CheckpointPreparation,
  NegotiatedCapabilities,
  ParkReadiness,
  RejectedCheckpoint,
  RuntimeEvent,
} from "@werft-ai/runtime-core";

const capabilities: NegotiatedCapabilities = {
  effective: {
    interrupt: true,
    checkpoint: false,
    approvalCheckpoint: false,
    resume: false,
    mcp: "none",
    skills: "none",
    permissionModes: {
      default: "native",
      acceptEdits: "none",
      dontAsk: "none",
      plan: "none",
      bypassPermissions: "none",
      auto: "none",
    },
  },
  effectiveExtraFeatures: {},
};

const noCheckpoint: RejectedCheckpoint = {
  status: "rejected",
  reason: "turn_in_flight",
  detail: "This run takes no checkpoints",
};

/**
 * An `AgentRun` written against the contract alone, with no engine driver
 * behind it: the test pushes the events and decides what each call does.
 */
export class ScriptedRun implements AgentRun {
  readonly inputs: AgentInput[] = [];
  readonly answers: ApprovalAnswer[] = [];
  onSend: (input: AgentInput) => void = () => {};
  onAnswer: (answer: ApprovalAnswer) => void = () => {};
  closing: () => Promise<void> = () => Promise.resolve();
  private readonly queue: RuntimeEvent[] = [];
  private wake: (() => void) | undefined;
  private ended = false;

  push(...events: RuntimeEvent[]): void {
    this.queue.push(...events);
    this.wake?.();
  }

  ready(): Promise<NegotiatedCapabilities> {
    return Promise.resolve(capabilities);
  }

  async *events(): AsyncIterable<RuntimeEvent> {
    for (;;) {
      const next = this.queue.shift();
      if (next !== undefined) {
        yield next;
        continue;
      }
      if (this.ended) return;
      await new Promise<void>((resolve) => {
        this.wake = resolve;
      });
    }
  }

  send(input: AgentInput): void {
    this.inputs.push(input);
    this.onSend(input);
  }

  finishInput(): void {}

  holdsInput(uuid: string): Promise<boolean> {
    return Promise.resolve(this.inputs.some((input) => input.uuid === uuid));
  }

  answer(answer: ApprovalAnswer): Promise<AnswerResult> {
    this.answers.push(answer);
    this.onAnswer(answer);
    return Promise.resolve("applied");
  }

  interrupt(): Promise<{ stillQueued: string[] }> {
    return Promise.resolve({ stillQueued: [] });
  }

  parkable(): ParkReadiness {
    return { ok: false, reason: "not_supported" };
  }

  prepareCheckpoint(): Promise<CheckpointPreparation> {
    return Promise.resolve(noCheckpoint);
  }

  leaseCheckpoint(): Promise<CheckpointLeaseGrant> {
    return Promise.resolve({ lease: null, preparation: noCheckpoint });
  }

  abort(): void {
    this.end();
  }

  /** The stream ends at once; the returned promise is whatever `closing` gives. */
  close(): Promise<void> {
    this.end();
    return this.closing();
  }

  private end(): void {
    this.ended = true;
    this.wake?.();
  }
}
