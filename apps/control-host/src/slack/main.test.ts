import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ALLOW_UNATTENDED_SETTING,
  loadSessionCatalog,
  PROFILES_FILE,
  REPOSITORIES_FILE,
} from "../api/catalog-config.ts";
import { slackRoleSettings, slackRoleStartup } from "./main.ts";

const profiles = (mode: string) => `profiles:
  coding:
    runtime_kind: claude_agent_sdk
    runtime_version: "0.3.270"
    model: claude-sonnet-5
    tools: [Read]
    permission_mode: ${mode}
    provider:
      kind: anthropic
      endpoint: https://api.anthropic.invalid
      auth:
        kind: api_key
        value_env: PROVIDER_KEY
`;
const REPOSITORIES = `repositories:
  sample-app:
    url: http://gitea:3000/agent/sample-app.git
    branch: main
    profiles: [coding]
`;

let root: string;
const noSecrets = async () => {
  throw new Error("no secret is read");
};

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "slack-role-"));
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

async function catalogDir(mode: string): Promise<string> {
  const dir = await mkdtemp(join(root, "catalog-"));
  await writeFile(join(dir, PROFILES_FILE), profiles(mode));
  await writeFile(join(dir, REPOSITORIES_FILE), REPOSITORIES);
  return dir;
}

// No PROVIDER_KEY: the role reads the catalog, not its credentials.
const base = { DATABASE_URL: "postgres://nobody@127.0.0.1:1/none" };

const failure = (promise: Promise<unknown>) =>
  promise.then(
    () => {
      throw new Error("expected a refusal");
    },
    (error: Error) => error.message,
  );

describe("slack role startup", () => {
  test("loads the catalog the api would, without its provider key", async () => {
    const dir = await catalogDir("default");
    const { catalog, secretKeySet } = await slackRoleStartup(
      { ...base, PLATFORM_CONFIG_DIR: dir },
      noSecrets,
    );
    expect(Object.keys(catalog.profiles)).toEqual(["coding"]);
    expect(secretKeySet).toBe(false);
    // The api, by contrast, needs the key to load the same catalog.
    expect(
      await failure(
        loadSessionCatalog({ dir, env: base, readSecret: noSecrets }),
      ),
    ).toContain("PROVIDER_KEY");
  });

  test("an unattended profile stops it for the api's reason, until allowed", async () => {
    const dir = await catalogDir("bypassPermissions");
    const env = { ...base, PLATFORM_CONFIG_DIR: dir };
    const role = await failure(slackRoleStartup(env, noSecrets));
    const api = await failure(
      loadSessionCatalog({
        dir,
        env: { ...env, PROVIDER_KEY: "value-from-environment" },
        readSecret: noSecrets,
      }),
    );
    expect(role).toBe(api);
    expect(role).toContain(`${ALLOW_UNATTENDED_SETTING}=true`);
    const allowed = await slackRoleStartup(
      { ...env, [ALLOW_UNATTENDED_SETTING]: "true" },
      noSecrets,
    );
    expect(allowed.catalog.profiles.coding?.permission_mode).toBe(
      "bypassPermissions",
    );
  });

  test("a bad master key or setting stops it before any pass", async () => {
    const dir = await catalogDir("default");
    expect(
      await failure(
        slackRoleStartup(
          { ...base, PLATFORM_CONFIG_DIR: dir, PLATFORM_SECRET_KEY: "abc" },
          noSecrets,
        ),
      ),
    ).toContain("PLATFORM_SECRET_KEY");
    expect(
      await failure(
        slackRoleStartup(
          { ...base, PLATFORM_CONFIG_DIR: dir, SLACK_ROLE_LEASE_SEC: "0" },
          noSecrets,
        ),
      ),
    ).toContain("SLACK_ROLE_LEASE_SEC");
    expect(
      await failure(slackRoleStartup({ PLATFORM_CONFIG_DIR: dir }, noSecrets)),
    ).toContain("DATABASE_URL or QUEUE_DATABASE_URL is required");
  });

  test("settings default to a 60s lease, batches of 10 and half the pass timeout", () => {
    expect(slackRoleSettings({})).toEqual({
      batchSize: 10,
      leaseMs: 60_000,
      passBudgetMs: 30_000,
    });
  });
});
