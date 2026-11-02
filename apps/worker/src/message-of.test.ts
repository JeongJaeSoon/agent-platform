import { expect, test } from "bun:test";
import { messageOf } from "./message-of.ts";

test("extracts an Error message", () => {
  expect(messageOf(new Error("failed"))).toBe("failed");
});

test("preserves a string", () => {
  expect(messageOf("failed")).toBe("failed");
});

test("converts an object to a string", () => {
  expect(messageOf({ reason: "failed" })).toBe("[object Object]");
});
