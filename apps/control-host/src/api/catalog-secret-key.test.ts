import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadSecretKey,
  PLATFORM_FILE,
  SECRET_KEY_SETTING,
  type SecretReader,
} from "./catalog-config.ts";

// Made per run, so no key-shaped value sits in a file.
const GOOD = randomBytes(32).toString("hex");
const noSecrets: SecretReader = async () => undefined;

let root: string;
let count = 0;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "catalog-secret-key-"));
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

async function catalogDir(platform?: string): Promise<string> {
  const dir = join(root, String(count++));
  await Bun.write(join(dir, ".keep"), "");
  if (platform !== undefined)
    await writeFile(join(dir, PLATFORM_FILE), platform);
  return dir;
}

async function failure(work: Promise<unknown>): Promise<string> {
  try {
    await work;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("expected the boot to fail");
}

describe("the master key for runtime secrets", () => {
  test("no platform.yaml and no variable: the store is off", async () => {
    const dir = await catalogDir();
    for (const env of [{}, { [SECRET_KEY_SETTING]: "" }]) {
      expect(
        await loadSecretKey({ dir, env, readSecret: noSecrets }),
      ).toBeNull();
    }
  });

  test("no platform.yaml: PLATFORM_SECRET_KEY is read when set", async () => {
    const key = await loadSecretKey({
      dir: await catalogDir(),
      env: { [SECRET_KEY_SETTING]: GOOD },
      readSecret: noSecrets,
    });
    expect(key?.version).toBe(1);
  });

  test.each([
    ["short", GOOD.slice(2)],
    ["not hex", `${GOOD.slice(2)}zz`],
    ["with a newline", `${GOOD}\n`],
  ])("a %s key stops the boot without naming the value", async (_, bad) => {
    const message = await failure(
      loadSecretKey({
        dir: await catalogDir(),
        env: { [SECRET_KEY_SETTING]: bad },
        readSecret: noSecrets,
      }),
    );
    expect(message).toContain(SECRET_KEY_SETTING);
    expect(message).toContain("64 hexadecimal");
    expect(message).not.toContain(bad.trim());
    expect(message).not.toContain(GOOD.slice(4, 20));
  });

  test("platform.yaml naming an environment variable reads it", async () => {
    const dir = await catalogDir(
      "platform:\n  secret_key:\n    value_env: OTHER_KEY_ENV\n",
    );
    expect(
      await loadSecretKey({
        dir,
        env: { OTHER_KEY_ENV: GOOD, [SECRET_KEY_SETTING]: "ignored" },
        readSecret: noSecrets,
      }),
    ).not.toBeNull();
  });

  test("platform.yaml makes the key required", async () => {
    const dir = await catalogDir(
      "platform:\n  secret_key:\n    value_env: OTHER_KEY_ENV\n",
    );
    expect(
      await failure(loadSecretKey({ dir, env: {}, readSecret: noSecrets })),
    ).toBe("platform.secret_key.value_env: OTHER_KEY_ENV is not set");
  });

  test("platform.yaml naming a Secrets Manager entry reads it once", async () => {
    const dir = await catalogDir(
      "platform:\n  secret_key:\n    secret_id: agent-platform/secret-key\n",
    );
    const asked: string[] = [];
    const key = await loadSecretKey({
      dir,
      env: {},
      readSecret: async (id) => {
        asked.push(id);
        return GOOD;
      },
    });
    expect(key).not.toBeNull();
    expect(asked).toEqual(["agent-platform/secret-key"]);
    const bad = await failure(
      loadSecretKey({ dir, env: {}, readSecret: async () => "abc123" }),
    );
    expect(bad).toContain("platform.secret_key (agent-platform/secret-key)");
    expect(bad).not.toContain("abc123");
    expect(
      await failure(
        loadSecretKey({
          dir,
          env: {},
          readSecret: async () => {
            throw new TypeError("connect ECONNREFUSED");
          },
        }),
      ),
    ).toBe(
      "platform.secret_key.secret_id: agent-platform/secret-key could not be read (TypeError)",
    );
  });

  test("a platform.yaml naming both, or neither, is refused", async () => {
    for (const body of [
      "platform:\n  secret_key:\n    value_env: A\n    secret_id: b\n",
      "platform:\n  secret_key: {}\n",
      "platform:\n  secret_key:\n    value: inline\n",
    ]) {
      const message = await failure(
        loadSecretKey({
          dir: await catalogDir(body),
          env: {},
          readSecret: noSecrets,
        }),
      );
      expect(message).toContain("platform.yaml is invalid");
      expect(message).not.toContain("inline");
    }
  });
});
