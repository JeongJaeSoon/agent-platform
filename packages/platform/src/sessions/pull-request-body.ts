import type { RelatedIssue, UserLocale } from "@werft-ai/contracts";
import { repoRefOf } from "../ports/forge.ts";
import { closeOpenBlocks, withPullRequestTail } from "./git-attribution.ts";
import {
  cleanBodies,
  cut,
  stripEngineSignatures,
} from "./pull-request-text.ts";

/** The fields the agent gives, before the platform lays them out. */
export type PullRequestFields = {
  summary?: string | undefined;
  changes?: readonly string[] | undefined;
  rationale?: string | undefined;
  testing?: string | undefined;
  notes?: string | undefined;
  related?: readonly RelatedIssue[] | undefined;
};

type SectionName =
  | "summary"
  | "changes"
  | "rationale"
  | "testing"
  | "related"
  | "notes";

const HEADINGS: Record<UserLocale, Record<SectionName, string>> = {
  ko: {
    summary: "요약",
    changes: "변경 사항",
    rationale: "배경",
    testing: "테스트",
    related: "관련 이슈",
    notes: "참고",
  },
  en: {
    summary: "Summary",
    changes: "Changes",
    rationale: "Background",
    testing: "Testing",
    related: "Related issues",
    notes: "Notes",
  },
  ja: {
    summary: "概要",
    changes: "変更点",
    rationale: "背景",
    testing: "テスト",
    related: "関連イシュー",
    notes: "備考",
  },
};

const OMITTED: Record<UserLocale, string> = {
  ko: "…(생략)",
  en: "…(omitted)",
  ja: "…(省略)",
};

// The order a body too long for the forge gives text up: the least central
// first.
const SHRINK_ORDER = [
  "notes",
  "testing",
  "rationale",
  "changes",
  "summary",
] as const;
type ShrinkField = (typeof SHRINK_ORDER)[number];

const MAX_RELATED_REPOSITORY_NAME = 140;

/**
 * The line a `related` item becomes, or null when the platform cannot name
 * it. Only the pull request's own repository's issue is closed; any other is
 * referenced. The reference is built here from validated parts, never from
 * agent text, so it is the one place a closing keyword or a cross-reference
 * is written on purpose.
 */
function relatedLine(
  item: RelatedIssue,
  repository: {
    id: string;
    repositories: Readonly<Record<string, { url: string }>>;
  },
): string | null {
  const own =
    item.repository_id === undefined || item.repository_id === repository.id;
  if (own) return `${item.closes ? "Closes" : "Refs"} #${item.number}`;
  const id = item.repository_id ?? "";
  const entry = Object.hasOwn(repository.repositories, id)
    ? repository.repositories[id]
    : undefined;
  const ref = entry === undefined ? null : repoRefOf(entry.url);
  if (ref === null) return null;
  const name = `${ref.owner}/${ref.name}`;
  if (name.length > MAX_RELATED_REPOSITORY_NAME) return null;
  return `Refs ${name}#${item.number}`;
}

type Cleaned = {
  summary: string;
  changes: string[];
  rationale: string;
  testing: string;
  notes: string;
  related: string[];
};

function assemble(fields: Cleaned, locale: UserLocale): string {
  const headings = HEADINGS[locale];
  const sections: string[] = [];
  const text = (name: SectionName, value: string) => {
    if (value !== "") sections.push(`## ${headings[name]}\n${value}`);
  };
  text("summary", fields.summary);
  if (fields.changes.length > 0) {
    sections.push(
      `## ${headings.changes}\n${fields.changes.map((change) => `- ${change}`).join("\n")}`,
    );
  }
  text("rationale", fields.rationale);
  text("testing", fields.testing);
  if (fields.related.length > 0) {
    sections.push(
      `## ${headings.related}\n${fields.related.map((line) => `- ${line}`).join("\n")}`,
    );
  }
  text("notes", fields.notes);
  return sections.join("\n\n");
}

const ZWSP = "​";

/**
 * A change item as one bullet line. A zero-width space in front keeps the text
 * from starting a block inside the bullet (fence, rule, heading, quote, list,
 * checkbox, link definition, HTML), each of which would hide the text or take
 * in the next item or the tail. It is not whitespace to Markdown.
 */
function oneLine(item: string): string {
  const line = item.replace(/\s*\n\s*/g, " ");
  return line === "" ? "" : `${ZWSP}${line}`;
}

// Slack for the closing text a cut may add.
const CLOSING_ROOM = 16;

/**
 * What starts HTML in Markdown: a tag, a closing tag, a processing instruction,
 * a declaration, CDATA. An HTML block runs on past the next section and the
 * tail, and each kind ends differently, so fields carry none: a zero-width
 * space after the `<` leaves the text as it reads. (Comments are already
 * broken by the cleaning.)
 */
const HTML_START = new RegExp(`<(?=[A-Za-z/?]|!(?!${ZWSP}))`, "g");

/** Each text cleaned in order (a private key block carries over). */
function cleanAll(
  values: readonly string[],
  redact: (line: string) => string,
): string[] {
  return cleanBodies(
    values.map((value) =>
      // A lone CR also ends a line for Markdown.
      stripEngineSignatures(value.replace(/\r\n?/g, "\n")),
    ),
    Number.MAX_SAFE_INTEGER,
    redact,
  ).map((text) => fenceSafe(text.trim().replace(HTML_START, `<${ZWSP}`)));
}

const FENCE_RUN = /`{3,}|~{3,}/g;
const breakRun = (run: string) => [...run].join(ZWSP);

/**
 * A field's fences made the one shape the fence tracker judges the way
 * Markdown does: a fence starts at the beginning of a line (its indent
 * dropped). A run of three or more backticks or tildes anywhere else is broken
 * with zero-width spaces, so a fence inside a list item, a quote or an indented
 * block cannot leave the tracker and the renderer disagreeing about what is
 * open.
 */
function fenceSafe(text: string): string {
  return text
    .split("\n")
    .map((line) => {
      const start = /^[ \t]*(`{3,}|~{3,})(.*)$/.exec(line);
      if (start === null) return line.replace(FENCE_RUN, breakRun);
      return `${start[1]}${(start[2] ?? "").replace(FENCE_RUN, breakRun)}`;
    })
    .join("\n");
}

/**
 * `value` cut by at least `overflow` characters, closing included, or empty
 * when that cannot be done: a fence that closes with a run as long as its
 * opening would otherwise make a cut longer than what it cut.
 */
function shrunk(value: string, overflow: number, marker: string): string {
  const room = value.length - overflow - CLOSING_ROOM;
  if (room <= marker.length) return "";
  const next = closeOpenBlocks(cut(value, room, marker));
  return next.length <= value.length - overflow ? next : "";
}

/**
 * The platform's default body for structured fields: a heading per field that
 * has content, in the workspace's language, then the tail. Every field goes
 * through the same cleaning as a legacy body. The length is judged on the
 * final string, tail included: while it is over `maxLength`, text is cut from
 * `notes`, `testing`, `rationale`, `changes` (last item first) and `summary`,
 * in that order, leaving a marker where it was cut.
 */
export function renderPullRequestBody(input: {
  fields: PullRequestFields;
  locale: UserLocale;
  tail: string;
  maxLength: number;
  redact: (line: string) => string;
  repository: {
    id: string;
    repositories: Readonly<Record<string, { url: string }>>;
  };
}): { body: string; relatedDropped: number } {
  const { fields, locale, tail, maxLength, redact } = input;
  const related: string[] = [];
  let relatedDropped = 0;
  for (const item of fields.related ?? []) {
    const line = relatedLine(item, input.repository);
    if (line === null) relatedDropped += 1;
    else if (!related.includes(line)) related.push(line);
  }
  // In the order they appear in the body.
  const changeCount = fields.changes?.length ?? 0;
  const texts = cleanAll(
    [
      fields.summary ?? "",
      ...(fields.changes ?? []),
      fields.rationale ?? "",
      fields.testing ?? "",
      fields.notes ?? "",
    ],
    redact,
  );
  // A text that leaves a fence or element open is closed, so what follows it
  // is not swallowed. An item of `changes` is one line: a fence in a bullet
  // would be read as the start of a block the tail then falls into.
  const block = (at: number) => closeOpenBlocks(texts[at] ?? "");
  const cleaned: Cleaned = {
    summary: block(0),
    changes: texts
      .slice(1, 1 + changeCount)
      .map((change) => oneLine(change))
      .filter((change) => change !== ""),
    rationale: block(1 + changeCount),
    testing: block(2 + changeCount),
    notes: block(3 + changeCount),
    related,
  };
  const marker = OMITTED[locale];
  const render = () => withPullRequestTail(assemble(cleaned, locale), tail);
  let body = render();
  const shrinkable = (field: ShrinkField) =>
    field === "changes" ? cleaned.changes.length > 0 : cleaned[field] !== "";
  while (body.length > maxLength) {
    const field = SHRINK_ORDER.find(shrinkable);
    if (field === undefined) {
      // Only the platform's own lines are left over the limit.
      return { body: cut(body, maxLength, ""), relatedDropped };
    }
    const overflow = body.length - maxLength;
    if (field === "changes") {
      const last = cleaned.changes.at(-1) ?? "";
      if (last.length - overflow > marker.length) {
        cleaned.changes[cleaned.changes.length - 1] = cut(
          last,
          last.length - overflow,
          marker,
        );
      } else {
        cleaned.changes.pop();
      }
    } else {
      cleaned[field] = shrunk(cleaned[field], overflow, marker);
    }
    body = render();
  }
  return { body, relatedDropped };
}
