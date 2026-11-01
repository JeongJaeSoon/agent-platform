import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/**
 * Where npm, Bundler and Go look for their user configuration under the
 * engine's HOME. Only these are written: a repository's own files are the
 * session's work, and changing them would show up in its diff.
 */
export const PACKAGE_MANAGER_FILES = {
  npm: ".npmrc",
  bundler: ".bundle/config",
  go: ".config/go/env",
} as const;

// Bundler takes the token from a URL's userinfo and sends it as Basic; the
// proxy reads the password and ignores this name. Go refuses userinfo on an
// http URL, so its token rides in the path instead.
const BASIC_USER = "werft";

/**
 * The user-level configuration that points npm, Bundler and Go at the egress
 * proxy's packages route, keyed by the file under HOME. Go gets no `direct`
 * fallback and its checksum database through the route as well, so nothing
 * leaves for a VCS host or sum.golang.org on its own; `-mod=readonly` keeps a
 * build from rewriting go.mod to versions the lockfile does not name.
 */
export function packageManagerFiles(
  credentialUrl: string,
  token: string,
): Record<keyof typeof PACKAGE_MANAGER_FILES, string> {
  const route = new URL(credentialUrl);
  const base = `${route.protocol}//${route.host}/packages`;
  const authed = `${route.protocol}//${BASIC_USER}:${encodeURIComponent(token)}@${route.host}/packages`;
  return {
    npm: [
      `registry=${base}/npm/`,
      `//${route.host}/packages/npm/:_authToken=${token}`,
      "",
    ].join("\n"),
    bundler: [
      "---",
      `BUNDLE_MIRROR__HTTPS://RUBYGEMS__ORG/: "${authed}/rubygems"`,
      "",
    ].join("\n"),
    go: [
      `GOPROXY=${base}/go/_token/${encodeURIComponent(token)}`,
      `GOSUMDB=sum.golang.org ${base}/gosum/_token/${encodeURIComponent(token)}`,
      "GOFLAGS=-mod=readonly",
      "",
    ].join("\n"),
  };
}

/**
 * Writes this claim's package manager configuration, or removes it when the
 * claim carries no packages token (an API from before the route): a
 * configuration left pointing at the route would only fail every install.
 */
export async function writePackageManagerConfig(
  home: string,
  credentialUrl: string,
  token: string | undefined,
): Promise<void> {
  const contents =
    token === undefined ? null : packageManagerFiles(credentialUrl, token);
  for (const [manager, relative] of Object.entries(PACKAGE_MANAGER_FILES)) {
    const path = join(home, relative);
    const content = contents?.[manager as keyof typeof PACKAGE_MANAGER_FILES];
    if (content === undefined) {
      await rm(path, { force: true });
      continue;
    }
    await mkdir(dirname(path), { recursive: true });
    const staged = `${path}.${process.pid}.tmp`;
    // The token is attempt-scoped, but still nobody else's to read.
    await writeFile(staged, content, { mode: 0o600 });
    await rename(staged, path);
  }
}
