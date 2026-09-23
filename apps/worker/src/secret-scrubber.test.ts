import { describe, expect, test } from "bun:test";
import { SCRUBBED, SecretScrubber } from "./secret-scrubber.ts";

describe("SecretScrubber", () => {
  test("replaces each known value wherever it sits, keys included", () => {
    const scrubber = new SecretScrubber([
      "token-abcdefgh",
      "token-abcdefgh-longer",
      null,
      undefined,
    ]);
    expect(
      scrubber.scrub<Record<string, unknown>>({
        text: "a token-abcdefgh-longer and token-abcdefgh",
        list: ["x token-abcdefgh y", 3, null, true],
        "token-abcdefgh": { nested: "token-abcdefgh" },
      }),
    ).toEqual({
      text: `a ${SCRUBBED} and ${SCRUBBED}`,
      list: [`x ${SCRUBBED} y`, 3, null, true],
      [SCRUBBED]: { nested: SCRUBBED },
    });
  });

  test("a short value goes wherever it stands alone, as in an environment dump (Codex R1)", () => {
    // The local object store's key is `test`: dropped for being short, the
    // bucket-wide value would reach the event stream through /proc/1/environ.
    const scrubber = new SecretScrubber(["test", "a.b"]);
    expect(
      scrubber.scrub([
        "AWS_SECRET_ACCESS_KEY=test\0HOME=/home/worker",
        "key: test",
        "testing the tests, a.b and axb",
      ]),
    ).toEqual([
      `AWS_SECRET_ACCESS_KEY=${SCRUBBED}\0HOME=/home/worker`,
      `key: ${SCRUBBED}`,
      `testing the tests, ${SCRUBBED} and axb`,
    ]);
  });

  test("with nothing to hide it changes nothing", () => {
    const value = { a: ["b", { c: "d" }] };
    expect(new SecretScrubber([]).scrub(value)).toEqual(value);
  });
});
