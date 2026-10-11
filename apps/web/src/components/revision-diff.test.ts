import { describe, expect, test } from "bun:test";
import { diffLines } from "./revision-diff.tsx";

const kinds = (before: string, after: string) =>
  diffLines(before, after).map(({ kind, text }) => `${kind}:${text}`);

describe("diffLines", () => {
  test("같은 줄은 same, 바뀐 줄은 removed 다음 added", () => {
    expect(kinds("a\nb\nc", "a\nB\nc")).toEqual([
      "same:a",
      "removed:b",
      "added:B",
      "same:c",
    ]);
  });

  test("앞뒤에 더하고 뺀 줄을 공통 줄을 기준으로 맞춘다", () => {
    expect(kinds("x\na\nb", "a\nb\ny")).toEqual([
      "removed:x",
      "same:a",
      "same:b",
      "added:y",
    ]);
  });

  test("같은 글은 전부 same, 없던 카드(null)와는 모든 줄이 바뀐다", () => {
    expect(kinds("a\nb", "a\nb").every((l) => l.startsWith("same:"))).toBe(
      true,
    );
    expect(kinds("null", "{\n}")).toEqual([
      "removed:null",
      "added:{",
      "added:}",
    ]);
  });
});
