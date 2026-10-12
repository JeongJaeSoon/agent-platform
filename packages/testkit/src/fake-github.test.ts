import { afterAll, expect, test } from "bun:test";
import { generateKeyPairSync, sign } from "node:crypto";
import { startFakeGitHub } from "./fake-github.ts";

const app = generateKeyPairSync("rsa", { modulusLength: 2048 });
const stranger = generateKeyPairSync("rsa", { modulusLength: 2048 });
let clock = Date.now();
const github = await startFakeGitHub({
  appId: 7,
  publicKey: app.publicKey.export({ type: "spki", format: "pem" }).toString(),
  tokenTtlSeconds: 60,
  now: () => new Date(clock),
});
await github.createRepository("acme", "app", { "README.md": "hi\n" });
afterAll(async () => {
  await github.stop();
});

function jwt(key: typeof app.privateKey, claims: Record<string, unknown>) {
  const encode = (value: unknown) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  const unsigned = `${encode({ alg: "RS256", typ: "JWT" })}.${encode(claims)}`;
  return `${unsigned}.${sign("RSA-SHA256", Buffer.from(unsigned), key).toString("base64url")}`;
}
const seconds = () => Math.floor(clock / 1000);
const issue = (token: string) =>
  fetch(`${github.origin}/app/installations/9/access_tokens`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
    body: JSON.stringify({
      repositories: ["app"],
      permissions: { contents: "read" },
    }),
  });
const infoRefs = (token: string) =>
  fetch(`${github.origin}/acme/app.git/info/refs?service=git-upload-pack`, {
    headers: {
      authorization: `Basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`,
    },
  });

test("only a JWT the App signed, unexpired and at most ten minutes long, gets a token", async () => {
  const now = seconds();
  for (const token of [
    jwt(stranger.privateKey, { iss: 7, iat: now - 30, exp: now + 500 }),
    jwt(app.privateKey, { iss: 8, iat: now - 30, exp: now + 500 }),
    jwt(app.privateKey, { iss: 7, iat: now - 30, exp: now - 1 }),
    jwt(app.privateKey, { iss: 7, iat: now - 30, exp: now + 700 }),
  ]) {
    expect((await issue(token)).status).toBe(401);
  }
  const ok = await issue(
    jwt(app.privateKey, { iss: 7, iat: now - 30, exp: now + 500 }),
  );
  expect(ok.status).toBe(201);
  expect(github.tokenRequests.at(-1)).toMatchObject({
    installationId: 9,
    status: 201,
    body: { repositories: ["app"], permissions: { contents: "read" } },
    jwt: { iss: "7" },
  });
});

test("git takes an issued token until it expires", async () => {
  const now = seconds();
  const { token } = (await (
    await issue(jwt(app.privateKey, { iss: 7, iat: now - 30, exp: now + 500 }))
  ).json()) as { token: string };
  expect((await infoRefs(token)).status).toBe(200);
  expect((await infoRefs("ghs_never_issued")).status).toBe(401);
  clock += 61_000;
  expect((await infoRefs(token)).status).toBe(401);
  expect(github.gitRequests.map((r) => r.status)).toEqual([200, 401, 401]);
});
