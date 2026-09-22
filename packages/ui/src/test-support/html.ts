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

/*
 * React's `useId` counts renders per process. `bun test packages/ui` and CI's
 * whole-repo run reach this component with different counters, so the raw id
 * (`_r_1e_` here, `_r_2g_` there) is not a property of the markup. Each
 * distinct id is renumbered in order of appearance, which keeps what the
 * snapshot is actually for — that the label still points at its input.
 */
const ID_ATTRIBUTE =
  /\b(id|for|data-ap-dialog|aria-labelledby|aria-describedby|aria-controls)="([^"]*)"/g;
const GENERATED_ID = /_r_[0-9a-z]+_/g;

function stableIds(markup: string): string {
  const seen = new Map<string, string>();
  // Only inside the attributes that carry an id: the same shape appearing in
  // visible text or an href is content, and normalising it would hide a change.
  return markup.replace(ID_ATTRIBUTE, (whole, name: string, value: string) => {
    const rewritten = value.replace(GENERATED_ID, (id) => {
      const existing = seen.get(id);
      if (existing) return existing;
      const replacement = `_id${seen.size + 1}_`;
      seen.set(id, replacement);
      return replacement;
    });
    return rewritten === value ? whole : `${name}="${rewritten}"`;
  });
}

export function htmlOf(node: Element | null): string {
  if (!node) return "";
  return indent(stableIds(node.outerHTML).replace(/></g, ">\n<"));
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
