import { startFakeAnthropicServer, textReply } from "./fake-anthropic.ts";

// The local stack's Messages API (94S-132): the example profile in
// config/profiles.yaml points here, so a session runs end to end without an
// Anthropic account. Every request gets the same short answer.
const port = Number(process.env.FAKE_MESSAGES_PORT ?? "4010");
const server = startFakeAnthropicServer(
  textReply("Hello from the local fake Messages API."),
  { listen: { hostname: "0.0.0.0", port } },
);
console.log(
  JSON.stringify({ msg: "Fake Messages API listening", url: server.url }),
);
process.on("SIGTERM", () => {
  server.stop();
  process.exit(0);
});
