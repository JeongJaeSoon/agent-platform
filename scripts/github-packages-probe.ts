// Measures whether a GitHub App installation token can read GitHub Packages
// (npm and RubyGems registries) (94S-1098). One-off: it mints tokens outside
// the GitHub gate with the same REST call @octokit/auth-app makes in
// forge-github.ts, and never prints, logs or stores a token or the App key.
//
// Usage (the App key is read from the file WERFT_APP_KEY_PATH names):
//   bun scripts/github-packages-probe.ts --no-packages \
//     --app-id <id> --installation-id <id> --owner <owner> --repo <repo> --out <log>
//   bun scripts/github-packages-probe.ts \
//     --app-id <id> --installation-id <id> --owner <owner> --repo <repo> \
//     --npm @<scope>/<name> --gem <name> --gem-version <version> --out <log>
// Control run, the owner's classic PAT read from the file WERFT_PAT_FILE names
// against no token at all; it needs no App:
//   bun scripts/github-packages-probe.ts --control --owner <owner> --repo <repo> \
//     --npm @<scope>/<name> --gem <name> --gem-version <version> --out <log>
//
// Every result line is `<row> <target> <http status> <redirect host|-> <summary>`;
// the same lines are appended to --out after a `#` header naming the run.
import { createSign } from "node:crypto";
import { appendFileSync, readFileSync } from "node:fs";
import { parseArgs } from "node:util";

const { values: args } = parseArgs({
  options: {
    "no-packages": { type: "boolean", default: false },
    control: { type: "boolean", default: false },
    "app-id": { type: "string" },
    "installation-id": { type: "string" },
    owner: { type: "string" },
    repo: { type: "string" },
    npm: { type: "string" },
    gem: { type: "string" },
    "gem-version": { type: "string" },
    out: { type: "string" },
  },
});

// Values are spliced into registry URLs, so each must stay one path segment.
function required(name: keyof typeof args, shape: RegExp): string {
  const value = args[name];
  if (typeof value !== "string" || !shape.test(value)) {
    console.error(`missing or malformed --${name}`);
    process.exit(2);
  }
  return value;
}

const ID = /^[0-9]+$/;
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const control = args.control === true;
const full = control || !args["no-packages"];
const mode = control ? "control" : full ? "full" : "no-packages";
const appId = control ? "-" : required("app-id", ID);
const installationId = control ? "-" : required("installation-id", ID);
const owner = required("owner", NAME);
const repo = required("repo", NAME);
const out = required("out", /./);
const npmName = full ? required("npm", /^@[^/]+\/[^/]+$/) : "";
const gemName = full ? required("gem", NAME) : "";
const gemVersion = full ? required("gem-version", NAME) : "";
const secretEnv = control ? "WERFT_PAT_FILE" : "WERFT_APP_KEY_PATH";
const secretPath = process.env[secretEnv];
if (!secretPath) {
  console.error(`${secretEnv} is not set`);
  process.exit(2);
}

const API = "https://api.github.com";
const NPM = "https://npm.pkg.github.com";
const GEMS = `https://rubygems.pkg.github.com/${owner}`;
const TIMEOUT_MS = 30_000;

function emit(
  row: string,
  target: string,
  status: string,
  host: string,
  summary: string,
) {
  const line = `${row} ${target} ${status} ${host} ${summary}`;
  console.log(line);
  appendFileSync(out, `${line}\n`);
}

function base64url(input: string | Buffer): string {
  return Buffer.from(input).toString("base64url");
}

function appJwt(): string {
  const now = Math.floor(Date.now() / 1000);
  const head = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  // iat is backdated for clock drift; GitHub caps exp at ten minutes.
  const body = base64url(
    JSON.stringify({ iat: now - 60, exp: now + 540, iss: appId }),
  );
  const signer = createSign("RSA-SHA256");
  signer.update(`${head}.${body}`);
  return `${head}.${body}.${base64url(signer.sign(readFileSync(secretPath as string, "utf8")))}`;
}

function githubHeaders(auth: string) {
  return {
    Accept: "application/vnd.github+json",
    Authorization: auth,
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "werft-packages-probe",
  };
}

type TokenSet = { label: string; permissions?: Record<string, string> };
const TOKEN_SETS: TokenSet[] = [
  { label: "contents", permissions: { contents: "read" } },
  { label: "packages", permissions: { packages: "read" } },
  { label: "none" },
];

// Tokens live only in this map and in request headers.
const tokens = new Map<string, string>();

async function mint(row: string, set: TokenSet, jwt: string) {
  const target = `mint:${set.label}`;
  try {
    const res = await fetch(
      `${API}/app/installations/${installationId}/access_tokens`,
      {
        method: "POST",
        headers: githubHeaders(`Bearer ${jwt}`),
        body: JSON.stringify({
          repositories: [repo],
          permissions: set.permissions,
        }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      },
    );
    const body = (await res.json().catch(() => ({}))) as {
      token?: string;
      permissions?: Record<string, string>;
    };
    if (res.status === 201 && typeof body.token === "string")
      tokens.set(set.label, body.token);
    const granted = Object.entries(body.permissions ?? {})
      .map(([name, level]) => `${name}:${level}`)
      .sort()
      .join("+");
    emit(row, target, String(res.status), "-", `granted=${granted || "-"}`);
  } catch (error) {
    emit(row, target, "ERR", "-", errorName(error));
  }
}

async function revoke(row: string, label: string) {
  const token = tokens.get(label);
  if (token === undefined) return;
  tokens.delete(label);
  try {
    const res = await fetch(`${API}/installation/token`, {
      method: "DELETE",
      headers: githubHeaders(`Bearer ${token}`),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    emit(row, `revoke:${label}`, String(res.status), "-", "-");
  } catch (error) {
    emit(row, `revoke:${label}`, "ERR", "-", errorName(error));
  }
}

// Only the class name: an error message may echo request details.
function errorName(error: unknown): string {
  return `error=${error instanceof Error ? error.name : "unknown"}`;
}

type Auth = "bearer" | "basic";

// The label "anon" sends no Authorization at all.
function authHeader(label: string, auth: Auth): Record<string, string> {
  const token = tokens.get(label);
  if (token === undefined) return {};
  if (auth === "bearer") return { Authorization: `Bearer ${token}` };
  // A PAT authenticates as its owner; an installation token as x-access-token.
  const user = label === "pat" ? owner : "x-access-token";
  return {
    Authorization: `Basic ${Buffer.from(`${user}:${token}`).toString("base64")}`,
  };
}

type Probe = {
  status: number;
  host: string;
  summary: string;
  tarball?: string | undefined;
};

// Redirects are not followed with the token: the follow-up request goes
// without Authorization, as a proxy would send it.
async function probe(
  url: string,
  headers: Record<string, string>,
  read: "json" | "gzip" | "none",
): Promise<Probe> {
  const res = await fetch(url, {
    headers: { "User-Agent": "werft-packages-probe", ...headers },
    redirect: "manual",
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const location = res.headers.get("location");
  if (res.status >= 300 && res.status < 400 && location) {
    await res.body?.cancel();
    const next = new URL(location, url);
    const followed = await fetch(next, {
      redirect: "manual",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    await followed.body?.cancel();
    const length = followed.headers.get("content-length") !== null;
    return {
      status: res.status,
      host: next.host,
      summary: `followed=${followed.status}+content-length=${yes(length)}`,
    };
  }
  if (read === "json" && res.ok) {
    const body = (await res.json().catch(() => null)) as {
      versions?: Record<string, { dist?: { tarball?: string } }>;
      "dist-tags"?: { latest?: string };
    } | null;
    const versions = body?.versions;
    const latest = body?.["dist-tags"]?.latest;
    const tarball = latest ? versions?.[latest]?.dist?.tarball : undefined;
    return {
      status: res.status,
      host: "-",
      summary: `versions=${yes(versions !== undefined)}`,
      tarball: registryUrl(tarball),
    };
  }
  if (read === "gzip" && res.ok) {
    const bytes = new Uint8Array(await res.arrayBuffer());
    return {
      status: res.status,
      host: "-",
      summary: `gzip=${yes(bytes[0] === 0x1f && bytes[1] === 0x8b)}`,
    };
  }
  await res.body?.cancel();
  return {
    status: res.status,
    host: "-",
    summary: `content-length=${yes(res.headers.get("content-length") !== null)}`,
  };
}

// The tarball URL comes from the response; the token goes only to the registry.
function registryUrl(url: string | undefined): string | undefined {
  if (url === undefined || !URL.canParse(url)) return undefined;
  const parsed = new URL(url);
  const registry = new URL(NPM);
  return parsed.protocol === registry.protocol && parsed.host === registry.host
    ? url
    : undefined;
}

function yes(value: boolean): string {
  return value ? "yes" : "no";
}

async function run(
  row: string,
  target: string,
  label: string,
  url: string | undefined,
  auth: Auth,
  read: "json" | "gzip" | "none",
): Promise<Probe | undefined> {
  if (label !== "anon" && !tokens.has(label)) {
    emit(row, target, "-", "-", "skipped=no-token");
    return;
  }
  if (url === undefined) {
    emit(row, target, "-", "-", "skipped=no-url");
    return;
  }
  try {
    const result = await probe(url, authHeader(label, auth), read);
    emit(row, target, String(result.status), result.host, result.summary);
    return result;
  } catch (error) {
    emit(row, target, "ERR", "-", errorName(error));
  }
}

function npmPath(name: string): string {
  return `${NPM}/${name.replace("/", "%2f")}`;
}

appendFileSync(
  out,
  `# ${mode} ${new Date().toISOString()} app=${appId} installation=${installationId} repo=${owner}/${repo}\n`,
);

async function revokeAll() {
  for (const [index, set] of TOKEN_SETS.entries()) {
    // revoke() drops the token before its log line, so a failed append
    // cannot stop the next DELETE.
    await revoke(`R${index + 1}`, set.label).catch(() => {});
  }
}

process.on("SIGINT", () => {
  void revokeAll().finally(() => process.exit(130));
});

try {
  await probeAll();
} catch (error) {
  // An uncaught error would print a stack trace; keep it to the class name.
  console.error(errorName(error));
  process.exitCode = 1;
} finally {
  await revokeAll();
}

async function probeAll() {
  if (control) {
    try {
      tokens.set("pat", readFileSync(secretPath as string, "utf8").trim());
    } catch (error) {
      emit("M0", "pat-file", "ERR", "-", errorName(error));
      throw error;
    }
    // The control: the PAT must download, no token must not.
    return probePackages([
      ["C-pat/", "pat"],
      ["C-anon/", "anon"],
    ]);
  }
  let jwt: string;
  try {
    jwt = appJwt();
  } catch (error) {
    emit("M0", "app-jwt", "ERR", "-", errorName(error));
    throw error;
  }
  for (const [index, set] of TOKEN_SETS.entries())
    await mint(`M${index + 1}`, set, jwt);
  if (!full) return probeRegistries();
  // Row 1-4 use the contents:read token; row 5 repeats them with the others.
  return probePackages([
    ["", "contents"],
    ["5-packages/", "packages"],
    ["5-none/", "none"],
  ]);
}

async function probeRegistries() {
  // No package exists yet: a missing name tells whether the registry accepts
  // the token at all (404) or refuses it (401/403), against no token.
  const absent = npmPath(`@${owner.toLowerCase()}/werft-probe-absent`);
  for (const label of ["anon", ...TOKEN_SETS.map((set) => set.label)]) {
    await run(`0-${label}`, "npm-absent", label, absent, "bearer", "none");
    await run(
      `0-${label}`,
      "gem-index",
      label,
      `${GEMS}/specs.4.8.gz`,
      "basic",
      "gzip",
    );
  }
}

async function probePackages(sets: [prefix: string, label: string][]) {
  const gem = `${GEMS}/gems/${gemName}-${gemVersion}.gem`;
  let tarball: string | undefined;
  for (const [prefix, label] of sets) {
    const meta = await run(
      `${prefix}1`,
      "npm-metadata",
      label,
      npmPath(npmName),
      "bearer",
      "json",
    );
    tarball ??= meta?.tarball;
  }
  for (const [prefix, label] of sets) {
    await run(`${prefix}2`, "npm-tarball", label, tarball, "bearer", "none");
    await run(
      `${prefix}3-basic`,
      "gem-index",
      label,
      `${GEMS}/specs.4.8.gz`,
      "basic",
      "gzip",
    );
    await run(
      `${prefix}3-bearer`,
      "gem-index",
      label,
      `${GEMS}/specs.4.8.gz`,
      "bearer",
      "gzip",
    );
    await run(`${prefix}4-basic`, "gem-file", label, gem, "basic", "none");
    await run(`${prefix}4-bearer`, "gem-file", label, gem, "bearer", "none");
  }
}
