import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import {
  type FakeAnthropicServer,
  startFakeAnthropicServer,
  textReply,
  toolReply,
} from "@werft-ai/testkit/fake-anthropic";
import {
  createIsolatedWorkspace,
  type IsolatedWorkspace,
} from "@werft-ai/testkit/workspace";
import type { AgentFrame } from "./driver.ts";
import { ClaudeSdkRuntime } from "./runtime.ts";

let isolated: IsolatedWorkspace | undefined;
let server: FakeAnthropicServer | undefined;

afterEach(async () => {
  server?.stop();
  await isolated?.dispose();
  isolated = undefined;
  server = undefined;
});

type Paths = { home: string; memory: string; workspace: string };

/**
 * Runs one tool call through the real engine, laid out as the worker lays it
 * out: `<config dir>/projects` is a link onto the workspace volume, which is
 * what keeps the engine's own memory carve-out from matching.
 */
async function callOnce(
  tool: string,
  input: Record<string, unknown>,
  setup: (paths: Paths) => Promise<void> = async () => {},
  tools = ["Bash", "Glob", "Grep", "Read", "Write"],
): Promise<{ asked: string[]; results: string }> {
  isolated = await createIsolatedWorkspace({ prefix: "memory-read-" });
  const { home, workspace } = isolated;
  const transcripts = join(workspace, ".git", "agent-platform-transcripts-x");
  await mkdir(transcripts, { recursive: true });
  await symlink(transcripts, join(home, "projects"));
  const canonical = (await realpath(workspace)).normalize("NFC");
  const memory = join(
    home,
    "projects",
    canonical.replaceAll(/[^a-zA-Z0-9]/g, "-"),
    "memory",
  );
  await mkdir(memory, { recursive: true });
  await writeFile(join(memory, "MEMORY.md"), "- remembered fact\n");
  await writeFile(join(home, "secret.txt"), "outside\n");
  await setup({ home, memory, workspace });
  const resolved = JSON.parse(
    JSON.stringify(input)
      .replaceAll("$RELATIVE_MEMORY", relative(workspace, memory))
      .replaceAll("$MEMORY", memory)
      .replaceAll("$HOME", home),
  ) as Record<string, unknown>;
  server = startFakeAnthropicServer((_request, index) =>
    index === 0 ? toolReply(tool, resolved, "toolu_memory") : textReply("done"),
  );
  const runtime = new ClaudeSdkRuntime({
    endpoints: [server.url],
    models: ["claude-sonnet-4-5"],
  });
  const asked: string[] = [];
  const run = runtime.start(
    {
      claudeConfigDir: home,
      correlationId: "memory-read",
      mode: "new",
      cwd: workspace,
      home,
      maxTurns: 2,
      model: "claude-sonnet-4-5",
      profile: {
        kind: "anthropic",
        endpoint: server.url,
        auth: { kind: "api_key", value: "placeholder-local" },
        principal: { ownerScope: "owner-a" },
      },
      settingSources: [],
      tools,
    },
    {
      onPermission: async (request) => {
        asked.push(request.tool);
        return { behavior: "deny", message: "Denied by host" };
      },
    },
  );
  const frames: AgentFrame[] = [];
  const consume = (async () => {
    for await (const frame of run) frames.push(frame);
  })();
  run.send({ message: "read memory", uuid: crypto.randomUUID() });
  run.finishInput();
  await consume;
  const results = frames.flatMap((frame) => {
    const message = frame.envelope.message as {
      message?: { content?: unknown };
      type: string;
    };
    if (message.type !== "user" || !Array.isArray(message.message?.content)) {
      return [];
    }
    return (message.message.content as Array<{ content?: unknown }>).map(
      (block) => JSON.stringify(block.content ?? ""),
    );
  });
  return { asked, results: results.join("\n") };
}

describe("the engine's memory directory in an approval mode", () => {
  test("Read of the memory index runs without asking a person", async () => {
    const { asked, results } = await callOnce("Read", {
      file_path: "$MEMORY/MEMORY.md",
    });
    expect(asked).toEqual([]);
    expect(results).toContain("remembered fact");
  }, 30_000);

  test("Read of a memory index not written yet runs without asking", async () => {
    const { asked, results } = await callOnce(
      "Read",
      { file_path: "$MEMORY/MEMORY.md" },
      async ({ memory }) => rm(join(memory, "MEMORY.md")),
    );
    expect(asked).toEqual([]);
    expect(results).toContain("does not exist");
  }, 30_000);

  test("Glob inside the memory directory runs without asking", async () => {
    const { asked, results } = await callOnce("Glob", {
      pattern: "*.md",
      path: "$MEMORY",
    });
    expect(asked).toEqual([]);
    expect(results).toContain("MEMORY.md");
  }, 30_000);

  test("Grep inside the memory directory runs without asking", async () => {
    const { asked, results } = await callOnce("Grep", {
      pattern: "remembered",
      path: "$MEMORY",
      output_mode: "content",
    });
    expect(asked).toEqual([]);
    expect(results).toContain("remembered fact");
  }, 30_000);

  test("a profile without Read cannot read its memory either", async () => {
    const { asked, results } = await callOnce(
      "Read",
      { file_path: "$MEMORY/MEMORY.md" },
      undefined,
      ["Bash"],
    );
    expect(asked).toEqual([]);
    expect(results).not.toContain("remembered fact");
  }, 30_000);

  test("Read outside the memory directory still asks", async () => {
    const { asked, results } = await callOnce("Read", {
      file_path: "$HOME/secret.txt",
    });
    expect(asked).toEqual(["Read"]);
    expect(results).not.toContain("outside");
  }, 30_000);

  test("Read climbing out of the memory directory with .. still asks", async () => {
    const { asked, results } = await callOnce("Read", {
      file_path: "$MEMORY/../../../../../secret.txt",
    });
    expect(asked).toEqual(["Read"]);
    expect(results).not.toContain("outside");
  }, 30_000);

  test("Read through a symlink in the memory directory still asks", async () => {
    const { asked, results } = await callOnce(
      "Read",
      { file_path: "$MEMORY/link.md" },
      async ({ home, memory }) =>
        symlink(join(home, "secret.txt"), join(memory, "link.md")),
    );
    expect(asked).toEqual(["Read"]);
    expect(results).not.toContain("outside");
  }, 30_000);

  test("Grep over a memory directory holding a symlink still asks", async () => {
    const { asked, results } = await callOnce(
      "Grep",
      { pattern: "outside", path: "$MEMORY", output_mode: "content" },
      async ({ home, memory }) => symlink(home, join(memory, "escape")),
    );
    expect(asked).toEqual(["Grep"]);
    expect(results).not.toContain("outside\\n");
  }, 30_000);

  test("Glob whose pattern climbs out with .. still asks", async () => {
    const { asked } = await callOnce("Glob", {
      pattern: "../../../../../*.txt",
      path: "$MEMORY",
    });
    expect(asked).toEqual(["Glob"]);
  }, 30_000);

  test("Grep given the memory directory as a relative path still asks", async () => {
    const { asked } = await callOnce("Grep", {
      pattern: "remembered",
      path: "$RELATIVE_MEMORY",
    });
    expect(asked).toEqual(["Grep"]);
  }, 30_000);

  test("Bash reading the memory index still asks", async () => {
    const { asked } = await callOnce(
      "Bash",
      { command: "cat $MEMORY/MEMORY.md 2>/dev/null" },
      async ({ memory }) => rm(join(memory, "MEMORY.md")),
    );
    expect(asked).toEqual(["Bash"]);
  }, 30_000);

  test("Write into the memory directory still asks", async () => {
    const { asked } = await callOnce("Write", {
      file_path: "$MEMORY/new.md",
      content: "x",
    });
    expect(asked).toEqual(["Write"]);
  }, 30_000);
});
