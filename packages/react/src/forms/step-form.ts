import { zodResolver } from "@hookform/resolvers/zod";
import { useMemo } from "react";
import {
  type FieldErrors,
  type FieldValues,
  type Resolver,
  type UseFormProps,
  type UseFormReturn,
  useForm,
} from "react-hook-form";
import type { z } from "zod";
import type { ModuleMessages } from "../messages/index.ts";
import { useAgentPlatform } from "../provider.tsx";
import { issueText } from "./issues.ts";

export type StepSchema = z.ZodType<FieldValues, FieldValues>;

export type StepForm<S extends StepSchema> = UseFormReturn<
  z.input<S>,
  unknown,
  z.output<S>
>;

/** Where `submitStep` puts a failed request; `formAlerts` lists it first. */
export const SERVER_ERROR = "root.server";

/** Calls `visit` on every error object in a nested FieldErrors tree. */
function walk(
  node: unknown,
  path: string,
  visit: (path: string, error: { message?: unknown; type?: unknown }) => void,
) {
  if (typeof node !== "object" || node === null) return;
  const error = node as Record<string, unknown>;
  if (typeof error.type === "string") visit(path, error);
  for (const [key, child] of Object.entries(error)) {
    if (key === "ref" || key === "types" || key === "message") continue;
    walk(child, path ? `${path}.${key}` : key, visit);
  }
}

/**
 * zodResolver with the console's wording. The per-parse error map turns each
 * issue into a message; a check that carries its own message (the contract's
 * `.regex(re, "must be lowercase kebab-case")`) outranks that map in zod, so
 * any message the map did not write is replaced by the one for its code.
 */
export function stepResolver<S extends StepSchema>(
  schema: S,
  messages: ModuleMessages,
): Resolver<z.input<S>, unknown, z.output<S>> {
  return async (values, context, options) => {
    const written = new Set<string>();
    // A generic S does not narrow to zodResolver's Zod 4 overload on its own.
    const typed = schema as unknown as z.ZodType<z.output<S>, z.input<S>>;
    const resolve = zodResolver(typed, {
      error: (issue) => {
        const text = issueText(issue, messages);
        written.add(text);
        return text;
      },
    });
    const result = await resolve(values, context, options);
    walk(result.errors, "", (_path, error) => {
      if (typeof error.message === "string" && !written.has(error.message)) {
        // zodResolver sets `type` to the issue code.
        error.message = issueText(
          { code: error.type as z.core.$ZodIssueCode },
          messages,
        );
      }
    });
    return result;
  };
}

/**
 * A form over one step schema: the form holds the schema's input, a valid
 * submit hands over its output. Pass a schema that keeps its identity across
 * renders (a module constant, or `useMemo` for `agentCardStep(base)`).
 */
export function useStepForm<S extends StepSchema>(
  schema: S,
  props: Omit<UseFormProps<z.input<S>, unknown, z.output<S>>, "resolver"> = {},
): StepForm<S> {
  const { messages } = useAgentPlatform();
  const resolver = useMemo(
    () => stepResolver(schema, messages),
    [schema, messages],
  );
  return useForm<z.input<S>, unknown, z.output<S>>({ ...props, resolver });
}

/**
 * The submit handler. A valid form goes to `send`; whatever `send` throws
 * becomes one line in `root.server`, worded by the host (the server's 400
 * carries no field paths, so nothing is mapped back onto inputs).
 */
export function submitStep<TInput extends FieldValues, TOutput>(
  form: UseFormReturn<TInput, unknown, TOutput>,
  send: (values: TOutput) => unknown,
  serverMessage: (error: unknown) => string,
) {
  return form.handleSubmit(async (values) => {
    try {
      await send(values);
    } catch (error) {
      form.setError(SERVER_ERROR, {
        type: "server",
        message: serverMessage(error),
      });
    }
  });
}

/**
 * The messages a form shows above its fields: the server's line, then other
 * root errors, then any error whose path is not one of `fields` (or inside
 * one) and so has no FieldError to show it.
 */
export function formAlerts<T extends FieldValues>(
  errors: FieldErrors<T>,
  fields: readonly string[],
): string[] {
  const server: string[] = [];
  const root: string[] = [];
  const unmapped: string[] = [];
  walk(errors, "", (path, error) => {
    if (typeof error.message !== "string" || !error.message) return;
    if (path === SERVER_ERROR) server.push(error.message);
    else if (path === "root" || path.startsWith("root."))
      root.push(error.message);
    else if (
      !fields.some((field) => path === field || path.startsWith(`${field}.`))
    )
      unmapped.push(error.message);
  });
  return [...new Set([...server, ...root, ...unmapped])];
}
