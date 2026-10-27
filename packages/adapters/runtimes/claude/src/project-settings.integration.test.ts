import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  type FakeAnthropicServer,
  startFakeAnthropicServer,
  textReply,
} from "@werft-ai/testkit/fake-anthropic";
import {
  createIsolatedWorkspace,
  type IsolatedWorkspace,
} from "@werft-ai/testkit/workspace";

import { ClaudeSdkRuntime } from "./runtime.ts";

const MODEL = "claude-sonnet-4-5";
const INSTRUCTIONS = "REPOSITORY_RULE_94S_258: run bun test before committing.";

let isolated: IsolatedWorkspace | undefined;
let server: FakeAnthropicServer | undefined;

afterEach(async () => {
  server?.stop();
  await isolated?.dispose();
  isolated = undefined;
  server = undefined;
});

// The negative control for apps/worker's project-settings test: without it, a
// marker that never appears there would prove only that these hooks cannot
// fire, not that the worker stops them.
describe("a checkout's own Claude project settings", () => {
  test("are live when the engine loads the project source itself", async () => {
    isolated = await createIsolatedWorkspace({ prefix: "94s-258-" });
    const { home, root, workspace } = isolated;
    const markers = ["session-start", "prompt-submit"].map((name) =>
      join(root, `${name}.marker`),
    );
    const command = (marker: string) => ({
      hooks: [{ type: "command", command: `touch '${marker}'` }],
    });
    await mkdir(join(workspace, ".claude"), { recursive: true });
    await writeFile(
      join(workspace, ".claude", "settings.json"),
      JSON.stringify({
        hooks: {
          SessionStart: [command(markers[0] ?? "")],
          UserPromptSubmit: [command(markers[1] ?? "")],
        },
      }),
    );
    await writeFile(join(workspace, "CLAUDE.md"), `${INSTRUCTIONS}\n`);
    server = startFakeAnthropicServer(() => textReply("ok"));

    const run = new ClaudeSdkRuntime({
      endpoints: [server.url],
      models: [MODEL],
    }).start(
      {
        claudeConfigDir: home,
        correlationId: "control",
        cwd: workspace,
        home,
        maxTurns: 2,
        mode: "new",
        model: MODEL,
        profile: {
          kind: "anthropic",
          endpoint: server.url,
          auth: { kind: "api_key", value: "placeholder-local" },
          principal: { ownerScope: "owner-a" },
        },
        settingSources: ["project"],
        tools: [],
      },
      {
        onPermission: async () => ({ behavior: "deny", message: "none" }),
      },
    );
    const consume = (async () => {
      for await (const _frame of run) {
      }
    })();
    run.send({ message: "hello", uuid: crypto.randomUUID() });
    run.finishInput();
    await consume;

    expect(server.requests.length).toBeGreaterThan(0);
    expect(markers.filter((marker) => existsSync(marker))).toEqual(markers);
    expect(JSON.stringify(server.requests[0]?.body)).toContain(INSTRUCTIONS);
  }, 60_000);
});
