import { startFakeAnthropicServer } from "./fake-anthropic.ts";
import { type GateRequest, replyFor } from "./scripted-messages.ts";

// The local stack's Messages API (94S-132): the example profile in
// config/profiles.yaml points here, so a session runs end to end without an
// Anthropic account. A message carrying a GATE-SPEC plays that script
// (docs/quickstart.md, tests/e2e); any other gets the same short answer.
const FALLBACK = "Hello from the local fake Messages API.";
// Nothing reads the record here; it only has to stay bounded while the
// stack runs for days.
const KEEP_RECORDED = 100;

const port = Number(process.env.FAKE_MESSAGES_PORT ?? "4010");
const recorded: GateRequest[] = [];
const server = startFakeAnthropicServer(
  (request) => {
    if (recorded.length >= KEEP_RECORDED) recorded.length = 0;
    return replyFor(request, recorded, FALLBACK);
  },
  { listen: { hostname: "0.0.0.0", port } },
);
console.log(
  JSON.stringify({ msg: "Fake Messages API listening", url: server.url }),
);
process.on("SIGTERM", () => {
  server.stop();
  process.exit(0);
});
