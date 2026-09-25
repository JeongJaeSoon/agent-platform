/**
 * Reproduces the response body stall of Bun's `node:http` client (94S-441):
 * under concurrent keep-alive requests, a body stops partway and never
 * resumes. The worker's and the API's S3 clients (the AWS SDK's
 * NodeHttpHandler) read every response this way; in the RC3 soak it was a
 * transcript ListObjectsV2 that stalled, 5 in 7,071.
 *
 * Measured on macOS arm64 with the defaults (6,000 list bodies of 90–390 KB):
 * Bun 1.3.10 and 1.3.11 stall 2–16 of them, 1.3.12 and later none. The
 * server runs under Node, so the stall is the client's.
 *
 *   bun scripts/bun-http-stall/client.ts [--sessions 4] [--parallel 4] [--rounds 1500]
 *
 * Needs `node` on PATH. Exits 1 when any body stalled.
 */
import http from "node:http";
import { join } from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    sessions: { type: "string", default: "4" },
    parallel: { type: "string", default: "4" },
    rounds: { type: "string", default: "1500" },
    "stall-ms": { type: "string", default: "5000" },
  },
});
const sessions = Number(values.sessions);
const parallel = Number(values.parallel);
const rounds = Number(values.rounds);
const stallMs = Number(values["stall-ms"]);

const server = Bun.spawn(["node", join(import.meta.dir, "server.mjs")], {
  stdout: "pipe",
  stderr: "inherit",
});
const reader = server.stdout.getReader();
const first = await reader.read();
reader.releaseLock();
const { port } = JSON.parse(new TextDecoder().decode(first.value)) as {
  port: number;
};

const agent = new http.Agent({ keepAlive: true, maxSockets: 50 });

let lists = 0;
const stalls: string[] = [];

/** Resolves once the body ended or, recorded in `stalls`, stopped. */
function exchange(method: string, path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = http.request(
      { host: "127.0.0.1", port, method, path, agent },
      (response) => {
        let bytes = 0;
        // Every body here arrives in milliseconds; this is the head-to-end
        // bound, well past anything but a stall.
        const timer = setTimeout(() => {
          stalls.push(`${method} ${path} stopped after ${bytes} bytes`);
          response.destroy();
          resolve();
        }, stallMs);
        response.on("data", (chunk: Buffer) => {
          bytes += chunk.byteLength;
        });
        response.on("end", () => {
          clearTimeout(timer);
          resolve();
        });
        response.on("error", (error) => {
          clearTimeout(timer);
          reject(error);
        });
      },
    );
    request.on("error", reject);
    request.end(method === "PUT" ? new Uint8Array(9) : undefined);
  });
}

// One checkpoint-shaped round per step: uploads, the transcript list, reads.
async function session(id: number): Promise<void> {
  for (let round = 0; round < rounds; round++) {
    await Promise.all(
      Array.from({ length: parallel }, (_, k) =>
        exchange("PUT", `/s${id}/upload-${round}-${k}`),
      ),
    );
    const keys = 200 + Math.floor(Math.random() * 700);
    await exchange("GET", `/?list-type=2&keys=${keys}&s=${id}`);
    lists++;
    await Promise.all(
      Array.from({ length: parallel }, (_, k) =>
        exchange("GET", `/s${id}/part-${k}?bytes=${1000 + k * 100}`),
      ),
    );
  }
}

try {
  await Promise.all(Array.from({ length: sessions }, (_, id) => session(id)));
} finally {
  server.kill();
}
console.log(
  JSON.stringify({
    bun: Bun.version,
    revision: Bun.revision,
    lists,
    stalls: stalls.length,
    examples: stalls.slice(0, 3),
  }),
);
process.exit(stalls.length > 0 ? 1 : 0);
