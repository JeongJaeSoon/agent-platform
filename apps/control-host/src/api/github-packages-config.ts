import { GITHUB_API_BASE, GITHUB_PACKAGES_UPSTREAMS } from "@werft-ai/platform";

export type GitHubPackagesConfig = {
  /** Where a registered token is checked (`GET /user`). */
  apiBase: string;
  upstreams: { npm: string; rubygems: string };
};

function urlOf(name: string, value: string | undefined, fallback: string) {
  if (value === undefined || value === "") return fallback;
  const parsed = URL.parse(value);
  if (
    parsed === null ||
    (parsed.protocol !== "https:" && parsed.protocol !== "http:") ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.search !== "" ||
    parsed.hash !== ""
  ) {
    throw new Error(`${name} must be an http(s) URL without credentials`);
  }
  return value.replace(/\/$/, "");
}

/**
 * GitHub's own hosts unless set; a GitHub Enterprise Server, or a test
 * double, is named here. The proxy must also list the registry hosts on
 * its credential allowlist, or every request is refused there.
 */
export function githubPackagesConfigFromEnv(
  env: Record<string, string | undefined>,
): GitHubPackagesConfig {
  return {
    apiBase: urlOf(
      "GITHUB_PACKAGES_API_URL",
      env.GITHUB_PACKAGES_API_URL,
      GITHUB_API_BASE,
    ),
    upstreams: {
      npm: urlOf(
        "GITHUB_PACKAGES_NPM_URL",
        env.GITHUB_PACKAGES_NPM_URL,
        GITHUB_PACKAGES_UPSTREAMS.npm,
      ),
      rubygems: urlOf(
        "GITHUB_PACKAGES_RUBYGEMS_URL",
        env.GITHUB_PACKAGES_RUBYGEMS_URL,
        GITHUB_PACKAGES_UPSTREAMS.rubygems,
      ),
    },
  };
}
