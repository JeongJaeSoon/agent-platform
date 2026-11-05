// A repository's pull request template, read for the pull request the
// platform opens. The template is input from the repository: anyone who may
// write to its default branch wrote it. It is read at one pinned commit of that
// branch, never shown to the agent, and made inert before any of it reaches
// the pull request: only the platform's own fields are ever put into it.

import type { PullRequestTemplateRecord } from "@werft-ai/contracts";
import type { GitHubApi, GitTreeEntry } from "../ports/github-gate.ts";
import { closeOpenBlocks } from "./git-attribution.ts";
import { breakReferences, stripEngineSignatures } from "./pull-request-text.ts";

// What a template may not link on its own: `#12`, `GH-12`, a commit, and the
// address of an issue, pull request or commit. (`&#12;` is an entity.) An
// address is broken in its path, whatever its scheme or host is written as:
// a host is normalised by a URL parser, a path is not.
const LOCAL_REFERENCE = /(^|[^\w&])(#|GH-)(?=\d)/gi;
// Whatever follows the segment, an entity or a percent escape included.
const NUMBERED_PATH = /(\/(?:issues|pull)\/)(?=[^\s])/gi;
const COMMIT_PATH = /(\/commit\/)(?=[^\s])/gi;
const COMMIT_REFERENCE = /(^|[^\w/.-])([\w.-]+\/[\w.-]+@)(?=[0-9a-f]{7})/gi;
const COMMIT_HASH = /\b([0-9a-f]{7})(?=[0-9a-f]{33}\b)/gi;

function breakLinks(text: string): string {
  return text
    .replace(LOCAL_REFERENCE, `$1$2${ZWSP}`)
    .replace(NUMBERED_PATH, `$1${ZWSP}`)
    .replace(COMMIT_PATH, `$1${ZWSP}`)
    .replace(COMMIT_REFERENCE, `$1$2${ZWSP}`)
    .replace(COMMIT_HASH, `$1${ZWSP}`);
}

export const SECTION_NAMES = [
  "summary",
  "changes",
  "rationale",
  "testing",
  "related",
  "notes",
] as const;
export type SectionName = (typeof SECTION_NAMES)[number];

/** What a section is filled with, without its heading. Absent or empty: nothing to place. */
export type SectionBlocks = Partial<Record<SectionName, string>>;

export const TEMPLATE_MAX_BYTES = 16 * 1024;
const ZWSP = "​";

// ---------------------------------------------------------------------------
// Detecting

type TemplateSkip = NonNullable<PullRequestTemplateRecord["skipped"]>;

export type TemplateRead =
  | {
      kind: "found";
      commit: string;
      path: string;
      blobSha: string;
      template: PreparedTemplate;
    }
  | { kind: "none"; commit: string }
  | {
      kind: "skipped";
      commit: string | null;
      reason: TemplateSkip;
      path?: string;
      /** Why a read failed, for the log: an error name, never a message. */
      error?: string;
    };

/** The reads the detection makes; the pull request grant's `api` has them. */
export type TemplateForge = Pick<
  GitHubApi,
  "getRepository" | "getBranchHead" | "readTree" | "readBlob"
>;

/** Stops the walk with a reason; the pull request opens on the default template. */
class Skip extends Error {
  constructor(
    readonly reason: TemplateSkip,
    readonly path?: string,
  ) {
    super(reason);
  }
}

const SINGLE_NAME = "pull_request_template.md";
const DIRECTORY_NAME = "pull_request_template";
// Where GitHub looks, in its order: `.github/`, the root, `docs/`.
const LOCATIONS: readonly (string | null)[] = [".github", null, "docs"];
const FILE_MODES: ReadonlySet<string> = new Set(["100644", "100755"]);
const MAX_PATH_RECORD = 200;

/** A path as it is recorded: names come from the repository, so no control or hidden character. */
function recordedPath(parts: readonly string[]): string {
  return stripHidden(parts.join("/"))
    .replace(/[\p{Cc}\p{Cf}]/gu, "?")
    .slice(0, MAX_PATH_RECORD);
}

/**
 * The repository's template at the default branch's commit as it is when
 * this starts. Never throws: a read that fails is `read_failed`, and the
 * caller opens the pull request on the platform's default template.
 */
export async function readRepositoryTemplate(
  forge: TemplateForge,
): Promise<TemplateRead> {
  let commit: string | null = null;
  try {
    const { defaultBranch } = await forge.getRepository();
    const head = await forge.getBranchHead(defaultBranch);
    commit = head.commitSha;
    const trees = new Map<string, Promise<GitTreeEntry[]>>();
    const tree = (sha: string) => {
      let entries = trees.get(sha);
      if (entries === undefined) {
        entries = forge.readTree(sha).then((read) => {
          // A cut list may be missing the template, or hide a second one.
          if (read.truncated) throw new Skip("read_failed");
          return read.entries;
        });
        trees.set(sha, entries);
      }
      return entries;
    };
    // GitHub matches names without regard to case. More than one entry for
    // a name has no right answer, so none is chosen.
    const named = (
      entries: readonly GitTreeEntry[],
      wanted: (name: string) => boolean,
    ) => entries.filter((entry) => wanted(entry.name.toLowerCase()));
    const only = (found: GitTreeEntry[]): GitTreeEntry | null => {
      if (found.length > 1) throw new Skip("multiple");
      return found[0] ?? null;
    };
    const locationTree = async (
      location: string | null,
    ): Promise<{ entries: GitTreeEntry[]; at: string[] } | null> => {
      const root = await tree(head.treeSha);
      if (location === null) return { entries: root, at: [] };
      const directory = only(named(root, (name) => name === location));
      if (directory === null || directory.type !== "tree") return null;
      return { entries: await tree(directory.sha), at: [directory.name] };
    };

    const candidate = async (
      entry: GitTreeEntry,
      at: readonly string[],
    ): Promise<TemplateRead> => {
      const parts = [...at, entry.name];
      const path = recordedPath(parts);
      if (entry.type !== "blob" || !FILE_MODES.has(entry.mode)) {
        throw new Skip("not_file", path);
      }
      if (entry.size !== null && entry.size > TEMPLATE_MAX_BYTES) {
        throw new Skip("too_large", path);
      }
      const bytes = await forge.readBlob(entry.sha);
      if (bytes.length > TEMPLATE_MAX_BYTES) throw new Skip("too_large", path);
      let text: string;
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch {
        throw new Skip("not_utf8", path);
      }
      const prepared = prepareTemplate(text);
      if (prepared === null) throw new Skip("unbalanced_comment", path);
      return {
        kind: "found",
        commit: head.commitSha,
        path,
        blobSha: entry.sha,
        template: prepared,
      };
    };

    for (const location of LOCATIONS) {
      const here = await locationTree(location);
      if (here === null) continue;
      const file = only(named(here.entries, (name) => name === SINGLE_NAME));
      if (file !== null) return await candidate(file, here.at);
    }
    for (const location of LOCATIONS) {
      const here = await locationTree(location);
      if (here === null) continue;
      const directory = only(
        named(here.entries, (name) => name === DIRECTORY_NAME),
      );
      if (directory === null || directory.type !== "tree") continue;
      const inside = await tree(directory.sha);
      const files = named(inside, (name) => name.endsWith(".md"));
      if (files.length === 0) continue;
      // Which of several is the repository's choice is a setting's to say.
      if (files.length > 1) {
        throw new Skip("multiple", recordedPath([...here.at, directory.name]));
      }
      return await candidate(files[0] as GitTreeEntry, [
        ...here.at,
        directory.name,
      ]);
    }
    return { kind: "none", commit: head.commitSha };
  } catch (error) {
    if (error instanceof Skip) {
      return {
        kind: "skipped",
        commit,
        reason: error.reason,
        ...(error.path === undefined ? {} : { path: error.path }),
      };
    }
    return {
      kind: "skipped",
      commit,
      reason: "read_failed",
      error: error instanceof Error ? error.name : "error",
    };
  }
}

/** What the receipt and the response record of a read, never the template's text. */
export function templateRecord(read: TemplateRead): PullRequestTemplateRecord {
  switch (read.kind) {
    case "found":
      return { commit: read.commit, path: read.path, blob_sha: read.blobSha };
    case "none":
      return { commit: read.commit };
    case "skipped":
      return {
        commit: read.commit,
        ...(read.path === undefined ? {} : { path: read.path }),
        skipped: read.reason,
      };
  }
}

// ---------------------------------------------------------------------------
// Making it inert

// Characters that show nothing or reorder what is shown: controls, soft
// hyphen, zero-width space and marks, bidirectional controls, invisible
// operators, the byte order mark, line and paragraph separators, language
// tags. The joiners (U+200C, U+200D) stay: scripts and emoji need them.
const HIDDEN = new RegExp(
  [
    "[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\u007F-\\u009F",
    "\\u00AD\\u061C\\u180E\\u200B\\u200E\\u200F\\u2028\\u2029",
    "\\u202A-\\u202E\\u2060-\\u2064\\u2066-\\u206F\\uFEFF\\uFFF9-\\uFFFB",
    "\\u{E0000}-\\u{E007F}]",
  ].join(""),
  "gu",
);

function stripHidden(text: string): string {
  return text.replace(HIDDEN, "");
}

type Part = { text: string; comment: boolean };

export type TemplateRow = {
  text: string;
  /** The row begins inside an HTML comment that began on an earlier row. */
  startsInComment: boolean;
  /** Nothing the reader sees: blank, or only comments. */
  skippable: boolean;
  /** `field` of a `<!-- werft:slot field -->` row that may be filled. */
  slot?: SectionName;
  /** A heading row that may be filled: its text as the reader sees it. */
  heading?: string;
};

export type PreparedTemplate = { rows: readonly TemplateRow[] };

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const SLOT_LINE = /^<!--\s*werft:slot\s+([a-z]+)\s*-->$/;
const ATX_HEADING = /^ {0,3}#{1,6}[ \t]+(.+?)(?:[ \t]+#+)?[ \t]*$/;
const BOLD_HEADING = /^ {0,3}(?:\*\*|__)([^*_].*?)(?:\*\*|__)[ \t]*:?[ \t]*$/;
// Elements that hold text the reader sees as written, not as Markdown.
const RAW_ELEMENTS: ReadonlySet<string> = new Set([
  "pre",
  "textarea",
  "script",
  "style",
  "title",
  "xmp",
  "noembed",
  "noframes",
  "noscript",
  "iframe",
]);
const ELEMENT_NAMES =
  "details|pre|div|table|blockquote|section|textarea|script|style|title|xmp|noembed|noframes|noscript|iframe|template";
// The tags a template may use inside an element it has opened: the tracked
// elements and plain text-level and table markup. Anything else (a `select`,
// `svg`, `form`...) changes how a parser reads the end tags that follow.
const KNOWN_INSIDE: ReadonlySet<string> = new Set([
  ...ELEMENT_NAMES.split("|"),
  ...[
    "summary,br,p,a,b,i,u,s,em,strong,code,kbd,img,ul,ol,li,span,hr,sub,sup",
    "h1,h2,h3,h4,h5,h6,tr,td,th,thead,tbody,tfoot,caption,colgroup,col",
    "picture,source,dl,dt,dd,del,ins,mark,small,abbr,center",
  ]
    .join(",")
    .split(","),
]);
// Markup that has no end the scan could follow: a declaration, a processing
// instruction, a CDATA section, a malformed comment opener, `<plaintext>`.
const OPEN_ENDED = /<(?:[!?](?!--)|plaintext(?![\w-]))/gi;
const ELEMENT_ANY = new RegExp(`<(/?)(${ELEMENT_NAMES})(?![\\w-])`, "gi");
// A tag whose attributes are bare words or `name=value` with a plain value.
const ELEMENT_SIMPLE = new RegExp(
  `^<(?:/?)(?:${ELEMENT_NAMES})(?:\\s+[\\w:-]+(?:=(?:"[^"<>\`]*"|'[^'<>\`]*'|[^\\s"'<>\`=]+))?)*\\s*/?>`,
  "i",
);
// A comment the platform reads or whose text it writes itself: its own tail
// markers, and the identifiers it may add later. A template's comment cannot
// pass for one of them. The identifier is changed, not the comment's syntax, so
// whatever was hidden stays hidden.
const PLATFORM_COMMENT = /(<!--\s*\/?\s*)(werft)(:)(?!slot\b)/gi;
// Lines a squash merge reads as co-authors, and the session's own trailer.
const TRAILER_LINE = /^([ \t>]*)(co-authored-by|agent-session)(?=\s*:)/i;

function indentOf(line: string): number {
  let width = 0;
  for (const char of line) {
    if (char === " ") width += 1;
    else if (char === "\t") width += 4;
    else break;
  }
  return width;
}

type Scanned = {
  rows: Array<{
    parts: Part[];
    startsInComment: boolean;
    inHtml: boolean;
    code: boolean;
    indent: number;
  }>;
  /** A comment still open at the end, or one that ends in a way readers differ on. */
  unbalanced: boolean;
};

/**
 * The template cut into what GitHub shows and what it hides. A comment is
 * recognised only where a renderer surely reads one: outside a fenced block,
 * outside the elements that show text as written, not escaped, not in a code
 * span, not in a quote or an indented block. Every `<!--` that is not such a
 * comment stays text, and text is made inert.
 */
function scan(text: string): Scanned {
  const rows: Scanned["rows"] = [];
  let fence: string | null = null;
  let inComment = false;
  let unbalanced = false;
  const open: string[] = [];
  for (const line of text.split("\n")) {
    const row = {
      parts: [] as Part[],
      startsInComment: inComment,
      inHtml: open.length > 0,
      code: false,
      indent: indentOf(line),
    };
    rows.push(row);
    const raw = open.some((tag) => RAW_ELEMENTS.has(tag));
    if (!inComment && !raw) {
      const marks = FENCE_OPEN.exec(line);
      if (fence !== null) {
        row.code = true;
        row.parts.push({ text: line, comment: false });
        const run = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line)?.[1] ?? "";
        if (run !== "" && run[0] === fence[0] && run.length >= fence.length) {
          fence = null;
        }
        continue;
      }
      if (
        marks?.[1] !== undefined &&
        !(marks[1][0] === "`" && marks[2]?.includes("`"))
      ) {
        fence = marks[1];
        row.code = true;
        row.parts.push({ text: line, comment: false });
        continue;
      }
    }
    const literal =
      raw ||
      /^\s*>/.test(line) ||
      row.indent >= 4 ||
      /<(?:pre|textarea|script|style)\b/i.test(line);
    let at = 0;
    let closeFrom = 0;
    let inside: boolean = inComment;
    while (at < line.length) {
      if (inside) {
        const close = line.indexOf("-->", Math.max(at, closeFrom));
        const end = close === -1 ? line.length : close + 3;
        const chunk = line.slice(at, end);
        // Some parsers end a comment at `--!>`; the renderer here does not.
        if (chunk.includes("--!>")) unbalanced = true;
        row.parts.push({ text: chunk, comment: true });
        at = end;
        if (close !== -1) inside = false;
        continue;
      }
      const marks = /<!--|`+/g;
      marks.lastIndex = at;
      let found = marks.exec(line);
      // An escaped `<` is text.
      while (found?.[0] === "<!--" && escaped(line, found.index)) {
        found = marks.exec(line);
      }
      if (found === null) break;
      const run = found[0];
      if (run === "<!--") {
        if (literal) {
          // Text: broken later with the rest of the text's references.
          row.parts.push({
            text: line.slice(at, found.index + 4),
            comment: false,
          });
          at = found.index + 4;
          continue;
        }
        if (found.index > at) {
          row.parts.push({ text: line.slice(at, found.index), comment: false });
        }
        // `<!-->` and `<!--->` end at once for some parsers and not for others.
        if (line.startsWith(">", found.index + 4)) unbalanced = true;
        if (line.startsWith("->", found.index + 4)) unbalanced = true;
        at = found.index;
        closeFrom = found.index + 4;
        inside = true;
        continue;
      }
      // A code span closes on a run of its own length; otherwise it is text.
      const closing = new RegExp(`(?<!\`)${run}(?!\`)`, "g");
      closing.lastIndex = found.index + run.length;
      const end = closing.exec(line);
      const stop =
        end === null ? found.index + run.length : end.index + run.length;
      row.parts.push({ text: line.slice(at, stop), comment: false });
      at = stop;
    }
    if (!inside && at < line.length) {
      row.parts.push({ text: line.slice(at), comment: false });
    }
    inComment = inside;
    const seen = row.parts
      .filter((part) => !part.comment)
      .map((part) => part.text.replace(/(`+)[^`]*?\1/g, " "))
      .join(" ");
    // A tag split over lines hides what follows it from every line-wise scan.
    if (endsInsideTag(seen)) unbalanced = true;
    for (const match of seen.matchAll(OPEN_ENDED)) {
      if (!escaped(seen, match.index)) unbalanced = true;
    }
    // Whether text in a code span or fence is code or markup depends on the
    // renderer's block rules; an element named there is not judged, it rejects.
    const code = row.parts
      .filter((part) => !part.comment)
      .map((part) => (part.text.match(/(`+)[^`]*?\1/g) ?? []).join(" "))
      .join(" ");
    if (mentionsElement(code)) unbalanced = true;
    const tags = elementsIn(seen, line);
    if (tags === null) unbalanced = true;
    // Inside an open element a parser ignores or reroutes the end tags of the
    // ones it does not know, so only tags the scan knows are taken there.
    if (
      (open.length > 0 || (tags ?? []).some(([closing]) => !closing)) &&
      [...seen.matchAll(/<\/?([A-Za-z][\w-]*)/g)].some(
        ([, name]) => !KNOWN_INSIDE.has((name ?? "").toLowerCase()),
      )
    ) {
      unbalanced = true;
    }
    for (const [closing, tag] of tags ?? []) {
      if (!closing) open.push(tag);
      // Closed in the order opened, or a parser may ignore the end tag.
      else if (open.at(-1) === tag) open.pop();
      else unbalanced = true;
    }
  }
  const fenced = rows.some(
    (row) => row.code && row.parts.some((part) => mentionsElement(part.text)),
  );
  // An element the template leaves open would take the platform's text in.
  return {
    rows,
    unbalanced: unbalanced || inComment || open.length > 0 || fenced,
  };
}

function mentionsElement(text: string): boolean {
  return new RegExp(ELEMENT_ANY).test(text);
}

/**
 * The element `seen` (a row's text outside comments and code spans) opens or
 * closes, or null when the row writes one in a way the scan does not follow:
 * more than one, one that does not begin the row (after at most three spaces),
 * one escaped, indented as code, quoted or in a list item, or one with a quote or `>`
 * inside the tag. Whether a renderer reads those as markup depends on block
 * rules the scan does not model, so none is judged.
 */
function elementsIn(
  seen: string,
  line: string,
): Array<[boolean, string]> | null {
  const named = [...seen.matchAll(ELEMENT_ANY)];
  if (named.length === 0) return [];
  const [only] = named;
  if (named.length > 1 || only === undefined) return null;
  const start = new RegExp(`^ {0,3}(?=<(/?)(${ELEMENT_NAMES})(?![\\w-]))`, "i");
  const at = start.exec(line);
  if (at === null) return null;
  if (!ELEMENT_SIMPLE.test(line.slice(at[0].length))) return null;
  return [[only[1] === "/", (only[2] ?? "").toLowerCase()]];
}

/** Whether an HTML tag opened in `text` is still open at its end (quotes honoured). */
function endsInsideTag(text: string): boolean {
  let inTag = false;
  let quote: string | null = null;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i] ?? "";
    if (!inTag) {
      if (
        char === "<" &&
        /[A-Za-z/]/.test(text[i + 1] ?? "") &&
        !escaped(text, i)
      ) {
        inTag = true;
      }
    } else if (quote !== null) {
      if (char === quote) quote = null;
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === ">") {
      inTag = false;
    }
  }
  return inTag;
}

function escaped(line: string, index: number): boolean {
  let slashes = 0;
  while (index - 1 - slashes >= 0 && line[index - 1 - slashes] === "\\") {
    slashes += 1;
  }
  return slashes % 2 === 1;
}

/**
 * The template made inert, as rows. Null when it cannot be: a comment left
 * open would hide whatever is put after it, the platform's tail included. The
 * text is cleaned first and the cleaned text is what is judged and used, so
 * what is checked is what is sent.
 */
export function prepareTemplate(raw: string): PreparedTemplate | null {
  const cleaned = stripEngineSignatures(
    stripHidden(raw.replace(/\r\n?/g, "\n")),
  );
  const scanned = scan(cleaned);
  if (scanned.unbalanced) return null;

  // Mentions, closing keywords and references are broken outside comments,
  // code included. The text is judged as the reader gets it, a comment
  // gone and a space where it was, so `Fixes <!-- x -->#1` is caught as well.
  // Breaking only adds zero-width spaces, so they are put back at the same
  // places in the original.
  const visible = scanned.rows
    .map((row) =>
      row.parts.map((part) => (part.comment ? " " : part.text)).join(""),
    )
    .join("\n");
  // A text `<!--` loses its `<` to the text, not its dashes: `<!` followed by
  // anything else opens a bogus comment that runs to the next `>`.
  const broken = breakLinks(
    breakReferences(visible).replaceAll("<!--", `<${ZWSP}!--`),
  );
  const added: number[] = new Array(visible.length + 1).fill(0);
  let j = 0;
  for (let i = 0; i <= visible.length; i += 1) {
    while (broken[j] === ZWSP) {
      added[i] = (added[i] ?? 0) + 1;
      j += 1;
    }
    if (i < visible.length) {
      if (broken[j] !== visible[i]) {
        throw new Error("Template reference breaking changed its text");
      }
      j += 1;
    }
  }
  let offset = 0;
  const rows: TemplateRow[] = scanned.rows.map((row) => {
    let line = "";
    for (const part of row.parts) {
      if (part.comment) {
        // Hidden text is broken too: a renderer that reads the markup another
        // way than the scan did would otherwise show it live.
        line += breakLinks(breakReferences(part.text)).replace(
          PLATFORM_COMMENT,
          `$1$2${ZWSP}$3`,
        );
        offset += 1;
        continue;
      }
      for (const char of part.text) {
        line += ZWSP.repeat(added[offset] ?? 0) + char;
        offset += char.length;
      }
    }
    offset += 1; // the newline
    line = line.replace(
      TRAILER_LINE,
      (_, lead: string, word: string) =>
        `${lead}${word.slice(0, 1)}${ZWSP}${word.slice(1)}`,
    );
    const shown = row.parts
      .filter((part) => !part.comment)
      .map((part) => part.text)
      .join("");
    const result: TemplateRow = {
      text: line,
      startsInComment: row.startsInComment,
      skippable: !row.code && shown.trim() === "",
    };
    const fillable =
      !row.startsInComment && !row.inHtml && !row.code && row.indent <= 3;
    if (fillable) {
      const only = row.parts.length === 1 ? row.parts[0] : undefined;
      const slot = only?.comment ? SLOT_LINE.exec(only.text.trim()) : null;
      const field = slot?.[1];
      if (field !== undefined && isSection(field)) result.slot = field;
      const title =
        ATX_HEADING.exec(shown)?.[1] ?? BOLD_HEADING.exec(shown)?.[1];
      if (title !== undefined && result.slot === undefined) {
        result.heading = title;
      }
    }
    return result;
  });
  return { rows };
}

function isSection(name: string): name is SectionName {
  return (SECTION_NAMES as readonly string[]).includes(name);
}

// ---------------------------------------------------------------------------
// Filling

// The phrases a heading is matched on, one set per field, in the order that
// breaks a tie.
const PHRASES: Record<SectionName, readonly string[]> = {
  summary: [
    "개요",
    "요약",
    "설명",
    "summary",
    "description",
    "overview",
    "概要",
    "説明",
  ],
  changes: [
    "변경 사항",
    "변경사항",
    "변경점",
    "작업 내용",
    "changes",
    "what changed",
    "変更点",
    "変更内容",
  ],
  rationale: [
    "배경",
    "이유",
    "목적",
    "동기",
    "why",
    "motivation",
    "background",
    "context",
    "背景",
    "目的",
  ],
  testing: [
    "테스트",
    "검증",
    "확인 방법",
    "test",
    "testing",
    "how to test",
    "verification",
    "テスト",
    "確認方法",
  ],
  related: ["관련 이슈", "이슈", "티켓", "related", "issue", "ticket", "関連"],
  notes: [
    "참고",
    "비고",
    "리뷰 포인트",
    "notes",
    "remarks",
    "reviewer",
    "備考",
  ],
};

function normalizeHeading(text: string): string {
  return text
    .toLowerCase()
    .replace(/\p{Extended_Pictographic}|️|‍/gu, " ")
    .replace(/[\p{P}\p{S}]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const MATCHERS = SECTION_NAMES.flatMap((section) =>
  PHRASES[section].map((phrase) => {
    const norm = normalizeHeading(phrase);
    const escapedPhrase = norm.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // A Latin phrase is a word (a plural is the same word); CJK has no spaces.
    const latin = /^[a-z0-9 ]+$/.test(norm);
    return {
      section,
      length: norm.length,
      test: latin
        ? new RegExp(
            `(?<![\\p{L}\\p{N}])${escapedPhrase}s?(?![\\p{L}\\p{N}])`,
            "u",
          )
        : new RegExp(escapedPhrase, "u"),
    };
  }),
);

/** The field a heading is for: the longest phrase it holds, the table's order on a tie. */
export function sectionOfHeading(heading: string): SectionName | null {
  const norm = normalizeHeading(heading);
  let best: { section: SectionName; length: number } | null = null;
  for (const matcher of MATCHERS) {
    if (!matcher.test.test(norm)) continue;
    if (best === null || matcher.length > best.length) {
      best = { section: matcher.section, length: matcher.length };
    }
  }
  return best?.section ?? null;
}

/**
 * The template with the fields put in, and nothing of it taken out. With slot
 * rows, only they place a field; otherwise a heading does. A field with no
 * place gets a section of the platform's own after the template; a template
 * with neither slot nor heading goes below the platform's default layout.
 */
export function fillTemplate(
  template: PreparedTemplate,
  blocks: SectionBlocks,
  headings: Record<SectionName, string>,
): string {
  const { rows } = template;
  const filled = SECTION_NAMES.filter((name) => (blocks[name] ?? "") !== "");
  const before = new Map<number, SectionName[]>();
  const placed = new Set<SectionName>();
  const put = (at: number, name: SectionName) => {
    placed.add(name);
    before.set(at, [...(before.get(at) ?? []), name]);
  };
  const bySlot = rows.some((row) => row.slot !== undefined);
  const claimed = new Set<SectionName>();
  rows.forEach((row, index) => {
    if (bySlot) {
      // The first slot of a field is the one; a later one stays as it is.
      if (row.slot === undefined || claimed.has(row.slot)) return;
      claimed.add(row.slot);
      if (filled.includes(row.slot)) put(index + 1, row.slot);
      return;
    }
    if (row.heading === undefined) return;
    const name = sectionOfHeading(row.heading);
    if (name === null || claimed.has(name)) return;
    claimed.add(name);
    if (!filled.includes(name)) return;
    let at = index + 1;
    // Past the comments and blank lines that follow the heading.
    while (at < rows.length) {
      const next = rows[at];
      if (next === undefined || !next.skippable) break;
      at += 1;
    }
    // A row that ends a comment and goes on with markup is no place to put
    // text before: it would land in the comment, or in what that markup opens.
    if (rows[at]?.startsInComment) return;
    put(at, name);
  });

  const hasPlace = bySlot || rows.some((row) => row.heading !== undefined);
  const unplaced = filled.filter((name) => !placed.has(name));
  const section = (name: SectionName) =>
    `## ${headings[name]}\n${blocks[name]}`;
  if (!hasPlace && unplaced.length > 0) {
    const text = rows
      .map((row) => row.text)
      .join("\n")
      .trim();
    const top = unplaced.map(section).join("\n\n");
    return text === "" ? top : `${top}\n\n${text}`;
  }
  const out: string[] = [];
  const emit = (at: number) => {
    for (const name of before.get(at) ?? []) {
      if (out.length > 0 && (out.at(-1) ?? "").trim() !== "") out.push("");
      out.push(...(blocks[name] ?? "").split("\n"));
      if (at < rows.length && (rows[at]?.text ?? "").trim() !== "")
        out.push("");
    }
  };
  rows.forEach((row, index) => {
    emit(index);
    out.push(row.text);
  });
  emit(rows.length);
  const text = out.join("\n").trimEnd();
  if (unplaced.length === 0) return text;
  // What the template leaves open is closed, or the sections would sit in it.
  const closed = closeOpenBlocks(text);
  const tail = unplaced.map(section).join("\n\n");
  return closed === "" ? tail : `${closed}\n\n${tail}`;
}
