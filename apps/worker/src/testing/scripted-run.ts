import type {
  AdmissionHold,
  AgentInput,
  AgentRun,
  AnswerResult,
  ApprovalAnswer,
  CheckpointLeaseGrant,
  CheckpointPoint,
  CheckpointPreparation,
  NegotiatedCapabilities,
  ParkReadiness,
  RejectedCheckpoint,
  RuntimeEvent,
} from "@werft-ai/runtime-core";

const noCheckpoints: NegotiatedCapabilities = {
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
  capabilities: NegotiatedCapabilities = noCheckpoints;
  leases = 0;
  /** What an `approval_wait` lease is granted with; refused while unset. */
  approvalWait: CheckpointPreparation | undefined;
  /** Leases granted for `approval_wait` and not yet released. */
  heldApprovalLeases = 0;
  /** The guard `holdAdmission` installed, until released. */
  admissionGuard: ((toolCallId: string) => Promise<void>) | undefined;
  onSend: (input: AgentInput) => void = () => {};
  onAnswer: (answer: ApprovalAnswer) => void = () => {};
  /** What `answer` says it did with each answer. */
  answerResult: AnswerResult = "applied";
  closing: () => Promise<void> = () => Promise.resolve();
  private readonly queue: RuntimeEvent[] = [];
  private wake: (() => void) | undefined;
  private ended = false;

  push(...events: RuntimeEvent[]): void {
    this.queue.push(...events);
    this.wake?.();
  }

  ready(): Promise<NegotiatedCapabilities> {
    return Promise.resolve(this.capabilities);
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
    return Promise.resolve(this.answerResult);
  }

  interrupt(): Promise<{ stillQueued: string[] }> {
    return Promise.resolve({ stillQueued: [] });
  }

  parkable(): ParkReadiness {
    return { ok: false, reason: "not_supported" };
  }

  holdAdmission(guard: (toolCallId: string) => Promise<void>): AdmissionHold {
    this.admissionGuard = guard;
    return {
      release: () => {
        if (this.admissionGuard === guard) this.admissionGuard = undefined;
      },
    };
  }

  /** What the engine's gate would do with a new call: true when admitted. */
  async admit(toolCallId: string): Promise<boolean> {
    const guard = this.admissionGuard;
    if (guard === undefined) return true;
    try {
      await guard(toolCallId);
      return true;
    } catch {
      return false;
    }
  }

  prepareCheckpoint(point?: CheckpointPoint): Promise<CheckpointPreparation> {
    if (point === "approval_wait" && this.approvalWait !== undefined) {
      return Promise.resolve(this.approvalWait);
    }
    return Promise.resolve(noCheckpoint);
  }

  leaseCheckpoint(point?: CheckpointPoint): Promise<CheckpointLeaseGrant> {
    this.leases += 1;
    const preparation = this.approvalWait;
    if (point === "approval_wait" && preparation?.status === "ready") {
      this.heldApprovalLeases += 1;
      let held = true;
      return Promise.resolve({
        preparation,
        lease: {
          release: () => {
            if (!held) return;
            held = false;
            this.heldApprovalLeases -= 1;
          },
        },
      });
    }
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
