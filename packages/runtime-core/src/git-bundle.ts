/**
 * Reading a git bundle far enough to answer one question: can this object
 * restore the commit a checkpoint manifest pins?
 *
 * A bundle is a text header followed by a packfile. The header names the refs
 * the pack carries and the commits it assumes the receiver already has, and
 * both are plain ASCII, so the check needs no git binary — which is what lets
 * the control plane make it. The packfile itself is not walked: the manifest
 * already pins the object's sha256, so the bytes are exactly the ones git
 * wrote, and re-deriving what git already encoded in its own header would buy
 * nothing.
 */

export type GitBundleRef = {
  readonly name: string;
  readonly oid: string;
};

export type GitBundleHeader = {
  /** `@`-prefixed v3 capability lines, verbatim and without the `@`. */
  readonly capabilities: readonly string[];
  /** Commits the bundle expects the receiver to already have. */
  readonly prerequisites: readonly string[];
  readonly refs: readonly GitBundleRef[];
  readonly version: 2 | 3;
};

export type GitBundleVerdict =
  /** Ref names a fetch may ask for to land the commit. */
  | { readonly refs: readonly string[]; readonly status: "offers" }
  | { readonly reason: string; readonly status: "unusable" };

/**
 * A malformed bundle must not be able to make the reader walk an arbitrary
 * amount of a multi-gigabyte object looking for a header terminator.
 */
const HEADER_LIMIT_BYTES = 1024 * 1024;

const SIGNATURES: ReadonlyMap<string, 2 | 3> = new Map([
  ["# v2 git bundle", 2],
  ["# v3 git bundle", 3],
]);

export function readGitBundleHeader(
  bytes: Uint8Array,
): GitBundleHeader | undefined {
  const end = headerEnd(bytes);
  if (end === undefined) return undefined;
  // The pack has to actually be there. Without this a manifest could pin a
  // header-shaped text file and the failure would surface only at restore.
  if (!startsWith(bytes.subarray(end + 2), "PACK")) return undefined;

  const lines = new TextDecoder("utf8", { fatal: false })
    .decode(bytes.subarray(0, end))
    .split("\n");
  const signature = lines[0];
  const version =
    signature === undefined ? undefined : SIGNATURES.get(signature);
  if (version === undefined) return undefined;

  const capabilities: string[] = [];
  const prerequisites: string[] = [];
  const refs: GitBundleRef[] = [];
  for (const line of lines.slice(1)) {
    if (line.length === 0) return undefined;
    if (line.startsWith("@")) {
      // Capabilities are a v3 addition, and git writes them before any ref.
      if (version !== 3 || refs.length > 0 || prerequisites.length > 0) {
        return undefined;
      }
      capabilities.push(line.slice(1));
      continue;
    }
    if (line.startsWith("-")) {
      prerequisites.push(line.slice(1).split(" ")[0] ?? "");
      continue;
    }
    const space = line.indexOf(" ");
    if (space <= 0 || space === line.length - 1) return undefined;
    refs.push({ name: line.slice(space + 1), oid: line.slice(0, space) });
  }
  return { capabilities, prerequisites, refs, version };
}

/**
 * Whether `bytes` is a bundle a restore can fetch `commit` out of on its own.
 *
 * Two things disqualify a bundle that parses. A *prerequisite* means git will
 * refuse the fetch unless the receiver already has that commit, and a restore
 * starts from an empty workspace, so a checkpoint pinning such a bundle is not
 * restorable — the pointer must not advance to it. And the commit has to be a
 * ref tip: a fetch asks for refs, so a commit that is merely somewhere in the
 * packed history is not reachable by name.
 */
export function gitBundleOffers(
  bytes: Uint8Array,
  commit: string,
): GitBundleVerdict {
  const header = readGitBundleHeader(bytes);
  if (header === undefined) {
    return { status: "unusable", reason: "not a git bundle" };
  }
  const objectFormat = header.capabilities
    .find((capability) => capability.startsWith("object-format="))
    ?.slice("object-format=".length);
  if (objectFormat !== undefined && objectFormat !== "sha1") {
    return {
      status: "unusable",
      reason: `git bundle uses object format ${objectFormat}`,
    };
  }
  if (header.prerequisites.length > 0) {
    return {
      status: "unusable",
      reason: `git bundle needs ${header.prerequisites.length} prerequisite commit(s) a fresh workspace does not have`,
    };
  }
  const wanted = commit.toLowerCase();
  const refs = header.refs
    .filter((ref) => ref.oid.toLowerCase() === wanted)
    .map((ref) => ref.name);
  if (refs.length === 0) {
    return {
      status: "unusable",
      reason: `git bundle does not offer ${commit} as a ref tip`,
    };
  }
  return { status: "offers", refs };
}

/** Index of the `\n\n` that ends the header, or undefined within the limit. */
function headerEnd(bytes: Uint8Array): number | undefined {
  const limit = Math.min(bytes.byteLength - 1, HEADER_LIMIT_BYTES);
  for (let index = 0; index < limit; index += 1) {
    if (bytes[index] === 0x0a && bytes[index + 1] === 0x0a) return index;
  }
  return undefined;
}

function startsWith(bytes: Uint8Array, ascii: string): boolean {
  if (bytes.byteLength < ascii.length) return false;
  for (let index = 0; index < ascii.length; index += 1) {
    if (bytes[index] !== ascii.charCodeAt(index)) return false;
  }
  return true;
}
