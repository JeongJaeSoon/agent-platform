import { describe, expect, test } from "bun:test";
import {
  allowedPair,
  type CatalogProfile,
  catalogRevision,
  describeConfigError,
  environmentCredentials,
  profileFingerprint,
  providerUpstreamOf,
  repositoryBinding,
  repositoryUpstreamOf,
  resolveSessionCatalog,
  runtimeProviderOf,
  sessionCatalogConfigSchema,
} from "./catalog.ts";

// What an operator writes: the credential is a reference, never a value.
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
const repository = {
  url: "https://git.example.invalid/team/app.git",
  branch: "main",
  profiles: ["p"],
};
const env = { ANTHROPIC_KEY_MAIN: "resolved-key" };

function config(
  profile: unknown = configured,
  repositories: unknown = { app: repository },
) {
  return { profiles: { p: profile }, repositories };
}

function load(
  input: unknown,
  lookup = environmentCredentials(env),
): ReturnType<typeof resolveSessionCatalog> {
  const parsed = sessionCatalogConfigSchema.safeParse(input);
  if (!parsed.success) throw new Error(describeConfigError(parsed.error));
  return resolveSessionCatalog(parsed.data, lookup);
}

describe("catalog config schema", () => {
  test("resolves the credential reference once, at load, and keeps where it came from", () => {
    const catalog = load(config());
    const expected: CatalogProfile = {
      runtime_kind: "claude_agent_sdk",
      runtime_version: "1",
      model: "claude-sonnet-5",
      tools: ["Read"],
      permission_mode: "default",
      provider: {
        kind: "anthropic",
        endpoint: "https://api.anthropic.invalid",
        auth: {
          kind: "api_key",
          value: "resolved-key",
          ref: { value_env: "ANTHROPIC_KEY_MAIN" },
        },
      },
      project_settings: { claude_md: false },
    };
    expect(catalog.profiles.p).toEqual(expected);
    expect(catalog.repositories.app).toEqual(repository);
    // What the worker protocol carries is neither the value nor where it
    // came from (94S-252): only the upstream and the proxy's token.
    expect(runtimeProviderOf(expected, "wep_t")).toEqual({
      kind: "anthropic",
      endpoint: "https://api.anthropic.invalid",
      auth: { kind: "egress_token", token: "wep_t" },
    });
    // The proxy is the one handed the value, as the header it injects.
    expect(providerUpstreamOf(expected)).toEqual({
      url: "https://api.anthropic.invalid",
      headers: [["x-api-key", "resolved-key"]],
    });
  });

  test("a Secrets Manager reference resolves through the lookup the loader filled", () => {
    const catalog = load(
      config({
        ...configured,
        provider: {
          ...configured.provider,
          auth: { kind: "api_key", secret_id: "agent-platform/anthropic" },
        },
      }),
      (ref) => ("secret_id" in ref ? "from-secrets" : undefined),
    );
    expect(catalog.profiles.p?.provider.auth).toEqual({
      kind: "api_key",
      value: "from-secrets",
      ref: { secret_id: "agent-platform/anthropic" },
    });
  });

  test("exactly one reference: both, neither, or an inline value is refused", () => {
    for (const auth of [
      {
        kind: "api_key",
        value_env: "ANTHROPIC_KEY_MAIN",
        secret_id: "agent-platform/anthropic",
      },
      { kind: "api_key" },
      { kind: "api_key", value: "leaked" },
    ]) {
      expect(() =>
        load(
          config({ ...configured, provider: { ...configured.provider, auth } }),
        ),
      ).toThrow(/profiles\.p\.provider\.auth/);
    }
  });

  test("a missing credential names the profile and the reference, never a value", () => {
    expect(() =>
      load(config(), environmentCredentials({ ANTHROPIC_KEY_MAIN: "" })),
    ).toThrow(
      /^profiles\.p\.provider\.auth\.value_env: ANTHROPIC_KEY_MAIN is not set$/,
    );
  });

  test("a repository credential is a reference too, resolved at load and kept out of the revision (94S-252)", () => {
    const withAuth = {
      ...repository,
      auth: { kind: "basic", username: "reader", value_env: "REPO_TOKEN" },
    };
    const lookup = (value: string) =>
      environmentCredentials({
        ANTHROPIC_KEY_MAIN: "resolved-key",
        REPO_TOKEN: value,
      });
    const catalog = load(
      config(configured, { app: withAuth }),
      lookup("repo-secret"),
    );
    expect(catalog.repositories.app?.auth).toEqual({
      kind: "basic",
      username: "reader",
      value: "repo-secret",
      ref: { value_env: "REPO_TOKEN" },
    });
    const app = catalog.repositories.app;
    if (!app) throw new Error("no repository");
    expect(repositoryUpstreamOf(app)).toEqual({
      url: repository.url,
      headers: [
        [
          "authorization",
          `Basic ${Buffer.from("reader:repo-secret").toString("base64")}`,
        ],
      ],
    });
    // Neither the revision nor the binding carries the value, and neither
    // moves when only the value behind the same reference is rotated.
    const rotated = load(
      config(configured, { app: withAuth }),
      lookup("rotated-value"),
    );
    expect(catalogRevision(rotated)).toBe(catalogRevision(catalog));
    expect(catalogRevision(catalog)).not.toContain("repo-secret");
    const rotatedApp = rotated.repositories.app;
    if (!rotatedApp) throw new Error("no repository");
    expect(repositoryBinding("app", rotatedApp)).toBe(
      repositoryBinding("app", app),
    );
    expect(repositoryBinding("app", app)).not.toContain("repo-secret");
    // A missing value names where the reference sits.
    expect(() => load(config(configured, { app: withAuth }))).toThrow(
      /^repositories\.app\.auth\.value_env: REPO_TOKEN is not set$/,
    );
    // Shorter than the proxy's response check covers: refused at load.
    expect(() =>
      load(config(configured, { app: withAuth }), lookup("seven77")),
    ).toThrow(
      /^repositories\.app\.auth\.value_env: REPO_TOKEN is shorter than 8 bytes$/,
    );
    // Nor one the proxy would refuse to put in a header.
    for (const bad of [
      "resolved-value\n",
      " resolved-value",
      "resolved\tvalue",
    ]) {
      expect(() =>
        load(config(configured, { app: withAuth }), lookup(bad)),
      ).toThrow(
        /^repositories\.app\.auth\.value_env: REPO_TOKEN has a control character or surrounding whitespace$/,
      );
    }
    // basic needs a login, bearer takes none, and there is exactly one ref.
    for (const auth of [
      { kind: "basic", value_env: "REPO_TOKEN" },
      { kind: "bearer", username: "reader", value_env: "REPO_TOKEN" },
      { kind: "bearer" },
      { kind: "bearer", value_env: "A", secret_id: "B" },
      { kind: "bearer", value: "inline" },
      { kind: "basic", username: "a:b", value_env: "REPO_TOKEN" },
    ]) {
      expect(
        sessionCatalogConfigSchema.safeParse(
          config(configured, { app: { ...repository, auth } }),
        ).success,
      ).toBe(false);
    }
  });

  test("the repository's CLAUDE.md is let in only when the profile says so, and hooks never are", () => {
    expect(
      load(config({ ...configured, project_settings: { claude_md: true } }))
        .profiles.p?.project_settings,
    ).toEqual({ claude_md: true });
    expect(() =>
      load(
        config({
          ...configured,
          project_settings: { claude_md: true, hooks: true },
        }),
      ),
    ).toThrow(/^profiles\.p\.project_settings: /);
  });

  test("a profile the worker could not run is refused at load, not at claim", () => {
    expect(() => load(config({ ...configured, runtime_kind: "gpt" }))).toThrow(
      /^profiles\.p\.runtime_kind: /,
    );
    const { model: _model, ...withoutModel } = configured;
    expect(() => load(config(withoutModel))).toThrow(/profiles\.p\.model: /);
    // anthropic takes an API key only; bearer is a litellm affordance.
    expect(() =>
      load(
        config({
          ...configured,
          provider: {
            ...configured.provider,
            auth: { kind: "bearer", value_env: "ANTHROPIC_KEY_MAIN" },
          },
        }),
      ),
    ).toThrow(/profiles\.p\.provider\.auth\.kind: /);
  });

  test("an empty catalog is refused: a host that can run nothing is a misconfiguration", () => {
    expect(() => load({ profiles: {}, repositories: {} })).toThrow(
      /profiles: at least one profile is required/,
    );
    expect(() => load(config(configured, {}))).toThrow(
      /repositories: at least one repository is required/,
    );
  });

  test("a repository must name the profiles allowed against it, and only real ones", () => {
    expect(() =>
      load(config(configured, { app: { ...repository, profiles: [] } })),
    ).toThrow(/repositories\.app\.profiles/);
    const { profiles: _profiles, ...withoutList } = repository;
    expect(() => load(config(configured, { app: withoutList }))).toThrow(
      /repositories\.app\.profiles/,
    );
    expect(() =>
      load(
        config(configured, { app: { ...repository, profiles: ["p", "q"] } }),
      ),
    ).toThrow(
      /repositories\.app\.profiles\.1: names profile q, which is not in profiles/,
    );
  });

  test("a URL carrying a credential is refused; login names without one are not", () => {
    for (const endpoint of [
      "https://user:pw@api.anthropic.invalid",
      "https://token@api.anthropic.invalid",
      "https://api.anthropic.invalid/?key=abc",
    ]) {
      expect(() =>
        load(
          config({
            ...configured,
            provider: { ...configured.provider, endpoint },
          }),
        ),
      ).toThrow(/profiles\.p\.provider\.endpoint: must not carry a credential/);
    }
    for (const url of [
      "https://oauth2:tok@git.example.invalid/team/app.git",
      "https://oauth2@git.example.invalid/team/app.git",
      "http://git.example.invalid/app.git?private_token=x",
    ]) {
      expect(() =>
        load(config(configured, { app: { ...repository, url } })),
      ).toThrow(/repositories\.app\.url: must not carry a credential/);
    }
    for (const url of [
      "https://git.example.invalid/team/app.git",
      "http://gitea:3000/agent/sample.git",
    ]) {
      expect(
        load(config(configured, { app: { ...repository, url } })).repositories
          .app?.url,
      ).toBe(url);
    }
  });
});

test("only web addresses: the worker's one way out is the HTTP(S) proxy", () => {
  for (const endpoint of [
    "file:///tmp/messages",
    "ftp://api.anthropic.invalid",
    "not a url",
  ]) {
    expect(() =>
      load(
        config({
          ...configured,
          provider: { ...configured.provider, endpoint },
        }),
      ),
    ).toThrow(/profiles\.p\.provider\.endpoint: must be an http/);
  }
  for (const url of [
    "not a repository",
    "file:///etc/passwd",
    "/srv/git/app.git",
    "ssh://git@git.example.invalid/team/app.git",
    "git://git.example.invalid/app.git",
    "git@git.example.invalid:team/app.git",
    "git.example.invalid:team/app.git",
  ]) {
    expect(
      () => load(config(configured, { app: { ...repository, url } })),
      url,
    ).toThrow(/repositories\.app\.url: must be an http/);
  }
  // The proxy refuses an upstream with a fragment, so the catalog does too.
  expect(() =>
    load(
      config({
        ...configured,
        provider: {
          ...configured.provider,
          endpoint: "https://api.example.invalid/#x",
        },
      }),
    ),
  ).toThrow(/profiles\.p\.provider\.endpoint: must not carry a fragment/);
  for (const endpoint of ["https://10.0.0.5/", "https://[::1]:8443/"]) {
    expect(() =>
      load(
        config({
          ...configured,
          provider: { ...configured.provider, endpoint },
        }),
      ),
    ).toThrow(/profiles\.p\.provider\.endpoint: https must name its host/);
  }
  // Plain http by address stays allowed (a compose service on its IP).
  expect(() =>
    load(
      config({
        ...configured,
        provider: { ...configured.provider, endpoint: "http://10.0.0.5:4000/" },
      }),
    ),
  ).not.toThrow();
});

describe("profile fingerprint and catalog revision", () => {
  const base = () => load(config()).profiles.p as CatalogProfile;

  test("is a sha256 over the settings and the reference, never the value", () => {
    const profile = base();
    const fingerprint = profileFingerprint(profile);
    expect(fingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
    // Rotating the value behind the same reference is not a new profile.
    const rotated = load(
      config(),
      environmentCredentials({ ANTHROPIC_KEY_MAIN: "rotated-key" }),
    ).profiles.p as CatalogProfile;
    expect(profileFingerprint(rotated)).toBe(fingerprint);
    // Any setting, or a different place to find the key, is.
    for (const changed of [
      { ...configured, model: "claude-opus-5-5" },
      { ...configured, tools: ["Read", "Edit"] },
      { ...configured, project_settings: { claude_md: true } },
      {
        ...configured,
        provider: {
          ...configured.provider,
          auth: { kind: "api_key", value_env: "ANTHROPIC_KEY_OTHER" },
        },
      },
    ]) {
      const other = load(
        config(changed),
        environmentCredentials({ ...env, ANTHROPIC_KEY_OTHER: "resolved-key" }),
      ).profiles.p as CatalogProfile;
      expect(profileFingerprint(other)).not.toBe(fingerprint);
    }
  });

  test("does not depend on key order", () => {
    const profile = base();
    const reordered = Object.fromEntries(
      Object.entries(profile).reverse(),
    ) as CatalogProfile;
    expect(profileFingerprint(reordered)).toBe(profileFingerprint(profile));
  });

  test("the revision moves with any repository and never with a credential value", () => {
    const catalog = load(config());
    const revision = catalogRevision(catalog);
    expect(revision).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(
      catalogRevision(
        load(
          config(),
          environmentCredentials({ ANTHROPIC_KEY_MAIN: "other-value" }),
        ),
      ),
    ).toBe(revision);
    expect(
      catalogRevision(
        load(config(configured, { app: { ...repository, branch: "dev" } })),
      ),
    ).not.toBe(revision);
  });
});

describe("allowedPair", () => {
  test("only a repository that lists the profile lets it run", () => {
    const catalog = load({
      profiles: { p: configured, q: configured },
      repositories: {
        app: repository,
        other: { ...repository, profiles: ["q"] },
      },
    });
    expect(allowedPair(catalog, "p", "app")?.repository).toEqual(repository);
    expect(allowedPair(catalog, "p", "other")).toBeNull();
    expect(allowedPair(catalog, "q", "other")).not.toBeNull();
    expect(allowedPair(catalog, "missing", "app")).toBeNull();
    expect(allowedPair(catalog, "p", "missing")).toBeNull();
    // Prototype keys are not entries.
    expect(allowedPair(catalog, "p", "__proto__")).toBeNull();
    expect(allowedPair(catalog, "constructor", "app")).toBeNull();
  });
});
