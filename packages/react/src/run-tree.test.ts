import { describe, expect, test } from "bun:test";
import type { StatusEventPhase } from "@werft-ai/contracts";
import {
  buildRunTree,
  createRunTreeBuilder,
  ROOT_RUN_ID,
  type RunTreeFrame,
  runRows,
} from "./run-tree.ts";

const T0 = Date.parse("2026-10-25T01:00:00.000Z");
const at = (seconds: number) => new Date(T0 + seconds * 1000).toISOString();

const TURN = "b7e1c2d3-4f5a-4b6c-8d7e-9f0a1b2c3d4e";

let cursor = 0;
const next = () => {
  cursor += 1;
  return `ev_${cursor.toString(36)}`;
};

function use(
  seconds: number,
  id: string,
  name: string,
  input: Record<string, unknown>,
  parent: string | null = null,
): RunTreeFrame {
  return {
    id: next(),
    occurredAt: at(seconds),
    turnId: TURN,
    payload: {
      event: "tool_use",
      data: {
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "tool_use", id, name, input }],
        },
        parent_tool_use_id: parent,
      },
    },
  };
}

function result(seconds: number, id: string, isError = false): RunTreeFrame {
  return {
    id: next(),
    occurredAt: at(seconds),
    turnId: TURN,
    payload: {
      event: "tool_result",
      data: {
        type: "tool_result",
        tool_use_id: id,
        content: "…",
        is_error: isError,
      },
    },
  };
}

function question(
  seconds: number,
  id: string,
  kind: "permission" | "question" = "permission",
): RunTreeFrame {
  return {
    id: next(),
    occurredAt: at(seconds),
    turnId: TURN,
    payload: {
      event: "question",
      data: {
        request_id: "8f1c2d3e-4b5a-4c6d-8e7f-9a0b1c2d3e4f",
        tool_use_id: id,
        kind,
        tool: "Bash",
        input: {},
      },
    },
  };
}

function status(seconds: number, phase: StatusEventPhase): RunTreeFrame {
  return {
    id: next(),
    occurredAt: at(seconds),
    turnId: TURN,
    payload: { event: "status", data: { phase } },
  };
}

function turnEnd(seconds: number, turnId = TURN): RunTreeFrame {
  return {
    id: next(),
    occurredAt: at(seconds),
    turnId,
    payload: {
      event: "result",
      data: { type: "result", subtype: "success", session_id: "engine-1" },
    },
  };
}

/** Root reads a file, spawns a reviewer that spawns an explorer, which greps. */
function nested(): RunTreeFrame[] {
  return [
    status(0, "running"),
    use(1, "read-1", "Read", { file_path: "retry.ts" }),
    result(1.2, "read-1"),
    use(2, "task-a", "Task", {
      subagent_type: "code-reviewer",
      description: "review",
    }),
    use(
      3,
      "task-b",
      "Task",
      { subagent_type: "Explore", description: "find" },
      "task-a",
    ),
    use(4, "grep-1", "Grep", { pattern: "maxAttempts" }, "task-b"),
    result(4.31, "grep-1"),
    result(5, "task-b"),
    use(6, "bash-1", "Bash", { command: "bun test" }, "task-a"),
  ];
}

const shuffle = <T>(list: readonly T[], seed: number) => {
  const out = [...list];
  let s = seed;
  for (let i = out.length - 1; i > 0; i -= 1) {
    s = (s * 1_103_515_245 + 12_345) % 2_147_483_648;
    const j = s % (i + 1);
    [out[i], out[j]] = [out[j] as T, out[i] as T];
  }
  return out;
};

describe("buildRunTree", () => {
  test("nests runs by parent_tool_use_id two levels deep", () => {
    const tree = buildRunTree(nested());
    expect(runRows(tree).map((run) => [run.id, run.label])).toEqual([
      [ROOT_RUN_ID, null],
      ["task-a", "code-reviewer"],
      ["task-b", "Explore"],
    ]);
    expect(tree.root.tools.map((tool) => tool.id)).toEqual([
      "read-1",
      "task-a",
    ]);
    const reviewer = tree.root.children[0];
    expect(reviewer?.spawn?.id).toBe("task-a");
    expect(reviewer?.tools.map((tool) => [tool.id, tool.target])).toEqual([
      ["task-b", "find"],
      ["bash-1", "bun test"],
    ]);
    expect(reviewer?.children[0]?.tools.map((tool) => tool.id)).toEqual([
      "grep-1",
    ]);
    expect(tree.detached).toEqual([]);
    expect(tree.tools).toBe(5);
  });

  test("pairs a call with its result and measures the time between", () => {
    const tree = buildRunTree(nested());
    const grep = tree.root.children[0]?.children[0]?.tools[0];
    expect(grep).toMatchObject({
      name: "Grep",
      target: "maxAttempts",
      state: "ok",
      startedAt: at(4),
      endedAt: at(4.31),
      ms: 310,
    });
    const explorer = tree.root.children[0]?.children[0];
    expect(explorer).toMatchObject({
      status: "done",
      startedAt: at(3),
      endedAt: at(5),
      ms: 2000,
    });
  });

  test("a call without a result is still running, and so is its run", () => {
    const tree = buildRunTree(nested());
    const reviewer = tree.root.children[0];
    expect(reviewer?.tools[1]).toMatchObject({
      id: "bash-1",
      state: "running",
      endedAt: null,
      ms: null,
    });
    expect(reviewer).toMatchObject({
      status: "run",
      endedAt: null,
      ms: null,
      edge: "delegation",
    });
    // The Task call has no result yet, so the session's own run is still working.
    expect(tree.root.status).toBe("run");
  });

  test("an error result fails the call, and a failed Task fails its run", () => {
    const tree = buildRunTree([
      ...nested(),
      result(7, "bash-1", true),
      result(8, "task-a", true),
    ]);
    const reviewer = tree.root.children[0];
    expect(reviewer?.tools[1]?.state).toBe("error");
    expect(reviewer).toMatchObject({ status: "failed", failed: 1 });
    expect(tree.root.tools[1]?.state).toBe("error");
    expect(tree.root.failed).toBe(1);
    expect(tree.errors).toBe(2);
  });

  test("a call waiting on a person reads as approval until the session moves on", () => {
    const frames = [
      ...nested(),
      question(7, "bash-1"),
      status(7, "needs_input"),
    ];
    const waiting = buildRunTree(frames);
    expect(waiting.root.children[0]).toMatchObject({
      status: "wait",
      edge: "approval",
    });
    expect(waiting.root.children[0]?.tools[1]?.state).toBe("waiting");

    const answered = buildRunTree([...frames, status(9, "running")]);
    expect(answered.root.children[0]).toMatchObject({
      status: "run",
      edge: "delegation",
    });
    expect(answered.root.children[0]?.tools[1]?.state).toBe("running");
  });

  test("a call whose turn ended without a result is interrupted", () => {
    const frames = [...nested(), turnEnd(7)];
    const tree = buildRunTree(frames);
    const reviewer = tree.root.children[0];
    expect(reviewer?.tools[1]).toMatchObject({
      id: "bash-1",
      state: "interrupted",
      endedAt: null,
      ms: null,
    });
    expect(tree.root.tools[1]?.state).toBe("interrupted");
    expect(reviewer).toMatchObject({ status: "done", edge: "delegation" });
    // Another turn's end leaves the calls of this one alone.
    const other = buildRunTree([...nested(), turnEnd(7, "another-turn")]);
    expect(other.root.children[0]?.tools[1]?.state).toBe("running");
    expect(buildRunTree([...frames].reverse())).toEqual(tree);
  });

  test("a call open when the session stopped is interrupted; a later one is not", () => {
    const frames = [
      status(0, "running"),
      use(1, "bash-1", "Bash", { command: "make" }),
      status(2, "stopped"),
      status(3, "running"),
      use(4, "bash-2", "Bash", { command: "make again" }),
    ];
    const tree = buildRunTree(frames);
    expect(tree.root.tools.map((tool) => tool.state)).toEqual([
      "interrupted",
      "running",
    ]);
    for (let seed = 1; seed <= 10; seed += 1) {
      expect(buildRunTree(shuffle(frames, seed))).toEqual(tree);
    }
  });

  test("a run whose spawning call ended is over even with a call left waiting", () => {
    const tree = buildRunTree([
      use(1, "task-a", "Task", {}),
      use(2, "bash-1", "Bash", {}, "task-a"),
      question(3, "bash-1"),
      result(4, "task-a", true),
    ]);
    expect(tree.root.children[0]).toMatchObject({
      status: "failed",
      edge: "delegation",
      endedAt: at(4),
    });
  });

  test("the session's own run spans its first event to its stop", () => {
    const tree = buildRunTree([
      status(0, "running"),
      use(1, "bash-1", "Bash", {}),
      result(2, "bash-1"),
      status(3, "stopped"),
    ]);
    expect(tree.root).toMatchObject({
      status: "done",
      startedAt: at(0),
      endedAt: at(3),
      ms: 3000,
    });
    const working = buildRunTree([status(0, "running")]);
    expect(working.root).toMatchObject({ startedAt: at(0), endedAt: null });
  });

  test("a question answered earlier does not rebuild its run on every status", () => {
    const builder = createRunTreeBuilder();
    for (const frame of [
      use(1, "task-a", "Task", {}),
      use(2, "bash-1", "Bash", {}, "task-a"),
      question(3, "bash-1"),
      status(4, "running"),
    ]) {
      builder.push(frame);
    }
    const before = builder.tree();
    builder.push(status(5, "running"));
    expect(builder.tree().root.children[0]).toBe(
      before.root.children[0] as never,
    );
  });

  test("a question waits without the approval edge", () => {
    const tree = buildRunTree([...nested(), question(7, "bash-1", "question")]);
    expect(tree.root.children[0]).toMatchObject({
      status: "wait",
      edge: "delegation",
    });
    expect(tree.root.children[0]?.tools[1]?.state).toBe("waiting");
  });

  test("with no open call the session's run follows its latest status", () => {
    const tree = buildRunTree([
      status(0, "running"),
      use(1, "read-1", "Read", { file_path: "a.ts" }),
      result(2, "read-1"),
      status(3, "idle"),
    ]);
    expect(tree.root.status).toBe("idle");
    expect(buildRunTree([]).root).toMatchObject({
      status: "idle",
      tools: [],
      children: [],
    });
  });

  test("a replay after reconnecting takes each event once", () => {
    const frames = nested();
    const builder = createRunTreeBuilder();
    for (const frame of frames) expect(builder.push(frame)).toBe(true);
    const before = builder.tree();
    // The stream resumes and delivers the last few frames again, then all of them.
    for (const frame of [...frames.slice(-3), ...frames])
      expect(builder.push(frame)).toBe(false);
    expect(builder.tree()).toBe(before);
    expect(before.tools).toBe(5);
    expect(builder.tree()).toEqual(buildRunTree(frames));
  });

  test("the same events in any arrival order make the same tree", () => {
    const frames = [
      ...nested(),
      question(7, "bash-1"),
      result(8, "bash-1", true),
    ];
    const expected = buildRunTree(frames);
    for (let seed = 1; seed <= 50; seed += 1) {
      expect(buildRunTree(shuffle(frames, seed))).toEqual(expected);
    }
    // The hardest order: results first, the grandchild before its parents.
    expect(buildRunTree([...frames].reverse())).toEqual(expected);
  });

  test("a run whose spawning call has not arrived stays apart until it does", () => {
    const frames = nested();
    const withoutTask = frames.filter(
      (frame) =>
        !(
          frame.payload.event === "tool_use" &&
          JSON.stringify(frame.payload).includes('"id":"task-a"')
        ),
    );
    const builder = createRunTreeBuilder();
    for (const frame of withoutTask) builder.push(frame);
    const apart = builder.tree();
    expect(apart.root.children).toEqual([]);
    expect(apart.detached.map((run) => [run.id, run.label, run.spawn])).toEqual(
      [["task-a", "Task", null]],
    );
    expect(apart.detached[0]?.children[0]?.id).toBe("task-b");

    const taskA = frames.find(
      (frame) => !withoutTask.includes(frame),
    ) as RunTreeFrame;
    builder.push(taskA);
    expect(builder.tree()).toEqual(buildRunTree(frames));
  });

  test("a parent_tool_use_id loop is drawn apart, whichever link came last", () => {
    const frames = [
      use(1, "task-x", "Task", {}, "task-y"),
      use(2, "task-y", "Task", {}, "task-x"),
      use(3, "read-1", "Read", {}, "task-x"),
    ];
    const tree = buildRunTree(frames);
    expect(runRows(tree).map((run) => run.id)).toEqual([
      ROOT_RUN_ID,
      "task-x",
      "task-y",
    ]);
    expect(tree.root.children).toEqual([]);
    expect(tree.detached.map((run) => run.children)).toEqual([[], []]);
    expect(buildRunTree([...frames].reverse())).toEqual(tree);
  });

  test("runs drawn apart keep one order however their calls arrive", () => {
    const frames = [
      use(3, "a", "Task", {}, "b"),
      use(6, "s", "Task", {}, "s"),
      use(5, "b", "Task", {}, "c"),
      use(8, "c", "Task", {}, "a"),
    ];
    const tree = buildRunTree(frames);
    expect(tree.detached.map((run) => run.id)).toEqual(["a", "b", "s", "c"]);
    for (let seed = 1; seed <= 30; seed += 1) {
      expect(buildRunTree(shuffle(frames, seed))).toEqual(tree);
    }
    expect(buildRunTree([...frames].reverse())).toEqual(tree);
  });

  test("a run that names itself as its parent is drawn apart", () => {
    const tree = buildRunTree([use(1, "x", "Task", {}, "x")]);
    expect(tree.detached.map((run) => [run.id, run.tools.length])).toEqual([
      ["x", 1],
    ]);
    expect(tree.root.children).toEqual([]);
  });

  test("an earlier frame that breaks a loop puts the runs back in any order", () => {
    const frames = [
      use(1, "x", "Task", {}),
      use(2, "x", "Task", {}, "y"),
      use(3, "y", "Task", {}, "x"),
    ];
    const tree = buildRunTree(frames);
    expect(runRows(tree).map((run) => run.id)).toEqual([ROOT_RUN_ID, "x", "y"]);
    expect(tree.detached).toEqual([]);
    for (let seed = 1; seed <= 10; seed += 1) {
      expect(buildRunTree(shuffle(frames, seed))).toEqual(tree);
    }
    expect(buildRunTree([...frames].reverse())).toEqual(tree);
  });

  test("calls sharing one frame keep their block order", () => {
    const ids = Array.from({ length: 12 }, (_, i) => `t${i}`);
    const tree = buildRunTree([
      {
        id: "c-many",
        occurredAt: at(1),
        turnId: TURN,
        payload: {
          event: "tool_use",
          data: {
            type: "assistant",
            message: {
              content: ids.map((id) => ({
                type: "tool_use",
                id,
                name: "Read",
                input: {},
              })),
            },
          },
        },
      },
    ]);
    expect(tree.root.tools.map((tool) => tool.id)).toEqual(ids);
  });

  test("frames that disagree about one call: the earlier one wins in any order", () => {
    const frames = [
      use(1, "x", "Bash", { command: "first" }),
      use(1.5, "x", "Task", { description: "second" }, "elsewhere"),
      result(2, "x"),
      result(3, "x", true),
    ];
    const tree = buildRunTree(frames);
    expect(tree.root.tools[0]).toMatchObject({
      name: "Bash",
      target: "first",
      state: "ok",
      endedAt: at(2),
      ms: 1000,
    });
    expect(tree.errors).toBe(0);
    for (let seed = 1; seed <= 30; seed += 1) {
      expect(buildRunTree(shuffle(frames, seed))).toEqual(tree);
    }
  });

  test("a question after a status in the same millisecond still waits", () => {
    const frames = [
      use(1, "bash-1", "Bash", { command: "git push" }),
      status(2, "running"),
      question(2, "bash-1"),
      status(2, "needs_input"),
    ];
    const tree = buildRunTree(frames);
    expect(tree.root.tools[0]?.state).toBe("waiting");
    expect(tree.root).toMatchObject({ status: "wait", edge: "approval" });
    expect(buildRunTree([...frames].reverse())).toEqual(tree);
  });

  test("a session that failed or stopped is not drawn as working", () => {
    const open = [use(1, "bash-1", "Bash", { command: "make" })];
    expect(buildRunTree([...open, status(2, "failed")]).root.status).toBe(
      "failed",
    );
    expect(buildRunTree([...open, status(2, "stopped")]).root.status).toBe(
      "done",
    );
    expect(buildRunTree([...open, status(2, "running")]).root.status).toBe(
      "run",
    );
  });

  test("a parent_tool_use_id chain 20,000 deep builds without overflowing", () => {
    const frames = Array.from({ length: 20_000 }, (_, i) =>
      use(i, `t${i}`, "Task", {}, i === 0 ? null : `t${i - 1}`),
    );
    for (const order of [frames, [...frames].reverse()]) {
      const tree = buildRunTree(order);
      expect(runRows(tree).length).toBe(20_001);
      expect(tree.detached).toEqual([]);
    }
  });

  test("the tree after every push equals a full build of what arrived", () => {
    const frames = [
      ...nested(),
      question(7, "bash-1"),
      status(7, "needs_input"),
      status(8, "running"),
      result(9, "bash-1", true),
      result(10, "task-a"),
      use(11, "task-c", "Task", {}, "task-b"),
      use(11.5, "c", "Task", {}, "task-c"),
      use(11.7, "task-c", "Task", {}, "c"),
      turnEnd(12),
      status(13, "stopped"),
    ];
    for (let seed = 1; seed <= 20; seed += 1) {
      const order = shuffle(frames, seed);
      const builder = createRunTreeBuilder();
      order.forEach((frame, i) => {
        builder.push(frame);
        expect(builder.tree()).toEqual(buildRunTree(order.slice(0, i + 1)));
      });
    }
  });

  test("a call carrying the root's id is left out", () => {
    const tree = buildRunTree([
      use(1, ROOT_RUN_ID, "Task", {}),
      use(2, "read-1", "Read", {}),
    ]);
    expect(runRows(tree).map((run) => run.id)).toEqual([ROOT_RUN_ID]);
    expect(tree.root.tools.map((tool) => tool.id)).toEqual(["read-1"]);
  });

  test("events in the same millisecond keep the order they were stored in", () => {
    const stored = (id: string, frame: RunTreeFrame) => ({ ...frame, id });
    const frames = [
      stored("ev_9", use(1, "read-9", "Read", {})),
      stored("ev_z", use(1, "read-35", "Read", {})),
      stored("ev_10", use(1, "read-36", "Read", {})),
    ];
    for (const order of [frames, [...frames].reverse()]) {
      expect(buildRunTree(order).root.tools.map((tool) => tool.id)).toEqual([
        "read-9",
        "read-35",
        "read-36",
      ]);
    }
    const aliases = [
      stored("ev_1", use(1, "a", "Read", {})),
      stored("ev_01", use(1, "b", "Read", {})),
    ];
    expect(buildRunTree(aliases)).toEqual(
      buildRunTree([...aliases].reverse()),
    );
  });

  test("an event names no target when its input has none", () => {
    const tree = buildRunTree([use(1, "todo-1", "TodoWrite", { todos: [] })]);
    expect(tree.root.tools[0]?.target).toBe("");
  });
});

describe("createRunTreeBuilder", () => {
  test("a new event rebuilds only the runs it touches", () => {
    const builder = createRunTreeBuilder();
    for (const frame of [
      ...nested(),
      use(7, "task-c", "Task", { subagent_type: "Plan" }),
      use(8, "read-2", "Read", { file_path: "plan.md" }, "task-c"),
    ]) {
      builder.push(frame);
    }
    const before = builder.tree();
    builder.push(result(9, "read-2"));
    const after = builder.tree();

    const [reviewer, planner] = after.root.children;
    expect(reviewer).toBe(before.root.children[0]);
    expect(planner).not.toBe(before.root.children[1]);
    expect(planner?.tools[0]?.state).toBe("ok");
    // The root is rebuilt to hold the new planner, but its calls are reused.
    expect(after.root).not.toBe(before.root);
    after.root.tools.forEach((tool, i) => {
      expect(tool).toBe(before.root.tools[i] as typeof tool);
    });
    expect(builder.tree()).toBe(after);
  });
});

describe("PERF", () => {
  /**
   * 20,000 events, the scale of packages/db/bench/session-reads.ts: 40
   * subagents (half nested one level deeper) and 9,960 calls with results.
   */
  function large() {
    const frames: RunTreeFrame[] = [status(0, "running")];
    const parents: (string | null)[] = [null];
    for (let i = 0; i < 40; i += 1) {
      const parent = i % 2 === 1 ? `task-${i - 1}` : null;
      frames.push(
        use(i, `task-${i}`, "Task", { subagent_type: `agent-${i}` }, parent),
      );
      parents.push(`task-${i}`);
    }
    for (let i = 0; frames.length < 20_000; i += 1) {
      const parent = parents[i % parents.length] ?? null;
      frames.push(
        use(40 + i, `call-${i}`, "Bash", { command: `step ${i}` }, parent),
      );
      if (frames.length < 20_000)
        frames.push(result(40.5 + i, `call-${i}`, i % 97 === 0));
    }
    return frames;
  }

  test("20,000 events build in one pass and one more event costs a fraction", () => {
    const frames = large();
    expect(frames.length).toBe(20_000);

    const fullRuns: number[] = [];
    let tree = buildRunTree([]);
    for (let run = 0; run < 5; run += 1) {
      const started = performance.now();
      tree = buildRunTree(frames);
      fullRuns.push(performance.now() - started);
    }
    expect(runRows(tree).length).toBe(41);

    const builder = createRunTreeBuilder();
    for (const frame of frames) builder.push(frame);
    builder.tree();
    const stepRuns: number[] = [];
    const leaf = "task-39";
    for (let i = 0; i < 200; i += 1) {
      const previous = builder.tree();
      const started = performance.now();
      builder.push(
        use(100_000 + i, `extra-${i}`, "Read", { file_path: `f${i}` }, leaf),
      );
      const next = builder.tree();
      stepRuns.push(performance.now() - started);
      // Only the touched run and its ancestors are new objects.
      expect(
        next.root.children
          .filter((run, j) => run !== previous.root.children[j])
          .map((run) => run.id),
      ).toEqual(["task-38"]);
    }

    const median = (list: number[]) =>
      [...list].sort((a, b) => a - b)[Math.floor(list.length / 2)] as number;
    const full = median(fullRuns);
    const step = median(stepRuns);
    console.log(
      `PERF run-tree: full build of ${frames.length} events median ${full.toFixed(2)} ms (runs: ${fullRuns.map((ms) => ms.toFixed(1)).join(", ")}); one appended event median ${step.toFixed(3)} ms over ${stepRuns.length} steps; ratio ${(full / step).toFixed(0)}x`,
    );
    expect(step).toBeLessThan(full / 10);
  });

  test("one event in a run of 10,000 calls rebuilds that run's list only", () => {
    const frames: RunTreeFrame[] = [];
    for (let i = 0; i < 10_000; i += 1) {
      frames.push(use(i, `wide-${i}`, "Read", { file_path: `f${i}` }));
      frames.push(result(i + 0.5, `wide-${i}`));
    }
    const builder = createRunTreeBuilder();
    for (const frame of frames) builder.push(frame);
    const before = builder.tree();
    const started = performance.now();
    builder.push(use(20_000, "wide-new", "Read", { file_path: "new" }));
    const after = builder.tree();
    const ms = performance.now() - started;
    console.log(
      `PERF run-tree: one appended event in a single run of 10000 calls ${ms.toFixed(3)} ms`,
    );
    expect(after.root.tools.length).toBe(10_001);
    expect(after.root.tools[0]).toBe(before.root.tools[0] as never);
  });

  test("20,000 events arriving newest first", () => {
    const frames = large().reverse();
    const started = performance.now();
    const tree = buildRunTree(frames);
    const ms = performance.now() - started;
    console.log(
      `PERF run-tree: full build of ${frames.length} events in reverse order ${ms.toFixed(2)} ms`,
    );
    expect(tree).toEqual(buildRunTree(large()));
  });
});
