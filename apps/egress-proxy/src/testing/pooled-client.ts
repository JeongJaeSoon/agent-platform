/**
 * A worker's two HTTP clients, run in their own process because Bun reads
 * `HTTP_PROXY` once at startup: a `fetch` POST (the gateway client) and then
 * a `node:http` GET on a keep-alive agent (the S3 client), both to the
 * proxy the environment names. Bun pools proxy connections per proxy, not
 * per origin, so the GET is sent down the socket the POST left open unless
 * the proxy said to close it. Prints each response body on its own line.
 *
 * Usage: bun pooled-client.ts <post-url> <get-url>
 */
import http from "node:http";

const [postUrl, getUrl] = process.argv.slice(2);
if (postUrl === undefined || getUrl === undefined) {
  throw new Error("usage: pooled-client.ts <post-url> <get-url>");
}

const posted = await fetch(postUrl, { body: "x", method: "POST" });
console.log(await posted.text());

const agent = new http.Agent({ keepAlive: true });
const got = await new Promise<string>((resolve, reject) => {
  const request = http.request(getUrl, { agent }, (response) => {
    let body = "";
    response.setEncoding("utf8");
    response.on("data", (chunk: string) => {
      body += chunk;
    });
    response.on("end", () => resolve(body));
  });
  request.on("error", reject);
  request.end();
});
console.log(got);
agent.destroy();
