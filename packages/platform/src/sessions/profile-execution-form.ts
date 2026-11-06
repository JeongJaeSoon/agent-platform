import { canonicalJson } from "@werft-ai/contracts";

type Definition = Record<string, unknown>;

const isRecord = (value: unknown): value is Definition =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isEmpty = (value: unknown): boolean =>
  value === undefined ||
  value === null ||
  value === "" ||
  (Array.isArray(value) && value.length === 0) ||
  (isRecord(value) && Object.keys(value).length === 0);

const sortedSet = (values: unknown): string[] =>
  [...new Set(Array.isArray(values) ? values.map(String) : [])].sort();

/**
 * What a profile makes a session do (design 2.1a): its definition with the
 * spellings that run the same collapsed. The stored `fingerprint` is not
 * used; it leaves out the models. `repository` is dropped on purpose: new
 * rows carry no repository value, so a save that differs from an older row
 * only in it must not start a rollout. `deny` and `tool_catalog_id`
 * are columns, not part of the definition.
 */
export function profileExecutionForm(definition: Definition): string {
  const { repository: _repository, ...rest } = definition;
  const provider = isRecord(rest.provider) ? rest.provider : {};
  const form: Definition = {
    ...rest,
    models: sortedSet([
      rest.model,
      ...(Array.isArray(rest.models) ? rest.models : []),
    ]),
    title_model: rest.title_model ?? null,
    tools: sortedSet(rest.tools),
    provider: { ...provider, billing: provider.billing ?? "per_token" },
    project_settings: isRecord(rest.project_settings)
      ? rest.project_settings
      : { claude_md: false },
  };
  for (const key of ["auto_mode_rules", "instructions"]) {
    if (isEmpty(form[key])) delete form[key];
  }
  return canonicalJson(form);
}

export function sameExecutionForm(a: Definition, b: Definition): boolean {
  return profileExecutionForm(a) === profileExecutionForm(b);
}
