import type { PERMISSION_MODE_VALUES } from "./session.ts";

type PermissionMode = (typeof PERMISSION_MODE_VALUES)[number];

/** The fields a workspace profile version sets over its operator base. */
export type DerivedFields = {
  readonly model: string;
  readonly models: readonly string[];
  readonly tools: readonly string[];
  readonly permission_mode: PermissionMode;
};

/** What a policy reads of a base: an operator profile, in the catalog or listed. */
export type DerivationBase = {
  readonly model: string;
  readonly models?: readonly string[] | undefined;
  readonly tools: readonly string[];
  readonly permission_mode: PermissionMode;
};

export type DerivationRefusal = {
  readonly field: keyof DerivedFields;
  readonly message: string;
};

/**
 * How a workspace profile version may differ from its base. The server checks
 * a save and a running version with `refusal` and runs `apply`; the console
 * starts from `initial` or `carry` and offers `choices`.
 */
export interface ProfileDerivationPolicy {
  readonly kind: string;
  /** The values a new version starts from. */
  initial(base: DerivationBase): DerivedFields;
  /** An earlier version's values, kept where the base still allows them. */
  carry(previous: DerivedFields, base: DerivationBase): DerivedFields;
  /** What each field may take over this base. */
  choices(base: DerivationBase): {
    readonly models: readonly string[];
    readonly tools: readonly string[];
    readonly permission_modes: readonly PermissionMode[];
  };
  /** Why `derived` leaves what the base allows, naming the field, or null. */
  refusal(
    base: DerivationBase,
    derived: DerivedFields,
  ): DerivationRefusal | null;
  /** The base as the version runs it. */
  apply<B extends DerivationBase>(base: B, derived: DerivedFields): B;
}

/**
 * The permission modes a version may run under a base of each mode: the
 * base's own, or one that leaves more to a person. A version never runs
 * unattended over an attended base.
 */
const NARROWER_PERMISSION_MODES: Readonly<
  Record<PermissionMode, readonly PermissionMode[]>
> = {
  bypassPermissions: [
    "bypassPermissions",
    "auto",
    "acceptEdits",
    "default",
    "plan",
  ],
  auto: ["auto", "acceptEdits", "default", "plan"],
  acceptEdits: ["acceptEdits", "default", "plan"],
  default: ["default", "plan"],
  dontAsk: ["dontAsk", "plan"],
  plan: ["plan"],
};

const offeredModels = (base: DerivationBase): string[] => [
  ...new Set([base.model, ...(base.models ?? [])]),
];

/** Every value is the base's or narrower: fewer models and tools, a stricter mode. */
export const narrowOnlyPolicy: ProfileDerivationPolicy = {
  kind: "narrow",
  initial: (base) => ({
    model: base.model,
    models: [base.model],
    tools: [...base.tools],
    permission_mode: base.permission_mode,
  }),
  carry(previous, base) {
    const offered = offeredModels(base);
    const models = previous.models.filter((model) => offered.includes(model));
    return {
      model: models.includes(previous.model)
        ? previous.model
        : (models[0] ?? base.model),
      models: models.length > 0 ? models : [base.model],
      tools: previous.tools.filter((tool) => base.tools.includes(tool)),
      permission_mode: NARROWER_PERMISSION_MODES[base.permission_mode].includes(
        previous.permission_mode,
      )
        ? previous.permission_mode
        : base.permission_mode,
    };
  },
  choices: (base) => ({
    models: offeredModels(base),
    tools: base.tools,
    permission_modes: NARROWER_PERMISSION_MODES[base.permission_mode],
  }),
  refusal(base, derived) {
    const offered = offeredModels(base);
    const unknownModel = derived.models.find((m) => !offered.includes(m));
    if (unknownModel !== undefined) {
      return {
        field: "models",
        message: `The base profile does not offer model ${unknownModel}`,
      };
    }
    if (!derived.models.includes(derived.model)) {
      return { field: "model", message: "model must be one of models" };
    }
    const unknownTool = derived.tools.find((t) => !base.tools.includes(t));
    if (unknownTool !== undefined) {
      return {
        field: "tools",
        message: `The base profile does not allow tool ${unknownTool}`,
      };
    }
    const modes = NARROWER_PERMISSION_MODES[base.permission_mode];
    if (!modes.includes(derived.permission_mode)) {
      return {
        field: "permission_mode",
        message: `A profile over a ${base.permission_mode} base may run ${modes.join(", ")}`,
      };
    }
    return null;
  },
  apply: (base, derived) => ({
    ...base,
    model: derived.model,
    models: [...derived.models],
    tools: [...derived.tools],
    permission_mode: derived.permission_mode,
  }),
};

/** The one place the server and the console pick the policy versions follow. */
export const WORKSPACE_PROFILE_POLICY: ProfileDerivationPolicy =
  narrowOnlyPolicy;
