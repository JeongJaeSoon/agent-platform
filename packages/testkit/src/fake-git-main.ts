import { startFakeGit } from "./fake-git.ts";

// An unauthenticated host for isolated HTTP transport tests.
// Local catalogs use local-github-main.ts instead.
// `bun fake-git-main.ts sample-app gate-app` serves
// http://<host>:3000/agent/sample-app.git and .../gate-app.git, read-only.
// FAKE_GIT_PORT and FAKE_GIT_OWNER set the test URL;
// FAKE_GIT_REQUEST_LIMIT caps GET /requests.
const env = process.env;
const git = await startFakeGit({
  repositories: process.argv.slice(2),
  owner: env.FAKE_GIT_OWNER ?? "agent",
  hostname: "0.0.0.0",
  port: Number(env.FAKE_GIT_PORT ?? "3000"),
  requestLimit: Number(env.FAKE_GIT_REQUEST_LIMIT ?? "1000"),
});

console.log(
  JSON.stringify({
    msg: "Fake git listening",
    port: git.port,
    heads: git.heads,
  }),
);
process.on("SIGTERM", async () => {
  await git.stop();
  process.exit(0);
});
