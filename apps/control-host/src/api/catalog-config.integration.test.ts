import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  localstackEnabled,
  localstackEnv,
} from "@agent-platform/testkit/localstack";
import {
  CreateSecretCommand,
  DeleteSecretCommand,
  SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";
import { loadSessionCatalog, secretsManagerReader } from "./catalog-config.ts";

const integration = localstackEnabled() ? describe : describe.skip;

integration("catalog credentials from LocalStack Secrets Manager", () => {
  const secretId = `agent-platform/it/${crypto.randomUUID()}`;
  const value = `secret-${crypto.randomUUID()}`;
  let client: SecretsManagerClient;
  let dir: string;
  let env: Record<string, string>;

  beforeAll(async () => {
    const ls = localstackEnv();
    env = {
      AWS_REGION: ls.region,
      AWS_ENDPOINT_URL_SECRETS_MANAGER: ls.endpoint,
    };
    client = new SecretsManagerClient({
      region: ls.region,
      endpoint: ls.endpoint,
      credentials: {
        accessKeyId: ls.accessKeyId,
        secretAccessKey: ls.secretAccessKey,
      },
    });
    await client.send(
      new CreateSecretCommand({ Name: secretId, SecretString: value }),
    );
    dir = await mkdtemp(join(tmpdir(), "catalog-secrets-"));
    await writeFile(
      join(dir, "profiles.yaml"),
      `profiles:
  p:
    runtime_kind: claude_agent_sdk
    runtime_version: "0.3.270"
    model: claude-sonnet-5
    tools: [Read]
    permission_mode: default
    provider:
      kind: anthropic
      endpoint: https://api.anthropic.invalid
      auth:
        kind: api_key
        secret_id: ${secretId}
`,
    );
    await writeFile(
      join(dir, "repositories.yaml"),
      `repositories:
  app:
    url: https://git.example.invalid/app.git
    branch: main
    profiles: [p]
`,
    );
  });

  afterAll(async () => {
    await client.send(
      new DeleteSecretCommand({
        SecretId: secretId,
        ForceDeleteWithoutRecovery: true,
      }),
    );
    client.destroy();
    await rm(dir, { recursive: true, force: true });
  });

  test("resolves a secret_id reference at load through AWS_ENDPOINT_URL_SECRETS_MANAGER", async () => {
    const catalog = await loadSessionCatalog({
      dir,
      env,
      readSecret: secretsManagerReader(env),
    });
    expect(catalog.profiles.p?.provider.auth).toEqual({
      kind: "api_key",
      value,
      ref: { secret_id: secretId },
    });
  });

  test("a secret that does not exist stops the load with its name and the error class", async () => {
    const missing = `${secretId}-missing`;
    const load = loadSessionCatalog({
      dir,
      env,
      readSecret: async (id) =>
        secretsManagerReader(env)(id === secretId ? missing : id),
    });
    await expect(load).rejects.toThrow(
      `profiles.p.provider.auth.secret_id: ${secretId} could not be read (ResourceNotFoundException)`,
    );
  });
});
