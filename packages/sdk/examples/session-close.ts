// Creates a session, sends a message, answers its permission request while
// waiting on the event stream, then closes the session.
//
//   WERFT_BASE_URL=http://127.0.0.1:3000 WERFT_API_KEY=... \
//     bun packages/sdk/examples/session-close.ts
//
// The key needs sessions:read, sessions:write, sessions:approve and
// sessions:control. The messages are GATE-SPEC scripts for the fake model;
// a real model takes plain prompts.
import {
  closeResult,
  isApiError,
  type PendingRequestHandlers,
  type SessionId,
  Werft,
  waitForReceipt,
  waitForTurn,
} from "@werft-ai/sdk";

const client = new Werft();
const signal = AbortSignal.timeout(5 * 60_000);
const profile_id = process.env.WERFT_PROFILE_ID ?? "claude-coding-local";
const repository_id = process.env.WERFT_REPOSITORY_ID ?? "sample-app";

const COMMAND = "echo alpha > hello.txt";
// A handler is a security boundary: allow the exact command, deny the rest.
const approvals: PendingRequestHandlers = {
  permission(request) {
    const command = (request.input as { command?: unknown } | null)?.command;
    if (request.tool === "Bash" && command === COMMAND) {
      console.log(
        `permission ${request.request_id}: allow ${request.tool} "${command}"`,
      );
      return { decision: "allow" };
    }
    return { decision: "deny", reason: `This script only allows: ${COMMAND}` };
  },
};

async function run(): Promise<void> {
  const created = await client.sessions.create(
    {
      profile_id,
      repository_id,
      message:
        'GATE-SPEC {"id":"sdk1","steps":[],"final":"hello from the SDK"}',
    },
    { signal },
  );
  const sessionId: SessionId = created.session_id;
  console.log(
    `session ${sessionId}: created, turn ${created.turn_id} ${created.status}`,
  );

  let lastEventId: string | undefined;
  const first = await waitForTurn(client, sessionId, created.turn_id, {
    signal,
    events: {
      onEvent(event) {
        lastEventId = event.id;
        console.log(
          `  event ${event.kind}${event.turn_id ? ` (turn ${event.turn_id})` : ""}`,
        );
      },
    },
  });
  console.log(`turn ${first.turn_id}: ${first.status}`);

  const sent = await client.sessions.messages.send(
    sessionId,
    {
      message: `GATE-SPEC ${JSON.stringify({
        id: "sdk2",
        steps: [
          {
            tool: "Bash",
            input: { command: COMMAND, description: "write hello.txt" },
          },
        ],
        final: "wrote hello.txt",
      })}`,
    },
    { signal },
  );
  const second = await waitForTurn(client, sessionId, sent.turn_id, {
    signal,
    onRequest: approvals,
    onAnswer: (outcome) =>
      console.log(`answer ${outcome.request_id}: ${outcome.outcome}`),
    events: {
      ...(lastEventId ? { lastEventId } : {}),
      onEvent: (event) =>
        console.log(
          `  event ${event.kind}${event.turn_id ? ` (turn ${event.turn_id})` : ""}`,
        ),
    },
  });
  console.log(`turn ${second.turn_id}: ${second.status}`);

  const { revision } = await client.sessions.get(sessionId, { signal });
  const accepted = await client.sessions.close(
    sessionId,
    { expected_revision: revision, reason: "script finished" },
    { signal },
  );
  console.log(`close: receipt ${accepted.receipt_status}`);
  const receipt = await waitForReceipt(client, accepted.receipt_id, { signal });
  console.log(`close: receipt ${receipt.status}`, closeResult(receipt));

  const closed = await client.sessions.get(sessionId, { signal });
  console.log(
    `session ${sessionId}: admission ${closed.admission_state}, status ${closed.status}`,
  );

  const refused = await client.sessions.messages
    .send(sessionId, { message: "one more" }, { signal })
    .catch((error: unknown) => error);
  console.log(
    "message after close:",
    isApiError(refused) ? `${refused.status} ${refused.code}` : refused,
  );
}

try {
  await run();
} catch (error) {
  if (isApiError(error))
    console.error(error.code, error.message, "request_id:", error.requestId);
  throw error;
}
