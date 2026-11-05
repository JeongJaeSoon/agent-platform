import { createPublicKey, generateKeyPairSync } from "node:crypto";
import {
  CreateSecretCommand,
  GetSecretValueCommand,
  SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";
import { startFakeGitHub } from "./fake-github.ts";

// Local catalogs use production's App JWT and installation-token flow.
// Signing material stays in this disposable stack's private secret store.
const env = process.env;
const secrets = new SecretsManagerClient({
  endpoint: env.AWS_ENDPOINT_URL_SECRETS_MANAGER ?? "http://secrets:4566",
  region: env.AWS_REGION ?? "ap-northeast-1",
});
const secretId = "agent-platform/local/fake-github-app";
let privateKey: string;
try {
  const stored = await secrets.send(
    new GetSecretValueCommand({ SecretId: secretId }),
  );
  if (!stored.SecretString) throw new Error("local App signing key is empty");
  privateKey = stored.SecretString;
} catch (error) {
  if (!(error instanceof Error) || error.name !== "ResourceNotFoundException")
    throw error;
  privateKey = generateKeyPairSync("rsa", { modulusLength: 2048 })
    .privateKey.export({ type: "pkcs8", format: "pem" })
    .toString();
  await secrets.send(
    new CreateSecretCommand({ Name: secretId, SecretString: privateKey }),
  );
}
secrets.destroy();
const git = await startFakeGitHub({
  appId: 1,
  installationId: 1,
  publicKey: createPublicKey(privateKey)
    .export({ type: "spki", format: "pem" })
    .toString(),
  hostname: "0.0.0.0",
  port: Number(env.FAKE_GIT_PORT ?? "3000"),
});
const repositories = process.argv.slice(2);
if (repositories.length === 0)
  throw new Error("at least one repository is required");
for (const name of repositories) {
  await git.createRepository(env.FAKE_GIT_OWNER ?? "agent", name, {
    "README.md": `# ${name}\n`,
  });
}
console.log(
  JSON.stringify({
    msg: "Local fake GitHub App listening",
    port: git.port,
    repositories,
  }),
);
process.on("SIGTERM", async () => {
  await git.stop();
  process.exit(0);
});
