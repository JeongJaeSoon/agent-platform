import { describe, expect, test } from "bun:test";

describe("workspace", () => {
  test("runs the unit-test stage before package tests exist", () => {
    expect(true).toBe(true);
  });
});
