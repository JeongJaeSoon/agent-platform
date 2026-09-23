/**
 * Reading a git bundle far enough to answer one question: can this object
 * restore the commit a checkpoint manifest pins?
 *
 * A bundle is a text header followed by a packfile. The header names the refs
 * the pack carries and the commits it assumes the receiver already has, and it
 * is plain ASCII; the pack ends in a sha1 git computed over the rest of it. So
 * both halves can be judged without a git binary, which is what lets the
 * control plane judge them at all.
 *
 * The pack's *contents* are not walked. Reading which objects it holds means
 * inflating every one and resolving its delta chain — `git index-pack`'s job,
 * not a manifest check's — so what is established here is that the pack is
 * whole and that its own header claims the commit, not that the two agree.
 */

import { createHash } from "node:crypto";

export type GitBundleRef = {
  readonly name: string;
  readonly oid: string;
};

export type GitBundleHeader = {
  /** `@`-prefixed v3 capability lines, verbatim and without the `@`. */
  readonly capabilities: readonly string[];
  /** Offset of the packfile, i.e. one past the blank line ending the header. */
  readonly packOffset: number;
  /** Commits the bundle expects the receiver to already have. */
  readonly prerequisites: readonly string[];
  readonly refs: readonly GitBundleRef[];
  readonly version: 2 | 3;
};

export type GitBundleVerdict =
  | {
      /** How many objects the pack header declares. */
      readonly objects: number;
      /** Ref names a fetch may ask for to land the commit. */
      readonly refs: readonly string[];
      readonly status: "offers";
    }
  | { readonly reason: string; readonly status: "unusable" };

/**
 * A malformed bundle must not be able to make the reader walk an arbitrary
 * amount of a multi-gigabyte object looking for a header terminator.
 */
const HEADER_LIMIT_BYTES = 1024 * 1024;

/** `PACK`, a 4-byte version and a 4-byte object count. */
const PACK_HEADER_BYTES = 12;
/** The sha1 git writes over everything before it. */
const PACK_TRAILER_BYTES = 20;

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
  return { capabilities, packOffset: end + 2, prerequisites, refs, version };
}

/**
 * Whether `bytes` is a bundle a restore can fetch `commit` out of on its own.
 *
 * Three things disqualify it. A *prerequisite* means git will refuse the fetch
 * unless the receiver already has that commit, and a restore starts from an
 * empty workspace. The commit has to be a *ref tip*, because a fetch asks for
 * refs and a commit merely somewhere in the packed history is not reachable by
 * name. And the *packfile* has to be intact — a header alone says what the
 * bundle claims to carry, not that it still carries it.
 *
 * What this does not establish is that the intact pack contains the object the
 * header names. Deciding that means reconstructing every packed object through
 * its delta chain, which is `git index-pack`'s job, so a deployment that wants
 * that assurance injects a git-backed `WorkspaceBundleVerifier` instead. What
 * is left uncovered is a worker that rewrites its own bundle's header while
 * keeping a valid pack — a worker lying about its own session's commit, which
 * it could equally do by pinning a different real commit.
 */
export function gitBundleOffers(
  bytes: Uint8Array,
  commit: string,
): GitBundleVerdict {
  const header = readGitBundleHeader(bytes);
  if (header === undefined) {
    return { status: "unusable", reason: "not a git bundle" };
  }
  const tips = headerTips(header, commit);
  if (tips.status === "unusable") return tips;
  const pack = createPackCheck();
  pack.update(bytes.subarray(header.packOffset));
  return pack.finish(tips.refs);
}

/**
 * `gitBundleOffers` over a bundle that arrives in pieces, for one too large
 * to hold. What it keeps is the header — at most `HEADER_LIMIT_BYTES` — and
 * the pack's last 20 bytes; everything else is hashed and let go. It stops
 * reading as soon as the header settles the answer.
 */
export async function gitBundleOffersFrom(
  chunks: AsyncIterable<Uint8Array>,
  commit: string,
): Promise<GitBundleVerdict> {
  let prefix: Uint8Array = new Uint8Array(0);
  let pack: ReturnType<typeof createPackCheck> | undefined;
  let refs: readonly string[] = [];
  for await (const chunk of chunks) {
    if (pack !== undefined) {
      pack.update(chunk);
      continue;
    }
    prefix = concat(prefix, chunk);
    const end = headerEnd(prefix);
    if (end === undefined) {
      if (prefix.byteLength > HEADER_LIMIT_BYTES + 1) break;
      continue;
    }
    // The header parse also looks for the pack's magic, so wait for it.
    if (prefix.byteLength < end + 2 + PACK_HEADER_BYTES) continue;
    const header = readGitBundleHeader(prefix);
    if (header === undefined) break;
    const tips = headerTips(header, commit);
    if (tips.status === "unusable") return tips;
    refs = tips.refs;
    pack = createPackCheck();
    pack.update(prefix.subarray(header.packOffset));
    prefix = new Uint8Array(0);
  }
  if (pack !== undefined) return pack.finish(refs);
  // Ended, or ran past the header limit, before a pack could be told apart:
  // the whole-body reader judges whatever arrived.
  return gitBundleOffers(prefix, commit);
}

/** Everything the header alone settles; the refs whose tip is the commit. */
function headerTips(
  header: GitBundleHeader,
  commit: string,
):
  | { readonly refs: readonly string[]; readonly status: "tips" }
  | Extract<GitBundleVerdict, { status: "unusable" }> {
  const objectFormat = header.capabilities
    .find((capability) => capability.startsWith("object-format="))
    ?.slice("object-format=".length);
  if (objectFormat !== undefined && objectFormat !== "sha1") {
    return {
      status: "unusable",
      reason: `git bundle uses object format ${objectFormat}`,
    };
  }
  // A filtered (partial-clone) bundle carries promises in place of objects
  // and expects a promisor remote to fill them in. A checkpoint restores
  // offline, so those objects would simply be missing at checkout.
  const filter = header.capabilities.find((capability) =>
    capability.startsWith("filter="),
  );
  if (filter !== undefined) {
    return {
      status: "unusable",
      reason: `git bundle is filtered (${filter}) and omits objects a restore needs`,
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
  return { refs, status: "tips" };
}

/**
 * Why the packfile cannot be the one git wrote, fed as it arrives.
 *
 * The trailing digest is the check that matters: git computes it over every
 * preceding pack byte, so a truncated upload, a lifecycle-mangled object or a
 * body swapped underneath a matching length all fail here. The fields before
 * it are cheap and rule out bytes that merely start with the magic.
 *
 * Which bytes are the trailer is only known once the pack ends, so the last
 * 20 seen are held back from the hash until the next chunk pushes them out.
 */
function createPackCheck() {
  const hash = createHash("sha1");
  const head = new Uint8Array(PACK_HEADER_BYTES);
  let tail: Uint8Array = new Uint8Array(0);
  let total = 0;
  return {
    update(chunk: Uint8Array) {
      if (total < PACK_HEADER_BYTES) {
        const wanted = chunk.subarray(0, PACK_HEADER_BYTES - total);
        head.set(wanted, total);
      }
      total += chunk.byteLength;
      // Copies, never views: the chunk may be refilled once the caller asks
      // for the next one.
      if (chunk.byteLength >= PACK_TRAILER_BYTES) {
        hash.update(tail);
        hash.update(chunk.subarray(0, chunk.byteLength - PACK_TRAILER_BYTES));
        tail = chunk.slice(chunk.byteLength - PACK_TRAILER_BYTES);
        return;
      }
      const pending = concat(tail, chunk);
      const release = pending.byteLength - PACK_TRAILER_BYTES;
      if (release > 0) hash.update(pending.subarray(0, release));
      tail = pending.slice(Math.max(0, release));
    },
    finish(refs: readonly string[]): GitBundleVerdict {
      const unusable = (reason: string): GitBundleVerdict => ({
        status: "unusable",
        reason,
      });
      if (total < PACK_HEADER_BYTES + PACK_TRAILER_BYTES) {
        return unusable("git bundle packfile is truncated");
      }
      if (!startsWith(head, "PACK")) {
        return unusable("git bundle has no packfile");
      }
      const view = new DataView(head.buffer);
      const version = view.getUint32(4);
      if (version !== 2 && version !== 3) {
        return unusable(`git bundle packfile is version ${version}`);
      }
      const objects = view.getUint32(8);
      if (objects === 0) {
        return unusable("git bundle packfile carries no objects");
      }
      return hash.digest().equals(Buffer.from(tail))
        ? { objects, refs, status: "offers" }
        : unusable("git bundle packfile does not match its own checksum");
    },
  };
}

/** Always a fresh array, so neither argument is kept by reference. */
function concat(first: Uint8Array, second: Uint8Array): Uint8Array {
  const joined = new Uint8Array(first.byteLength + second.byteLength);
  joined.set(first);
  joined.set(second, first.byteLength);
  return joined;
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
