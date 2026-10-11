import { useI18n } from "../i18n/i18n.tsx";

export type DiffLine = {
  readonly kind: "same" | "added" | "removed";
  readonly text: string;
};

/** Line diff by longest common subsequence; cards are small enough for O(n·m). */
export function diffLines(before: string, after: string): DiffLine[] {
  const a = before.split("\n");
  const b = after.split("\n");
  const width = b.length + 1;
  // lcs[i][j]: common lines between a[i..] and b[j..], flattened row-major.
  const lcs = new Int32Array((a.length + 1) * width);
  const at = (i: number, j: number) => lcs[i * width + j] ?? 0;
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i * width + j] =
        a[i] === b[j]
          ? at(i + 1, j + 1) + 1
          : Math.max(at(i + 1, j), at(i, j + 1));
    }
  }
  const lines: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    const left = a[i];
    const right = b[j];
    if (left !== undefined && left === right) {
      lines.push({ kind: "same", text: left });
      i++;
      j++;
    } else if (
      left !== undefined &&
      (right === undefined || at(i + 1, j) >= at(i, j + 1))
    ) {
      lines.push({ kind: "removed", text: left });
      i++;
    } else {
      lines.push({ kind: "added", text: right ?? "" });
      j++;
    }
  }
  return lines;
}

const MARK = { same: " ", added: "+", removed: "-" } as const;

/** Two revisions of the same document, side by side as one annotated text. */
export function RevisionDiff({
  before,
  after,
  beforeLabel,
  afterLabel,
}: {
  readonly before: unknown;
  readonly after: unknown;
  readonly beforeLabel: string;
  readonly afterLabel: string;
}) {
  const { t } = useI18n();
  const lines = diffLines(
    JSON.stringify(before, null, 2),
    JSON.stringify(after, null, 2),
  );
  const changed = lines.some((line) => line.kind !== "same");
  return (
    <figure className="web-diff">
      <figcaption>
        {t("diff.caption", { before: beforeLabel, after: afterLabel })}
      </figcaption>
      {changed ? (
        <pre className="web-diff__body">
          {lines.map((line, index) => (
            <span
              // Lines repeat, so position is the only stable identity here.
              // biome-ignore lint/suspicious/noArrayIndexKey: see above
              key={index}
              className="web-diff__line"
              data-kind={line.kind}
            >
              <span className="web-diff__mark" aria-hidden="true">
                {MARK[line.kind]}
              </span>
              {line.kind === "same" ? null : (
                <span className="web-sr-only">
                  {t(line.kind === "added" ? "diff.added" : "diff.removed")}
                </span>
              )}
              {line.text}
              {"\n"}
            </span>
          ))}
        </pre>
      ) : (
        <p className="web-page__empty">{t("diff.same")}</p>
      )}
    </figure>
  );
}
