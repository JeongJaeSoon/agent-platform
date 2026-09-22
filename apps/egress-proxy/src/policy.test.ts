import { describe, expect, test } from "bun:test";
import type { AddressClass } from "./policy.ts";
import {
  classifyAddress,
  decideEgress,
  type EgressPolicy,
  parseDestination,
  parseDestinations,
} from "./policy.ts";

describe("classifyAddress", () => {
  test.each<[string, AddressClass]>([
    ["8.8.8.8", "public"],
    ["10.1.2.3", "private"],
    ["172.16.0.1", "private"],
    ["172.32.0.1", "public"],
    ["192.168.1.1", "private"],
    ["100.64.0.1", "private"],
    ["127.0.0.1", "loopback"],
    ["169.254.169.254", "link_local"],
    ["224.0.0.1", "multicast"],
    ["255.255.255.255", "reserved"],
    ["0.0.0.0", "unspecified"],
    ["198.18.0.1", "reserved"],
    ["2606:4700::1111", "public"],
    ["::1", "loopback"],
    ["::", "unspecified"],
    ["fe80::1", "link_local"],
    ["fd00::1", "private"],
    ["ff02::1", "multicast"],
    ["2001:db8::1", "reserved"],
    ["::ffff:169.254.169.254", "link_local"],
    ["::ffff:10.0.0.1", "private"],
    ["fec0::1", "private"],
    ["fecf::1", "private"],
    ["64:ff9b::a00:1", "private"],
    ["64:ff9b::808:808", "public"],
    // The translation prefixes a name could answer with instead.
    ["::ffff:0:10.0.0.1", "private"],
    ["::ffff:0:169.254.169.254", "link_local"],
    ["64:ff9b:1:a00:0:100::", "reserved"],
    ["2002:a00:1::1", "private"],
    ["2002:0808:0808::1", "public"],
  ])("%s is %s", (address, expected) => {
    expect(classifyAddress(address)).toBe(expected);
  });

  test("a leading-zero octet is not read as decimal", () => {
    // Some resolvers read 0177.0.0.1 as octal loopback; we refuse to guess.
    expect(classifyAddress("0177.0.0.1")).toBeNull();
    expect(classifyAddress("010.0.0.1")).toBeNull();
  });

  test("text that is not an address at all is null", () => {
    expect(classifyAddress("example.com")).toBeNull();
    expect(classifyAddress("1.2.3")).toBeNull();
    expect(classifyAddress("1.2.3.4.5")).toBeNull();
    expect(classifyAddress("256.1.1.1")).toBeNull();
    expect(classifyAddress("1::2::3")).toBeNull();
    expect(classifyAddress("1:2:3:4:5:6:7")).toBeNull();
  });
});

describe("parseDestination", () => {
  test("host:port and bracketed IPv6", () => {
    expect(parseDestination("api.example.com:443", "list")).toEqual({
      host: "api.example.com",
      port: 443,
    });
    expect(parseDestination("[::1]:3000", "list")).toEqual({
      host: "::1",
      port: 3000,
    });
    expect(parseDestination(" Gateway.Test.:3000 ", "list")).toEqual({
      host: "gateway.test",
      port: 3000,
    });
  });

  test("an entry without a usable port is rejected", () => {
    expect(() => parseDestination("api.example.com", "list")).toThrow("list");
    expect(() => parseDestination("api.example.com:0", "list")).toThrow("list");
    expect(() => parseDestination("api.example.com:https", "list")).toThrow(
      "list",
    );
    expect(() => parseDestination(":443", "list")).toThrow("list");
  });

  test("a list splits on commas and ignores blanks", () => {
    expect(parseDestinations("a.test:80, b.test:443 ,", "list")).toEqual([
      { host: "a.test", port: 80 },
      { host: "b.test", port: 443 },
    ]);
    expect(parseDestinations("", "list")).toEqual([]);
  });
});

describe("decideEgress", () => {
  const policy: EgressPolicy = {
    allow: [{ host: "api.example.com", port: 443 }],
    allowPrivate: [
      { host: "host.docker.internal", port: 3000 },
      { host: "metadata.test", port: 80 },
    ],
  };
  const resolver = (map: Record<string, string[]>) => async (host: string) => {
    const addresses = map[host];
    if (addresses === undefined) throw new Error(`no such host ${host}`);
    return addresses;
  };

  test("a public destination that resolves publicly is allowed", async () => {
    expect(
      await decideEgress(
        policy,
        { host: "api.example.com", port: 443 },
        resolver({ "api.example.com": ["93.184.216.34"] }),
      ),
    ).toEqual({ addresses: ["93.184.216.34"], allowed: true, scope: "public" });
  });

  test("the same host on another port is not allowlisted", async () => {
    expect(
      await decideEgress(
        policy,
        { host: "api.example.com", port: 8443 },
        resolver({ "api.example.com": ["93.184.216.34"] }),
      ),
    ).toEqual({ allowed: false, reason: "destination is not allowlisted" });
  });

  test("a host outside both lists is denied before it is resolved", async () => {
    let resolved = false;
    expect(
      await decideEgress(policy, { host: "evil.test", port: 443 }, async () => {
        resolved = true;
        return ["93.184.216.34"];
      }),
    ).toEqual({ allowed: false, reason: "destination is not allowlisted" });
    expect(resolved).toBe(false);
  });

  test("a public entry that resolves into the private plane is denied", async () => {
    expect(
      await decideEgress(
        policy,
        { host: "api.example.com", port: 443 },
        resolver({ "api.example.com": ["10.0.0.5"] }),
      ),
    ).toEqual({ allowed: false, reason: "10.0.0.5 is private, not public" });
  });

  test("one bad address among good ones denies the whole destination", async () => {
    expect(
      await decideEgress(
        policy,
        { host: "api.example.com", port: 443 },
        resolver({ "api.example.com": ["93.184.216.34", "127.0.0.1"] }),
      ),
    ).toEqual({ allowed: false, reason: "127.0.0.1 is loopback, not public" });
  });

  test("a private entry may resolve to a private address", async () => {
    expect(
      await decideEgress(
        policy,
        { host: "host.docker.internal", port: 3000 },
        resolver({ "host.docker.internal": ["192.168.65.254"] }),
      ),
    ).toEqual({
      addresses: ["192.168.65.254"],
      allowed: true,
      scope: "private",
    });
  });

  test("link-local is refused even from the private list", async () => {
    expect(
      await decideEgress(
        policy,
        { host: "metadata.test", port: 80 },
        resolver({ "metadata.test": ["169.254.169.254"] }),
      ),
    ).toEqual({ allowed: false, reason: "169.254.169.254 is link_local" });
  });

  test("a host that does not resolve is denied, not allowed by default", async () => {
    expect(
      await decideEgress(
        policy,
        { host: "api.example.com", port: 443 },
        resolver({}),
      ),
    ).toMatchObject({ allowed: false });
    expect(
      await decideEgress(
        policy,
        { host: "api.example.com", port: 443 },
        async () => [],
      ),
    ).toEqual({ allowed: false, reason: "host does not resolve" });
  });

  test("the trailing dot spelling of an allowlisted host still matches", async () => {
    expect(
      await decideEgress(
        policy,
        { host: "API.example.com.", port: 443 },
        resolver({ "api.example.com": ["93.184.216.34"] }),
      ),
    ).toMatchObject({ allowed: true });
  });
});
