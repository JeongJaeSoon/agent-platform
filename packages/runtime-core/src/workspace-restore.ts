/**
 * Writing a checkpoint's untracked files back without leaving the workspace,
 * and reading them for a capture the same way.
 *
 * A manifest names each untracked file by a workspace-relative path, and
 * finalize checks that path as text. Text is not enough: the bundle checkout
 * that runs first may bring a tracked symlink, and `out/file` is inside the
 * workspace as a string and outside it on disk once `out -> /etc`. So the
 * writer here never hands the kernel more than one name at a time. It opens
 * the root, then each directory relative to the descriptor of its parent, and
 * the file relative to the last one, following no symlink on the way.
 *
 * Node has no `openat`, so a parent descriptor is addressed through procfs as
 * `/proc/self/fd/<fd>/<name>`: the kernel resolves the proc entry to the open
 * directory itself and then looks up exactly one name inside it. Without
 * procfs there is no sound equivalent — a path walk that checks each ancestor
 * first can still be raced into writing somewhere else — so the writer refuses
 * rather than approximates. Workers run on Linux; native `openat` bindings are
 * the upgrade if restore ever has to run elsewhere.
 *
 * What a descriptor walk does not give is permanence: a directory renamed out
 * of the root while its descriptor is held stays writable. The restorer must
 * be the only thing touching the workspace until the engine starts.
 */

import { constants } from "node:fs";
import { type FileHandle, mkdir, open, stat } from "node:fs/promises";
import type { RestorePlanResponse } from "@agent-platform/contracts";

/**
 * The restore plan's own refusal. A restore that cannot be carried out safely
 * fails the claim exactly as a plan the control plane could not produce does,
 * so the worker has one outcome to handle, not two.
 */
export type RestoreRefusal = Extract<
  RestorePlanResponse,
  { status: "unavailable" }
>;

export function restoreRefusal(reason: string): RestoreRefusal {
  return { status: "unavailable", code: "CHECKPOINT_UNAVAILABLE", reason };
}

const NAME_MAX_BYTES = 255;
const utf8 = new TextEncoder();
// In `u` mode a well-formed pair is one code point, so only a lone half matches.
const LONE_SURROGATE = /\p{Cs}/u;

/**
 * Why `path` cannot name a file under a workspace root, or undefined when it
 * can. Shared by finalize, which refuses such a manifest, and the writer,
 * which does not trust that finalize ran.
 *
 * `.` is refused along with `..` so that one file has one spelling and the
 * duplicate check means something. `.git` is refused because no capture of
 * untracked files ever produces it, and a restored `.git/hooks/*` is code the
 * engine's next `git commit` runs.
 */
export function workspacePathProblem(path: string): string | undefined {
  if (path.length === 0) return "is empty";
  if (path.startsWith("/")) return "is absolute";
  if (path.includes("\\")) return "contains a backslash";
  if (path.includes("\0")) return "contains a NUL byte";
  // A lone surrogate reaches the filesystem as U+FFFD, so two paths that
  // differ here as strings would name one file there.
  if (LONE_SURROGATE.test(path)) return "is not well-formed Unicode";
  for (const segment of path.split("/")) {
    if (segment === "") return "has an empty segment";
    if (segment === "." || segment === "..") {
      return `has a "${segment}" segment`;
    }
    // Case-insensitive filesystems treat `.GIT` as the same directory.
    if (segment.toLowerCase() === ".git") return "writes into .git";
    // NAME_MAX on every filesystem a workspace lives on. A longer name passes
    // as text and then cannot be created, so a committed checkpoint could
    // never be restored.
    if (utf8.encode(segment).byteLength > NAME_MAX_BYTES) {
      return `has a segment longer than ${NAME_MAX_BYTES} bytes`;
    }
  }
  return undefined;
}

/**
 * Why this set of destinations cannot all be restored into one workspace, or
 * undefined when it can: each path must be safe on its own, no two may name
 * the same file, and no file may also be the directory another one sits in.
 */
export function workspacePathsProblem(
  paths: readonly string[],
): string | undefined {
  const files = new Set<string>();
  for (const path of paths) {
    const problem = workspacePathProblem(path);
    if (problem !== undefined) return `${JSON.stringify(path)} ${problem}`;
    if (files.has(path)) return `two files restore to ${path}`;
    files.add(path);
  }
  // The paths are the worker's, so checking each one's every prefix would let
  // one deep path cost the control plane quadratic time. Sorted with "/" as
  // NUL (refused above, so unambiguous), everything under a directory sorts
  // straight after that directory's own name, and neighbours are enough.
  const keys = [...files].map((path) => path.replaceAll("/", "\0")).sort();
  for (let index = 1; index < keys.length; index += 1) {
    const file = keys[index - 1] as string;
    const next = keys[index] as string;
    if (next.startsWith(`${file}\0`)) {
      return `${file.replaceAll("\0", "/")} is restored both as a file and as the directory of ${next.replaceAll("\0", "/")}`;
    }
  }
  return undefined;
}

/**
 * The manifest's `cwd` is what the capturing worker said; the workspace root
 * is what the execution backend provisioned for this one. Restore uses the
 * root and only checks the claim against it — a checkpoint taken somewhere
 * else describes a different workspace, and resolving the two into agreement
 * would mean trusting the claim.
 */
export function restoreCwdRefusal(
  cwd: string,
  workspaceRoot: string,
): RestoreRefusal | undefined {
  assertWorkspaceRoot(workspaceRoot);
  return cwd === workspaceRoot
    ? undefined
    : restoreRefusal(
        `checkpoint cwd ${cwd} is not this workspace root ${workspaceRoot}`,
      );
}

const { O_CREAT, O_DIRECTORY, O_EXCL, O_NOFOLLOW, O_RDONLY, O_WRONLY } =
  constants;
const DIRECTORY = O_RDONLY | O_DIRECTORY | O_NOFOLLOW;
// Exclusive: after the checkout nothing should sit at an untracked path, so
// anything that does — a tracked file, a symlink, a hard link — means the tree
// is not the one the manifest describes. Never truncated into.
const NEW_FILE = O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW;
// The manifest carries no mode, and the engine runs as the restoring user.
// Executable bits are lost until it does.
const FILE_MODE = 0o600;
const DIRECTORY_MODE = 0o700;

// A leaf or ancestor that is a symlink, a file where a directory should be,
// or something already at the destination: confinement refusals, not faults.
// ENAMETOOLONG is here too: the name comes from the checkpoint, and the
// lexical limit below should have caught it first.
const CONFINEMENT_ERRORS = new Set([
  "EEXIST",
  "ELOOP",
  "ENAMETOOLONG",
  "ENOTDIR",
  "EISDIR",
]);

/**
 * Writes `bytes` to `path` under `workspaceRoot`, creating missing parent
 * directories, without following a symlink anywhere below the root. Returns
 * a refusal for anything that would leave the workspace or overwrite what is
 * there; throws for faults that are not about confinement (ENOSPC, EIO), so a
 * full disk is never reported as a bad checkpoint.
 *
 * `fdDirectory` exists for tests that need procfs to be missing.
 */
export async function writeWorkspaceFile(input: {
  bytes: Uint8Array;
  path: string;
  workspaceRoot: string;
  fdDirectory?: string;
}): Promise<RestoreRefusal | undefined> {
  const { bytes, path, workspaceRoot } = input;
  const fdDirectory = input.fdDirectory ?? "/proc/self/fd";
  assertWorkspaceRoot(workspaceRoot);
  const problem = workspacePathProblem(path);
  if (problem !== undefined) {
    return restoreRefusal(`untracked file ${JSON.stringify(path)} ${problem}`);
  }
  // Only the directory the next name is looked up in is held. Holding every
  // ancestor would add nothing (renames are excluded by the restore contract,
  // see the top of this file) and would let one deep path exhaust the
  // worker's descriptor table.
  let parent: FileHandle | undefined;
  try {
    const root = await openDirectory(workspaceRoot);
    if (root === "missing" || root === "refused") {
      return restoreRefusal(
        `workspace root ${workspaceRoot} is not a directory`,
      );
    }
    parent = root;
    if (!(await addressable(root, fdDirectory))) {
      return restoreRefusal(
        `restoring untracked files needs ${fdDirectory} to address directories by descriptor, and it is not available here`,
      );
    }
    const names = path.split("/");
    const leaf = names.pop() as string;
    let walked = "";
    for (const name of names) {
      walked = walked === "" ? name : `${walked}/${name}`;
      const at = `${fdDirectory}/${parent.fd}/${name}`;
      let child = await openDirectory(at);
      if (child === "missing") {
        await mkdir(at, { mode: DIRECTORY_MODE }).catch((error: unknown) => {
          // Lost a race to something that made it first; reopening decides.
          if (errorCode(error) !== "EEXIST") throw error;
        });
        child = await openDirectory(at);
      }
      if (child === "missing" || child === "refused") {
        return restoreRefusal(
          `cannot restore ${path}: ${walked} is not a directory inside the workspace (a symlink or a file)`,
        );
      }
      await closeDirectory(parent);
      parent = child;
    }
    let file: FileHandle;
    try {
      file = await open(
        `${fdDirectory}/${parent.fd}/${leaf}`,
        NEW_FILE,
        FILE_MODE,
      );
    } catch (error) {
      if (!CONFINEMENT_ERRORS.has(errorCode(error) ?? "")) throw error;
      return restoreRefusal(
        `cannot restore ${path}: something is already there (${errorCode(error)})`,
      );
    }
    try {
      await file.writeFile(bytes);
    } catch (error) {
      await file.close().catch(() => undefined);
      throw error;
    }
    // Not swallowed: a close that fails can be the write failing late.
    await file.close();
    return undefined;
  } finally {
    if (parent !== undefined) await closeDirectory(parent);
  }
}

export type WorkspaceFileRead =
  | { bytes: Uint8Array; status: "read" }
  | { reason: string; status: "refused" };

// Non-blocking so a FIFO planted at the path opens at once and is refused by
// the fstat below, rather than hanging the capture until a writer shows up.
const EXISTING_FILE = O_RDONLY | O_NOFOLLOW | constants.O_NONBLOCK;

/**
 * Reads the regular file at `path` under `workspaceRoot` with the same
 * descriptor walk the writer uses, so capturing an untracked file never
 * follows a symlink. That matters more on this side: the capture runs in the
 * worker process, and an untracked `x -> /proc/self/environ` read by path
 * would upload the worker's own environment — its object store and model
 * credentials — into a checkpoint that the next restore writes into the
 * engine's workspace.
 *
 * Anything that is not a regular file, or is larger than `maxBytes`, is
 * refused. Faults that are not about the file itself (EIO) throw.
 */
export async function readWorkspaceFile(input: {
  maxBytes: number;
  path: string;
  workspaceRoot: string;
  fdDirectory?: string;
}): Promise<WorkspaceFileRead> {
  const { maxBytes, path, workspaceRoot } = input;
  const fdDirectory = input.fdDirectory ?? "/proc/self/fd";
  assertWorkspaceRoot(workspaceRoot);
  const refused = (reason: string): WorkspaceFileRead => ({
    status: "refused",
    reason: `untracked file ${JSON.stringify(path)} ${reason}`,
  });
  const problem = workspacePathProblem(path);
  if (problem !== undefined) return refused(problem);
  let parent: FileHandle | undefined;
  try {
    const root = await openDirectory(workspaceRoot);
    if (root === "missing" || root === "refused") {
      return refused(`has no workspace root: ${workspaceRoot}`);
    }
    parent = root;
    if (!(await addressable(root, fdDirectory))) {
      return refused(
        `cannot be read safely: ${fdDirectory} does not address directories by descriptor here`,
      );
    }
    const names = path.split("/");
    const leaf = names.pop() as string;
    for (const name of names) {
      const child = await openDirectory(`${fdDirectory}/${parent.fd}/${name}`);
      if (child === "missing" || child === "refused") {
        return refused("is not under directories inside the workspace");
      }
      await closeDirectory(parent);
      parent = child;
    }
    let file: FileHandle;
    try {
      file = await open(`${fdDirectory}/${parent.fd}/${leaf}`, EXISTING_FILE);
    } catch (error) {
      const code = errorCode(error);
      if (code === "ENOENT") return refused("is gone");
      if (!CONFINEMENT_ERRORS.has(code ?? "")) throw error;
      return refused(`is not a regular file (${code})`);
    }
    try {
      const info = await file.stat();
      if (!info.isFile()) return refused("is not a regular file");
      if (info.size > maxBytes) {
        return refused(`is ${info.size} bytes, over the ${maxBytes} left`);
      }
      // One byte past what fstat said, so a file that grew between the two is
      // noticed instead of silently cut at its old length.
      const buffer = new Uint8Array(info.size + 1);
      let filled = 0;
      while (filled < buffer.byteLength) {
        const { bytesRead } = await file.read(
          buffer,
          filled,
          buffer.byteLength - filled,
        );
        if (bytesRead === 0) break;
        filled += bytesRead;
      }
      if (filled !== info.size) return refused("changed while it was read");
      return { status: "read", bytes: buffer.subarray(0, filled) };
    } finally {
      await file.close().catch(() => undefined);
    }
  } finally {
    if (parent !== undefined) await closeDirectory(parent);
  }
}

// A read-only directory descriptor has nothing to flush, so a failed close
// loses nothing and must not replace the answer the caller is owed.
async function closeDirectory(handle: FileHandle): Promise<void> {
  await handle.close().catch(() => undefined);
}

async function openDirectory(
  at: string,
): Promise<FileHandle | "missing" | "refused"> {
  try {
    return await open(at, DIRECTORY);
  } catch (error) {
    const code = errorCode(error);
    if (code === "ENOENT") return "missing";
    if (CONFINEMENT_ERRORS.has(code ?? "")) return "refused";
    throw error;
  }
}

/**
 * Whether `<fdDirectory>/<fd>` really is the open directory, rather than
 * assuming procfs is mounted because the platform is Linux.
 */
async function addressable(
  handle: FileHandle,
  fdDirectory: string,
): Promise<boolean> {
  const [direct, viaDirectory] = await Promise.all([
    handle.stat(),
    stat(`${fdDirectory}/${handle.fd}`).catch((error: unknown) => {
      if (["ENOENT", "ENOTDIR", "EACCES"].includes(errorCode(error) ?? "")) {
        return undefined;
      }
      throw error;
    }),
  ]);
  return (
    viaDirectory !== undefined &&
    viaDirectory.dev === direct.dev &&
    viaDirectory.ino === direct.ino
  );
}

/**
 * The root comes from launch configuration, so a malformed one is a
 * deployment fault to throw on, not a checkpoint to refuse. It must be
 * spelled canonically, or comparing it with a manifest's `cwd` is meaningless.
 */
function assertWorkspaceRoot(root: string): void {
  const canonical =
    root.startsWith("/") &&
    !root
      .slice(1)
      .split("/")
      .some((segment) => segment === "" || segment === "." || segment === "..");
  if (!canonical) {
    throw new Error(
      `Workspace root must be a canonical absolute path: ${JSON.stringify(root)}`,
    );
  }
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code: unknown }).code)
    : undefined;
}
