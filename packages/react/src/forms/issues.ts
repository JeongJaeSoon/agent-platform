import type { core } from "zod";
import type { formsKo } from "../messages/forms.ts";
import type { ModuleMessages } from "../messages/index.ts";

export type FormMessageKey = keyof typeof formsKo;

/** The parts of a zod issue a message depends on; a raw issue has them all. */
export interface IssueFacts {
  readonly code: core.$ZodIssueCode;
  readonly input?: unknown;
  readonly origin?: string;
  readonly minimum?: number | bigint;
  readonly maximum?: number | bigint;
  readonly format?: string;
}

export interface IssueMessage {
  readonly key: FormMessageKey;
  readonly vars?: Readonly<Record<string, number | bigint>>;
}

const sized = (origin: string | undefined) =>
  origin === "string" ? "text" : origin === "array" || origin === "set";

const BY_CODE: {
  readonly [C in core.$ZodIssueCode]: (issue: IssueFacts) => IssueMessage;
} = {
  invalid_type: ({ input }) => ({
    key:
      input === undefined || input === null
        ? "form.error.required"
        : "form.error.invalid",
  }),
  too_small: ({ origin, minimum = 0 }) => {
    const size = sized(origin);
    if (size === "text" && Number(minimum) <= 1)
      return { key: "form.error.required" };
    const key =
      size === "text"
        ? "form.error.tooShort"
        : size
          ? "form.error.tooFew"
          : "form.error.tooSmall";
    return { key, vars: { min: minimum } };
  },
  too_big: ({ origin, maximum = 0 }) => {
    const size = sized(origin);
    const key =
      size === "text"
        ? "form.error.tooLong"
        : size
          ? "form.error.tooMany"
          : "form.error.tooBig";
    return { key, vars: { max: maximum } };
  },
  invalid_format: ({ format }) => ({
    key: format === "email" ? "form.error.email" : "form.error.format",
  }),
  invalid_value: () => ({ key: "form.error.choice" }),
  not_multiple_of: () => ({ key: "form.error.invalid" }),
  unrecognized_keys: () => ({ key: "form.error.invalid" }),
  invalid_union: () => ({ key: "form.error.invalid" }),
  invalid_key: () => ({ key: "form.error.invalid" }),
  invalid_element: () => ({ key: "form.error.invalid" }),
  custom: () => ({ key: "form.error.invalid" }),
};

/** An unknown code (a zod release adding one) reads as a generic check. */
export function issueMessageKey(issue: IssueFacts): IssueMessage {
  return (
    Object.hasOwn(BY_CODE, issue.code) ? BY_CODE[issue.code] : BY_CODE.custom
  )(issue);
}

export function issueText(issue: IssueFacts, messages: ModuleMessages): string {
  const { key, vars = {} } = issueMessageKey(issue);
  return messages[key].replace(/\{(\w+)\}/g, (whole, name: string) =>
    Object.hasOwn(vars, name) ? String(vars[name]) : whole,
  );
}
