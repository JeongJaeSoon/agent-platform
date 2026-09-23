import type { Database } from "@agent-platform/db";
import { createPostgresCheckpointStore } from "@agent-platform/db";
import {
  type CheckpointProtocol,
  type CheckpointServiceDependencies,
  type CheckpointVerifier,
  createCheckpointService,
  rejectUnverifiedCheckpoints,
  serviceCheckpointVerifier,
} from "@agent-platform/platform";
import {
  CLAUDE_CHECKPOINT_ENGINE,
  claudeCheckpointCodec,
} from "@agent-platform/runtime-claude-codec";
import {
  createCheckpointObjectStore,
  createGitWorkspaceBundleVerifier,
  createStorageS3Client,
  DEFAULT_MAX_GIT_MEMORY_BYTES,
  type GitCommandRunner,
} from "@agent-platform/storage";

export type ApiCheckpointServiceDependencies = Pick<
  CheckpointServiceDependencies,
  "codecs" | "objects" | "store"
> & {
  /** Tests observe the git the verifier starts; the product path never passes this. */
  readonly gitRunner?: GitCommandRunner;
  /** Address space per verifying git process; unset keeps the verifier's default. */
  readonly maxGitMemoryBytes?: number;
  /** Tests substitute a spy; the product path never passes this. */
  readonly workspaceBundles?: CheckpointServiceDependencies["workspaceBundles"];
};

/**
 * The API's CheckpointService, with its workspace bundle verifier chosen by
 * name.
 *
 * `createCheckpointService` defaults to refusing every bundle, and the
 * structural verifier would take a worker's word for its own commit, so the
 * git-backed one is named here rather than left to a default.
 */
export function createApiCheckpointService(
  deps: ApiCheckpointServiceDependencies,
): ReturnType<typeof createCheckpointService> {
  return createCheckpointService({
    codecs: deps.codecs,
    objects: deps.objects,
    store: deps.store,
    workspaceBundles:
      deps.workspaceBundles ??
      createGitWorkspaceBundleVerifier({
        ...(deps.gitRunner === undefined ? {} : { gitRunner: deps.gitRunner }),
        ...(deps.maxGitMemoryBytes === undefined
          ? {}
          : { maxGitMemoryBytes: deps.maxGitMemoryBytes }),
      }),
  });
}

/**
 * Smallest cap accepted: twice what a bundle near the service's size ceiling
 * needed in the API image (one incompressible 120 MiB file: refused at
 * 96 MiB, verified at 128 MiB). A cap below what ordinary bundles need fails
 * every verification, so no checkpoint would ever commit; refusing to start
 * says that once instead of on every turn.
 */
export const MIN_CHECKPOINT_GIT_MEMORY_MB = 256;

/**
 * `CHECKPOINT_GIT_MEMORY_MB`: the address space, in MiB, each git process
 * verifying a workspace bundle may use. Unset or blank keeps
 * `DEFAULT_MAX_GIT_MEMORY_BYTES`. It exists so the value can be sized
 * together with the container's memory limit: up to
 * `DEFAULT_MAX_CONCURRENT_BUNDLE_VERIFICATIONS` verifications run at once,
 * each with git fetch and index-pack alive together under this cap apiece
 * (see infra/docker-compose.yml).
 */
export function checkpointGitMemoryBytesFromEnv(
  environment: CheckpointStorageEnvironment,
): number {
  const raw = environment.CHECKPOINT_GIT_MEMORY_MB?.trim();
  if (raw === undefined || raw === "") return DEFAULT_MAX_GIT_MEMORY_BYTES;
  const mb = /^[0-9]+$/.test(raw) ? Number(raw) : Number.NaN;
  const bytes = mb * 1024 * 1024;
  if (!Number.isSafeInteger(bytes) || mb < MIN_CHECKPOINT_GIT_MEMORY_MB) {
    throw new Error(
      `CHECKPOINT_GIT_MEMORY_MB must be a whole number of MiB, at least ${MIN_CHECKPOINT_GIT_MEMORY_MB}, not ${raw}`,
    );
  }
  return bytes;
}

/** The engines this control plane can read a manifest for. */
export const API_CHECKPOINT_CODECS: CheckpointServiceDependencies["codecs"] = {
  [CLAUDE_CHECKPOINT_ENGINE]: claudeCheckpointCodec,
};

/**
 * Read: `S3_BUCKET`, `AWS_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`,
 * `AWS_ENDPOINT_URL` (optional) and `CHECKPOINT_OBJECT_STORE`. The last one
 * set to `disabled` runs the API with no object store: every checkpoint is
 * refused and the worker checkpoint protocol answers CHECKPOINT_UNAVAILABLE.
 * It has to be said out loud — a missing bucket is a misconfiguration, and
 * one that would otherwise hide behind turns that keep finalizing without a
 * checkpoint.
 */
export type CheckpointStorageEnvironment = Readonly<
  Record<string, string | undefined>
>;

export type CheckpointStorageConfig = {
  accessKeyId: string;
  bucket: string;
  endpoint?: string;
  region: string;
  secretAccessKey: string;
};

export function checkpointStorageConfigFromEnv(
  environment: CheckpointStorageEnvironment,
): CheckpointStorageConfig | "disabled" {
  const mode = environment.CHECKPOINT_OBJECT_STORE?.trim();
  if (mode === "disabled") return "disabled";
  if (mode !== undefined && mode !== "" && mode !== "s3") {
    throw new Error(
      `CHECKPOINT_OBJECT_STORE must be "s3" (default) or "disabled", not ${mode}`,
    );
  }
  const endpoint = environment.AWS_ENDPOINT_URL?.trim();
  if (endpoint) {
    let parsed: URL | undefined;
    try {
      parsed = new URL(endpoint);
    } catch {
      parsed = undefined;
    }
    // A bare host:port parses as a URL whose scheme is the host name; the
    // SDK needs an http(s) origin.
    // The value is not echoed: an endpoint pasted with userinfo would put
    // a credential into the startup log.
    if (!parsed || !["http:", "https:"].includes(parsed.protocol)) {
      throw new Error("AWS_ENDPOINT_URL is not an http(s) URL");
    }
    if (parsed.username !== "" || parsed.password !== "") {
      throw new Error("AWS_ENDPOINT_URL must not carry userinfo");
    }
  }
  // The bucket is named first so an empty environment is reported as the
  // missing object store, not as a missing key.
  const bucket = required(environment.S3_BUCKET, "S3_BUCKET");
  return {
    accessKeyId: required(environment.AWS_ACCESS_KEY_ID, "AWS_ACCESS_KEY_ID"),
    bucket,
    ...(endpoint ? { endpoint } : {}),
    region: required(environment.AWS_REGION, "AWS_REGION"),
    secretAccessKey: required(
      environment.AWS_SECRET_ACCESS_KEY,
      "AWS_SECRET_ACCESS_KEY",
    ),
  };
}

function required(value: string | undefined, name: string): string {
  if (!value || value.trim() === "") {
    throw new Error(
      `${name} is required for the checkpoint object store (set CHECKPOINT_OBJECT_STORE=disabled to run without one)`,
    );
  }
  return value;
}

export type ApiCheckpoints = {
  verifier: CheckpointVerifier;
  protocol: CheckpointProtocol | undefined;
};

/**
 * What the worker gateway is bound to: the storage-backed verifier and the
 * checkpoint protocol when an object store is configured, and the fail-closed
 * verifier with no protocol when it is explicitly disabled.
 */
export function createApiCheckpoints(
  db: Database,
  config: CheckpointStorageConfig | "disabled",
  maxGitMemoryBytes?: number,
): ApiCheckpoints {
  if (config === "disabled") {
    return { verifier: rejectUnverifiedCheckpoints, protocol: undefined };
  }
  const client = createStorageS3Client({
    s3: {
      accessKeyId: config.accessKeyId,
      ...(config.endpoint === undefined ? {} : { endpoint: config.endpoint }),
      region: config.region,
      secretAccessKey: config.secretAccessKey,
    },
  });
  const service = createApiCheckpointService({
    codecs: API_CHECKPOINT_CODECS,
    objects: createCheckpointObjectStore({ bucket: config.bucket, client }),
    store: createPostgresCheckpointStore(db),
    ...(maxGitMemoryBytes === undefined ? {} : { maxGitMemoryBytes }),
  });
  return { verifier: serviceCheckpointVerifier(service), protocol: service };
}
