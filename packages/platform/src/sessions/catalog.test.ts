import { describe, expect, test } from "bun:test";
import {
  type CatalogProfile,
  isCatalogEmpty,
  parseSessionCatalogEnv,
} from "./catalog.ts";

// The JSON an operator writes: the credential is a reference to a variable.
const configured = {
  runtime_kind: "claude_agent_sdk",
  runtime_version: "1",
  model: "claude-sonnet-5",
  tools: ["Read"],
  permission_mode: "default",
  provider: {
    kind: "anthropic",
    endpoint: "https://api.anthropic.invalid",
    auth: { kind: "api_key", value_env: "ANTHROPIC_KEY_MAIN" },
  },
};
const env = { ANTHROPIC_KEY_MAIN: "resolved-key" };

function catalogJson(profile: unknown) {
  return JSON.stringify({ profiles: { p: profile }, repositories: {} });
}

describe("parseSessionCatalogEnv", () => {
  test("resolves the credential reference once, at load", () => {
    const catalog = parseSessionCatalogEnv(
      "SESSION_CATALOG_JSON",
      catalogJson(configured),
      env,
    );
    const expected: CatalogProfile = {
      runtime_kind: "claude_agent_sdk",
      runtime_version: "1",
      model: "claude-sonnet-5",
      tools: ["Read"],
      permission_mode: "default",
      provider: {
        kind: "anthropic",
        endpoint: "https://api.anthropic.invalid",
        auth: { kind: "api_key", value: "resolved-key" },
      },
    };
    expect(catalog.profiles.p).toEqual(expected);
  });

  test("a missing credential names the profile and the variable, never a value", () => {
    expect(() =>
      parseSessionCatalogEnv("SESSION_CATALOG_JSON", catalogJson(configured), {
        ANTHROPIC_KEY_MAIN: "",
      }),
    ).toThrow(
      /^SESSION_CATALOG_JSON is invalid: profiles\.p\.provider\.auth\.value_env: ANTHROPIC_KEY_MAIN is not set$/,
    );
  });

  test("an inline credential value is refused: the JSON holds references only", () => {
    const inline = {
      ...configured,
      provider: {
        ...configured.provider,
        auth: { kind: "api_key", value: "leaked" },
      },
    };
    expect(() =>
      parseSessionCatalogEnv("SESSION_CATALOG_JSON", catalogJson(inline), env),
    ).toThrow(/profiles\.p\.provider\.auth/);
  });

  test("names the variable and the failing path", () => {
    expect(() =>
      parseSessionCatalogEnv(
        "SESSION_CATALOG_JSON",
        catalogJson({ ...configured, runtime_kind: "gpt" }),
        env,
      ),
    ).toThrow(/^SESSION_CATALOG_JSON is invalid: profiles\.p\.runtime_kind: /);
  });

  test("a profile the worker could not run is refused at load, not at claim", () => {
    const { model: _model, ...withoutModel } = configured;
    expect(() =>
      parseSessionCatalogEnv(
        "SESSION_CATALOG_JSON",
        catalogJson(withoutModel),
        env,
      ),
    ).toThrow(/profiles\.p\.model: /);
    // anthropic takes an API key only; bearer is a litellm affordance.
    const anthropicBearer = {
      ...configured,
      provider: {
        ...configured.provider,
        auth: { kind: "bearer", value_env: "ANTHROPIC_KEY_MAIN" },
      },
    };
    expect(() =>
      parseSessionCatalogEnv(
        "SESSION_CATALOG_JSON",
        catalogJson(anthropicBearer),
        env,
      ),
    ).toThrow(/profiles\.p\.provider\.auth\.kind: /);
  });

  test("names the variable on malformed JSON", () => {
    expect(() =>
      parseSessionCatalogEnv("SESSION_CATALOG_JSON", "{", env),
    ).toThrow(/^SESSION_CATALOG_JSON is invalid: /);
  });

  test("defaults to an empty catalog when unset", () => {
    const catalog = parseSessionCatalogEnv(
      "SESSION_CATALOG_JSON",
      undefined,
      env,
    );
    expect(catalog).toEqual({ profiles: {}, repositories: {} });
    expect(isCatalogEmpty(catalog)).toBe(true);
  });

  test("a catalog missing only repositories still counts as empty", () => {
    const catalog = parseSessionCatalogEnv(
      "SESSION_CATALOG_JSON",
      catalogJson(configured),
      env,
    );
    expect(isCatalogEmpty(catalog)).toBe(true);
  });
});
