import type { RelatedIssue, UserLocale } from "@werft-ai/contracts";
import { repoRefOf } from "../ports/forge.ts";
import { withPullRequestTail } from "./git-attribution.ts";
import { cleanBody, cut, stripEngineSignatures } from "./pull-request-text.ts";

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

function clean(
  value: string | undefined,
  redact: (line: string) => string,
): string {
  if (value === undefined) return "";
  return cleanBody(
    stripEngineSignatures(value.replaceAll("\r\n", "\n")),
    Number.MAX_SAFE_INTEGER,
    redact,
  ).trim();
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
  const cleaned: Cleaned = {
    summary: clean(fields.summary, redact),
    changes: (fields.changes ?? [])
      .map((change) => clean(change, redact).replace(/\s*\n\s*/g, " "))
      .filter((change) => change !== ""),
    rationale: clean(fields.rationale, redact),
    testing: clean(fields.testing, redact),
    notes: clean(fields.notes, redact),
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
      const room = last.length - overflow - marker.length - 1;
      if (room > 0) {
        cleaned.changes[cleaned.changes.length - 1] = cut(
          last,
          room + marker.length,
          marker,
        );
      } else {
        cleaned.changes.pop();
      }
    } else {
      const value = cleaned[field];
      const room = value.length - overflow;
      cleaned[field] = room > marker.length ? cut(value, room, marker) : "";
    }
    body = render();
  }
  return { body, relatedDropped };
}
