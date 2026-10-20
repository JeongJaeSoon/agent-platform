import { ApiError } from "./errors.ts";
import type { paths } from "./schema.gen.ts";

/**
 * What a response that breaks the API contract does: `strict` throws an
 * ApiError (CLIENT_CONTRACT_MISMATCH), `warn` reports it and passes the
 * value on, `off` never runs a validator.
 */
export type ValidateMode = "strict" | "warn" | "off";

/** Where a value broke the contract. Never the value itself. */
export interface ContractIssue {
  readonly path: string;
  readonly message: string;
}

/**
 * Checks one value; [] when it conforms. The caller builds these (from Zod
 * schemas, say): the client carries no schema library of its own.
 */
export type Validator = (value: unknown) => readonly ContractIssue[];

export interface ContractMismatch {
  /** `GET /v1/sessions/{id}`, or `SSE /v1/sessions/{id}/events`. */
  readonly operation: string;
  readonly issues: readonly ContractIssue[];
}

type Method = "get" | "post" | "put" | "patch" | "delete";

/** `METHOD /path` of every operation in the OpenAPI document. */
export type OperationKey = {
  [P in keyof paths]: {
    [M in Method]: [NonNullable<paths[P][M]>] extends [never]
      ? never
      : `${Uppercase<M>} ${P & string}`;
  }[Method];
}[keyof paths];

export interface ClientValidators {
  /** Run on the JSON body of a 2xx answer. */
  readonly responses?: Partial<Record<OperationKey, Validator>>;
  /** Run on a whole session event frame `{ id, event, data }`. */
  readonly sessionEvent?: Validator;
}

export interface ContractOptions {
  readonly validate?: ValidateMode;
  readonly validators?: ClientValidators;
  /** Where `warn` reports. Defaults to console.warn. */
  readonly onContractMismatch?: (mismatch: ContractMismatch) => void;
}

export interface ContractPolicy {
  readonly mode: ValidateMode;
  readonly validators: ClientValidators;
  /** Applies the mode to issues already found. */
  report(
    mismatch: ContractMismatch,
    status: number,
    requestId: string | null,
  ): void;
  /** Runs `validator` on `value` unless the mode is off, then reports. */
  check(
    operation: string,
    validator: Validator | undefined,
    value: unknown,
    status: number,
    requestId: string | null,
  ): void;
}

export function contractPolicy(options: ContractOptions): ContractPolicy {
  const mode = options.validate ?? "off";
  const warn =
    options.onContractMismatch ??
    ((mismatch: ContractMismatch) =>
      console.warn("API contract mismatch", mismatch));
  const policy: ContractPolicy = {
    mode,
    validators: options.validators ?? {},
    report(mismatch, status, requestId) {
      if (mode === "off" || mismatch.issues.length === 0) return;
      if (mode === "warn") return warn(mismatch);
      throw new ApiError(
        status,
        "CLIENT_CONTRACT_MISMATCH",
        `${mismatch.operation} answered outside the API contract`,
        { requestId, mismatch },
      );
    },
    check(operation, validator, value, status, requestId) {
      if (mode === "off" || !validator) return;
      // Copied field by field: an injected validator may hang the offending
      // value on an issue, and a mismatch is reported and logged.
      const issues = validator(value).map(({ path, message }) => ({
        path: String(path),
        message: String(message),
      }));
      policy.report({ operation, issues }, status, requestId);
    },
  };
  return policy;
}
