import { expect, test } from "bun:test";
import { sameString } from "./same-string.ts";

test("compares equal UTF-8 strings", () => {
  expect(sameString("state", "state")).toBe(true);
  expect(sameString("", "")).toBe(true);
  expect(sameString("한글", "한글")).toBe(true);
});

test("rejects different strings with equal byte lengths", () => {
  expect(sameString("state", "other")).toBe(false);
});

test("rejects different byte lengths without throwing", () => {
  expect(sameString("state", "states")).toBe(false);
  expect(sameString("é", "e")).toBe(false);
  expect(sameString("", "a")).toBe(false);
});
