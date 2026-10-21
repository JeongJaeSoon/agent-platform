import { startFakeGitHub } from "./fake-github.ts";

// A GitHub App's GitHub for a local stack: a catalog repository with
// `auth.kind: github_app` and `api_base` pointing here clones without a real
// App. Each token and git request is logged as one JSON line, with the
// request body and JWT claims but never a token. A second port, on no
// worker's allowlist, switches the token endpoint to failing, lists the
// repository's refs (GET /refs), moves a branch off its history
// (POST /unrelated?branch=<name>), changes the default branch
// (POST /default-branch?branch=<name>), lists the pull requests and their
// comments as received (GET /pulls) and rate-limits the next REST calls
// (POST /rate-limit?count=<n>&limit=primary|secondary).
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
let apiLogged = 0;
setInterval(() => {
  for (const entry of github.tokenRequests.slice(tokensLogged)) {
    console.log(JSON.stringify({ msg: "token request", ...entry }));
  }
  tokensLogged = github.tokenRequests.length;
  for (const entry of github.gitRequests.slice(gitLogged)) {
    console.log(JSON.stringify({ msg: "git request", ...entry }));
  }
  gitLogged = github.gitRequests.length;
  for (const entry of github.apiRequests.slice(apiLogged)) {
    console.log(JSON.stringify({ msg: "api request", ...entry }));
  }
  apiLogged = github.apiRequests.length;
}, 200);

Bun.serve({
  hostname: "0.0.0.0",
  port: Number(env.FAKE_GITHUB_CONTROL_PORT ?? "8081"),
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/healthz") return new Response("ok");
    if (url.pathname === "/fail-tokens" && request.method === "POST") {
      const on = url.searchParams.get("on") === "1";
      github.failTokens(on);
      console.log(JSON.stringify({ msg: "token endpoint failing", on }));
      return new Response(on ? "failing\n" : "issuing\n");
    }
    if (url.pathname === "/refs" && request.method === "GET") {
      return Response.json(await github.refs(owner, name));
    }
    if (url.pathname === "/pulls" && request.method === "GET") {
      return Response.json(
        github.pullRequests(owner, name).map((pull) => ({
          ...pull,
          comments: github.comments(owner, name, pull.number),
        })),
      );
    }
    if (url.pathname === "/rate-limit" && request.method === "POST") {
      const count = Number(url.searchParams.get("count") ?? "1");
      const limit =
        url.searchParams.get("limit") === "primary" ? "primary" : "secondary";
      github.rateLimitNext(count, limit);
      console.log(JSON.stringify({ msg: "rate limit", count, limit }));
      return Response.json({ count, limit });
    }
    const branch = url.searchParams.get("branch");
    if (url.pathname === "/unrelated" && request.method === "POST" && branch) {
      const commit = await github.writeUnrelatedCommit(owner, name, branch);
      console.log(JSON.stringify({ msg: "unrelated commit", branch, commit }));
      return Response.json({ branch, commit });
    }
    if (
      url.pathname === "/default-branch" &&
      request.method === "POST" &&
      branch
    ) {
      await github.setDefaultBranch(owner, name, branch);
      console.log(JSON.stringify({ msg: "default branch", branch }));
      return Response.json({ default_branch: branch });
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
