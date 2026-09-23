/**
 * A worker's HTTP clients, run in their own process because Bun reads
 * `HTTP_PROXY` once at startup: `fetch` (the gateway client) and `node:http`
 * on a keep-alive agent (the S3 client), both to the proxy the environment
 * names. Bun pools proxy connections per proxy, not per origin, and its
 * node:http reuses one after a non-2xx answer even when told to close, so
 * each request after the first goes down whatever socket the last one left
 * open unless the proxy ended it.
 *
 * Usage: bun pooled-client.ts (fetch|http) METHOD URL [(fetch|http) METHOD URL]...
 * Prints `<status> <body>` per request, or `error <message>`. A PUT or POST
 * carries a body of 7240 bytes of "x" (a transcript part's size), except a
 * fetch POST, which sends "x".
 */
import http from "node:http";

const args = process.argv.slice(2);
if (args.length === 0 || args.length % 3 !== 0) {
  throw new Error("usage: pooled-client.ts (fetch|http) METHOD URL ...");
}

const agent = new http.Agent({ keepAlive: true });

function viaNodeHttp(method: string, url: string): Promise<string> {
  const body = method === "GET" ? undefined : "x".repeat(7240);
  return new Promise((resolve, reject) => {
    const request = http.request(
      url,
      {
        agent,
        headers:
          body === undefined ? {} : { "content-length": String(body.length) },
        method,
        timeout: 5_000,
      },
      (response) => {
        let text = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => {
          text += chunk;
        });
        response.on("end", () => resolve(`${response.statusCode} ${text}`));
      },
    );
    request.on("timeout", () => request.destroy(new Error("timed out")));
    request.on("error", reject);
    request.end(body);
  });
}

async function viaFetch(method: string, url: string): Promise<string> {
  const response = await fetch(url, {
    method,
    ...(method === "GET" ? {} : { body: "x" }),
    signal: AbortSignal.timeout(5_000),
  });
  return `${response.status} ${await response.text()}`;
}

for (let i = 0; i < args.length; i += 3) {
  const [client, method, url] = args.slice(i, i + 3) as [
    string,
    string,
    string,
  ];
  try {
    console.log(
      client === "fetch"
        ? await viaFetch(method, url)
        : await viaNodeHttp(method, url),
    );
  } catch (error) {
    console.log(`error ${(error as Error).message}`);
  }
}
agent.destroy();
