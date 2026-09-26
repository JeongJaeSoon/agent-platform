import { describe, expect, test } from "bun:test";
import { sessionEventSchema } from "@agent-platform/contracts";

import { frameFromNativeMessage, pendingRequestEvent } from "./mapper.ts";

describe("native SDK message mapping", () => {
  test("projects assistant blocks and preserves correlation fields", () => {
    const frame = frameFromNativeMessage(
      {
        type: "assistant",
        uuid: "message-uuid",
        parent_tool_use_id: "parent-tool-id",
        message: {
          content: [
            { type: "text", text: "hello" },
            { type: "tool_use", id: "tool-id", name: "Read", input: {} },
          ],
        },
      },
      "correlation-1",
      "cursor",
    );
    expect(frame.events.map((item) => item.event)).toEqual([
      "assistant",
      "tool_use",
    ]);
    expect(frame.envelope.correlation_id).toBe("correlation-1");
    expect(JSON.stringify(frame)).toContain("message-uuid");
    expect(JSON.stringify(frame)).toContain("parent-tool-id");
    expect(JSON.stringify(frame)).toContain("tool-id");
    for (const item of frame.events) {
      expect(sessionEventSchema.parse(item)).toEqual(item);
    }
  });

  test("keeps partials only in the native envelope and versions unknown events", () => {
    const partial = frameFromNativeMessage(
      { type: "stream_event", event: { type: "content_block_delta" } },
      "correlation-2",
      "partial",
    );
    expect(partial.events).toEqual([]);
    expect(partial.envelope.message.type).toBe("stream_event");

    const unknown = frameFromNativeMessage(
      { type: "future_event", uuid: "future-uuid" },
      "correlation-3",
      "future",
    );
    expect(unknown.events[0]).toEqual(
      expect.objectContaining({
        event: "system",
        data: expect.objectContaining({
          subtype: "sdk_event",
          native_type: "future_event",
          schema_version: "sdk-envelope/v1",
        }),
      }),
    );
  });

  test("redacts credentials without losing request IDs or the working directory", () => {
    const credentialMarker = ["s", "k", "-ant-api03-marker-value"].join("");
    const frame = frameFromNativeMessage(
      {
        type: "system",
        subtype: "init",
        cwd: "/private/tenant",
        authorization: "Bearer private-token",
        diagnostic: credentialMarker,
        request_id: "request-1",
        tool_use_id: "tool-1",
      },
      "correlation-4",
      "init",
    );
    const serialized = JSON.stringify(frame);
    expect(serialized).toContain("/private/tenant");
    expect(serialized).not.toContain("private-token");
    expect(serialized).not.toContain(credentialMarker);
    expect(serialized).toContain("request-1");
    expect(serialized).toContain("tool-1");
  });

  test("projects permission and question requests with stable correlation", () => {
    const event = pendingRequestEvent(
      {
        input: { command: "pwd" },
        kind: "permission",
        requestId: "request-2",
        tool: "Bash",
        toolUseId: "tool-2",
      },
      "question",
    );
    expect(event.data).toEqual(
      expect.objectContaining({
        request_id: "request-2",
        tool_use_id: "tool-2",
      }),
    );
  });

  test("shows which file a tool request touches", () => {
    const inputs: Record<string, Record<string, string>> = {
      Write: { file_path: "/workspace/src/a.ts", content: "x" },
      Edit: {
        file_path: "/workspace/src/a.ts",
        old_string: "a",
        new_string: "b",
      },
      Read: { file_path: "/home/agent/.claude/settings.json" },
      Glob: { pattern: "**/*.ts", path: "/workspace/src" },
      Grep: { pattern: "TODO", path: "/workspace" },
      NotebookEdit: { notebook_path: "/workspace/n.ipynb", new_source: "x" },
    };
    for (const [tool, input] of Object.entries(inputs)) {
      const event = pendingRequestEvent(
        {
          input,
          kind: "permission",
          requestId: `request-${tool}`,
          tool,
          toolUseId: `tool-${tool}`,
        },
        "question",
      );
      expect(event.event === "question" ? event.data.input : null).toEqual(
        input,
      );
    }

    const frame = frameFromNativeMessage(
      {
        type: "assistant",
        message: {
          content: [
            {
              type: "tool_use",
              id: "tool-3",
              name: "Write",
              input: { file_path: "/workspace/src/a.ts", content: "x" },
            },
          ],
        },
      },
      "correlation-5",
      "tool",
    );
    expect(JSON.stringify(frame.events)).toContain("/workspace/src/a.ts");
  });

  test("hides only the value of a sensitive name when its end is clear", () => {
    const shown = (command: string) => {
      const event = pendingRequestEvent(
        {
          input: { command },
          kind: "permission",
          requestId: "request-4",
          tool: "Bash",
          toolUseId: "tool-4",
        },
        "question",
      );
      return event.event === "question"
        ? (event.data.input as { command: string }).command
        : "";
    };
    const value = ["v4lue", "0f", "api"].join("-");

    expect(shown(`curl "https://x.test/v1?api_key=${value}&q=1"`)).toBe(
      'curl "https://x.test/v1?api_key=[REDACTED]&q=1"',
    );
    expect(shown(`export API_KEY=${value} && ls /workspace`)).toBe(
      "export API_KEY=[REDACTED] && ls /workspace",
    );
    expect(shown(`api_key="${value} two" ./run.sh`)).toBe(
      "api_key=[REDACTED] ./run.sh",
    );
    expect(shown(`run --api-key='${value}' --verbose`)).toBe(
      "run --api-key=[REDACTED] --verbose",
    );

    // Where the value's end is unclear, nothing is shown.
    for (const command of [
      `API_KEY=$'${value} two' ./run`,
      `API_KEY="${value}\\"two" ./run`,
      `API_KEY=${value}\\\ntwo ./run`,
      `API_KEY=${value}\\&two ./run`,
      `API_KEY=${value}"two" ./run`,
      `API_KEY="$(cat key)${value}" ./run`,
      `curl -H 'X-Api-Key: ${value}' https://x.test`,
      `curl -H 'Authorization: Digest username="a", response="${value}"'`,
      `user: me\npassword: ${value}\n  two\nhost: db`,
      `cat <<EOF\npassword: |\n  ${value}\nEOF`,
      `echo password=\n${value}`,
      `grep -rn "api_key=" /workspace`,
      `password: [REDACTED] ${value}`,
      `api_key=x:${value}"`,
    ]) {
      expect(shown(command)).toBe("[REDACTED]");
    }
  });

  test("hides a value in linear time when its end is unclear", () => {
    const command = `${"api_key=x:".repeat(50_000)}"`;
    const event = pendingRequestEvent(
      {
        input: { command },
        kind: "permission",
        requestId: "request-6",
        tool: "Bash",
        toolUseId: "tool-6",
      },
      "question",
    );
    expect(event.event === "question" ? event.data.input : null).toEqual({
      command: "[REDACTED]",
    });
  });

  test("shows a path but still hides a value that reads like a sensitive name", () => {
    const shown = (input: Record<string, string>) => {
      const event = pendingRequestEvent(
        {
          input,
          kind: "permission",
          requestId: "request-5",
          tool: "Write",
          toolUseId: "tool-5",
        },
        "question",
      );
      return event.event === "question" ? event.data.input : null;
    };
    expect(shown({ file_path: "/workspace/api_key=fixture.txt" })).toEqual({
      file_path: "/workspace/api_key=[REDACTED]",
    });
    expect(shown({ request_path: "/v1/jobs?api_key=violet&page=2" })).toEqual({
      request_path: "/v1/jobs?api_key=[REDACTED]&page=2",
    });
  });
});
