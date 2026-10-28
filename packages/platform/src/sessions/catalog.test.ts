import { describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import {
  allowedPair,
  allowedRun,
  type CatalogProfile,
  catalogRevision,
  describeConfigError,
  environmentCredentials,
  fingerprintModel,
  isUnmetered,
  mcpBinding,
  mcpUpstreamOf,
  pinnedMcpTools,
  profileFingerprint,
  profileModels,
  profilePinned,
  profilePins,
  profileWithModel,
  providerUpstreamOf,
  repositoryBinding,
  repositoryModeOf,
  repositoryUpstreamOf,
  resolveSessionCatalog,
  runtimeConfigOf,
  runtimeProviderOf,
  sessionCatalogConfigSchema,
  sessionCatalogView,
  sessionProfile,
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
    // came from: only the upstream and the proxy's token.
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

  test("a repository credential is a reference too, resolved at load and kept out of the revision", () => {
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

  test("a GitHub repository, on github.com or GHES, takes a PAT as basic x-access-token", () => {
    const pat = "github_pat_fixture_not_a_real_token";
    for (const [url, ref] of [
      ["https://github.com/acme/app.git", { value_env: "GITHUB_PAT" }],
      [
        "https://ghes.example.invalid/acme/app.git",
        { secret_id: "agent-platform/ghes-pat" },
      ],
    ] as const) {
      const catalog = load(
        config(configured, {
          app: {
            ...repository,
            url,
            auth: { kind: "basic", username: "x-access-token", ...ref },
          },
        }),
        (lookup) =>
          "value_env" in lookup && lookup.value_env === "ANTHROPIC_KEY_MAIN"
            ? "resolved-key"
            : pat,
      );
      const app = catalog.repositories.app;
      if (!app) throw new Error("no repository");
      expect(repositoryUpstreamOf(app)).toEqual({
        url,
        headers: [
          [
            "authorization",
            `Basic ${Buffer.from(`x-access-token:${pat}`).toString("base64")}`,
          ],
        ],
      });
    }
  });

  describe("a GitHub App repository", () => {
    const pem = generateKeyPairSync("rsa", { modulusLength: 2048 })
      .privateKey.export({ type: "pkcs1", format: "pem" })
      .toString();
    const appAuth = {
      kind: "github_app",
      app_id: 101,
      installation_id: 202,
      value_env: "GITHUB_APP_KEY",
    };
    const github = {
      ...repository,
      url: "https://github.com/acme/app.git",
      auth: appAuth,
    };
    const keyed = (key: string) =>
      environmentCredentials({ ...env, GITHUB_APP_KEY: key });

    test("resolves the private key once and keeps it out of the binding and revision", () => {
      const catalog = load(config(configured, { app: github }), keyed(pem));
      const app = catalog.repositories.app;
      if (!app) throw new Error("no repository");
      expect(app.auth).toEqual({
        kind: "github_app",
        app_id: 101,
        installation_id: 202,
        api_base: "https://api.github.com",
        value: pem.trim(),
        ref: { value_env: "GITHUB_APP_KEY" },
      });
      const body = pem.split("\n")[1] ?? "";
      expect(body.length).toBeGreaterThan(20);
      expect(repositoryBinding("app", app)).not.toContain(body);
      expect(catalogRevision(catalog)).not.toContain(body);
      // A rotated key behind the same reference keeps the binding; another
      // installation, App or API base does not.
      const other = generateKeyPairSync("rsa", { modulusLength: 2048 })
        .privateKey.export({ type: "pkcs1", format: "pem" })
        .toString();
      const rotated = load(config(configured, { app: github }), keyed(other))
        .repositories.app;
      if (!rotated) throw new Error("no repository");
      expect(repositoryBinding("app", rotated)).toBe(
        repositoryBinding("app", app),
      );
      for (const moved of [
        { installation_id: 203 },
        { app_id: 102 },
        { api_base: "https://ghes.example.invalid/api/v3" },
      ]) {
        const changed = load(
          config(configured, {
            app: { ...github, auth: { ...appAuth, ...moved } },
          }),
          keyed(pem),
        ).repositories.app;
        if (!changed) throw new Error("no repository");
        expect(repositoryBinding("app", changed)).not.toBe(
          repositoryBinding("app", app),
        );
      }
    });

    test("takes a key with escaped newlines, a GHES API base, or a Secrets Manager reference", () => {
      const escaped = pem.trim().replaceAll("\n", "\\n");
      const ghes = load(
        config(configured, {
          app: {
            ...github,
            url: "https://ghes.example.invalid/acme/app.git",
            auth: {
              kind: "github_app",
              app_id: 101,
              installation_id: 202,
              secret_id: "github-app-key",
              api_base: "https://ghes.example.invalid/api/v3",
            },
          },
        }),
        (ref) =>
          "secret_id" in ref ? escaped : environmentCredentials(env)(ref),
      ).repositories.app?.auth;
      expect(ghes).toMatchObject({
        api_base: "https://ghes.example.invalid/api/v3",
        value: pem.trim(),
        ref: { secret_id: "github-app-key" },
      });
      // A private host (the local stack's fake GitHub) may be plain http.
      expect(
        load(
          config(configured, {
            app: {
              ...github,
              url: "http://fake-github:8080/acme/app.git",
              auth: { ...appAuth, api_base: "http://fake-github:8080" },
            },
          }),
          keyed(pem),
        ).repositories.app?.auth,
      ).toMatchObject({ api_base: "http://fake-github:8080" });
    });

    test("a key that cannot sign fails at load without echoing it", () => {
      const ec = generateKeyPairSync("ec", { namedCurve: "P-256" })
        .privateKey.export({ type: "pkcs8", format: "pem" })
        .toString();
      for (const bad of ["not-a-pem-at-all", ec]) {
        let message = "";
        try {
          load(config(configured, { app: github }), keyed(bad));
        } catch (error) {
          message = (error as Error).message;
        }
        expect(message).toBe(
          "repositories.app.auth.value_env: GITHUB_APP_KEY is not an RSA private key PEM",
        );
      }
      expect(() =>
        load(config(configured, { app: github }), keyed("")),
      ).toThrow(
        /^repositories\.app\.auth\.value_env: GITHUB_APP_KEY is not set$/,
      );
    });

    test("the schema refuses what would issue a wrong or unscoped token", () => {
      for (const app of [
        { ...github, auth: { ...appAuth, app_id: "101" } },
        { ...github, auth: { ...appAuth, installation_id: 0 } },
        { ...github, auth: { ...appAuth, username: "x-access-token" } },
        { ...github, auth: { ...appAuth, secret_id: "also" } },
        { ...github, auth: { ...appAuth, value_env: undefined } },
        {
          ...github,
          auth: { ...appAuth, api_base: "http://api.github.example.com" },
        },
        // A token is scoped to `<owner>/<name>`; a URL without one has none.
        { ...github, url: "https://github.com/acme" },
        { ...github, url: "https://github.com/acme/app/tree/main" },
      ]) {
        expect(
          sessionCatalogConfigSchema.safeParse(config(configured, { app }))
            .success,
        ).toBe(false);
      }
    });

    test("its route sends the credential the forge issued, never the key", () => {
      const app = load(config(configured, { app: github }), keyed(pem))
        .repositories.app;
      if (!app) throw new Error("no repository");
      expect(() => repositoryUpstreamOf(app)).toThrow(
        /needs an issued credential/,
      );
      expect(
        repositoryUpstreamOf(app, {
          username: "x-access-token",
          password: "installation-token-fixture",
        }),
      ).toEqual({
        url: github.url,
        headers: [
          [
            "authorization",
            `Basic ${Buffer.from("x-access-token:installation-token-fixture").toString("base64")}`,
          ],
        ],
      });
    });
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

  test("no profiles is a catalog: the database holds them, and the file only seeds it", () => {
    expect(load({ profiles: {}, repositories: {} }).profiles).toEqual({});
    expect(() => load(config(configured, {}))).toThrow(
      /repositories: at least one repository is required/,
    );
  });

  test("a catalog of profiles that run without a repository needs no repository", () => {
    const catalog = load(config({ ...configured, repository: "none" }, {}));
    expect(catalog.repositories).toEqual({});
    expect(repositoryModeOf(catalog.profiles.p as CatalogProfile)).toBe("none");
  });

  test("a repository must name the profiles allowed against it; one this file lacks may be another's row", () => {
    expect(() =>
      load(config(configured, { app: { ...repository, profiles: [] } })),
    ).toThrow(/repositories\.app\.profiles/);
    const { profiles: _profiles, ...withoutList } = repository;
    expect(() => load(config(configured, { app: withoutList }))).toThrow(
      /repositories\.app\.profiles/,
    );
    expect(
      load(config(configured, { app: { ...repository, profiles: ["p", "q"] } }))
        .repositories.app?.profiles,
    ).toEqual(["p", "q"]);
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

describe("billing", () => {
  const billed = (billing: string, endpoint: string) =>
    config({
      ...configured,
      provider: { ...configured.provider, endpoint, billing },
    });

  test("none is kept on the profile; per_token, the default, is dropped", () => {
    const none = load(billed("none", "http://litellm:4000")).profiles.p;
    expect(none?.provider.billing).toBe("none");
    expect(isUnmetered(none as CatalogProfile)).toBe(true);
    const perToken = load(billed("per_token", "https://api.anthropic.invalid"))
      .profiles.p;
    expect(perToken?.provider).not.toHaveProperty("billing");
    expect(isUnmetered(perToken as CatalogProfile)).toBe(false);
    expect(perToken).toEqual(load(config()).profiles.p);
  });

  test("none is accepted only on an endpoint public DNS does not serve", () => {
    for (const endpoint of [
      "http://litellm:4000",
      "http://ollama.internal:11434",
      "http://gpu.local:8000",
      "http://localhost:11434",
      "https://gpu-box.lan",
      "http://10.0.0.5:4000",
      "http://172.20.1.2:4000",
      "http://192.168.1.10:11434",
      "http://100.100.1.1:4000",
      "http://127.0.0.1:11434",
      "http://[::1]:11434",
      "http://[fd12:3456::1]:4000",
    ]) {
      expect(() => load(billed("none", endpoint))).not.toThrow();
    }
    for (const endpoint of [
      "https://api.anthropic.com",
      "https://litellm.example.com",
      "http://8.8.8.8:4000",
      "http://172.32.0.1:4000",
      "http://[2001:db8::1]:4000",
      "http://[fc::1]:4000",
    ]) {
      expect(() => load(billed("none", endpoint))).toThrow(
        /profiles\.p\.provider\.billing: billing none needs an endpoint on a private address/,
      );
    }
  });

  test("an unknown value is refused", () => {
    expect(() => load(billed("free", "http://litellm:4000"))).toThrow(
      /profiles\.p\.provider\.billing/,
    );
  });
});

describe("repository mode", () => {
  const withMode = (repository: string, extra: object = {}) => ({
    ...configured,
    ...extra,
    repository,
  });

  test("omitted or written out, required is the same profile; the others are kept", () => {
    const omitted = load(config()).profiles.p as CatalogProfile;
    expect(omitted).not.toHaveProperty("repository");
    expect(repositoryModeOf(omitted)).toBe("required");
    expect(load(config(withMode("required"))).profiles.p).toEqual(omitted);
    const optional = load(config(withMode("optional"))).profiles
      .p as CatalogProfile;
    expect(repositoryModeOf(optional)).toBe("optional");
    expect(profileFingerprint(optional)).toBe(profileFingerprint(omitted));
    expect(() => load(config(withMode("sometimes")))).toThrow(
      /^profiles\.p\.repository: /,
    );
  });

  test("a none profile cannot let a repository CLAUDE.md in; optional can", () => {
    const claudeMd = { project_settings: { claude_md: true } };
    expect(() =>
      load({
        profiles: { p: configured, q: withMode("none", claudeMd) },
        repositories: { app: repository },
      }),
    ).toThrow(
      /^profiles\.q\.project_settings\.claude_md: a profile with repository none has no repository CLAUDE\.md to read$/,
    );
    expect(
      load(config(withMode("optional", claudeMd))).profiles.p?.project_settings,
    ).toEqual({ claude_md: true });
  });

  test("a none profile is listed by no repository, so no pair allows it", () => {
    const catalog = load({
      profiles: { p: configured, q: withMode("none") },
      repositories: { app: repository },
    });
    expect(repositoryModeOf(catalog.profiles.q as CatalogProfile)).toBe("none");
    expect(allowedPair(catalog, "q", "app")).toBeNull();
    expect(() =>
      load({
        profiles: { p: configured, q: withMode("none") },
        repositories: { app: { ...repository, profiles: ["p", "q"] } },
      }),
    ).toThrow(
      /^repositories\.app\.profiles\.1: names profile q, whose repository is none$/,
    );
  });
});

describe("the catalog view (94S-791)", () => {
  test("holds where each credential comes from, never a value, and pins the same profiles", () => {
    const parsed = sessionCatalogConfigSchema.parse(
      config(configured, {
        app: {
          ...repository,
          auth: { kind: "bearer", value_env: "GIT_TOKEN" },
        },
      }),
    );
    const asked: string[] = [];
    const view = sessionCatalogView(parsed);
    expect(asked).toEqual([]);
    expect(JSON.stringify(view)).not.toContain("resolved-key");
    expect(view.profiles.p?.provider.auth).toEqual({
      kind: "api_key",
      ref: { value_env: "ANTHROPIC_KEY_MAIN" },
    });
    expect(view.repositories.app).not.toHaveProperty("auth");
    const resolved = resolveSessionCatalog(parsed, (ref) => {
      asked.push(JSON.stringify(ref));
      return "resolved-key";
    });
    expect(asked).not.toEqual([]);
    const [viewed, full] = [view.profiles.p, resolved.profiles.p];
    if (!viewed || !full) throw new Error("profile p is missing");
    expect(profileFingerprint(viewed)).toBe(profileFingerprint(full));
  });
});

describe("profile fingerprint and catalog revision", () => {
  const base = () => load(config()).profiles.p as CatalogProfile;

  test("a profile without billing, or with per_token, keeps the fingerprint it had before the field", () => {
    const perToken = load(
      config({
        ...configured,
        provider: { ...configured.provider, billing: "per_token" },
      }),
    ).profiles.p as CatalogProfile;
    expect(profileFingerprint(perToken)).toBe(profileFingerprint(base()));
    // The version 1 fingerprint main computed before `billing` existed
    // still names both.
    const before =
      "sha256:99f5f59a41e3bc02be1f2ffd7af4b0a4fae68ca567dc05368cab9285f5ffd983";
    expect(profilePinned(base(), before)).toBe(true);
    expect(profilePinned(perToken, before)).toBe(true);
    // Declaring none is a new profile.
    const local = (billing?: string) =>
      profileFingerprint(
        load(
          config({
            ...configured,
            provider: {
              ...configured.provider,
              endpoint: "http://litellm:4000",
              ...(billing === undefined ? {} : { billing }),
            },
          }),
        ).profiles.p as CatalogProfile,
      );
    expect(local("none")).not.toBe(local());
  });

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

  test("leaves out the model, the model list and the repository mode", () => {
    const fingerprint = profileFingerprint(base());
    for (const changed of [
      { ...configured, model: "claude-opus-5-5" },
      { ...configured, models: ["claude-opus-5-5"] },
      { ...configured, repository: "optional" },
    ]) {
      expect(
        profileFingerprint(load(config(changed)).profiles.p as CatalogProfile),
      ).toBe(fingerprint);
    }
  });

  test("a repository binding and the catalog revision are the values main computed before version 2", () => {
    // Pending pushes and pull requests hold the binding and compare it
    // when they run, so it must not move with the profile fingerprint.
    const catalog = load(
      config({ ...configured, models: ["claude-opus-5-5"] }),
    );
    expect(repositoryBinding("app", catalog.repositories.app as never)).toBe(
      "sha256:c8954e2d28652f1630adf031f84b8446160fc6fc9712c7d5fe153d8998feacce",
    );
    expect(catalogRevision(catalog)).toBe(
      "sha256:920c69094709f4acdff2c9d7e0215957d59190a289e312b7c719eb339ab0a529",
    );
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

describe("allowedRun", () => {
  const catalog = load({
    profiles: {
      required: configured,
      optional: { ...configured, repository: "optional" },
      none: { ...configured, repository: "none" },
    },
    repositories: {
      app: { ...repository, profiles: ["required", "optional"] },
    },
  });

  test("without a repository, only a profile whose repository is optional or none runs", () => {
    expect(allowedRun(catalog, "required", null)).toBeNull();
    expect(allowedRun(catalog, "optional", null)).toEqual({
      profile: catalog.profiles.optional as CatalogProfile,
      repository: null,
    });
    expect(allowedRun(catalog, "none", null)?.repository).toBeNull();
    expect(allowedRun(catalog, "missing", null)).toBeNull();
    expect(allowedRun(catalog, "constructor", null)).toBeNull();
  });

  test("with a repository, it is the pair the repository allows", () => {
    expect(allowedRun(catalog, "required", "app")?.repository?.url).toBe(
      repository.url,
    );
    expect(allowedRun(catalog, "optional", "app")).not.toBeNull();
    expect(allowedRun(catalog, "none", "app")).toBeNull();
  });
});

describe("runtimeConfigOf", () => {
  test("a session without a repository has no CLAUDE.md, whatever the profile allows", () => {
    const profile = load(
      config({
        ...configured,
        repository: "optional",
        project_settings: { claude_md: true },
      }),
    ).profiles.p as CatalogProfile;
    expect(runtimeConfigOf(profile, "t", true).project_settings).toEqual({
      claude_md: true,
    });
    expect(runtimeConfigOf(profile, "t", false)).not.toHaveProperty(
      "project_settings",
    );
  });
});

describe("models a session may name", () => {
  const offering = (models: unknown) =>
    load(config({ ...configured, models })).profiles.p as CatalogProfile;
  const bare = () => load(config()).profiles.p as CatalogProfile;

  test("the list is optional, never empty, and the default always comes first", () => {
    expect(() => offering([])).toThrow("models");
    expect(() => offering([""])).toThrow("models");
    expect(profileModels(bare())).toEqual(["claude-sonnet-5"]);
    expect(
      profileModels(offering(["claude-opus-5-5", "claude-sonnet-5"])),
    ).toEqual(["claude-sonnet-5", "claude-opus-5-5"]);
  });

  test("the list is not part of what a session is pinned to", () => {
    const listed = offering(["claude-opus-5-5"]);
    expect(profileFingerprint(listed)).toBe(profileFingerprint(bare()));
    expect(profileWithModel(listed)).toEqual(bare());
  });

  test("a session runs only a model the profile offers, named on its row", () => {
    const listed = offering(["claude-opus-5-5"]);
    const opus = profileWithModel(listed, "claude-opus-5-5");
    expect(opus?.model).toBe("claude-opus-5-5");
    expect(opus && "models" in opus).toBe(false);
    expect(profileWithModel(listed, "claude-fable-5-1")).toBeNull();
    expect(profileWithModel(bare(), "claude-opus-5-5")).toBeNull();
    const fingerprint = profileFingerprint(listed);
    expect(
      sessionProfile(listed, { fingerprint, model: "claude-opus-5-5" }),
    ).toEqual(opus);
    // Off the list, the session's model is no longer there to run.
    expect(
      sessionProfile(bare(), { fingerprint, model: "claude-opus-5-5" }),
    ).toBeNull();
    expect(sessionProfile(listed, { fingerprint, model: null })).toBeNull();
    // A row from before the pin runs the default.
    expect(sessionProfile(listed, { fingerprint: null, model: null })).toEqual(
      bare(),
    );
  });

  test("a version 1 pin still names the model it was taken with, whatever the row says", () => {
    const listed = offering(["claude-opus-5-5"]);
    // What main pinned a session that named the second model to.
    const v1Opus =
      "sha256:c1810e0b388cb79421095745e83356f1a1e03aee8858fbe4ce65d63f3aa90d5f";
    const opus = profileWithModel(listed, "claude-opus-5-5");
    expect(
      sessionProfile(listed, { fingerprint: v1Opus, model: null }),
    ).toEqual(opus);
    expect(
      sessionProfile(listed, { fingerprint: v1Opus, model: "claude-sonnet-5" }),
    ).toEqual(opus);
    expect(profilePinned(listed, v1Opus)).toBe(true);
    expect(
      sessionProfile(bare(), { fingerprint: v1Opus, model: null }),
    ).toBeNull();
    expect(profilePinned(bare(), v1Opus)).toBe(false);
    expect(
      fingerprintModel(
        load(config({ ...configured, models: ["claude-opus-5-5"] })),
        "p",
        v1Opus,
      ),
    ).toBe("claude-opus-5-5");
  });

  test("the pins a claim offers: version 2 per model with the default first, then each model's version 1", () => {
    const listed = offering(["claude-opus-5-5"]);
    const current = profileFingerprint(listed);
    expect(profilePins(listed)).toEqual([
      { fingerprint: current, model: "claude-sonnet-5" },
      { fingerprint: current, model: "claude-opus-5-5" },
      {
        fingerprint:
          "sha256:99f5f59a41e3bc02be1f2ffd7af4b0a4fae68ca567dc05368cab9285f5ffd983",
        model: null,
      },
      {
        fingerprint:
          "sha256:c1810e0b388cb79421095745e83356f1a1e03aee8858fbe4ce65d63f3aa90d5f",
        model: null,
      },
    ]);
  });

  test("the model a fingerprint names, for the backfill", () => {
    const catalog = load(
      config({ ...configured, models: ["claude-opus-5-5"] }),
    );
    const v1Default =
      "sha256:99f5f59a41e3bc02be1f2ffd7af4b0a4fae68ca567dc05368cab9285f5ffd983";
    expect(fingerprintModel(catalog, "p", v1Default)).toBe("claude-sonnet-5");
    expect(
      fingerprintModel(
        catalog,
        "p",
        profileFingerprint(catalog.profiles.p as CatalogProfile),
      ),
    ).toBeNull();
    expect(fingerprintModel(catalog, "gone", v1Default)).toBeNull();
    expect(
      fingerprintModel(catalog, "p", `sha256:${"0".repeat(64)}`),
    ).toBeNull();
  });
});

describe("remote MCP servers", () => {
  const server = {
    url: "http://fake-mcp:4020/mcp",
    credential_ref: "mcp/fake",
    auth: { kind: "bearer", value_env: "FAKE_MCP_SA" },
    workspaces: ["default"],
  };
  const withMcp = (mcp: unknown) => ({ ...config(), mcp_servers: mcp });
  const lookup = environmentCredentials({ ...env, FAKE_MCP_SA: "sa-value" });

  test("resolves the bearer at load, and only the proxy's upstream holds it", () => {
    const catalog = load(withMcp({ fake: server }), lookup);
    const fake = catalog.mcp_servers?.fake;
    expect(fake?.auth).toEqual({
      kind: "bearer",
      value: "sa-value",
      ref: { value_env: "FAKE_MCP_SA" },
    });
    if (fake === undefined) throw new Error("no server");
    expect(mcpUpstreamOf(fake)).toEqual({
      url: "http://fake-mcp:4020/mcp",
      headers: [["authorization", "Bearer sa-value"]],
    });
    expect(load(config())).not.toHaveProperty("mcp_servers");
    expect(catalogRevision(catalog)).toBe(catalogRevision(load(config())));
  });

  test("refuses what the proxy or the card could not name", () => {
    for (const bad of [
      { a__b: server },
      { Fake: server },
      { fake: { ...server, url: "http://fake-mcp:4020/mcp?x=1" } },
      { fake: { ...server, workspaces: [] } },
      { fake: { ...server, workspaces: ["a", "a"] } },
      { fake: { ...server, credential_ref: "Not A Ref" } },
      { fake: { ...server, auth: { kind: "basic", value_env: "X" } } },
      { fake: { ...server, extra: true } },
    ]) {
      expect(sessionCatalogConfigSchema.safeParse(withMcp(bad)).success).toBe(
        false,
      );
    }
  });

  test("the binding moves with the release, server, URL and credential name only", () => {
    const binding = mcpBinding("rel-1", "fake", server);
    expect(binding).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(mcpBinding("rel-1", "fake", { ...server })).toBe(binding);
    for (const moved of [
      mcpBinding("rel-2", "fake", server),
      mcpBinding("rel-1", "other", server),
      mcpBinding("rel-1", "fake", { ...server, url: "http://x.test/mcp" }),
      mcpBinding("rel-1", "fake", { ...server, credential_ref: "mcp/other" }),
    ]) {
      expect(moved).not.toBe(binding);
    }
  });

  test("a session runs the server's allowed tools only", () => {
    expect(
      pinnedMcpTools("fake", {
        mcp__fake__whoami: "allow",
        mcp__fake__other: "ask",
        mcp__fake__gone: "deny",
        mcp__fake__: "allow",
        mcp__fakery__x: "allow",
        Read: "allow",
      }),
    ).toEqual(["mcp__fake__whoami"]);
  });
});
