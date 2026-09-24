import type { LookupAddress, LookupOptions } from "node:dns";

// Bun's node:dns lookup, which net.connect uses for a hostname, answers from
// c-ares, and c-ares keeps a record for the TTL the server gave it. Docker's
// embedded DNS gives 600s, so in a long-lived process a name stays at the
// address it had before its container restarted — refused, or someone
// else's — for up to ten minutes (94S-343). The libc resolver keeps no cache
// of its own and asks on every call; a connection is rare enough that the
// extra query does not matter.
export async function resolveEveryTime(
  hostname: string,
  family: 0 | 4 | 6 = 0,
): Promise<LookupAddress[]> {
  try {
    const addresses = await Bun.dns.lookup(hostname, {
      family,
      backend: "libc",
    });
    return addresses.map(({ address, family }) => ({ address, family }));
  } catch (error) {
    // Bun prefixes its codes (DNS_ENOTFOUND); node's, which callers match
    // as connection failures, have none.
    const failure = error as NodeJS.ErrnoException;
    if (failure.code?.startsWith("DNS_")) failure.code = failure.code.slice(4);
    throw failure;
  }
}

type LookupCallback = (
  error: NodeJS.ErrnoException | null,
  address: string | LookupAddress[],
  family?: number,
) => void;

// resolveEveryTime in the shape of net.connect's `lookup` option.
export function lookupEveryTime(
  hostname: string,
  options: LookupOptions,
  callback: LookupCallback,
): void {
  const family =
    options.family === 4 || options.family === 6 ? options.family : 0;
  resolveEveryTime(hostname, family).then(
    (addresses) => {
      if (options.all) {
        callback(null, addresses);
        return;
      }
      const [first] = addresses;
      callback(null, first?.address ?? "", first?.family);
    },
    (error: NodeJS.ErrnoException) => callback(error, ""),
  );
}
