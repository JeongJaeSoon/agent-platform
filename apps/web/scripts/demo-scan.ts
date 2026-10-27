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
  /** The fixture key the match sits under. */
  readonly where: string;
}

const RULES: readonly (readonly [string, RegExp])[] = [
  ["platform token", /\bap[a-z]_[A-Za-z0-9_-]{20,}/g],
  ["anthropic key", /\bsk-ant-[A-Za-z0-9_-]{10,}/g],
  ["slack token", /\bxox[abeprs]-[A-Za-z0-9-]{10,}/g],
  ["slack app token", /\bxapp-[A-Za-z0-9-]{10,}/g],
  ["github token", /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_\w{20,})/g],
  ["aws key", /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g],
  ["private key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/g],
  ["jwt", /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\./g],
  ["bearer header", /\bBearer [A-Za-z0-9._~+/-]{16,}/g],
  ["tailnet host", /[\w.-]*\.ts\.net\b|\btailscale\b/gi],
  [
    "private address",
    /\b(?:127\.0\.0\.1|localhost|10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2})\b/g,
  ],
  ["machine name", /\b(?:jaesoon|94soon|soons?-mac[\w-]*|wjdwotns\w*)\b/gi],
  ["home path", /\/(?:Users|home)\/[\w.-]+/g],
];

const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;
const ALLOWED_EMAIL = /@example\.test$/;

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
  for (const [where, response] of Object.entries(fixtures.responses)) {
    const text = `${where}\n${JSON.stringify(response)}`;
    for (const [rule, pattern] of RULES)
      for (const [match] of text.matchAll(pattern))
        findings.push({ rule, match, where });
    for (const [match] of text.matchAll(EMAIL))
      if (!ALLOWED_EMAIL.test(match))
        findings.push({ rule: "email outside example.test", match, where });
  }
  return findings;
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
  for (const entry of ignoreText.split("\n").map((line) => line.trim())) {
    if (!entry.startsWith(`${FIXTURES_PATH}:`)) continue;
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
        where: response || "?",
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

// CI logs are public: never print what was found, only where.
function report(findings: readonly Finding[]): void {
  for (const { rule, match, where } of findings)
    console.error(
      rule.startsWith("gitleaks ignore")
        ? `${rule}: ${match} (in ${where})`
        : `${rule}: ${match.slice(0, 3)}… ${match.length} chars (in ${where})`,
    );
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

  if (values["write-ignores"]) {
    // A gitleaks JSON report of the fixture file (README, "콘솔 데모").
    const found = (await Bun.file(values["write-ignores"]).json()) as {
      File: string;
      RuleID: string;
      StartLine: number;
    }[];
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

  const fixtures = JSON.parse(fixturesText);
  const findings = [
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
