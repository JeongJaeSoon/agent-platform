import { afterEach, describe, expect, test } from "bun:test";
import { createServer } from "node:net";
import {
  type FakeAnthropicServer,
  type FakeFailure,
  overloadedError,
  quotaError,
  serverError,
  startFakeAnthropicServer,
  textReply,
} from "@agent-platform/testkit/fake-anthropic";
import {
  createIsolatedWorkspace,
  type IsolatedWorkspace,
} from "@agent-platform/testkit/workspace";
import { ClaudeSdkRuntime } from "./runtime.ts";

let isolated: IsolatedWorkspace | undefined;
let server: FakeAnthropicServer | undefined;

afterEach(async () => {
  server?.stop();
  await isolated?.dispose();
  isolated = undefined;
  server = undefined;
});

type Native = Record<string, unknown> & { type: string };

/** Runs one turn against `endpoint` and returns every native message it saw. */
async function oneTurn(
  endpoint: string,
  providerMaxRetries: number,
): Promise<Native[]> {
  isolated = await createIsolatedWorkspace({ prefix: "94s-131-" });
  const { home, workspace } = isolated;
  const runtime = new ClaudeSdkRuntime({
    endpoints: [endpoint],
    models: ["claude-sonnet-4-5"],
  });
  const run = runtime.start(
    {
      claudeConfigDir: home,
      correlationId: "provider-retry",
      mode: "new",
      cwd: workspace,
      home,
      maxTurns: 4,
      model: "claude-sonnet-4-5",
      profile: {
        kind: "anthropic",
        endpoint,
        auth: { kind: "api_key", value: "placeholder-local" },
        principal: { ownerScope: "owner-a" },
      },
      providerMaxRetries,
      settingSources: ["project"],
      tools: [],
    },
    { onPermission: async () => ({ behavior: "deny", message: "no" }) },
  );
  const seen: Native[] = [];
  run.send({ message: "hello", uuid: crypto.randomUUID() });
  let finished = false;
  try {
    for await (const frame of run) {
      const native = frame.envelope.message as Native;
      seen.push(native);
      if (native.type === "result") {
        finished = true;
        run.finishInput();
      }
    }
  } catch (error) {
    // A session whose last turn failed exits 1 once its input closes; the
    // process stays up until then, so only a throw before the result is real.
    if (!finished) throw error;
  }
  return seen;
}

function resultOf(seen: Native[]): Native {
  const result = seen.find((native) => native.type === "result");
  expect(result).toBeDefined();
  return result as Native;
}

function retryStatuses(seen: Native[]): unknown[] {
  return seen
    .filter(
      (native) => native.type === "system" && native.subtype === "api_retry",
    )
    .map((native) => native.error_status);
}

describe("provider retries with the actual Claude SDK", () => {
  const failures: [string, FakeFailure][] = [
    ["500", serverError(500)],
    ["529", overloadedError()],
    ["429", quotaError()],
  ];
  for (const [label, failure] of failures) {
    test(`${label}: retries PROVIDER_MAX_RETRIES times, then ends the turn as api_error`, async () => {
      server = startFakeAnthropicServer(textReply("never"), {
        failWith: failure,
      });
      const seen = await oneTurn(server.url, 2);

      expect(server.requests).toHaveLength(3);
      expect(retryStatuses(seen)).toEqual([failure.status, failure.status]);
      expect(resultOf(seen)).toMatchObject({
        is_error: true,
        terminal_reason: "api_error",
      });
    }, 60_000);
  }

  test("zero retries sends the request once", async () => {
    server = startFakeAnthropicServer(textReply("never"), {
      failWith: serverError(500),
    });
    const seen = await oneTurn(server.url, 0);

    expect(server.requests).toHaveLength(1);
    expect(retryStatuses(seen)).toEqual([]);
    expect(resultOf(seen)).toMatchObject({ terminal_reason: "api_error" });
  }, 60_000);

  test("a refused connection retries without a status and ends as api_error", async () => {
    const closed = createServer();
    await new Promise<void>((resolve) =>
      closed.listen(0, "127.0.0.1", resolve),
    );
    const address = closed.address();
    if (address === null || typeof address === "string") {
      throw new Error("no port");
    }
    await new Promise<void>((resolve) => closed.close(() => resolve()));

    const seen = await oneTurn(`http://127.0.0.1:${address.port}`, 2);

    expect(retryStatuses(seen)).toHaveLength(2);
    expect(resultOf(seen)).toMatchObject({
      is_error: true,
      terminal_reason: "api_error",
    });
  }, 60_000);
});
