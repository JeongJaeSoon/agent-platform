import { afterEach, describe, expect, spyOn, test } from "bun:test";
import type { LookupAddress } from "node:dns";
import { lookupEveryTime, resolveEveryTime } from "./fresh-lookup.ts";

const spies: Array<{ mockRestore(): void }> = [];
afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore();
});

function answering(
  answer: () => ReturnType<typeof Bun.dns.lookup>,
): ReturnType<typeof spyOn<typeof Bun.dns, "lookup">> {
  const lookup = spyOn(Bun.dns, "lookup").mockImplementation(
    () => answer() as never,
  );
  spies.push(lookup);
  return lookup;
}

describe("resolveEveryTime", () => {
  test("asks libc on every call, whatever TTL the last answer carried", async () => {
    const lookup = answering(async () => [
      { address: "10.0.0.7", family: 4, ttl: 600 },
    ]);

    expect(await resolveEveryTime("localstack")).toEqual([
      { address: "10.0.0.7", family: 4 },
    ]);
    await resolveEveryTime("localstack", 6);

    expect(lookup.mock.calls).toEqual([
      ["localstack", { family: 0, backend: "libc" }],
      ["localstack", { family: 6, backend: "libc" }],
    ]);
  });

  test("a failure carries node's code, not Bun's", async () => {
    answering(async () => {
      throw Object.assign(new Error("getaddrinfo ENOTFOUND"), {
        code: "DNS_ENOTFOUND",
      });
    });

    await expect(resolveEveryTime("gone")).rejects.toMatchObject({
      code: "ENOTFOUND",
    });
  });
});

describe("lookupEveryTime", () => {
  test("answers in the shape net.connect asked for", async () => {
    answering(async () => [
      { address: "10.0.0.7", family: 4, ttl: 600 },
      { address: "fd00::7", family: 6, ttl: 600 },
    ]);
    const lookup = (all: boolean) =>
      new Promise<unknown[]>((resolve, reject) =>
        lookupEveryTime("api", { all }, (error, address, family) =>
          error ? reject(error) : resolve([address, family]),
        ),
      );

    expect(await lookup(false)).toEqual(["10.0.0.7", 4]);
    const [all] = (await lookup(true)) as [LookupAddress[]];
    expect(all).toEqual([
      { address: "10.0.0.7", family: 4 },
      { address: "fd00::7", family: 6 },
    ]);
  });
});
