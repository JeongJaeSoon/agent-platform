import { ErrorState, type ErrorStateProps } from "@werft-ai/ui";
import type { JSX } from "react";

import { guidanceFor } from "./error-guidance.ts";

export interface ApiErrorStateProps extends Omit<ErrorStateProps, "guidance"> {
  /** `error.code` — branching and copy key on the code, not the HTTP status. */
  readonly code?: string | undefined;
}

/** `ErrorState` that leads with what to do about the API's error code. */
export function ApiErrorState({
  code,
  ...props
}: ApiErrorStateProps): JSX.Element {
  return <ErrorState {...props} code={code} guidance={guidanceFor(code)} />;
}
