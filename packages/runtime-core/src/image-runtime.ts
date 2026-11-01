import type { RuntimeFingerprint } from "./checkpoint-manifest.ts";

/**
 * What a worker image stamps its checkpoints with, apart from the profile
 * digest it computes per claim, and which way of computing that digest its
 * code follows. Two images with the same engine build can hash one profile
 * differently; only the same `profileDigestScheme` says they do not.
 */
export type ImageRuntime = Omit<RuntimeFingerprint, "profileSha256"> & {
  readonly profileDigestScheme: number;
};

/**
 * The scheme of an image that does not name one: every image from before
 * the field hashed profiles the one way there was.
 */
export const FIRST_PROFILE_DIGEST_SCHEME = 1;

/**
 * `RuntimeModule.imageFingerprint()` as an image prints it (the
 * `image-runtime.ts` output, whose `profiles` map is ignored). Throws on
 * anything else, so a mistyped setting stops the process that reads it.
 */
export function parseImageRuntime(text: string): ImageRuntime {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("image runtime is not JSON");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("image runtime must be a JSON object");
  }
  const {
    cliVersion,
    engine,
    profileDigestScheme = FIRST_PROFILE_DIGEST_SCHEME,
    profiles: _profiles,
    sdkVersion,
    ...rest
  } = value as Record<string, unknown>;
  const unknown = Object.keys(rest);
  if (unknown.length > 0) {
    throw new Error(
      `image runtime has unknown field(s): ${unknown.join(", ")}`,
    );
  }
  for (const [field, found] of Object.entries({
    cliVersion,
    engine,
    sdkVersion,
  })) {
    if (typeof found !== "string" || found === "") {
      throw new Error(`image runtime ${field} must be a non-empty string`);
    }
  }
  if (
    typeof profileDigestScheme !== "number" ||
    !Number.isInteger(profileDigestScheme) ||
    profileDigestScheme < FIRST_PROFILE_DIGEST_SCHEME
  ) {
    throw new Error(
      "image runtime profileDigestScheme must be a positive integer",
    );
  }
  return {
    cliVersion: cliVersion as string,
    engine: engine as string,
    profileDigestScheme,
    sdkVersion: sdkVersion as string,
  };
}

/** The versions a profile's `runtime_version` may name to run on this image. */
export function imageRuntimeVersions(runtime: ImageRuntime): string[] {
  return [runtime.sdkVersion, runtime.cliVersion];
}
