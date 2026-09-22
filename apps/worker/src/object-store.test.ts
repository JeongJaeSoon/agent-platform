import { describe, expect, test } from "bun:test";

import {
  createWorkerObjectStore,
  objectStoreConfigFromEnv,
} from "./object-store.ts";

const base = {
  AWS_ACCESS_KEY_ID: "AKIATEST",
  AWS_ENDPOINT_URL: "http://localstack:4566",
  AWS_REGION: "ap-northeast-1",
  AWS_SECRET_ACCESS_KEY: "not-a-real-secret",
  S3_BUCKET: "claude-sessions",
  WORKER_OBJECT_PREFIX: "sessions/s1/",
};

describe("objectStoreConfigFromEnv", () => {
  test("reads the control host's storage variables plus the session prefix", () => {
    expect(objectStoreConfigFromEnv(base)).toEqual({
      accessKeyId: "AKIATEST",
      bucket: "claude-sessions",
      endpoint: "http://localstack:4566",
      region: "ap-northeast-1",
      scope: "sessions/s1/",
      secretAccessKey: "not-a-real-secret",
    });
  });

  test("an https or absent endpoint is refused at startup, not on the first request", () => {
    // Bun's node:https sends GREASE ECH and the egress proxy refuses it
    // (94S-219); until 94S-254 lands the only endpoint the worker can reach
    // is a plaintext one behind the proxy.
    expect(() =>
      objectStoreConfigFromEnv({ ...base, AWS_ENDPOINT_URL: undefined }),
    ).toThrow("94S-254");
    expect(() =>
      objectStoreConfigFromEnv({
        ...base,
        AWS_ENDPOINT_URL: "https://s3.ap-northeast-1.amazonaws.com",
      }),
    ).toThrow("must be http");
    for (const url of [
      "https://user:hunter2@s3.example",
      "http://u:hunter2@",
    ]) {
      let message = "";
      try {
        objectStoreConfigFromEnv({ ...base, AWS_ENDPOINT_URL: url });
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).toContain("AWS_ENDPOINT_URL");
      expect(message).not.toContain("hunter2");
    }
  });

  test("every variable is required and the prefix must be a key prefix", () => {
    for (const name of Object.keys(base) as Array<keyof typeof base>) {
      expect(() =>
        objectStoreConfigFromEnv({ ...base, [name]: undefined }),
      ).toThrow(name);
      expect(() => objectStoreConfigFromEnv({ ...base, [name]: " " })).toThrow(
        name,
      );
    }
    for (const prefix of [
      "sessions/s1",
      "/sessions/s1/",
      "sessions/../",
      "sessions/./s1/",
      "sessions//s1/",
      "/",
    ]) {
      expect(() =>
        objectStoreConfigFromEnv({ ...base, WORKER_OBJECT_PREFIX: prefix }),
      ).toThrow("WORKER_OBJECT_PREFIX");
    }
    expect(() =>
      objectStoreConfigFromEnv({ ...base, AWS_ENDPOINT_URL: "localstack" }),
    ).toThrow("AWS_ENDPOINT_URL");
  });
});

describe("createWorkerObjectStore", () => {
  test("refuses a key outside the session prefix without touching the network", async () => {
    const store = createWorkerObjectStore({
      ...objectStoreConfigFromEnv(base),
      // Nothing listens here; a request that got this far would hang or fail
      // with a connection error, not with the scope error asserted below.
      endpoint: "http://127.0.0.1:9",
    });
    await expect(store.get("sessions/s2/x")).rejects.toThrow(
      "outside the scope sessions/s1/",
    );
    await expect(store.list("sessions/")).rejects.toThrow(
      "outside the scope sessions/s1/",
    );
  });
});
