/*
 * `expect(element).toMatchSnapshot()` never returns under bun: the serializer
 * walks a happy-dom node's whole object graph (element → document → window →
 * element). Snapshots therefore go through markup, which also reviews better
 * than a serialized object. Whitespace is kept as-is — a lost space between
 * inline elements is exactly the kind of drift a snapshot should catch.
 */
const VOID_TAGS = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "source",
  "track",
  "wbr",
]);

const TAG = /<(\/?)([a-zA-Z][\w-]*)(?:\s[^>]*?)?(\/?)>/g;

export function htmlOf(node: Element | null): string {
  if (!node) return "";
  return indent(node.outerHTML.replace(/></g, ">\n<"));
}

/** How much deeper the tree is after this line. Text keeps tags on one line. */
function depthChange(line: string): number {
  let change = 0;
  for (const [, closing, name, selfClosing] of line.matchAll(TAG)) {
    if (closing) change -= 1;
    else if (!selfClosing && !VOID_TAGS.has((name ?? "").toLowerCase())) {
      change += 1;
    }
  }
  return change;
}

function indent(source: string): string {
  let depth = 0;
  return source
    .split("\n")
    .map((line) => {
      const change = depthChange(line);
      // A line that opens with a closing tag lines up with its opening tag.
      const lead = line.startsWith("</") ? depth - 1 : depth;
      depth += change;
      return "  ".repeat(Math.max(0, lead)) + line;
    })
    .join("\n");
}
