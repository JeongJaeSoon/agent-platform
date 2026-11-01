import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { WorkspaceDescriptor } from "@werft-ai/contracts";

/**
 * The engine's user-level git configuration (`$HOME/.config/git/config`).
 * Git reads `~/.gitconfig` after it, and a `git config --global` the session
 * runs writes there only when that file exists, so it is made empty if
 * missing: otherwise the session's own settings would land here and go
 * with the next claim's routes.
 */
export const REPOSITORY_ROUTES_FILE = ".config/git/config";
const USER_GIT_CONFIG = ".gitconfig";
// The one segment the proxy's repository route takes as an id.
const ROUTE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

type Routed = { id: string; url: URL };

/**
 * The session's repositories the proxy's repository route serves: the
 * session's own and each one attached, by catalog id.
 */
function routedRepositories(workspace: WorkspaceDescriptor): Routed[] {
  const listed = [
    ...(workspace.repository === null ? [] : [workspace.repository]),
    ...(workspace.additional_repositories ?? []),
  ];
  const routed: Routed[] = [];
  for (const repository of listed) {
    if (
      repository.id === null ||
      repository.access === undefined ||
      !ROUTE_ID.test(repository.id)
    ) {
      continue;
    }
    const url = URL.parse(repository.url);
    if (
      url === null ||
      (url.protocol !== "https:" && url.protocol !== "http:")
    ) {
      continue;
    }
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    routed.push({ id: repository.id, url });
  }
  return routed;
}

/** `https://host/owner/repo`, whichever way the catalog spelled the end. */
function bareUrl(url: URL): string {
  return url.href.replace(/\/+$/, "").replace(/\.git$/, "");
}

function quoted(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

/**
 * Sends every fetch of one of the session's repositories through the proxy's
 * repository route, so a submodule, a git URL dependency, a private Go module
 * and Git LFS reach it the way the worker's own clone does: with the
 * attempt's token, and only for repositories the gate allows the session.
 * Each URL maps two ways, `.git` and bare, both onto `<id>/.git`: Git LFS
 * then puts its endpoint under that path whatever the id ends in. A URL that
 * only starts like a bare one (`…/repo-x`) comes out as a path no route has,
 * rather than as another id. Null when there is nothing to route.
 */
export function repositoryRoutesConfig(
  credentialUrl: string,
  token: string,
  workspace: WorkspaceDescriptor,
): string | null {
  const routed = routedRepositories(workspace);
  if (routed.length === 0 || /[\r\n\0]/.test(token)) return null;
  const route = new URL(credentialUrl);
  const base = `${route.protocol}//${route.host}/repository`;
  const lines: string[] = [];
  for (const { id, url } of routed) {
    const bare = bareUrl(url);
    lines.push(
      `[url ${quoted(`${base}/${id}/.git`)}]`,
      `\tinsteadOf = ${quoted(`${bare}.git`)}`,
      `[url ${quoted(`${base}/${id}/.git/`)}]`,
      `\tinsteadOf = ${quoted(bare)}`,
      `\tinsteadOf = ${quoted(`${bare}/`)}`,
    );
  }
  lines.push(
    `[http ${quoted(`${base}/`)}]`,
    `\textraHeader = ${quoted(`Authorization: Bearer ${token}`)}`,
    "",
  );
  return lines.join("\n");
}

/**
 * The Go module paths of the session's github.com repositories, for
 * `GOPRIVATE`: fetched with git through the route above rather than from the
 * module proxy and checked against no checksum database, neither of which
 * can see a private repository. Other hosts are left out: Go finds their
 * VCS with an HTTPS `?go-get=1` request that the route does not serve.
 */
export function goPrivateModules(workspace: WorkspaceDescriptor): string[] {
  return routedRepositories(workspace)
    .filter(({ url }) => url.protocol === "https:" && url.host === "github.com")
    .map(({ url }) => bareUrl(url).slice("https://".length));
}

/**
 * Writes this claim's repository routes for the engine, or removes them when
 * the claim gives no repository token: routes left from an earlier claim
 * would carry a token that no longer stands.
 */
export async function writeRepositoryRoutes(
  home: string,
  credentialUrl: string,
  workspace: WorkspaceDescriptor,
): Promise<void> {
  const path = join(home, REPOSITORY_ROUTES_FILE);
  // One token per attempt stands for every repository the claim routes; a
  // session without a repository of its own may still attach some.
  const token = [
    workspace.repository,
    ...(workspace.additional_repositories ?? []),
  ].find((repository) => repository?.access !== undefined)?.access?.token;
  const content =
    token === undefined
      ? null
      : repositoryRoutesConfig(credentialUrl, token, workspace);
  if (content === null) {
    await rm(path, { force: true });
    return;
  }
  await mkdir(dirname(path), { recursive: true });
  // Appending nothing creates it when missing and leaves it alone otherwise.
  await writeFile(join(home, USER_GIT_CONFIG), "", { flag: "a" });
  const staged = `${path}.${process.pid}.tmp`;
  // The token is attempt-scoped, but still nobody else's to read.
  await writeFile(staged, content, { mode: 0o600 });
  await rename(staged, path);
}
