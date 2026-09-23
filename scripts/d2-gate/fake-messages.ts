import { startFakeAnthropicServer } from "../../packages/testkit/src/fake-anthropic.ts";
import {
  type GateRequest,
  replyFor,
} from "../../packages/testkit/src/scripted-messages.ts";

/**
 * The D2 gate's Messages API (94S-247): the scripted fake of
 * packages/testkit/src/scripted-messages.ts, which the compose stack's
 * fake-messages also plays (94S-134), served with the gate's control port.
 */

export {
  type GateRequest,
  type GateSpec,
  type GateStep,
  planOf,
  replyFor,
  SPEC_MARKER,
} from "../../packages/testkit/src/scripted-messages.ts";

if (import.meta.main) {
  const recorded: GateRequest[] = [];
  const port = Number(process.env.FAKE_MESSAGES_PORT ?? "4010");
  const controlPort = Number(process.env.GATE_CONTROL_PORT ?? "4011");
  startFakeAnthropicServer((request) => replyFor(request, recorded), {
    listen: { hostname: "0.0.0.0", port },
  });
  // Read by the gate test from the host; workers only ever see `port`.
  Bun.serve({
    hostname: "0.0.0.0",
    port: controlPort,
    fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/healthz") return new Response("ok");
      if (url.pathname !== "/requests") {
        return new Response("not found", { status: 404 });
      }
      const spec = url.searchParams.get("spec");
      return Response.json(
        spec === null
          ? recorded
          : recorded.filter((entry) => entry.specId === spec),
      );
    },
  });
  console.log(
    JSON.stringify({ msg: "Gate Messages API listening", port, controlPort }),
  );
  process.on("SIGTERM", () => process.exit(0));
}
