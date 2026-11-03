import { isSafeUrl, mapCodeAndText } from "./slack-presentation.ts";

// Code, links and URLs are swapped for these tokens while the rest is
// rewritten, so no rule reaches into them and a table can be read whole even
// when a cell holds code.
const OPEN = "\uE000";
const CLOSE = "\uE001";
const TOKEN = /\uE000(\d+)\uE001/g;

// Slack formats `*x*` and `~x~` only next to a space or punctuation; a
// zero-width space in between is enough (checked in 94soon-dev, 2026-11-02).
const ZWSP = "\u200B";
const WORD = /[\p{L}\p{N}]/u;

// Slack turns ▪, ▫ and ☑ into emoji; these stay text.
const BULLETS = ["•", "◦", "▸"];
const INDENT = "    ";

type Kept = {
  keep(text: string): string;
  get(token: string): string | undefined;
  restore(text: string): string;
};

function keeper(): Kept {
  const items: string[] = [];
  const restore = (text: string): string => {
    let output = text;
    // A kept item can hold tokens of its own, a link label with code in it.
    while (output.includes(OPEN)) {
      output = output.replace(
        TOKEN,
        (_whole, index: string) => items[Number(index)] ?? "",
      );
    }
    return output;
  };
  return {
    keep(text) {
      items.push(text);
      return `${OPEN}${items.length - 1}${CLOSE}`;
    },
    get(token) {
      const index = /^\uE000(\d+)\uE001$/.exec(token)?.[1];
      return index === undefined ? undefined : items[Number(index)];
    },
    restore,
  };
}

const ENDS_IN_URL = /\bhttps?:\/\/\S+$/;

/** GitHub's `` spans; Slack would read them as empty code pairs. */
function keepDoubleBacktickSpans(text: string, kept: Kept): string {
  // The inner text cannot cross another `` run, so each search stops there.
  return text.replace(/(?<!`)``(?!`)(?:[^`\n]|`(?!`))+?``(?!`)/g, (span) => {
    const inner = span.slice(2, -2);
    // A URL needs a span Slack reads as code for guardCodeUrls to protect it.
    return kept.keep(
      !inner.includes("`") && ENDS_IN_URL.test(inner) ? `\`${inner}\`` : span,
    );
  });
}

/**
 * Slack finds URLs itself and reads one on to the next space, past a closing
 * backtick or fence, so a URL that ends the code is cut off from what follows.
 */
function guardCodeUrls(text: string): string {
  let position = 0;
  return mapCodeAndText(
    text,
    (part) => {
      position += part.length;
      return part;
    },
    (code) => {
      position += code.length;
      if (code.startsWith("```")) {
        const body = code.slice(0, -3);
        return ENDS_IN_URL.test(body) ? `${body}\n\`\`\`` : code;
      }
      const next = text[position];
      return next !== undefined &&
        !/[\s\p{P}​]/u.test(next) &&
        ENDS_IN_URL.test(code.slice(1, -1))
        ? `${code}${ZWSP}`
        : code;
    },
  );
}

/** A `~~~` fence becomes a ``` fence; Slack knows only that one. */
function keepTildeFences(text: string, kept: Kept): string {
  const lines = text.split("\n");
  const output: string[] = [];
  // The longest closing fence at or below each line: an opener longer than
  // what remains below has no close and need not look.
  const longestBelow = new Array<number>(lines.length + 1).fill(0);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const fence = /^ {0,3}(~{3,})\s*$/.exec(lines[index] ?? "")?.[1];
    longestBelow[index] = Math.max(
      fence?.length ?? 0,
      longestBelow[index + 1] ?? 0,
    );
  }
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const open = /^ {0,3}(~{3,})/.exec(line)?.[1];
    let close = -1;
    if (open !== undefined && open.length <= (longestBelow[index + 1] ?? 0)) {
      for (let next = index + 1; next < lines.length; next += 1) {
        const fence = /^ {0,3}(~{3,})\s*$/.exec(lines[next] ?? "")?.[1];
        if (fence !== undefined && fence.length >= open.length) {
          close = next;
          break;
        }
      }
    }
    if (close === -1) {
      output.push(line);
      continue;
    }
    const body = lines.slice(index + 1, close).join("\n");
    // A body holding ``` cannot become a ``` fence, so it stays as written.
    output.push(
      kept.keep(
        kept.restore(body).includes("```")
          ? lines.slice(index, close + 1).join("\n")
          : `\`\`\`\n${body}\n\`\`\``,
      ),
    );
    index = close;
  }
  return output.join("\n");
}

const LINK =
  /!?\[([^[\]\n]+)\]\(((?:[^()\s]|\([^()\s]*\))+)(?:\s+"[^"\n]*")?\)/g;
const CONTROL = /<[^<>\n]+>/g;
const BARE_URL = /\bhttps?:\/\/[^\s<>]+/g;

/** Trailing punctuation belongs to the sentence, a `)` only when unbalanced. */
function urlEnd(url: string): number {
  let unbalanced = url.split(")").length - url.split("(").length;
  let end = url.length;
  for (;;) {
    const last = url[end - 1] ?? "";
    if (last === ")" && unbalanced > 0) unbalanced -= 1;
    else if (!/[*~_.,;:!?'"]/.test(last) || end === 0) return end;
    end -= 1;
  }
}

type Inline = { links: "slack" | "plain"; marks: "convert" | "strip" };

function wrap(text: string, pattern: RegExp, marker: string): string {
  return text.replace(
    pattern,
    (whole, inner: string, offset: number, all: string) => {
      const before = all[offset - 1];
      const after = all[offset + whole.length];
      const lead = before !== undefined && WORD.test(before) ? ZWSP : "";
      const trail = after !== undefined && WORD.test(after) ? ZWSP : "";
      return `${lead}${marker}${inner}${marker}${trail}`;
    },
  );
}

// The inner text may not hold its own marker, so a search for the close stops
// at the next marker instead of running to the end of the line.
const BOLD = /\*\*(?![\s*])([^*\n]*[^\s*])\*\*/g;
const STRIKE = /~~(?![\s~])([^~\n]*[^\s~])~~/g;

function marks(text: string, mode: Inline["marks"]): string {
  if (mode === "strip") return text.replace(BOLD, "$1").replace(STRIKE, "$1");
  return wrap(wrap(text, BOLD, "*"), STRIKE, "~");
}

function inline(text: string, kept: Kept, mode: Inline): string {
  const linked = text
    .replace(LINK, (_whole, label: string, url: string) => {
      const shown = marks(label, mode.marks);
      // Slack refuses a link whose label holds a control or code.
      if (
        mode.links === "plain" ||
        !isSafeUrl(url) ||
        /[<>|\uE000]/.test(label)
      ) {
        return kept.keep(label === url ? url : `${shown} (${url})`);
      }
      return kept.keep(label === url ? `<${url}>` : `<${url}|${shown}>`);
    })
    .replace(CONTROL, (control) => kept.keep(control))
    .replace(BARE_URL, (url) => {
      const end = urlEnd(url);
      return kept.keep(url.slice(0, end)) + url.slice(end);
    });
  return marks(linked, mode.marks);
}

const BODY: Inline = { links: "slack", marks: "convert" };
const HEADING: Inline = { links: "slack", marks: "strip" };
const CELL: Inline = { links: "plain", marks: "strip" };

/** Columns a monospace font gives the text: wide East Asian characters take two. */
function width(text: string): number {
  let columns = 0;
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (char === ZWSP) continue;
    columns +=
      (code >= 0x1100 && code <= 0x115f) ||
      (code >= 0x2e80 && code <= 0xa4cf) ||
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xfe30 && code <= 0xfe4f) ||
      (code >= 0xff00 && code <= 0xff60) ||
      (code >= 0xffe0 && code <= 0xffe6) ||
      (code >= 0x1f300 && code <= 0x1faff) ||
      (code >= 0x20000 && code <= 0x3fffd)
        ? 2
        : 1;
  }
  return columns;
}

function splitRow(line: string): string[] {
  const trimmed = line
    .trim()
    .replace(/^\|/, "")
    .replace(/(?<!\\)\|$/, "");
  return trimmed.split(/(?<!\\)\|/).map((cell) => cell.replace(/\\\|/g, "|"));
}

function isTableStart(lines: readonly string[], index: number): boolean {
  const header = lines[index];
  const rule = lines[index + 1];
  return (
    header !== undefined &&
    rule !== undefined &&
    header.includes("|") &&
    rule.includes("|") &&
    splitRow(rule).every((cell) => /^:?-+:?$/.test(cell.trim())) &&
    splitRow(header).length === splitRow(rule).length
  );
}

function isTableRow(line: string): boolean {
  return (
    line.includes("|") && !/^\s*(>|#{1,6}\s|[-*+]\s|\d{1,9}[.)]\s)/.test(line)
  );
}

/** A cell goes into a code block, so its code shows without the backticks. */
function cellText(cell: string, kept: Kept): string {
  const text = inline(cell, kept, CELL).replace(/\uE000\d+\uE001/g, (token) => {
    const code = kept.get(token) ?? token;
    return /^`[^`]|^``(?!`)/.test(code)
      ? kept.restore(code).replace(/^(`+) ?([\s\S]*?) ?\1$/, "$2")
      : token;
  });
  // ``` would close the table's own fence.
  return kept
    .restore(text)
    .trim()
    .replace(/`(?=`)/g, `\`${ZWSP}`);
}

// A long cell is not padded past this, so one cell cannot widen every row.
const COLUMN_MAX = 40;

/** Null when padding would grow the table past `limit` characters. */
function renderTable(rows: string[][], limit: number): string | null {
  // Cells past the header's count are dropped, as GitHub does.
  const columns = rows[0]?.length ?? 0;
  // Every row carries every column's separator, so a wide header over many
  // rows is refused before any cell is visited.
  if (rows.length * 3 * Math.max(0, columns - 1) > limit) return null;
  const widths = new Array<number>(columns).fill(0);
  for (const row of rows) {
    for (let column = 0; column < Math.min(columns, row.length); column += 1) {
      widths[column] = Math.min(
        COLUMN_MAX,
        Math.max(widths[column] ?? 0, width(row[column] ?? "")),
      );
    }
  }
  const line = (row: readonly string[]) =>
    widths
      .map((columnWidth, column) => {
        const cell = row[column] ?? "";
        return cell + " ".repeat(Math.max(0, columnWidth - width(cell)));
      })
      .join(" | ")
      .trimEnd();
  const output = [
    "```",
    line(rows[0] ?? []),
    widths.map((columnWidth) => "-".repeat(columnWidth)).join("-+-"),
  ];
  // Counted with the closing "\n```" from the start.
  let length = output.join("\n").length + 4;
  if (length > limit) return null;
  for (const row of rows.slice(1)) {
    const text = line(row);
    length += text.length + 1;
    if (length > limit) return null;
    output.push(text);
  }
  output.push("```");
  return output.join("\n");
}

/** Drops a closing `##` run; a scan, since a regex backtracks on long spaces. */
function headingTitle(rest: string): string {
  const title = rest.trimEnd();
  let end = title.length;
  while (end > 0 && title[end - 1] === "#") end -= 1;
  const closing =
    end < title.length && (end === 0 || /\s/.test(title[end - 1] ?? ""));
  return closing ? title.slice(0, end).trimEnd() : title;
}

const LIST_ITEM = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;

function convertLines(text: string, kept: Kept): string {
  const lines = text.split("\n");
  const output: string[] = [];
  let indents: number[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";

    if (isTableStart(lines, index)) {
      const start = index;
      const rows = [splitRow(line)];
      index += 2;
      while (index < lines.length && isTableRow(lines[index] ?? "")) {
        rows.push(splitRow(lines[index] ?? ""));
        index += 1;
      }
      const source = lines.slice(start, index);
      index -= 1;
      const table = renderTable(
        rows.map((row) => row.map((cell) => cellText(cell, kept))),
        4 * source.join("\n").length + 1_000,
      );
      // A sparse table that would balloon stays as the lines it was.
      output.push(
        table === null
          ? source.map((row) => inline(row, kept, BODY)).join("\n")
          : kept.keep(table),
      );
      indents = [];
      continue;
    }

    const heading = /^ {0,3}#{1,6}[ \t]+(.*)$/.exec(line);
    if (heading?.[1] !== undefined && heading[1].trim() !== "") {
      output.push(`*${inline(headingTitle(heading[1]), kept, HEADING)}*`);
      indents = [];
      continue;
    }

    const item = LIST_ITEM.exec(line);
    if (item !== null) {
      const indent = (item[1] ?? "").replace(/\t/g, INDENT).length;
      while (indents.length > 0 && (indents.at(-1) ?? 0) > indent)
        indents.pop();
      if (indents.length === 0 || (indents.at(-1) ?? 0) < indent) {
        indents.push(indent);
      }
      const level = indents.length - 1;
      const marker = item[2] ?? "-";
      let rest = item[3] ?? "";
      let bullet = /\d/.test(marker)
        ? marker
        : (BULLETS[level % BULLETS.length] ?? "•");
      const task = /^\[([ xX])\]\s+/.exec(rest);
      if (task !== null && !/\d/.test(marker)) {
        bullet += task[1] === " " ? " ☐" : " ☒";
        rest = rest.slice(task[0].length);
      }
      output.push(
        `${INDENT.repeat(level)}${bullet} ${inline(rest, kept, BODY)}`,
      );
      continue;
    }

    // Blank and indented lines stay inside a list; text at the margin ends it.
    if (/^\S/.test(line)) indents = [];
    output.push(inline(line, kept, BODY));
  }
  return output.join("\n");
}

/**
 * Rewrites the GitHub-style Markdown a model writes into Slack mrkdwn: bold,
 * strikethrough, headings, links, nested lists and tables. Code spans and
 * blocks keep their text; a fence only loses its language tag, which Slack
 * would show as the first line.
 */
export function markdownToSlackMrkdwn(markdown: string): string {
  if (markdown.includes(OPEN) || markdown.includes(CLOSE)) return markdown;
  const kept = keeper();
  const spans = keepDoubleBacktickSpans(markdown, kept);
  const masked = mapCodeAndText(
    spans,
    (text) => text,
    (code) => kept.keep(code.replace(/^```[\w+#.-]+\n/, "```\n")),
  );
  return guardCodeUrls(
    kept.restore(convertLines(keepTildeFences(masked, kept), kept)),
  );
}
