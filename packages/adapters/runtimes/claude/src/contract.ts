import {
  CLAUDE_DESCRIPTOR,
  type ClaudeOptions,
} from "@werft-ai/runtime-claude-codec";
import {
  type AgentFrame,
  type AgentInput,
  type AgentRun,
  type AgentRuntime,
  type AnswerResult,
  type ApprovalAnswer,
  ApprovalChannel,
  type CheckpointLeaseGrant,
  type CheckpointPreparation,
  type NegotiatedCapabilities,
  negotiatedFromDescriptor,
  type PermissionDecision,
  type PermissionRequest,
  type RuntimeDescriptor,
  type RuntimeEvent,
  type RuntimeStart,
  type TranscriptMirror,
} from "@werft-ai/runtime-core";

import type {
  ClaudeNativeRun,
  ClaudeRuntimeConfig,
  NativeApprovalGate,
} from "./config.ts";
import { ClaudeEventMapper } from "./mapper.ts";
import type { RuntimePolicy } from "./profile.ts";
import { remoteMcpRelay } from "./remote-mcp.ts";
import { ClaudeSdkRuntime, type RuntimeProcessObserver } from "./runtime.ts";

/** The tool the engine uses to put a question to the person. */
const QUESTION_TOOL = "AskUserQuestion";

/**
 * What the composition root binds per image and per claim, outside the
 * contract: where the engine keeps its config, and the session's transcript
 * store, whose shape is the Claude SDK's.
 */
export type ClaudeDeployment = {
  claudeConfigDir: string;
  localTranscriptResume?: true;
  providerMaxRetries?: number;
  sessionStore?: TranscriptMirror;
  settingSources?: [] | ["project"];
  trustedCaBundle?: string;
};

export class ClaudeAgentRuntime implements AgentRuntime<ClaudeOptions> {
  readonly descriptor: RuntimeDescriptor = CLAUDE_DESCRIPTOR;

  constructor(
    private readonly policy: RuntimePolicy,
    private readonly deployment: ClaudeDeployment,
    private readonly processObserver?: RuntimeProcessObserver,
  ) {}

  start(start: RuntimeStart<ClaudeOptions>): AgentRun {
    const config = claudeRuntimeConfig(start, this.deployment);
    const driver = new ClaudeSdkRuntime(this.policy, this.processObserver);
    return claudeContractRun(start.config.correlationId, (gate) =>
      driver.start(config, gate),
    );
  }
}

/**
 * The driver's config for a contract start. Shared with the checkpoint
 * fingerprint, so a run and its fingerprint cannot describe different runs.
 */
export function claudeRuntimeConfig(
  start: RuntimeStart<ClaudeOptions>,
  deployment: ClaudeDeployment,
): ClaudeRuntimeConfig {
  const { bindings, bundle, config } = start;
  if (bundle.skills.length > 0) {
    throw new Error("This runtime does not load skills yet");
  }
  if (start.env.vars.length > 0) {
    throw new Error("This runtime takes no engine environment yet");
  }
  const platform = bundle.instructions.filter(
    (part) => part.scope === "platform" && part.text !== null,
  );
  const repository = bundle.instructions.find(
    (part) => part.scope === "repository",
  );
  const { maxBudgetUsd, maxTurns, permissionMode, ...run } = config;
  return {
    ...run,
    ...(maxBudgetUsd === undefined ? {} : { maxBudgetUsd }),
    ...(maxTurns === undefined ? {} : { maxTurns }),
    ...(platform.length === 0
      ? {}
      : {
          appendSystemPrompt: platform.map((part) => part.text).join("\n\n"),
        }),
    claudeConfigDir: deployment.claudeConfigDir,
    ...(bundle.mcpServers.length === 0
      ? {}
      : {
          identities: {
            mcpServers: Object.fromEntries(
              bundle.mcpServers.map((server) => [server.name, server.binding]),
            ),
          },
          mcpServers: Object.fromEntries(
            bundle.mcpServers.map((server) => [
              server.name,
              remoteMcpRelay({
                name: server.name,
                url: server.relay.url,
                token: server.relay.token,
                tools: bundle.tools,
              }),
            ]),
          ),
        }),
    permissionMode,
    profile: {
      ...bindings.provider,
      principal: bindings.principal,
    } as ClaudeRuntimeConfig["profile"],
    ...(repository === undefined
      ? {}
      : { repositoryClaudeMd: { contents: repository.text } }),
    ...(deployment.localTranscriptResume === undefined
      ? {}
      : { localTranscriptResume: deployment.localTranscriptResume }),
    ...(deployment.providerMaxRetries === undefined
      ? {}
      : { providerMaxRetries: deployment.providerMaxRetries }),
    ...(deployment.sessionStore === undefined
      ? {}
      : { sessionStore: deployment.sessionStore }),
    ...(deployment.settingSources === undefined
      ? {}
      : { settingSources: deployment.settingSources }),
    ...(deployment.trustedCaBundle === undefined
      ? {}
      : { trustedCaBundle: deployment.trustedCaBundle }),
    tools: [...bundle.tools],
  } as ClaudeRuntimeConfig;
}

/** A contract run over a driver run the caller starts with the gate given. */
export function claudeContractRun(
  correlationId: string,
  startDriver: (gate: NativeApprovalGate) => ClaudeNativeRun,
  descriptor: RuntimeDescriptor = CLAUDE_DESCRIPTOR,
): AgentRun {
  return new ClaudeContractRun(correlationId, startDriver, descriptor);
}

const CHANGED = Symbol("changed");

class ClaudeContractRun implements AgentRun {
  private readonly approvals = new ApprovalChannel();
  private readonly mapper: ClaudeEventMapper;
  private readonly driver: ClaudeNativeRun;

  constructor(
    correlationId: string,
    startDriver: (gate: NativeApprovalGate) => ClaudeNativeRun,
    private readonly descriptor: RuntimeDescriptor,
  ) {
    this.mapper = new ClaudeEventMapper(correlationId);
    this.driver = startDriver({ onPermission: (request) => this.ask(request) });
  }

  abort(): void {
    this.driver.abort();
  }

  async answer(answer: ApprovalAnswer): Promise<AnswerResult> {
    return this.approvals.answer(answer);
  }

  close(): void {
    this.driver.close();
  }

  events(): AsyncIterable<RuntimeEvent> {
    return this;
  }

  finishInput(): void {
    this.driver.finishInput();
  }

  holdsInput(uuid: string): Promise<boolean> {
    return this.driver.holdsInput(uuid);
  }

  interrupt(): Promise<{ stillQueued: string[] }> {
    return this.driver.interrupt();
  }

  leaseCheckpoint(): Promise<CheckpointLeaseGrant> {
    return this.driver.leaseCheckpoint();
  }

  prepareCheckpoint(): Promise<CheckpointPreparation> {
    return this.driver.prepareCheckpoint();
  }

  async ready(): Promise<NegotiatedCapabilities> {
    await this.driver.ready();
    return negotiatedFromDescriptor(this.descriptor);
  }

  send(input: AgentInput): void {
    this.driver.send(input);
  }

  /**
   * The driver's frames and the approvals raised between them, as one
   * stream. The next frame is asked for only once the consumer has taken
   * the last one, as when it read the driver directly.
   */
  async *[Symbol.asyncIterator](): AsyncIterator<RuntimeEvent> {
    const frames = this.driver[Symbol.asyncIterator]();
    let next: Promise<IteratorResult<AgentFrame>> | undefined;
    try {
      for (;;) {
        for (const body of this.approvals.drain()) {
          yield this.mapper.stamp(body);
        }
        next ??= frames.next();
        const step = await Promise.race([
          next,
          this.approvals.changed().then(() => CHANGED),
        ]);
        if (typeof step === "symbol") continue;
        next = undefined;
        if (step.done === true) break;
        yield* this.mapper.fromFrame(step.value);
      }
      for (const body of this.approvals.drain()) {
        yield this.mapper.stamp(body);
      }
    } finally {
      this.approvals.cancelAll("The run's stream ended");
      // A frame still being awaited would hold a return queued behind it.
      const closing = frames.return?.()?.catch(() => undefined);
      if (next === undefined) await closing;
    }
  }

  private async ask(request: PermissionRequest): Promise<PermissionDecision> {
    const answer = await this.approvals.request(
      {
        kind: request.tool === QUESTION_TOOL ? "question" : "permission",
        nativeRef: { id: request.requestId, method: "can_use_tool" },
        tool: { input: request.input, name: request.tool },
        toolCallId: request.toolUseId,
      },
      request.signal,
    );
    return decisionOf(answer, request.input);
  }
}

function decisionOf(
  answer: ApprovalAnswer,
  input: Record<string, unknown>,
): PermissionDecision {
  if (answer.outcome === "answered") {
    // The SDK carries answers on the tool input, keyed by the question.
    return {
      behavior: "allow",
      updatedInput: { ...input, answers: answer.answers },
    };
  }
  if (answer.outcome === "selected" && answer.optionKind === "allow_once") {
    return { behavior: "allow" };
  }
  return {
    behavior: "deny",
    message: answer.message ?? "Denied without a reason",
  };
}
