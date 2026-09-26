import { describe, expect, test } from "bun:test";
import {
  integerSetting,
  positiveNumberSetting,
  settingProblems,
} from "./settings.ts";

describe("integerSetting", () => {
  test("unset takes the default, or is required without one", () => {
    expect(integerSetting({}, "N", { min: 1, default: 5 })).toBe(5);
    expect(() => integerSetting({}, "N", { min: 1 })).toThrow("N is required");
  });

  test("a blank is a wrong value, never the default", () => {
    for (const blank of ["", "  "]) {
      expect(() =>
        integerSetting({ N: blank }, "N", { min: 0, default: 5 }),
      ).toThrow(
        `N must be a non-negative integer, got ${JSON.stringify(blank)}`,
      );
    }
  });

  test("names the range it wanted and the value it got", () => {
    expect(() => integerSetting({ N: "0" }, "N", { min: 1 })).toThrow(
      'N must be a positive integer, got "0"',
    );
    expect(() => integerSetting({ N: "1.5" }, "N", { min: 0 })).toThrow(
      'N must be a non-negative integer, got "1.5"',
    );
    expect(() => integerSetting({ N: "11" }, "N", { min: 0, max: 10 })).toThrow(
      'N must be an integer from 0 to 10, got "11"',
    );
    expect(() =>
      integerSetting({ N: "9007199254740993" }, "N", { min: 1 }),
    ).toThrow("N must be a positive integer");
    expect(integerSetting({ N: "10" }, "N", { min: 0, max: 10 })).toBe(10);
  });
});

describe("positiveNumberSetting", () => {
  test("takes fractions and refuses zero, blanks and non-finite values", () => {
    expect(positiveNumberSetting({ N: "0.5" }, "N")).toBe(0.5);
    expect(positiveNumberSetting({}, "N", { default: 2 })).toBe(2);
    for (const value of ["0", "-1", "", "Infinity", "abc"]) {
      expect(() => positiveNumberSetting({ N: value }, "N")).toThrow(
        `N must be a positive number, got ${JSON.stringify(value)}`,
      );
    }
    expect(() => positiveNumberSetting({ N: "11" }, "N", { max: 10 })).toThrow(
      'N must be a positive number up to 10, got "11"',
    );
  });
});

test("settingProblems keeps every problem in the order read", () => {
  const { problems, read } = settingProblems();
  expect(read(() => integerSetting({}, "A", { min: 1 }))).toBeUndefined();
  expect(read(() => integerSetting({ B: "2" }, "B", { min: 1 }))).toBe(2);
  expect(read(() => positiveNumberSetting({ C: "0" }, "C"))).toBeUndefined();
  expect(problems).toEqual([
    "A is required",
    'C must be a positive number, got "0"',
  ]);
});
