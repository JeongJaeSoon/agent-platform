import { describe, expect, test } from "bun:test";
import {
  runtimeVersionsOf,
  selectWorkerImage,
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

describe("selectWorkerImage", () => {
  const images = [
    { image: "worker@sha256:new", runtime: current },
    { image: "worker@sha256:old", runtime: previous },
  ] as const;

  test("a session with no checkpoint, or one whose pointer predates the record, runs on the current image", () => {
    for (const pointer of [
      { kind: "none" },
      { kind: "unrecorded" },
    ] as const) {
      expect(selectWorkerImage(pointer, images)).toEqual({
        kind: "selected",
        image: "worker@sha256:new",
        runtime: current,
      });
    }
  });

  test("a checkpoint sealed on the previous image resumes on it", () => {
    expect(
      selectWorkerImage({ kind: "recorded", runtime: previous }, images),
    ).toEqual({
      kind: "selected",
      image: "worker@sha256:old",
      runtime: previous,
    });
  });

  test("of two images with the same combination, the newest wins", () => {
    expect(
      selectWorkerImage({ kind: "recorded", runtime: current }, [
        { image: "worker@sha256:rebuilt", runtime: current },
        { image: "worker@sha256:new", runtime: { ...current } },
      ]),
    ).toMatchObject({ kind: "selected", image: "worker@sha256:rebuilt" });
  });

  test("a different digest scheme is not the same combination", () => {
    const outcome = selectWorkerImage(
      { kind: "recorded", runtime: { ...current, profileDigestScheme: 2 } },
      images,
    );
    expect(outcome).toMatchObject({
      kind: "none",
      reason: "incompatible_checkpoint",
    });
    expect(outcome.kind === "none" && outcome.detail).toContain(
      "digest scheme 2",
    );
  });

  test("no image matching engine, sdk and cli stops the launch", () => {
    for (const changed of [
      { engine: "other" },
      { sdkVersion: "0.3.260" },
      { cliVersion: "2.1.260" },
    ]) {
      expect(
        selectWorkerImage(
          { kind: "recorded", runtime: { ...previous, ...changed } },
          images,
        ).kind,
      ).toBe("none");
    }
  });
});
