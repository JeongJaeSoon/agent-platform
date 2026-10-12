import { startFakeGitHub } from "./fake-github.ts";

// A GitHub App's GitHub for a local stack: a catalog repository with
// `auth.kind: github_app` and `api_base` pointing here clones without a real
// App. Each token and git request is logged as one JSON line, with the
// request body and JWT claims but never a token. A second port, on no
// worker's allowlist, switches the token endpoint to failing.
const env = process.env;
const appId = Number(env.FAKE_GITHUB_APP_ID ?? "1");
const publicKey = (env.FAKE_GITHUB_PUBLIC_KEY ?? "").replace(/\\n/g, "\n");
const [owner = "acme", name = "app"] = (
  env.FAKE_GITHUB_REPOSITORY ?? "acme/app"
).split("/");

const github = await startFakeGitHub({
  appId,
  publicKey,
  hostname: "0.0.0.0",
  port: Number(env.FAKE_GITHUB_PORT ?? "8080"),
  tokenTtlSeconds: Number(env.FAKE_GITHUB_TOKEN_TTL_SECONDS ?? "3600"),
});
await github.createRepository(owner, name, {
  "README.md": `# ${name}\n\nServed by the local fake GitHub.\n`,
});

let tokensLogged = 0;
let gitLogged = 0;
setInterval(() => {
  for (const entry of github.tokenRequests.slice(tokensLogged)) {
    console.log(JSON.stringify({ msg: "token request", ...entry }));
  }
  tokensLogged = github.tokenRequests.length;
  for (const entry of github.gitRequests.slice(gitLogged)) {
    console.log(JSON.stringify({ msg: "git request", ...entry }));
  }
  gitLogged = github.gitRequests.length;
}, 200);

Bun.serve({
  hostname: "0.0.0.0",
  port: Number(env.FAKE_GITHUB_CONTROL_PORT ?? "8081"),
  fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/healthz") return new Response("ok");
    if (url.pathname === "/fail-tokens" && request.method === "POST") {
      const on = url.searchParams.get("on") === "1";
      github.failTokens(on);
      console.log(JSON.stringify({ msg: "token endpoint failing", on }));
      return new Response(on ? "failing\n" : "issuing\n");
    }
    return new Response("not found", { status: 404 });
  },
});

console.log(
  JSON.stringify({
    msg: "Fake GitHub listening",
    port: github.port,
    repository: `${owner}/${name}`,
  }),
);
process.on("SIGTERM", async () => {
  await github.stop();
  process.exit(0);
});
