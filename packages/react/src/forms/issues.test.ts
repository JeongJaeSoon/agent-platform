import { describe, expect, test } from "bun:test";
import type { core } from "zod";
import { formsEn, formsKo } from "../messages/forms.ts";
import { defaultMessages } from "../messages/index.ts";
import {
  type FormMessageKey,
  type IssueFacts,
  issueMessageKey,
  issueText,
} from "./issues.ts";

// Every zod issue code, keyed so a code zod adds fails the typecheck here.
const TABLE: {
  readonly [C in core.$ZodIssueCode]: readonly [
    Omit<IssueFacts, "code">,
    FormMessageKey,
  ][];
} = {
  invalid_type: [
    [{ input: undefined }, "form.error.required"],
    [{ input: null }, "form.error.required"],
    [{ input: 3 }, "form.error.invalid"],
  ],
  too_small: [
    [{ origin: "string", minimum: 1 }, "form.error.required"],
    [{ origin: "string", minimum: 12 }, "form.error.tooShort"],
    [{ origin: "array", minimum: 1 }, "form.error.tooFew"],
    [{ origin: "number", minimum: 1 }, "form.error.tooSmall"],
  ],
  too_big: [
    [{ origin: "string", maximum: 64 }, "form.error.tooLong"],
    [{ origin: "set", maximum: 32 }, "form.error.tooMany"],
    [{ origin: "int", maximum: 9 }, "form.error.tooBig"],
  ],
  invalid_format: [
    [{ format: "email" }, "form.error.email"],
    [{ format: "regex" }, "form.error.format"],
  ],
  invalid_value: [[{}, "form.error.choice"]],
  not_multiple_of: [[{}, "form.error.invalid"]],
  unrecognized_keys: [[{}, "form.error.invalid"]],
  invalid_union: [[{}, "form.error.invalid"]],
  invalid_key: [[{}, "form.error.invalid"]],
  invalid_element: [[{}, "form.error.invalid"]],
  custom: [[{}, "form.error.invalid"]],
};

describe("zod issue code → message key", () => {
  for (const [code, rows] of Object.entries(TABLE)) {
    for (const [facts, key] of rows) {
      test(`${code} ${JSON.stringify(facts)} → ${key}`, () => {
        expect(
          issueMessageKey({ code: code as core.$ZodIssueCode, ...facts }).key,
        ).toBe(key);
      });
    }
  }

  test("every key the table reaches has Korean and English wording", () => {
    const keys = new Set(
      Object.values(TABLE).flatMap((rows) => rows.map(([, key]) => key)),
    );
    expect<string[]>([...keys].sort()).toEqual(Object.keys(formsKo).sort());
    expect(Object.keys(formsEn).sort()).toEqual(Object.keys(formsKo).sort());
    for (const key of keys) {
      expect(formsKo[key]).toBeTruthy();
      expect(formsEn[key]).toBeTruthy();
    }
  });

  test("limits fill the wording", () => {
    expect(
      issueText(
        { code: "too_big", origin: "string", maximum: 64 },
        defaultMessages.ko,
      ),
    ).toBe("64자 이하로 입력하세요.");
    expect(
      issueText(
        { code: "too_small", origin: "string", minimum: 12 },
        defaultMessages.en,
      ),
    ).toBe("Enter at least 12 characters.");
  });

  test("a code zod has not shipped yet reads as a generic check", () => {
    expect(
      issueMessageKey({ code: "brand_new" as core.$ZodIssueCode }).key,
    ).toBe("form.error.invalid");
  });
});
