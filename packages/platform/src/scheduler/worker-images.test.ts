import { describe, expect, test } from "bun:test";
import {
  runtimeVersionsOf,
  workerImageRuntimesFromEnv,
} from "./worker-images.ts";

const current = {
  cliVersion: "2.1.280",
  engine: "claude",
  profileDigestScheme: 1,
  sdkVersion: "0.3.280",
};
const previous = { ...current, cliVersion: "2.1.270", sdkVersion: "0.3.270" };

describe("workerImageRuntimesFromEnv", () => {
  test("nothing configured is no images", () => {
    expect(workerImageRuntimesFromEnv({})).toBeNull();
    expect(workerImageRuntimesFromEnv({ WORKER_IMAGE_RUNTIME: "" })).toBeNull();
  });

  test("reads the current image and, when given, the previous one", () => {
    expect(
      workerImageRuntimesFromEnv({
        WORKER_IMAGE_RUNTIME: JSON.stringify(current),
      }),
    ).toEqual({ current, previous: null });
    expect(
      workerImageRuntimesFromEnv({
        WORKER_IMAGE_RUNTIME: JSON.stringify(current),
        WORKER_IMAGE_PREVIOUS_RUNTIME: JSON.stringify({
          ...previous,
          profiles: {},
        }),
      }),
    ).toEqual({ current, previous });
  });

  test("refuses a previous image alone and names a setting it cannot read", () => {
    expect(() =>
      workerImageRuntimesFromEnv({
        WORKER_IMAGE_PREVIOUS_RUNTIME: JSON.stringify(previous),
      }),
    ).toThrow("needs WORKER_IMAGE_RUNTIME");
    expect(() =>
      workerImageRuntimesFromEnv({ WORKER_IMAGE_RUNTIME: "0.3.280" }),
    ).toThrow("WORKER_IMAGE_RUNTIME: image runtime");
    expect(() =>
      workerImageRuntimesFromEnv({
        WORKER_IMAGE_RUNTIME: JSON.stringify(current),
        WORKER_IMAGE_PREVIOUS_RUNTIME: "{}",
      }),
    ).toThrow("WORKER_IMAGE_PREVIOUS_RUNTIME: image runtime");
  });
});

test("new sessions take the current image's versions; pins take either image's", () => {
  expect(runtimeVersionsOf({ current, previous })).toEqual({
    current: ["0.3.280", "2.1.280"],
    accepted: ["0.3.280", "2.1.280", "0.3.270", "2.1.270"],
  });
  expect(runtimeVersionsOf({ current, previous: null })).toEqual({
    current: ["0.3.280", "2.1.280"],
    accepted: ["0.3.280", "2.1.280"],
  });
});
