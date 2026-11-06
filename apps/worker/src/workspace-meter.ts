import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  readFileSync,
  type Stats,
  statfsSync,
} from "node:fs";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import {
  type FilesystemUsage,
  type MountInfo,
  workspaceMount,
} from "./workspace-limit-mode.ts";

export type WorkspaceMeasurement = {
  bytes: number;
  inodes: number;
  complete: boolean;
  errors: number;
  durationMs: number;
  filesystem?: FilesystemUsage;
  mount?: MountInfo;
};

export function scanWorkspace(
  root: string,
  budgetMs: number,
  progress: (measurement: WorkspaceMeasurement) => void = () => {},
  now = () => performance.now(),
): WorkspaceMeasurement {
  const started = now();
  const result: WorkspaceMeasurement = {
    bytes: 0,
    inodes: 0,
    complete: true,
    errors: 0,
    durationMs: 0,
  };
  try {
    const fs = statfsSync(root, { bigint: true });
    result.filesystem = {
      totalBytes: Number(fs.blocks * fs.bsize),
      freeBytes: Number(fs.bfree * fs.bsize),
      totalInodes: Number(fs.files),
      freeInodes: Number(fs.ffree),
    };
  } catch {
    result.errors++;
  }
  try {
    const mount = workspaceMount(
      readFileSync("/proc/self/mountinfo", "utf8"),
      root,
    );
    if (mount !== undefined) result.mount = mount;
  } catch {
    /* mountinfo is unavailable outside Linux. */
  }
  const seen = new Set<string>();
  const directories: Array<{
    fd: number;
    path: string;
    names: string[];
    index: number;
  }> = [];
  let nextProgress = 250;
  const expired = () => {
    result.durationMs = now() - started;
    if (result.durationMs >= nextProgress) {
      progress({ ...result, complete: false });
      nextProgress = result.durationMs + 250;
    }
    return result.durationMs >= budgetMs;
  };
  const count = (entry: Stats): boolean => {
    const directory = entry.isDirectory();
    if (!directory && entry.nlink > 1) {
      const key = `${entry.dev}:${entry.ino}`;
      if (seen.has(key)) return false;
      seen.add(key);
    }
    result.bytes += entry.blocks * 512;
    result.inodes++;
    return directory;
  };
  const openDirectory = (path: string) => {
    const fd = openSync(
      path,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    try {
      // Linux production scans stay anchored to an open directory across renames.
      const directory =
        process.platform === "linux" ? `/proc/self/fd/${fd}` : path;
      const frame = {
        fd,
        path: directory,
        names: readdirSync(directory),
        index: 0,
      };
      directories.push(frame);
    } catch (error) {
      closeSync(fd);
      throw error;
    }
  };
  try {
    openDirectory(root);
    const first = directories[0];
    if (first !== undefined) count(fstatSync(first.fd));
    while (directories.length > 0) {
      if (expired()) {
        result.complete = false;
        break;
      }
      const directory = directories.at(-1);
      if (directory === undefined) break;
      const name = directory.names[directory.index++];
      if (name === undefined) {
        closeSync(directory.fd);
        directories.pop();
        continue;
      }
      try {
        const path = join(directory.path, name);
        const entry = lstatSync(path);
        if (count(entry)) openDirectory(path);
      } catch {
        result.errors++;
        result.complete = false;
      }
    }
  } catch {
    result.errors++;
    result.complete = false;
  } finally {
    for (const directory of directories) closeSync(directory.fd);
  }
  result.durationMs = now() - started;
  return result;
}

export function measureWorkspace(
  root: string,
  budgetMs: number,
  signal: AbortSignal,
): Promise<WorkspaceMeasurement> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const started = performance.now();
    let latest: WorkspaceMeasurement = {
      bytes: 0,
      inodes: 0,
      complete: false,
      errors: 0,
      durationMs: 0,
    };
    let settled = false;
    const worker = new Worker(
      new URL("./workspace-meter-thread.ts", import.meta.url),
      { workerData: { root, budgetMs } },
    );
    const finish = (result?: WorkspaceMeasurement, error?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      const measurement = result ?? {
        ...latest,
        complete: false,
        durationMs: performance.now() - started,
      };
      // A new scan must not start while the previous thread is still exiting.
      void worker.terminate().then(() => {
        if (error !== undefined) reject(error);
        else resolve(measurement);
      }, reject);
    };
    const abort = () => finish(undefined, signal.reason);
    const timer = setTimeout(() => finish(), budgetMs);
    signal.addEventListener("abort", abort, { once: true });
    worker.on(
      "message",
      (message: { done: boolean; measurement: WorkspaceMeasurement }) => {
        latest = message.measurement;
        if (message.done) finish(latest);
      },
    );
    worker.on("error", (error) => finish(undefined, error));
    worker.on("exit", () =>
      finish(undefined, new Error("Workspace measurement thread exited")),
    );
  });
}
