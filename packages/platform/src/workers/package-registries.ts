import type { GitHubPackagesRegistry } from "@werft-ai/contracts";

/**
 * The public registries the egress proxy's packages route reaches, by the
 * name a worker puts in its path (`/packages/<name>/...`). No credential is
 * attached. Which of them a worker can actually reach is the proxy's global
 * credential allowlist, so an operator opens or closes one there.
 *
 * `gosum` is the Go checksum database, reached through the route because
 * proxy.golang.org answers its `/sumdb/` proxy endpoints with 404.
 */
export const PUBLIC_PACKAGE_REGISTRIES = {
  npm: "https://registry.npmjs.org",
  rubygems: "https://rubygems.org",
  go: "https://proxy.golang.org",
  gosum: "https://sum.golang.org",
} as const;

/**
 * GitHub Packages registries, reached with the workspace's bot token and
 * only for what its allowlist names.
 */
export const GITHUB_PACKAGE_REGISTRIES = {
  "github-npm": "npm",
  "github-rubygems": "rubygems",
} as const satisfies Record<string, GitHubPackagesRegistry>;

export type PackageRegistry =
  | keyof typeof PUBLIC_PACKAGE_REGISTRIES
  | keyof typeof GITHUB_PACKAGE_REGISTRIES;

export const PACKAGE_REGISTRY_NAMES = [
  ...Object.keys(PUBLIC_PACKAGE_REGISTRIES),
  ...Object.keys(GITHUB_PACKAGE_REGISTRIES),
] as [PackageRegistry, ...PackageRegistry[]];

/** What a packages token is bound to: the same set for every session. */
export const PACKAGES_BINDING = "public";
