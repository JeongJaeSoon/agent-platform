import {
  type ImageRuntime,
  imageRuntimeVersions,
  parseImageRuntime,
} from "@werft-ai/runtime-core";
import type { RuntimeVersions } from "../sessions/catalog.ts";

export type WorkerImagesEnvironment = {
  WORKER_IMAGE_PREVIOUS_RUNTIME?: string | undefined;
  WORKER_IMAGE_RUNTIME?: string | undefined;
};

/**
 * What the configured worker images stamp: the current one new sessions
 * start on, and the release before it, which sessions sealed on it resume
 * on. Each value is the image's own `imageFingerprint()` output, carried
 * from its build (images.yml) rather than written by hand.
 */
export type WorkerImageRuntimes = {
  readonly current: ImageRuntime;
  readonly previous: ImageRuntime | null;
};

/**
 * Null when no image runtime is configured. A malformed value, or a
 * previous image without a current one, throws: the process should not
 * start on a setting it cannot read.
 */
export function workerImageRuntimesFromEnv(
  environment: WorkerImagesEnvironment,
): WorkerImageRuntimes | null {
  const current = environment.WORKER_IMAGE_RUNTIME;
  const previous = environment.WORKER_IMAGE_PREVIOUS_RUNTIME;
  if (!current) {
    if (previous) {
      throw new Error(
        "WORKER_IMAGE_PREVIOUS_RUNTIME needs WORKER_IMAGE_RUNTIME beside it",
      );
    }
    return null;
  }
  return {
    current: readRuntime("WORKER_IMAGE_RUNTIME", current),
    previous: previous
      ? readRuntime("WORKER_IMAGE_PREVIOUS_RUNTIME", previous)
      : null,
  };
}

function readRuntime(name: string, value: string): ImageRuntime {
  try {
    return parseImageRuntime(value);
  } catch (error) {
    throw new Error(`${name}: ${(error as Error).message}`);
  }
}

export function runtimeVersionsOf(
  images: WorkerImageRuntimes,
): RuntimeVersions {
  const current = imageRuntimeVersions(images.current);
  return {
    current,
    accepted: [
      ...current,
      ...(images.previous === null
        ? []
        : imageRuntimeVersions(images.previous)),
    ],
  };
}
