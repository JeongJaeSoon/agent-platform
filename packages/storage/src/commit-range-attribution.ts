// The control host's push reaches the range check through this package, as it
// does the rest of its git (git-runner.ts); the check itself is runtime-core's,
// shared with the worker's checkpoint manifest.
export {
  type RangeAttribution,
  type RangeGit,
  rangeAttribution,
} from "@werft-ai/runtime-core";
