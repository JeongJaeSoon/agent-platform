/**
 * What every engine adapter promises the platform, as checks an adapter's
 * own test registers before it goes into the installed runtimes. Nothing
 * here knows which engine it is: what only the adapter can read comes in
 * through the harness.
 */
import { deepStrictEqual } from "node:assert/strict";
import {
  PERMISSION_MODE_VALUES,
  type PermissionMode,
} from "@werft-ai/contracts";

export type AdapterConformanceHarness = {
  /**
   * The text the engine is set up to add on its own to a commit message and
   * to a pull request description, in a run started with `permissionMode`.
   * `undefined` means the adapter left the engine's default in place.
   */
  engineSignature(permissionMode: PermissionMode): {
    commit: string | undefined;
    pr: string | undefined;
  };
};

export type AdapterConformanceItem = {
  name: string;
  /** Throws when the adapter breaks the promise. */
  check(harness: AdapterConformanceHarness): void;
};

export const ADAPTER_CONFORMANCE: readonly AdapterConformanceItem[] = [
  {
    name: "1. the engine adds no signature of its own to commits or pull requests",
    check(harness) {
      for (const permissionMode of PERMISSION_MODE_VALUES) {
        deepStrictEqual(
          { permissionMode, ...harness.engineSignature(permissionMode) },
          { permissionMode, commit: "", pr: "" },
        );
      }
    },
  },
];
