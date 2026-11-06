import { afterEach, expect, test } from "bun:test";
import { renameSync, symlinkSync, unlinkSync } from "node:fs";
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  open,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { measureWorkspace, scanWorkspace } from "./workspace-meter.ts";

const roots: string[] = [];
async function fixture() {
  const root = await mkdtemp(join(import.meta.dir, ".workspace-meter-test-"));
  roots.push(root);
  return root;
}
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

test("allocated blocks match du, including directories, sparse files and hardlinks", async () => {
  const root = await fixture();
  await mkdir(join(root, "dir"));
  await writeFile(join(root, "dir/file"), "hello");
  await link(join(root, "dir/file"), join(root, "link"));
  const sparse = await open(join(root, "sparse"), "w");
  await sparse.truncate(64 * 1024 * 1024);
  await sparse.close();
  const result = scanWorkspace(root, 30_000);
  const du = Bun.spawn(["du", "-sk", root], { stdout: "pipe" });
  const output = await new Response(du.stdout).text();
  expect(await du.exited).toBe(0);
  expect(result.bytes).toBe(Number(output.split(/\s/)[0]) * 1024);
  expect(result.inodes).toBe(4);
  expect(result.complete).toBe(true);
  expect(result.bytes).toBeLessThan(64 * 1024 * 1024);
});

test("symbolic links are counted but never followed, including loops and external directories", async () => {
  const root = await fixture();
  const outside = await fixture();
  await writeFile(join(outside, "outside"), "outside");
  await symlink(root, join(root, "loop"));
  await symlink(outside, join(root, "external"));
  const result = scanWorkspace(root, 30_000);
  expect(result.inodes).toBe(3);
  expect(result.complete).toBe(true);
});

test("unlinked open files are an explicit traversal blind spot", async () => {
  const root = await fixture();
  const file = await open(join(root, "deleted"), "w");
  try {
    await file.write(Buffer.alloc(8192));
    await unlink(join(root, "deleted"));
    const result = scanWorkspace(root, 30_000);
    expect(result.inodes).toBe(1);
    expect(result.bytes).toBe((await lstat(root)).blocks * 512);
  } finally {
    await file.close();
  }
});

test("a FIFO contributes an inode without opening its contents", async () => {
  const root = await fixture();
  const fifo = Bun.spawn(["mkfifo", join(root, "fifo")]);
  expect(await fifo.exited).toBe(0);
  expect(scanWorkspace(root, 30_000)).toMatchObject({
    complete: true,
    inodes: 2,
  });
});

test("permission errors produce incomplete measurements", async () => {
  if (process.getuid?.() === 0) return;
  const root = await fixture();
  const directory = join(root, "denied");
  await mkdir(directory);
  await chmod(directory, 0);
  try {
    expect(scanWorkspace(root, 30_000)).toMatchObject({
      complete: false,
      errors: 1,
    });
  } finally {
    await chmod(directory, 0o700);
  }
});

test("deletion during traversal marks the partial result incomplete", async () => {
  const root = await fixture();
  const file = join(root, "disappearing");
  await writeFile(file, "data");
  let clock = 0;
  let deleted = false;
  const result = scanWorkspace(
    root,
    30_000,
    () => {
      if (!deleted) {
        unlinkSync(file);
        deleted = true;
      }
    },
    () => {
      clock += 250;
      return clock;
    },
  );
  expect(result).toMatchObject({ complete: false, errors: 1, inodes: 1 });
});

test.skipIf(process.platform !== "linux")(
  "renaming an open directory to a symlink cannot redirect Linux traversal",
  async () => {
    const root = await fixture();
    const outside = await fixture();
    await mkdir(join(root, "dir"));
    await writeFile(join(root, "dir/file"), "original");
    await writeFile(join(outside, "file"), Buffer.alloc(1024 * 1024));
    let clock = 0;
    let replaced = false;
    const result = scanWorkspace(
      root,
      30_000,
      (partial) => {
        if (partial.inodes === 2 && !replaced) {
          renameSync(join(root, "dir"), join(root, "renamed"));
          symlinkSync(outside, join(root, "dir"));
          replaced = true;
        }
      },
      () => {
        clock += 250;
        return clock;
      },
    );
    expect(replaced).toBe(true);
    expect(result.inodes).toBe(3);
    expect(result.bytes).toBeLessThan(1024 * 1024);
  },
);

test("a disappearing root and exhausted budget are incomplete, never zero usage successes", async () => {
  expect(scanWorkspace(join(await fixture(), "missing"), 30_000)).toMatchObject(
    { complete: false },
  );
  expect(scanWorkspace(await fixture(), 0)).toMatchObject({ complete: false });
});

test("worker thread returns the same usage without blocking the event loop", async () => {
  const root = await fixture();
  await writeFile(join(root, "file"), "hello");
  const result = await measureWorkspace(
    root,
    30_000,
    new AbortController().signal,
  );
  expect(result).toMatchObject({
    bytes: scanWorkspace(root, 30_000).bytes,
    inodes: 2,
    complete: true,
  });
});

test("thread deadline yields partial usage and cancellation rejects", async () => {
  const root = await fixture();
  const result = await measureWorkspace(root, 1, new AbortController().signal);
  expect(result.complete).toBe(false);
  const controller = new AbortController();
  const pending = measureWorkspace(root, 30_000, controller.signal);
  controller.abort();
  await expect(pending).rejects.toBeDefined();
});
