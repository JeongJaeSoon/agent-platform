import { expect, test } from "bun:test";
import { createServer, type Socket } from "node:net";
import { createLogger, MemoryLogSink } from "@agent-platform/observability";
import { migrateDatabase } from "./migrate.ts";

test("a database that accepts the connection but never answers fails the migrate", async () => {
  const sockets: Socket[] = [];
  const server = createServer((socket) => sockets.push(socket));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  try {
    const started = performance.now();
    await expect(
      migrateDatabase(`postgresql://user:pw@127.0.0.1:${port}/sessions`, {
        logger: createLogger({ sinks: [new MemoryLogSink()] }),
        timeouts: { connectMs: 200, statementMs: 1_000, queryMs: 2_000 },
      }),
    ).rejects.toThrow();
    expect(performance.now() - started).toBeLessThan(5_000);
  } finally {
    for (const socket of sockets) socket.destroy();
    server.close();
  }
});
