import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HeadBucketCommand } from "@aws-sdk/client-s3";
import { createStorageS3Client, storageS3Credentials } from "./index.ts";

/**
 * Without static keys the client signs with what the SDK's default chain
 * finds. On EKS that is IRSA: a projected web identity token exchanged at
 * STS. Both STS and the object store are loopback servers here, and the
 * chain's other sources are pointed at nothing so only the web identity can
 * answer.
 */
const CHAIN_ENV = [
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AWS_PROFILE",
  "AWS_CONFIG_FILE",
  "AWS_SHARED_CREDENTIALS_FILE",
  "AWS_WEB_IDENTITY_TOKEN_FILE",
  "AWS_ROLE_ARN",
  "AWS_ROLE_SESSION_NAME",
  "AWS_ENDPOINT_URL",
  "AWS_ENDPOINT_URL_STS",
  "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
  "AWS_CONTAINER_CREDENTIALS_FULL_URI",
  "AWS_EC2_METADATA_DISABLED",
  "AWS_REGION",
] as const;

const STS_KEY_ID = "ASIAWEBIDENTITYFAKE";

const saved = new Map<string, string | undefined>();
const closers: Array<() => void> = [];
let dir = "";

beforeEach(() => {
  for (const name of CHAIN_ENV) {
    saved.set(name, process.env[name]);
    delete process.env[name];
  }
  dir = mkdtempSync(join(tmpdir(), "storage-credentials-"));
  process.env.AWS_CONFIG_FILE = join(dir, "no-config");
  process.env.AWS_SHARED_CREDENTIALS_FILE = join(dir, "no-credentials");
  process.env.AWS_EC2_METADATA_DISABLED = "true";
  process.env.AWS_REGION = "ap-northeast-1";
});

afterEach(() => {
  for (const close of closers.splice(0)) close();
  for (const [name, value] of saved) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  saved.clear();
  rmSync(dir, { recursive: true, force: true });
});

async function serve(
  answer: (request: IncomingMessage, body: string) => [number, string],
): Promise<{
  requests: Array<{ authorization: string; body: string }>;
  url: string;
}> {
  const requests: Array<{ authorization: string; body: string }> = [];
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      requests.push({
        authorization: request.headers.authorization ?? "",
        body,
      });
      const [status, payload] = answer(request, body);
      response
        .writeHead(status, {
          "content-length": Buffer.byteLength(payload),
          "content-type": "text/xml",
        })
        .end(payload);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  closers.push(() => server.close());
  const { port } = server.address() as { port: number };
  return { requests, url: `http://127.0.0.1:${port}` };
}

function fakeSts() {
  return serve((_request, body) =>
    body.includes("Action=AssumeRoleWithWebIdentity")
      ? [
          200,
          `<AssumeRoleWithWebIdentityResponse xmlns="https://sts.amazonaws.com/doc/2011-06-15/">
  <AssumeRoleWithWebIdentityResult>
    <Credentials>
      <AccessKeyId>${STS_KEY_ID}</AccessKeyId>
      <SecretAccessKey>fake-sts-secret</SecretAccessKey>
      <SessionToken>fake-sts-session</SessionToken>
      <Expiration>2099-01-01T00:00:00Z</Expiration>
    </Credentials>
    <AssumedRoleUser>
      <Arn>arn:aws:sts::123456789012:assumed-role/agent-platform-api/api</Arn>
      <AssumedRoleId>AROAFAKE:api</AssumedRoleId>
    </AssumedRoleUser>
  </AssumeRoleWithWebIdentityResult>
  <ResponseMetadata><RequestId>fake</RequestId></ResponseMetadata>
</AssumeRoleWithWebIdentityResponse>`,
        ]
      : [400, "<ErrorResponse/>"],
  );
}

function useWebIdentity(stsUrl: string) {
  const tokenFile = join(dir, "token");
  writeFileSync(tokenFile, "fake-projected-token");
  process.env.AWS_WEB_IDENTITY_TOKEN_FILE = tokenFile;
  process.env.AWS_ROLE_ARN =
    "arn:aws:iam::123456789012:role/agent-platform-api";
  process.env.AWS_ROLE_SESSION_NAME = "api";
  process.env.AWS_ENDPOINT_URL_STS = stsUrl;
}

describe("storage S3 credentials", () => {
  test("static keys are used as given", () => {
    const keys = { accessKeyId: "id", secretAccessKey: "s" };
    expect(
      storageS3Credentials({ credentials: keys, region: "ap-northeast-1" }),
    ).toBe(keys);
  });

  test("without static keys the default chain resolves the IRSA web identity", async () => {
    const sts = await fakeSts();
    useWebIdentity(sts.url);
    const provider = storageS3Credentials({ region: "ap-northeast-1" });
    expect(typeof provider).toBe("function");
    const resolved = await (
      provider as () => Promise<{ accessKeyId: string }>
    )();
    expect(resolved.accessKeyId).toBe(STS_KEY_ID);
    expect(sts.requests).toHaveLength(1);
    expect(sts.requests[0]?.body).toContain(
      "WebIdentityToken=fake-projected-token",
    );
  });

  test("a keyless client signs its requests with the web identity's credentials", async () => {
    const sts = await fakeSts();
    useWebIdentity(sts.url);
    const objects = await serve(() => [200, ""]);
    const client = createStorageS3Client({
      s3: { endpoint: objects.url, region: "ap-northeast-1" },
    });
    closers.push(() => client.destroy());
    await client.send(new HeadBucketCommand({ Bucket: "claude-sessions" }));
    expect(objects.requests).toHaveLength(1);
    expect(objects.requests[0]?.authorization).toStartWith(
      `AWS4-HMAC-SHA256 Credential=${STS_KEY_ID}/`,
    );
  });

  test("a keyless client with no credential source sends nothing unsigned", async () => {
    const objects = await serve(() => [200, ""]);
    const client = createStorageS3Client({
      s3: { endpoint: objects.url, region: "ap-northeast-1" },
    });
    closers.push(() => client.destroy());
    await expect(
      client.send(new HeadBucketCommand({ Bucket: "claude-sessions" })),
    ).rejects.toThrow(/credentials/i);
    expect(objects.requests).toHaveLength(0);
  });
});
