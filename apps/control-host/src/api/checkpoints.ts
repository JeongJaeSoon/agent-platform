import type { Database } from "@agent-platform/db";
import { createPostgresCheckpointStore } from "@agent-platform/db";
import {
  type CheckpointProtocol,
  type CheckpointServiceDependencies,
  type CheckpointVerifier,
  createCheckpointService,
  type ObjectProtection,
  rejectUnverifiedCheckpoints,
  serviceCheckpointVerifier,
} from "@agent-platform/platform";
import {
  CLAUDE_CHECKPOINT_ENGINE,
  claudeCheckpointCodec,
} from "@agent-platform/runtime-claude-codec";
import {
  bucketHoldsObjectVersion,
  createCheckpointObjectStore,
  createGitWorkspaceBundleVerifier,
  createObjectRouteSigner,
  createStorageS3Client,
  DEFAULT_MAX_GIT_MEMORY_BYTES,
  describeBucketEncryption,
  describeBucketProtection,
  type GitCommandRunner,
  type ObjectRouteSigner,
  type S3ClientLike,
} from "@agent-platform/storage";

export type ApiCheckpointServiceDependencies = Pick<
  CheckpointServiceDependencies,
  "codecs" | "objectProtection" | "objects" | "store"
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
    ...(deps.objectProtection === undefined
      ? {}
      : { objectProtection: deps.objectProtection }),
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
 * Smallest cap accepted: twice what the largest bundle a worker writes may
 * need. What git needs follows the largest file, a little over its size
 * (one incompressible 120 MiB file: refused at 96 MiB, verified at 128 MiB),
 * and workers now write bundles up to the service's 256 MiB ceiling
 * (94S-318), so a single 250 MiB file needs ~256 MiB. A cap below what
 * ordinary bundles need fails every verification, so no checkpoint would
 * ever commit; refusing to start says that once instead of on every turn.
 */
export const MIN_CHECKPOINT_GIT_MEMORY_MB = 512;

/**
 * `CHECKPOINT_GIT_MEMORY_MB`: the address space, in MiB, each git process
 * verifying a workspace bundle may use. Unset or blank keeps
 * `DEFAULT_MAX_GIT_MEMORY_BYTES`. It exists so the value can be sized
 * together with the container's memory limit: up to
 * `DEFAULT_MAX_CONCURRENT_BUNDLE_VERIFICATIONS` verifications run at once,
 * each with git fetch and index-pack alive together under this cap apiece
 * (see infra/compose.core.yml).
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
 * `AWS_ENDPOINT_URL` (optional), `CHECKPOINT_OBJECT_STORE` and
 * `CHECKPOINT_OBJECT_PROTECTION`. `CHECKPOINT_OBJECT_STORE=disabled` runs the
 * API with no object store: every checkpoint is refused and the worker
 * checkpoint protocol answers CHECKPOINT_UNAVAILABLE. It has to be said out
 * loud — a missing bucket is a misconfiguration, and one that would otherwise
 * hide behind turns that keep finalizing without a checkpoint.
 *
 * `CHECKPOINT_OBJECT_PROTECTION` is `locked` (default) or `unversioned`, the
 * CheckpointService `objectProtection`. Degrading to `unversioned` has to be
 * said out loud for the same reason.
 *
 * `CHECKPOINT_OBJECT_ENCRYPTION_CHECK` is `enforce` (default) or `warn`: what
 * `assertCheckpointBucketEncryption` does with a bucket whose default
 * encryption is not SSE-S3.
 */
export type CheckpointStorageEnvironment = Readonly<
  Record<string, string | undefined>
>;

export type CheckpointStorageConfig = {
  accessKeyId: string;
  bucket: string;
  endpoint?: string;
  /** Absent means `enforce`. */
  encryptionCheck?: "warn";
  protection: ObjectProtection;
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
  const protection = environment.CHECKPOINT_OBJECT_PROTECTION?.trim();
  if (
    protection !== undefined &&
    protection !== "" &&
    protection !== "locked" &&
    protection !== "unversioned"
  ) {
    throw new Error(
      `CHECKPOINT_OBJECT_PROTECTION must be "locked" (default) or "unversioned", not ${protection}`,
    );
  }
  const encryptionCheck =
    environment.CHECKPOINT_OBJECT_ENCRYPTION_CHECK?.trim();
  if (
    encryptionCheck !== undefined &&
    encryptionCheck !== "" &&
    encryptionCheck !== "enforce" &&
    encryptionCheck !== "warn"
  ) {
    throw new Error(
      `CHECKPOINT_OBJECT_ENCRYPTION_CHECK must be "enforce" (default) or "warn", not ${encryptionCheck}`,
    );
  }
  return {
    accessKeyId: required(environment.AWS_ACCESS_KEY_ID, "AWS_ACCESS_KEY_ID"),
    bucket,
    ...(endpoint ? { endpoint } : {}),
    ...(encryptionCheck === "warn" ? { encryptionCheck } : {}),
    protection: protection === "unversioned" ? "unversioned" : "locked",
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
  const service = createApiCheckpointService({
    codecs: API_CHECKPOINT_CODECS,
    objectProtection: config.protection,
    objects: createCheckpointObjectStore({
      bucket: config.bucket,
      client: checkpointS3Client(config),
    }),
    store: createPostgresCheckpointStore(db),
    ...(maxGitMemoryBytes === undefined ? {} : { maxGitMemoryBytes }),
  });
  return { verifier: serviceCheckpointVerifier(service), protocol: service };
}

function checkpointS3Client(config: CheckpointStorageConfig) {
  return createStorageS3Client({
    s3: {
      accessKeyId: config.accessKeyId,
      ...(config.endpoint === undefined ? {} : { endpoint: config.endpoint }),
      region: config.region,
      secretAccessKey: config.secretAccessKey,
    },
  });
}

/**
 * What signs the workers' object store requests (94S-251): the same bucket
 * and key the API itself uses, which is why the key stays in this process.
 */
export function checkpointObjectRouteSigner(
  config: CheckpointStorageConfig,
): ObjectRouteSigner {
  return createObjectRouteSigner({
    bucket: config.bucket,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
    ...(config.endpoint === undefined ? {} : { endpoint: config.endpoint }),
    region: config.region,
  });
}

/**
 * Refuses to start a `locked` deployment on a bucket that cannot pin or hold
 * versions. Every finalize would otherwise fail on its first hold — and a
 * bucket with versioning but no Object Lock would still verify, which reads
 * like protection until the first hold is refused. `unversioned` is checked
 * for nothing; the operator has said what it gives up.
 */
export async function assertCheckpointBucketProtection(
  config: CheckpointStorageConfig,
): Promise<void> {
  if (config.protection !== "locked") return;
  const client = checkpointS3Client(config);
  try {
    const found = await describeBucketProtection(client, config.bucket);
    if (found.versioning !== "Enabled" || !found.objectLock) {
      throw new Error(
        `Checkpoint bucket ${config.bucket} has versioning ${found.versioning} and Object Lock ${found.objectLock ? "enabled" : "not configured"}; CHECKPOINT_OBJECT_PROTECTION=locked needs both (set it to "unversioned" to run without version pinning and holds)`,
      );
    }
  } finally {
    client.destroy();
  }
}

/**
 * The default encryption a checkpoint bucket must have: SSE-S3. Checkpoint
 * writes name no encryption, so the bucket default is what every object
 * gets. SSE-KMS is not accepted in its place: every worker would need
 * GenerateDataKey on the key, which is exactly the credential 94S-251
 * narrows, and a worker without it fails its first write rather than this
 * check (docs/operations.md, 94S-337).
 */
export const CHECKPOINT_BUCKET_ENCRYPTION = "AES256";

/**
 * Refuses to start on a checkpoint bucket whose default encryption is not
 * `CHECKPOINT_BUCKET_ENCRYPTION`, whatever the protection mode: an
 * unversioned deployment still stores transcripts and workspaces.
 * `CHECKPOINT_OBJECT_ENCRYPTION_CHECK=warn` reports it through `warn` and
 * starts anyway.
 */
export async function assertCheckpointBucketEncryption(
  config: CheckpointStorageConfig,
  options: {
    /** Tests substitute a fake; the product path never passes this. */
    readonly client?: S3ClientLike;
    readonly warn: (message: string, fields: { bucket: string }) => void;
  },
): Promise<void> {
  const check = async (client: S3ClientLike) => {
    const found = await describeBucketEncryption(client, config.bucket);
    if (found === CHECKPOINT_BUCKET_ENCRYPTION) return;
    const message = `Checkpoint bucket ${config.bucket} encrypts new objects with ${found}; checkpoints need the bucket default SSE-S3 (${CHECKPOINT_BUCKET_ENCRYPTION})`;
    if (config.encryptionCheck !== "warn") {
      throw new Error(
        `${message} (set CHECKPOINT_OBJECT_ENCRYPTION_CHECK=warn to start anyway)`,
      );
    }
    options.warn(message, { bucket: config.bucket });
  };
  if (options.client !== undefined) return check(options.client);
  const client = checkpointS3Client(config);
  try {
    await check(client);
  } finally {
    client.destroy();
  }
}

/**
 * Refuses to start when the database still has checkpoints a restore or a
 * backup reads but the bucket holds no object version at all. That is the
 * local LocalStack losing its S3 state (it keeps it in memory, so a raw
 * `docker compose down` or a Docker restart empties it) while postgres kept
 * its volume; every such session would fail its restore instead. This only
 * catches the empty bucket fast. It does not replace the backup's
 * per-version check.
 */
export async function assertCheckpointObjectsPresent(
  config: CheckpointStorageConfig,
  options: {
    readonly hasUncollectedCheckpoint: () => Promise<boolean>;
    /** Tests substitute a fake; the product path never passes this. */
    readonly client?: S3ClientLike;
  },
): Promise<void> {
  if (!(await options.hasUncollectedCheckpoint())) return;
  const check = async (client: S3ClientLike) => {
    if (await bucketHoldsObjectVersion(client, config.bucket)) return;
    throw new Error(
      `Checkpoint bucket ${config.bucket} holds no object version, but the database still has checkpoints that restores read: the object store lost its data while the database kept it. A local LocalStack keeps S3 in memory, so \`docker compose down\` or a Docker restart empties it. Start the local installation over with \`scripts/local.sh reset\` (it deletes every session)`,
    );
  };
  if (options.client !== undefined) return check(options.client);
  const client = checkpointS3Client(config);
  try {
    await check(client);
  } finally {
    client.destroy();
  }
}
