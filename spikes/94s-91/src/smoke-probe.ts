import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  createProbeContext,
  runSdkQuery,
  startFakeAnthropicServer,
  textReply,
} from "./harness";

const context = await createProbeContext();
const server = startFakeAnthropicServer(() => textReply("SDK smoke passed"));

try {
  await writeFile(
    join(context.workspace, "CLAUDE.md"),
    "PROJECT_INSTRUCTION_SENTINEL_94S_91",
  );
  const messages = await runSdkQuery(context, server.url, "Reply briefly.", {
    maxTurns: 1,
  });
  const requestText = JSON.stringify(server.requests);
  const outputText = JSON.stringify(messages);

  console.log(
    JSON.stringify(
      {
        executable: context.executable,
        outputContainsSmoke: outputText.includes("SDK smoke passed"),
        projectInstructionLoaded: requestText.includes(
          "PROJECT_INSTRUCTION_SENTINEL_94S_91",
        ),
        requestPath: server.requests[0]?.path,
        sdkMessageTypes: messages.map((message) => message.type),
        systemAppendLoaded: requestText.includes("APPEND_SENTINEL_94S_91"),
      },
      null,
      2,
    ),
  );
} finally {
  server.stop();
  await context.dispose();
}
