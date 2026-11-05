import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  CreateSecretCommand,
  DeleteSecretCommand,
  SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";
import { localstackEnabled, localstackEnv } from "@werft-ai/testkit/localstack";
import { secretsManagerReader } from "./catalog-config.ts";

const integration = localstackEnabled() ? describe : describe.skip;

integration("credentials from LocalStack Secrets Manager", () => {
  const secretId = `werft/it/${crypto.randomUUID()}`;
  const value = `secret-${crypto.randomUUID()}`;
  let client: SecretsManagerClient;
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
  });

  afterAll(async () => {
    await client.send(
      new DeleteSecretCommand({
        SecretId: secretId,
        ForceDeleteWithoutRecovery: true,
      }),
    );
    client.destroy();
  });

  test("reads a secret_id reference through AWS_ENDPOINT_URL_SECRETS_MANAGER", async () => {
    expect(await secretsManagerReader(env)(secretId)).toBe(value);
  });

  test("a secret that does not exist fails with the store's error class", async () => {
    await expect(
      secretsManagerReader(env)(`${secretId}-missing`),
    ).rejects.toMatchObject({ name: "ResourceNotFoundException" });
  });
});
