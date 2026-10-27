/**
 * The check a fixture file passes before the demo is published: no
 * credential, no address outside example.test, no host or name from the
 * machine it was recorded on. CI runs it on every build of the demo.
 *
 *   bun apps/web/scripts/demo-scan.ts
 *   bun apps/web/scripts/demo-scan.ts --write-ignores <gitleaks-report.json>
 */
import { join } from "node:path";
import { parseArgs } from "node:util";

export interface Finding {
  readonly rule: string;
  readonly match: string;
  /** Position of the answer in `responses`; its key may hold the value too. */
  readonly answer?: number;
  /** 1-based line of the offending .gitleaksignore entry. */
  readonly ignoreLine?: number;
}

const PRIVATE_IPV4 =
  /\b(?:127\.0\.0\.1|localhost|10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2}|100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])(?:\.\d{1,3}){2})\b/gi;

const RULES: readonly (readonly [string, RegExp])[] = [
  ["platform token", /\bap[a-z]_[A-Za-z0-9_-]{20,}/g],
  ["anthropic key", /\bsk-ant-[A-Za-z0-9_-]{10,}/g],
  ["slack token", /\bxox[abeprs]-[A-Za-z0-9-]{10,}/g],
  ["slack app token", /\bxapp-[A-Za-z0-9-]{10,}/g],
  ["github token", /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_\w{20,})/g],
  ["aws key", /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g],
  ["private key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/g],
  ["jwt", /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\./g],
  ["bearer header", /\bBearer[ +][A-Za-z0-9._~+/-]{16,}/gi],
  // Patterns that open with a repeated class start only where a word starts;
  // otherwise a long run of letters is retried from every position.
  ["tailnet host", /(?<![\w.-])[\w.-]*\.ts\.net\b|\btailscale\b/gi],
  ["private address", PRIVATE_IPV4],
  ["machine name", /\b(?:jaesoon|94soon|soons?-mac[\w-]*|wjdwotns\w*)\b/gi],
  ["home path", /\/(?:Users|home)\/[\w.-]+/g],
];

const EMAIL = /(?<![\w.+-])[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;
const ALLOWED_EMAIL = /@example\.test$/i;

/**
 * Addresses of the recording stack that a visitor's copy should not carry:
 * the Slack app's redirect URL names the local API port.
 */
const REPLACEMENTS: readonly (readonly [RegExp, string])[] = [
  [/http:\/\/(?:127\.0\.0\.1|localhost):\d+/g, "https://console.example.test"],
];

/** Applied by the recorder before it writes the file. */
export function sanitize(text: string): string {
  return REPLACEMENTS.reduce(
    (current, [pattern, replacement]) => current.replace(pattern, replacement),
    text,
  );
}

export function scanFixtures(fixtures: {
  readonly responses: Readonly<Record<string, unknown>>;
}): Finding[] {
  const findings: Finding[] = [];
  Object.entries(fixtures.responses).forEach(([key, response], answer) => {
    const text = [key, ...strings(response)].map(reveal).join("\n");
    for (const [rule, pattern] of RULES)
      for (const [match] of text.matchAll(pattern))
        findings.push({ rule, match, answer });
    for (const [match] of text.matchAll(EMAIL))
      if (!ALLOWED_EMAIL.test(match))
        findings.push({ rule: "email outside example.test", match, answer });
    for (const [match] of text.matchAll(IPV6_CANDIDATE))
      if (isPrivateIpv6(match))
        findings.push({ rule: "private address", match, answer });
  });
  return findings;
}

/** Every string in an answer, object keys included, as JavaScript reads it. */
function strings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(strings);
  if (typeof value === "object" && value !== null)
    return Object.entries(value).flatMap(([k, v]) => [k, ...strings(v)]);
  return [];
}

/**
 * What a reader of the published demo could recover from a string. SSE
 * frames carry JSON as text, so its escapes are still literal; URLs and
 * fixture keys are percent-encoded, sometimes twice. Decoding only reveals,
 * so the decoded text is the one scanned.
 */
function reveal(text: string): string {
  let current = text.replace(
    /\\u([0-9a-f]{4})|\\([bfnrt"\\/])/gi,
    (_, hex: string | undefined, char: string | undefined) =>
      hex
        ? String.fromCharCode(Number.parseInt(hex, 16))
        : ({ b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" }[char as "b"] ??
          (char as string)),
  );
  for (let round = 0; round < 4; round += 1) {
    // Byte-wise, so one stray `%` does not leave the rest encoded.
    const next = current.replace(/%([0-9a-f]{2})/gi, (_, hex: string) =>
      String.fromCharCode(Number.parseInt(hex, 16)),
    );
    if (next === current) break;
    current = next;
  }
  return current;
}

const IPV6_CANDIDATE =
  /(?<![\w:.])[0-9a-f]{0,4}(?::[0-9a-f]{0,4}){2,7}(?![\w:])/gi;

/**
 * Loopback or unique local (fc00::/7). The URL parser validates and
 * normalises the address, so `0:0:0:0:0:0:0:1` and `::0001` read as `::1`
 * and clock times such as `12:30:45` are not addresses at all.
 */
function isPrivateIpv6(candidate: string): boolean {
  let host: string;
  try {
    host = new URL(`http://[${candidate}]/`).hostname;
  } catch {
    return false;
  }
  // The parser writes ::ffff:127.0.0.1 as [::ffff:7f00:1].
  const mapped = /^\[::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})\]$/i.exec(host);
  if (mapped) {
    const [hi, lo] = [mapped[1], mapped[2]].map((group) =>
      Number.parseInt(group ?? "", 16),
    ) as [number, number];
    const ipv4 = [hi >> 8, hi & 255, lo >> 8, lo & 255].join(".");
    return new RegExp(PRIVATE_IPV4.source, "i").test(ipv4);
  }
  return host === "[::1]" || /^\[f[cd]/i.test(host);
}

/** A demo without a signed-in session answer opens on an error screen. */
export function checkComplete(fixtures: {
  readonly responses: Readonly<Record<string, unknown>>;
}): Finding[] {
  const me = fixtures.responses["/v1/auth/me"] as
    | { status?: unknown; json?: unknown }
    | undefined;
  const signedIn =
    me?.status === 200 &&
    typeof me.json === "object" &&
    me.json !== null &&
    !Array.isArray(me.json) &&
    Object.keys(me.json).length > 0;
  return signedIn
    ? []
    : [
        {
          rule: "no signed-in /v1/auth/me answer (record the fixtures first)",
          match: "",
        },
      ];
}

/** The fixture file as gitleaks names it, from the repository root. */
export const FIXTURES_PATH = "apps/web/src/demo/fixtures.json";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const BREAKDOWN_KEY_LINE = /^ {2,}"key": "([^"]*)",?$/;
const RESPONSE_LINE = /^ {4}"(\/v1\/[^"]*)": \{$/;

function agentIds(fixtures: {
  readonly responses: Readonly<Record<string, unknown>>;
}): Set<string> {
  const ids = new Set<string>();
  for (const [key, response] of Object.entries(fixtures.responses)) {
    if (!/^\/v1\/agents(?:\?|$)/.test(key)) continue;
    const items = (response as { json?: { items?: { id?: unknown }[] } }).json
      ?.items;
    for (const item of items ?? [])
      if (typeof item.id === "string") ids.add(item.id);
  }
  return ids;
}

/**
 * gitleaks' generic-api-key reads a usage breakdown's `"key": "<agent id>"`
 * as a credential. A .gitleaksignore entry for the fixture file may excuse
 * exactly that line and nothing else: the rule, a usage breakdown answer, a
 * UUID the recording's agent list names. A re-recording moves the lines, so
 * an entry left from the last one fails here instead of hiding a new value.
 */
export function checkIgnores(
  fixturesText: string,
  ignoreText: string,
): Finding[] {
  const lines = fixturesText.split("\n");
  const agents = agentIds(JSON.parse(fixturesText));
  const findings: Finding[] = [];
  for (const [i, raw] of ignoreText.split("\n").entries()) {
    const entry = raw.trim();
    if (!entry.includes(FIXTURES_PATH)) continue;
    const ignoreLine = i + 1;
    // gitleaks also honours `<commit>:<path>:<rule>:<line>`.
    if (!entry.startsWith(`${FIXTURES_PATH}:`)) {
      findings.push({
        rule: "gitleaks ignore in another form",
        match: entry,
        ignoreLine,
      });
      continue;
    }
    const [rule, lineNumber] = entry.slice(FIXTURES_PATH.length + 1).split(":");
    const index = Number(lineNumber) - 1;
    const line = lines[index] ?? "";
    let response = "";
    for (let i = index; i >= 0 && !response; i -= 1)
      response = RESPONSE_LINE.exec(lines[i] ?? "")?.[1] ?? "";
    const value = BREAKDOWN_KEY_LINE.exec(line)?.[1];
    const fail = (why: string) =>
      findings.push({
        rule: `gitleaks ignore ${why}`,
        match: entry,
        ignoreLine,
      });
    if (rule !== "generic-api-key") fail("for another rule");
    else if (value === undefined) fail("not on a breakdown key line");
    else if (!response.startsWith("/v1/usage/breakdown"))
      fail("outside a usage breakdown");
    else if (!UUID.test(value)) fail("on a value that is not a UUID");
    else if (!agents.has(value)) fail("on a UUID that is no recorded agent");
  }
  return findings;
}

/** The ignore file with the fixture's entries replaced by `entries`. */
export function withFixtureIgnores(
  ignoreText: string,
  entries: readonly string[],
): string {
  const kept = ignoreText
    .split("\n")
    .filter((line) => line.trim() && !line.startsWith(`${FIXTURES_PATH}:`));
  return `${[...kept, ...[...entries].sort()].join("\n")}\n`;
}

// CI logs are public: print no part of a match, its key or an ignore entry,
// only positions. `jq '.responses | keys[N]'` names answer N locally.
export function describeFinding(finding: Finding): string {
  const { rule, match, answer, ignoreLine } = finding;
  if (answer !== undefined)
    return `${rule}: ${match.length} chars (answer ${answer})`;
  if (ignoreLine !== undefined)
    return `${rule} (.gitleaksignore line ${ignoreLine})`;
  return rule;
}

function report(findings: readonly Finding[]): void {
  for (const finding of findings) console.error(describeFinding(finding));
}

if (import.meta.main) {
  const repo = new URL("../../../", import.meta.url).pathname;
  const ignorePath = join(repo, ".gitleaksignore");
  const ignoreFile = Bun.file(ignorePath);
  const ignoreText = (await ignoreFile.exists()) ? await ignoreFile.text() : "";
  const fixturesText = await Bun.file(join(repo, FIXTURES_PATH)).text();
  const { values } = parseArgs({
    options: { "write-ignores": { type: "string" } },
  });
  // A parser's message quotes the text around the error.
  const parse = (text: string, name: string) => {
    try {
      return JSON.parse(text);
    } catch {
      console.error(`${name} is not valid JSON`);
      process.exit(1);
    }
  };
  const fixtures: { responses: Record<string, unknown> } = parse(
    fixturesText,
    FIXTURES_PATH,
  );

  if (values["write-ignores"]) {
    // A gitleaks JSON report of the fixture file (README, "콘솔 데모").
    const found: { File: string; RuleID: string; StartLine: number }[] = parse(
      await Bun.file(values["write-ignores"]).text(),
      values["write-ignores"],
    );
    const entries = found
      .filter((finding) => finding.File === FIXTURES_PATH)
      .map(
        (finding) => `${finding.File}:${finding.RuleID}:${finding.StartLine}`,
      );
    const refused = checkIgnores(fixturesText, entries.join("\n"));
    if (refused.length > 0) {
      report(refused);
      console.error("not written: these findings need a look, not an ignore");
      process.exit(1);
    }
    await Bun.write(ignorePath, withFixtureIgnores(ignoreText, entries));
    console.log(`wrote ${entries.length} fixture entries to .gitleaksignore`);
    process.exit(0);
  }

  const findings = [
    ...checkComplete(fixtures),
    ...scanFixtures(fixtures),
    ...checkIgnores(fixturesText, ignoreText),
  ];
  report(findings);
  if (findings.length > 0) {
    console.error(`${findings.length} finding(s) in ${FIXTURES_PATH}`);
    process.exit(1);
  }
  const ignored = ignoreText
    .split("\n")
    .filter((line) => line.startsWith(`${FIXTURES_PATH}:`)).length;
  console.log(
    `clean: ${FIXTURES_PATH} (${Object.keys(fixtures.responses).length} answers; ${ignored} gitleaks ignores, each a recorded agent id in a usage breakdown, of ${agentIds(fixtures).size} agents)`,
  );
}
