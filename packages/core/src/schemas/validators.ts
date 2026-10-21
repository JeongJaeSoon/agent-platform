import type {
  ClientValidators,
  ContractIssue,
  ContractMismatch,
  OperationKey,
  Validator,
} from "@agent-platform/client";
import { sseEventSchema } from "@agent-platform/contracts";
// biome-ignore lint/style/noRestrictedImports: the schemas entry is where the core may name zod; the root entry still may not.
import type { ZodType } from "zod";
import { responseSchemas } from "./responses.ts";

/** Every object field name declared anywhere inside `schema`. */
function declaredKeys(schema: ZodType): Set<string> {
  const keys = new Set<string>();
  const seen = new Set<object>();
  const visit = (node: unknown): void => {
    if (typeof node !== "object" || node === null || seen.has(node)) return;
    seen.add(node);
    const def = (node as { _zod?: { def?: Record<string, unknown> } })._zod
      ?.def;
    if (!def) return;
    for (const [name, value] of Object.entries(def)) {
      if (name === "shape" && typeof value === "object" && value !== null) {
        for (const [key, field] of Object.entries(value)) {
          keys.add(key);
          visit(field);
        }
      } else if (name === "getter" && typeof value === "function") {
        visit(value());
      } else if (Array.isArray(value)) {
        for (const item of value) visit(item);
      } else {
        visit(value);
      }
    }
  };
  visit(schema);
  return keys;
}

/**
 * Each issue carries its path and Zod issue code only. A Zod message can
 * quote the value (a custom refinement's text is anyone's), and a response
 * holds API key secrets and invite tokens. A path keeps only field names the
 * contract declares: an unknown key or a record key is the response's own
 * text, so it becomes `*`; an index becomes `[]`, so the same bad field in
 * 100 rows is one issue.
 */
function validatorOf(schema: ZodType): Validator {
  let declared: Set<string> | undefined;
  return (value) => {
    const result = schema.safeParse(value);
    if (result.success) return [];
    declared ??= declaredKeys(schema);
    const known = declared;
    const segment = (key: PropertyKey) =>
      typeof key === "number"
        ? "[]"
        : typeof key === "string" && known.has(key)
          ? key
          : "*";
    return result.error.issues.flatMap((issue): ContractIssue[] => {
      const path = issue.path.map(segment);
      if (issue.code === "unrecognized_keys") {
        return issue.keys.map((key) => ({
          path: [...path, segment(key)].join("."),
          message: issue.code,
        }));
      }
      return [{ path: path.join("."), message: issue.code }];
    });
  };
}

/** Every response and the session event frame, checked against contracts. */
export const contractValidators: ClientValidators = {
  responses: Object.fromEntries(
    Object.entries(responseSchemas).map(([operation, schema]) => [
      operation,
      validatorOf(schema),
    ]),
  ) as Partial<Record<OperationKey, Validator>>,
  sessionEvent: validatorOf(sseEventSchema),
};

/**
 * An `onContractMismatch` for `warn` that logs each (operation, path, issue
 * code) once for the life of the reporter, so a field the server added
 * warns once rather than on every poll.
 */
export function warnOncePerIssue(
  // Looked up per call, so a console patched later still receives it.
  log: (message: string, mismatch: ContractMismatch) => void = (...line) =>
    console.warn(...line),
): (mismatch: ContractMismatch) => void {
  const seen = new Set<string>();
  return ({ operation, issues }) => {
    const fresh = issues.filter((issue) => {
      const key = JSON.stringify([operation, issue.path, issue.message]);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    if (fresh.length > 0)
      log("API contract mismatch", { operation, issues: fresh });
  };
}
