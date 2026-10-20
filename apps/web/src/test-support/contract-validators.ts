import { readFileSync } from "node:fs";
import { join } from "node:path";
import type {
  ClientValidators,
  OperationKey,
  Validator,
} from "@agent-platform/client";
import { sseEventSchema } from "@agent-platform/contracts";
import { type ZodType, z } from "zod";

/*
 * What the screen tests hold every fake answer to: the response schema of
 * each operation in docs/openapi.json, which is generated from the Zod
 * contracts and checked for freshness. The operation-to-schema table lives
 * only in the server's code, so the document stands in for it until the
 * shared schemas package publishes one.
 */

const DOCUMENT = join(
  import.meta.dir,
  "..",
  "..",
  "..",
  "..",
  "docs",
  "openapi.json",
);
const METHODS = ["get", "post", "put", "patch", "delete"] as const;

interface Operation {
  responses?: Record<
    string,
    { content?: Record<string, { schema?: unknown }> }
  >;
}

function fromZod(schema: ZodType): Validator {
  return (value) => {
    const result = schema.safeParse(value);
    return result.success
      ? []
      : result.error.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message,
        }));
  };
}

// The document's objects are closed (`additionalProperties: false`), but the
// contracts' z.object strips keys it does not know rather than failing.
function openObjects(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(openObjects);
  if (typeof node !== "object" || node === null) return node;
  const copy: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) {
    if (key === "additionalProperties" && value === false) continue;
    copy[key] = openObjects(value);
  }
  return copy;
}

function responseValidators(): Partial<Record<OperationKey, Validator>> {
  const document = JSON.parse(readFileSync(DOCUMENT, "utf8")) as {
    paths: Record<string, Partial<Record<string, Operation>>>;
    components: { schemas: Record<string, unknown> };
  };
  // z.fromJSONSchema resolves references only within the schema it is given.
  const local = (node: unknown) =>
    JSON.parse(
      JSON.stringify(openObjects(node)).replaceAll(
        "#/components/schemas/",
        "#/$defs/",
      ),
    );
  const $defs = local(document.components.schemas);
  const validators: Partial<Record<OperationKey, Validator>> = {};
  for (const [path, item] of Object.entries(document.paths)) {
    for (const method of METHODS) {
      const success = Object.entries(item[method]?.responses ?? {}).find(
        ([status]) => status.startsWith("2"),
      )?.[1];
      const schema = success?.content?.["application/json"]?.schema;
      if (!schema) continue;
      const key = `${method.toUpperCase()} ${path}` as OperationKey;
      validators[key] = fromZod(z.fromJSONSchema({ ...local(schema), $defs }));
    }
  }
  return validators;
}

export const contractValidators: ClientValidators = {
  responses: responseValidators(),
  sessionEvent: fromZod(sseEventSchema),
};
