import {
  type CheckpointServiceDependencies,
  createCheckpointService,
} from "@agent-platform/platform";
import { createGitWorkspaceBundleVerifier } from "@agent-platform/storage";

export type ApiCheckpointServiceDependencies = Pick<
  CheckpointServiceDependencies,
  "codecs" | "objects" | "store"
> & {
  /** Tests substitute a spy; the product path never passes this. */
  readonly workspaceBundles?: CheckpointServiceDependencies["workspaceBundles"];
};

/**
 * The API's CheckpointService, with its workspace bundle verifier chosen by
 * name.
 *
 * `createCheckpointService` defaults to refusing every bundle, and the
 * structural verifier would take a worker's word for its own commit, so the
 * git-backed one is named here rather than left to a default. 94S-201 binds
 * the service this returns to the worker gateway and the session detail.
 */
export function createApiCheckpointService(
  deps: ApiCheckpointServiceDependencies,
): ReturnType<typeof createCheckpointService> {
  return createCheckpointService({
    codecs: deps.codecs,
    objects: deps.objects,
    store: deps.store,
    workspaceBundles:
      deps.workspaceBundles ?? createGitWorkspaceBundleVerifier(),
  });
}
