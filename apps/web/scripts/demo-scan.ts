/**
 * The check a fixture file passes before the demo is published: no
 * credential, no address outside example.test, no host or name from the
 * machine it was recorded on. CI runs it on every build of the demo.
 *
 *   bun apps/web/scripts/demo-scan.ts [fixtures.json]
 */

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
 * Hosts the recording stack names that a visitor's copy should not: the
 * compose service names behind repository and gateway URLs.
 */
const REPLACEMENTS: readonly (readonly [RegExp, string])[] = [];

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

if (import.meta.main) {
  const path =
    process.argv[2] ??
    new URL("../src/demo/fixtures.json", import.meta.url).pathname;
  const findings = scanFixtures(await Bun.file(path).json());
  // CI logs are public: never print what was found, only where.
  for (const { rule, match, where } of findings)
    console.error(
      `${rule}: ${match.slice(0, 3)}… ${match.length} chars (in ${where})`,
    );
  if (findings.length > 0) {
    console.error(`${findings.length} finding(s) in ${path}`);
    process.exit(1);
  }
  console.log(`clean: ${path}`);
}
