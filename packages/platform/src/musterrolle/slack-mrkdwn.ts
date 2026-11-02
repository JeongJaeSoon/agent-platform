import { isSafeUrl, mapCodeAndText } from "./slack-presentation.ts";

// Code is swapped for these tokens while the rest is rewritten, so no rule can
// reach into it and a table can be read whole even when a cell holds code.
const OPEN = "\uE000";
const CLOSE = "\uE001";
const TOKEN = /\uE000(\d+)\uE001/g;

// Slack formats `*x*` and `~x~` only next to a space or punctuation; a
// zero-width space in between is enough (checked in 94soon-dev, 2026-11-02).
const ZWSP = "\u200B";
const WORD = /[\p{L}\p{N}]/u;

const BULLETS = ["•", "◦", "▪"];
const INDENT = "    ";

const LINK =
  /!?\[([^[\]\n]+)\]\(((?:[^()\s]|\([^()\s]*\))+)(?:\s+"[^"\n]*")?\)/g;

function convertLinks(text: string, slackLinks: boolean): string {
  return text.replace(LINK, (_whole, label: string, url: string) => {
    if (!slackLinks || !isSafeUrl(url) || /[<>|]/.test(label)) {
      return label === url ? url : `${label} (${url})`;
    }
    return label === url ? `<${url}>` : `<${url}|${label}>`;
  });
}

function wrap(text: string, pattern: RegExp, marker: string): string {
  return text.replace(
    pattern,
    (_whole, inner: string, offset: number, all: string) => {
      const before = all[offset - 1];
      const after = all[offset + _whole.length];
      const lead = before !== undefined && WORD.test(before) ? ZWSP : "";
      const trail = after !== undefined && WORD.test(after) ? ZWSP : "";
      return `${lead}${marker}${inner}${marker}${trail}`;
    },
  );
}

function convertInline(text: string): string {
  const linked = convertLinks(text, true);
  const bold = wrap(linked, /\*\*(?!\s)([^\n]+?)(?<!\s)\*\*/g, "*");
  return wrap(bold, /~~(?!\s)([^\n]+?)(?<!\s)~~/g, "~");
}

function plainCell(cell: string, codes: readonly string[]): string {
  const text = convertLinks(cell, false)
    .replace(/\*\*([^\n]+?)\*\*/g, "$1")
    .replace(/~~([^\n]+?)~~/g, "$1");
  return text
    .replace(TOKEN, (_whole, index: string) => codes[Number(index)] ?? "")
    .replace(/`/g, "")
    .trim();
}

/** Columns a monospace font gives the text: wide East Asian characters take two. */
function width(text: string): number {
  let columns = 0;
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
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

const TABLE_RULE = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;

function isTableStart(lines: readonly string[], index: number): boolean {
  const header = lines[index];
  const rule = lines[index + 1];
  return (
    header !== undefined &&
    rule !== undefined &&
    header.includes("|") &&
    rule.includes("|") &&
    TABLE_RULE.test(rule) &&
    splitRow(header).length === splitRow(rule).length
  );
}

function renderTable(rows: string[][]): string {
  const columns = Math.max(...rows.map((row) => row.length));
  const widths = Array.from({ length: columns }, (_, column) =>
    Math.max(...rows.map((row) => width(row[column] ?? ""))),
  );
  const line = (row: readonly string[]) =>
    widths
      .map((columnWidth, column) => {
        const cell = row[column] ?? "";
        return cell + " ".repeat(columnWidth - width(cell));
      })
      .join(" | ")
      .trimEnd();
  const [header = [], ...body] = rows;
  const rule = widths.map((columnWidth) => "-".repeat(columnWidth)).join("-+-");
  return ["```", line(header), rule, ...body.map(line), "```"].join("\n");
}

const LIST_ITEM = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;

function convertLines(text: string, codes: string[]): string {
  const lines = text.split("\n");
  const output: string[] = [];
  let indents: number[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";

    if (isTableStart(lines, index)) {
      const rows = [splitRow(line)];
      index += 2;
      while (index < lines.length && (lines[index] ?? "").includes("|")) {
        rows.push(splitRow(lines[index] ?? ""));
        index += 1;
      }
      index -= 1;
      output.push(
        renderTable(
          rows.map((row) => row.map((cell) => plainCell(cell, codes))),
        ),
      );
      indents = [];
      continue;
    }

    const heading = /^ {0,3}#{1,6}\s+(.+?)(?:\s+#+)?\s*$/.exec(line);
    if (heading?.[1] !== undefined) {
      const title = heading[1].replace(/\*\*([^\n]+?)\*\*/g, "$1");
      output.push(`*${convertInline(title)}*`);
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
        bullet += task[1] === " " ? " ☐" : " ☑";
        rest = rest.slice(task[0].length);
      }
      output.push(`${INDENT.repeat(level)}${bullet} ${convertInline(rest)}`);
      continue;
    }

    if (line.trim() === "") indents = [];
    output.push(convertInline(line));
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
  const codes: string[] = [];
  const masked = mapCodeAndText(
    markdown,
    (text) => text,
    (code) => {
      codes.push(code);
      return `${OPEN}${codes.length - 1}${CLOSE}`;
    },
  );
  return convertLines(masked, codes).replace(TOKEN, (_whole, index: string) => {
    const code = codes[Number(index)] ?? "";
    return code.replace(/^```[\w+#.-]+\n/, "```\n");
  });
}
