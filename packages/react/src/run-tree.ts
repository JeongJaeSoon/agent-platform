import type { SessionEventFrame } from "@werft-ai/client";
import type { StatusEventPhase } from "@werft-ai/contracts";

/*
 * One session's events as the tree the agent map's relation panel draws: the
 * session's own run, the subagent runs its Task/Agent calls spawned (linked
 * only by parent_tool_use_id, never across sessions), and each run's tool
 * calls paired with their results. The result does not depend on the order
 * frames arrive in or on a frame arriving twice.
 */

export type ToolCallState = "ok" | "error" | "running" | "waiting";
/** The same values as the ui's StatusDotStatus. */
export type RunStatus = "wait" | "run" | "idle" | "done" | "failed";

export interface ToolNode {
  /** The tool_use id. */
  readonly id: string;
  readonly name: string;
  /** What the call acts on, read from its input; "" when the input names nothing. */
  readonly target: string;
  readonly state: ToolCallState;
  readonly startedAt: string;
  readonly endedAt: string | null;
  readonly ms: number | null;
}

export interface RunTreeNode {
  readonly kind: "run";
  /** `ROOT_RUN_ID` for the session's own run, else the spawning tool_use id. */
  readonly id: string;
  /** Null for the session's own run; a subagent's subagent_type, else its tool name. */
  readonly label: string | null;
  readonly status: RunStatus;
  /** "approval" while one of the run's calls waits on a person's permission; a question only makes it "wait". */
  readonly edge: "delegation" | "approval";
  /** Oldest first. */
  readonly tools: readonly ToolNode[];
  /** In spawn order. */
  readonly children: readonly RunTreeNode[];
  /** The call that spawned this run, in its parent's tools; null for the root and a detached run. */
  readonly spawn: ToolNode | null;
  readonly startedAt: string | null;
  /** The spawning call's result; the session's own run has no end in its events. */
  readonly endedAt: string | null;
  readonly ms: number | null;
  /** Calls of this run that ended in an error. */
  readonly failed: number;
}

export interface RunTree {
  readonly root: RunTreeNode;
  /** Runs whose spawning call has not arrived (or fell out of the event window). */
  readonly detached: readonly RunTreeNode[];
  readonly tools: number;
  readonly errors: number;
}

export type RunTreeFrame = Pick<
  SessionEventFrame,
  "id" | "occurredAt" | "payload"
>;

export interface RunTreeBuilder {
  /** False when the frame's id was already taken in, as a reconnect replays them. */
  push(frame: RunTreeFrame): boolean;
  /** Only runs a push touched since the last call are rebuilt; the rest keep their identity. */
  tree(): RunTree;
}

export const ROOT_RUN_ID = "root";

const SPAWNING_TOOLS = new Set(["Task", "Agent"]);
const TARGET_KEYS = [
  "command",
  "file_path",
  "path",
  "pattern",
  "url",
  "query",
  "description",
] as const;
const PHASE_STATUS: Record<StatusEventPhase, RunStatus> = {
  queued: "idle",
  running: "run",
  needs_input: "wait",
  idle: "idle",
  failed: "failed",
  stopped: "done",
  interrupting: "run",
  engine_stopped: "done",
};

interface Stamp {
  readonly t: number;
  readonly id: string;
  readonly at: string;
}

interface ToolRecord {
  readonly id: string;
  readonly name: string;
  readonly target: string;
  readonly label: string;
  readonly parent: string | null;
  readonly start: Stamp;
}

interface RunRecord {
  readonly id: string;
  parentRun: string | null;
  first: Stamp | null;
  readonly tools: string[];
  readonly children: string[];
}

const before = (a: Stamp, b: Stamp) =>
  a.t < b.t || (a.t === b.t && a.id < b.id);

function stamp(frame: RunTreeFrame): Stamp {
  const t = Date.parse(frame.occurredAt);
  return { t: Number.isNaN(t) ? 0 : t, id: frame.id, at: frame.occurredAt };
}

function insertSorted(list: string[], id: string, key: (id: string) => Stamp) {
  const mine = key(id);
  let index = list.length;
  while (index > 0 && before(mine, key(list[index - 1] as string))) index -= 1;
  list.splice(index, 0, id);
}

function toolUses(message: unknown) {
  const content = (message as { content?: unknown } | null)?.content;
  if (!Array.isArray(content)) return [];
  return content.flatMap((block: unknown) => {
    const b = block as {
      type?: unknown;
      id?: unknown;
      name?: unknown;
      input?: unknown;
    } | null;
    // A call may not take the root's id, or it would stand in for the root.
    return b?.type === "tool_use" &&
      typeof b.id === "string" &&
      b.id !== "" &&
      b.id !== ROOT_RUN_ID
      ? [
          {
            id: b.id,
            name: typeof b.name === "string" ? b.name : "",
            input: b.input,
          },
        ]
      : [];
  });
}

function field(input: unknown, key: string) {
  const value = (input as Record<string, unknown> | null)?.[key];
  return typeof value === "string" && value !== "" ? value : undefined;
}

export function createRunTreeBuilder(): RunTreeBuilder {
  const seen = new Set<string>();
  const tools = new Map<string, ToolRecord>();
  const results = new Map<
    string,
    { readonly end: Stamp; readonly error: boolean }
  >();
  const questions = new Map<string, Stamp>();
  // Calls whose latest question asks for a permission, not for an answer.
  const permissions = new Set<string>();
  const runs = new Map<string, RunRecord>();
  const detached: string[] = [];
  let lastStatus: {
    readonly stamp: Stamp;
    readonly phase: StatusEventPhase;
  } | null = null;
  let errors = 0;
  // A question is answered once the session moves on from needs_input.
  let answeredUntil = Number.NEGATIVE_INFINITY;
  const openQuestions = new Set<string>();

  const dirtyTools = new Set<string>();
  const dirtyRuns = new Set<string>([ROOT_RUN_ID]);
  const toolCache = new Map<string, ToolNode>();
  const runCache = new Map<string, RunTreeNode>();
  let last: RunTree | null = null;

  runs.set(ROOT_RUN_ID, {
    id: ROOT_RUN_ID,
    parentRun: null,
    first: null,
    tools: [],
    children: [],
  });

  const runFirst = (id: string) => {
    const spawn = tools.get(id);
    return spawn ? spawn.start : (runs.get(id)?.first ?? { t: 0, id, at: "" });
  };

  const touchTool = (id: string) => {
    dirtyTools.add(id);
    const tool = tools.get(id);
    if (tool) dirtyRuns.add(tool.parent ?? ROOT_RUN_ID);
    // The tool may spawn a run, whose status and end follow the tool's result.
    if (runs.has(id)) dirtyRuns.add(id);
  };

  const attach = (runId: string) => {
    const spawn = tools.get(runId);
    let parent = spawn ? (spawn.parent ?? ROOT_RUN_ID) : null;
    // A parent_tool_use_id chain that loops back would never end; such a run is drawn apart.
    for (
      let up = parent;
      up !== null && up !== ROOT_RUN_ID;
      up = runs.get(up)?.parentRun ?? null
    ) {
      if (up === runId) {
        parent = null;
        break;
      }
    }
    const run = runs.get(runId) as RunRecord;
    run.parentRun = parent;
    if (parent === null) insertSorted(detached, runId, runFirst);
    else
      insertSorted((runs.get(parent) as RunRecord).children, runId, runFirst);
    dirtyRuns.add(parent ?? runId);
  };

  const ensureRun = (id: string, at: Stamp | null) => {
    const run = runs.get(id);
    if (run) {
      if (at && (run.first === null || before(at, run.first))) {
        run.first = at;
        dirtyRuns.add(id);
        if (id !== ROOT_RUN_ID && run.parentRun === null && !tools.has(id)) {
          detached.splice(detached.indexOf(id), 1);
          insertSorted(detached, id, runFirst);
        }
      }
      return;
    }
    runs.set(id, { id, parentRun: null, first: at, tools: [], children: [] });
    dirtyRuns.add(id);
    attach(id);
  };

  const addTool = (record: ToolRecord) => {
    tools.set(record.id, record);
    const parent = record.parent ?? ROOT_RUN_ID;
    ensureRun(parent, record.start);
    insertSorted(
      (runs.get(parent) as RunRecord).tools,
      record.id,
      (id) => (tools.get(id) as ToolRecord).start,
    );
    if (runs.has(record.id)) {
      // The run was detached until its spawning call arrived: move it under that call's run.
      detached.splice(detached.indexOf(record.id), 1);
      attach(record.id);
    } else if (SPAWNING_TOOLS.has(record.name)) {
      ensureRun(record.id, null);
    }
    if (questions.has(record.id) && !results.has(record.id))
      openQuestions.add(record.id);
    if (results.get(record.id)?.error) errors += 1;
    touchTool(record.id);
  };

  const push = (frame: RunTreeFrame) => {
    if (seen.has(frame.id)) return false;
    seen.add(frame.id);
    const at = stamp(frame);
    const { payload } = frame;
    switch (payload.event) {
      case "assistant":
      case "tool_use": {
        const parent = payload.data.parent_tool_use_id ?? null;
        ensureRun(parent ?? ROOT_RUN_ID, at);
        toolUses(payload.data.message).forEach((use, index) => {
          if (tools.has(use.id)) return;
          const target = TARGET_KEYS.map((key) => field(use.input, key)).find(
            (v) => v !== undefined,
          );
          addTool({
            id: use.id,
            name: use.name,
            target: target ?? "",
            label: field(use.input, "subagent_type") ?? use.name,
            parent,
            // Calls sharing a frame keep their block order.
            start: index === 0 ? at : { ...at, id: `${at.id}\u0000${index}` },
          });
        });
        break;
      }
      case "tool_result": {
        const data = payload.data as {
          tool_use_id?: unknown;
          is_error?: unknown;
        } | null;
        const id = data?.tool_use_id;
        if (typeof id !== "string" || results.has(id)) break;
        results.set(id, { end: at, error: data?.is_error === true });
        if (data?.is_error === true && tools.has(id)) errors += 1;
        openQuestions.delete(id);
        touchTool(id);
        break;
      }
      case "question": {
        const id = payload.data.tool_use_id;
        const known = questions.get(id);
        if (known && !before(known, at)) break;
        questions.set(id, at);
        if (payload.data.kind === "permission") permissions.add(id);
        else permissions.delete(id);
        if (tools.has(id) && !results.has(id)) openQuestions.add(id);
        touchTool(id);
        break;
      }
      case "status": {
        if (lastStatus === null || before(lastStatus.stamp, at)) {
          lastStatus = { stamp: at, phase: payload.data.phase };
          dirtyRuns.add(ROOT_RUN_ID);
        }
        if (payload.data.phase !== "needs_input" && at.t > answeredUntil) {
          answeredUntil = at.t;
          for (const id of openQuestions) touchTool(id);
        }
        break;
      }
      default:
        break;
    }
    return true;
  };

  const toolState = (id: string): ToolCallState => {
    const result = results.get(id);
    if (result) return result.error ? "error" : "ok";
    const question = questions.get(id);
    return question && question.t > answeredUntil ? "waiting" : "running";
  };

  const toolNode = (id: string): ToolNode => {
    const cached = toolCache.get(id);
    if (cached && !dirtyTools.has(id)) return cached;
    const tool = tools.get(id) as ToolRecord;
    const end = results.get(id)?.end ?? null;
    const node: ToolNode = {
      id,
      name: tool.name,
      target: tool.target,
      state: toolState(id),
      startedAt: tool.start.at,
      endedAt: end?.at ?? null,
      ms: end ? Math.max(0, end.t - tool.start.t) : null,
    };
    // A Task call is read twice per tree: in its run's tools and as its child's spawn.
    toolCache.set(id, node);
    dirtyTools.delete(id);
    return node;
  };

  const runNode = (id: string): RunTreeNode => {
    const cached = runCache.get(id);
    if (cached && !dirtyRuns.has(id)) return cached;
    const run = runs.get(id) as RunRecord;
    const own = run.tools.map(toolNode);
    const children = run.children.map(runNode);
    const spawn = id !== ROOT_RUN_ID && tools.has(id) ? toolNode(id) : null;
    const waiting = own.some((tool) => tool.state === "waiting");
    let status: RunStatus;
    if (waiting) status = "wait";
    else if (spawn?.state === "ok") status = "done";
    else if (spawn?.state === "error") status = "failed";
    else if (id !== ROOT_RUN_ID) status = "run";
    else if (own.some((tool) => tool.state === "running")) status = "run";
    else status = lastStatus ? PHASE_STATUS[lastStatus.phase] : "idle";
    const startedAt = spawn?.startedAt ?? run.first?.at ?? null;
    const endedAt = spawn?.endedAt ?? null;
    const node: RunTreeNode = {
      kind: "run",
      id,
      label: id === ROOT_RUN_ID ? null : (tools.get(id)?.label ?? "Task"),
      status,
      edge: own.some(
        (tool) => tool.state === "waiting" && permissions.has(tool.id),
      )
        ? "approval"
        : "delegation",
      tools: own,
      children,
      spawn,
      startedAt,
      endedAt,
      ms: spawn?.ms ?? null,
      failed: own.filter((tool) => tool.state === "error").length,
    };
    runCache.set(id, node);
    return node;
  };

  const tree = () => {
    if (last && dirtyRuns.size === 0 && dirtyTools.size === 0) return last;
    // A rebuilt run is a new object, so every run above it is rebuilt too.
    for (const id of [...dirtyRuns]) {
      for (
        let up = runs.get(id)?.parentRun ?? null;
        up !== null;
        up = runs.get(up)?.parentRun ?? null
      ) {
        if (dirtyRuns.has(up)) break;
        dirtyRuns.add(up);
      }
    }
    const root = runNode(ROOT_RUN_ID);
    const apart = detached.map(runNode);
    dirtyRuns.clear();
    dirtyTools.clear();
    last = {
      root,
      detached:
        apart.length === last?.detached.length &&
        apart.every((run, i) => run === last?.detached[i])
          ? last.detached
          : apart,
      tools: tools.size,
      errors,
    };
    return last;
  };

  return { push, tree };
}

export function buildRunTree(frames: readonly RunTreeFrame[]): RunTree {
  const builder = createRunTreeBuilder();
  for (const frame of frames) builder.push(frame);
  return builder.tree();
}

/** The relation panel's rows: the session's run, then every subagent run depth first. */
export function runRows(tree: RunTree): readonly RunTreeNode[] {
  const rows: RunTreeNode[] = [];
  const visit = (run: RunTreeNode) => {
    rows.push(run);
    for (const child of run.children) visit(child);
  };
  visit(tree.root);
  for (const run of tree.detached) visit(run);
  return rows;
}
