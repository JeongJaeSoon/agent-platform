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

// An index becomes `[]`: the same bad field in 100 rows is one issue.
const segment = (key: PropertyKey) =>
  typeof key === "number" ? "[]" : String(key);

/**
 * Each issue carries its path and Zod issue code only. A Zod message can
 * quote the value (a custom refinement's text is anyone's), and a response
 * holds API key secrets and invite tokens.
 */
function validatorOf(schema: ZodType): Validator {
  return (value) => {
    const result = schema.safeParse(value);
    if (result.success) return [];
    return result.error.issues.flatMap((issue): ContractIssue[] => {
      const path = issue.path.map(segment);
      if (issue.code === "unrecognized_keys") {
        return issue.keys.map((key) => ({
          path: [...path, key].join("."),
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
