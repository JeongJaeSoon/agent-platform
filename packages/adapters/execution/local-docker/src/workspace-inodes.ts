import type { DockerClient } from "./docker-client.ts";

/**
 * On the inode helper, holding the installation id: what makes an exited
 * helper that was never cleaned up this host's to remove. Not `managed`, so
 * the scheduler never takes it for a worker.
 */
export const INODE_HELPER_LABEL = "agent-platform.workspace-inode-helper";

/**
 * Puts an inode ceiling on the xfs project Docker made for a `size`-bounded
 * volume. Docker's quota code only ever sets the block limits
 * (FS_DQ_BHARD|FS_DQ_BSOFT), so what is set here survives it.
 *
 * `xfs_quota` needs the filesystem's block device, which a container does
 * not have: the helper makes the node itself, under the path the mount table
 * names so `xfs_quota` finds it there, in its own private `/dev`. It also
 * exits 0 whether or not the limit was set, so success is only ever read
 * back: the hard and soft limits from the quota report, and `f_files` from
 * statfs — which xfs answers from the project's soft limit, hence both are
 * set.
 *
 * $1 is the limit and $2 the mount point. Every refusal has its own exit
 * code (`HELPER_EXIT`); `set -e` turns anything else into 1.
 */
const APPLY_AND_VERIFY = `set -eu
limit="$1"
dir="$2"
line="$(awk -v d="$dir" '$5 == d' /proc/self/mountinfo)"
[ -n "$line" ] || exit 10
set -- $line
devnum="$3"
while [ "$1" != "-" ]; do shift; done
fstype="$2"
source="$3"
[ "$fstype" = xfs ] || exit 11
projid="$(xfs_io -r -c lsproj "$dir" | sed -n 's/^projid = \\([0-9][0-9]*\\)$/\\1/p')"
[ -n "$projid" ] && [ "$projid" != 0 ] || exit 12
xfs_io -r -c lsattr "$dir" | awk '{ exit ($1 ~ /P/) ? 0 : 1 }' || exit 12
case "$source" in /dev/*) ;; *) exit 13 ;; esac
if [ ! -e "$source" ]; then
  mkdir -p "\${source%/*}"
  mknod "$source" b "\${devnum%%:*}" "\${devnum##*:}"
fi
[ -b "$source" ] || exit 13
xfs_quota -x -c "limit -p isoft=$limit ihard=$limit $projid" "$dir"
set -- $(xfs_quota -x -c "quota -p -i -N -n $projid" "$dir")
[ "\${3:-}" = "$limit" ] && [ "\${4:-}" = "$limit" ] || exit 14
[ "$(stat -f -c %c "$dir")" = "$limit" ] || exit 14
`;

/** Far past any helper's own deadline, which is one Docker request's. */
const STRAY_HELPER_AGE_SEC = 600;

/** Exit codes of `APPLY_AND_VERIFY`, named for the error an operator reads. */
const HELPER_EXIT: Record<number, string> = {
  1: "the inode helper failed before it could set the limit (the daemon may refuse it CAP_SYS_ADMIN or CAP_MKNOD)",
  10: "the helper could not find the volume in its mount table",
  11: "the volume is not on xfs",
  // Project 0 is every file on the filesystem that has no project of its
  // own; a limit on it would bound the whole daemon, not this volume.
  12: "the volume has no xfs project of its own (it was created without a byte quota)",
  13: "the daemon's storage is not a block device the helper can address",
  14: "xfs_quota did not leave the limit in force (is the filesystem mounted with prjquota?)",
  126: "the helper image cannot run xfsprogs",
  127: "the helper image has no xfsprogs (xfs_io, xfs_quota)",
};

/**
 * Runs the helper against `volume` and answers what went wrong, or null once
 * the limit is read back in force. The caller has already checked the
 * volume is the one it means; the helper checks it is a project of its own.
 *
 * Mounted where the worker mounts it, so an image that declares that path a
 * `VOLUME` gets no anonymous one for it; `NoCopy`, so the helper never seeds
 * a fresh volume and leaves that to the worker's first mount.
 */
export async function applyInodeLimit(
  client: DockerClient,
  options: {
    /** An image id: `inspectedImage` has already vetted its volumes. */
    image: string;
    inodes: number;
    installationId: string;
    timeoutMs: number;
    volume: string;
    workspaceDir: string;
  },
): Promise<string | null> {
  const { image, inodes, installationId, timeoutMs, volume, workspaceDir } =
    options;
  // A helper removes itself on the way out; one is left behind only when
  // its process died first. Only old ones are taken: a young one may be
  // another process's, mid-run — the preflight runs outside the pass lock —
  // and removing it would fail that run's wait.
  const cutoff = Date.now() / 1000 - STRAY_HELPER_AGE_SEC;
  for (const stray of await client.listContainers([
    `${INODE_HELPER_LABEL}=${installationId}`,
  ])) {
    if (stray.Created !== undefined && stray.Created < cutoff) {
      await client.stopAndRemoveContainer(stray.Id, 1).catch(() => undefined);
    }
  }
  const name = `ap-inodes-${installationId}-${crypto.randomUUID().slice(0, 8)}`;
  const { Id } = await client.createContainer(name, {
    Cmd: [],
    Entrypoint: [
      "/bin/sh",
      "-c",
      APPLY_AND_VERIFY,
      "workspace-inodes",
      String(inodes),
      workspaceDir,
    ],
    Env: [],
    HostConfig: {
      // SYS_ADMIN for quotactl, MKNOD for the device node. The device cgroup
      // still refuses to open the node; quotactl only looks it up.
      CapAdd: ["MKNOD", "SYS_ADMIN"],
      CapDrop: ["ALL"],
      Memory: 64 * 1024 * 1024,
      Mounts: [
        {
          Source: volume,
          Target: workspaceDir,
          Type: "volume",
          VolumeOptions: { NoCopy: true },
        },
      ],
      NanoCpus: 500_000_000,
      NetworkMode: "none",
      PidsLimit: 32,
      ReadonlyRootfs: true,
      RestartPolicy: { Name: "no" },
      SecurityOpt: ["no-new-privileges"],
      Tmpfs: {},
    },
    Image: image,
    Labels: { [INODE_HELPER_LABEL]: installationId },
    User: "0:0",
  });
  try {
    await client.startContainer(Id);
    const exitCode = await client.waitContainer(Id, timeoutMs);
    if (exitCode === 0) return null;
    return HELPER_EXIT[exitCode] ?? `the inode helper exited ${exitCode}`;
  } finally {
    await client.stopAndRemoveContainer(Id, 1).catch(() => undefined);
  }
}
