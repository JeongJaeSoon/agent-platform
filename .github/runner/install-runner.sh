#!/usr/bin/env bash
# Installs (or re-installs) the GitHub Actions runner inside the Lima VM.
#
# Runs on the macOS host. The registration token comes from the already
# authenticated `gh` and goes into the VM on stdin, so it never reaches this
# script's output, a file, or a host command line. It does reach `config.sh` as
# an argument inside the VM; it expires in an hour, and nothing long-lived is
# left on the VM.
#
#   .github/runner/install-runner.sh
#
# Re-running is safe: it replaces the existing registration of the same name.

set -euo pipefail

VM=${VM:-agent-platform-ci}
REPO=${REPO:-JeongJaeSoon/agent-platform}
RUNNER_NAME=${RUNNER_NAME:-$VM}
LABELS=${LABELS:-agent-platform-ci}
RUNNER_DIR=/opt/actions-runner

command -v limactl >/dev/null || { echo "limactl not found: brew install lima" >&2; exit 1; }
command -v gh >/dev/null || { echo "gh not found" >&2; exit 1; }

limactl list --format '{{.Name}} {{.Status}}' | grep -qx "$VM Running" || {
  echo "VM '$VM' is not running. Start it first:" >&2
  echo "  limactl start --name=$VM .github/runner/lima.yaml" >&2
  exit 1
}

# Ask for the current release: a pinned version goes stale and starts failing
# the pre-job version check.
version=$(gh api repos/actions/runner/releases/latest --jq '.tag_name' | sed 's/^v//')
arch=$(limactl shell "$VM" uname -m)
case "$arch" in
aarch64) rarch=arm64 ;;
x86_64) rarch=x64 ;;
*) echo "unsupported guest arch: $arch" >&2; exit 1 ;;
esac
echo "runner v${version} (linux-${rarch}) into ${VM}:${RUNNER_DIR}"

limactl shell "$VM" sudo -u runner env \
  VERSION="$version" RARCH="$rarch" DIR="$RUNNER_DIR" bash -s <<'GUEST'
set -euo pipefail
cd "$DIR"
if [ ! -x ./config.sh ] || [ "$(cat .installed-version 2>/dev/null || true)" != "$VERSION" ]; then
  tgz="actions-runner-linux-${RARCH}-${VERSION}.tar.gz"
  curl -fsSLo "/tmp/$tgz" \
    "https://github.com/actions/runner/releases/download/v${VERSION}/${tgz}"
  tar xzf "/tmp/$tgz" -C "$DIR"
  rm -f "/tmp/$tgz"
  echo "$VERSION" > .installed-version
fi
GUEST

# installdependencies.sh needs root; the unpacked tree is owned by `runner`.
limactl shell "$VM" sudo "$RUNNER_DIR/bin/installdependencies.sh" >/dev/null

# Otherwise the old service keeps running against the registration this
# replaces. From here until the new service is up there is no runner: jobs
# queue instead of failing, so a failure in between has to say so out loud.
trap 'echo "
FAILED with no runner registered. Jobs will queue, not fail. Either re-run this
script, or fall back to GitHub-hosted with: gh variable delete CI_RUNS_ON" >&2' ERR

limactl shell "$VM" sudo bash -c \
  "cd $RUNNER_DIR && ./svc.sh stop 2>/dev/null; ./svc.sh uninstall 2>/dev/null; true" >/dev/null

# `bash -c`, not `bash -s` with a heredoc: a heredoc takes over stdin and the
# token would never arrive.
gh api --method POST "repos/${REPO}/actions/runners/registration-token" --jq '.token' \
  | limactl shell "$VM" sudo -u runner env \
      DIR="$RUNNER_DIR" URL="https://github.com/${REPO}" \
      NAME="$RUNNER_NAME" LABELS="$LABELS" \
      bash -c 'set -euo pipefail
read -r token
cd "$DIR"
./config.sh --unattended --replace --url "$URL" --token "$token" --name "$NAME" --labels "$LABELS" --work _work --disableupdate >/dev/null'

limactl copy .github/runner/job-cleanup.sh "$VM":/tmp/job-cleanup.sh
limactl shell "$VM" sudo bash -c "
  install -d -o runner -g runner $RUNNER_DIR/hooks
  install -o runner -g runner -m 0755 /tmp/job-cleanup.sh $RUNNER_DIR/hooks/job-cleanup.sh
  rm -f /tmp/job-cleanup.sh
  # runsvc.sh sources .env, and this is the runner's own name for the hook.
  install -o runner -g runner -m 0644 /dev/stdin $RUNNER_DIR/.env <<'ENV'
ACTIONS_RUNNER_HOOK_JOB_COMPLETED=$RUNNER_DIR/hooks/job-cleanup.sh
ENV
" >/dev/null

limactl shell "$VM" sudo bash -c "cd $RUNNER_DIR && ./svc.sh install runner && ./svc.sh start" >/dev/null

# Stopping the VM must let the runner tell GitHub the job is gone, and let the
# hook clean up, instead of the job hanging until GitHub times it out. The
# isolation dependency belongs here too: no ruleset, no jobs.
limactl shell "$VM" sudo bash -s <<'GUEST' >/dev/null
set -euo pipefail
mapfile -t units < <(systemctl list-units --type=service --all --no-legend 'actions.runner.*' | awk '{print $1}')
# An empty name would write to a literal `.d` directory that daemon-reload
# ignores without a word, leaving the runner with none of this — including the
# isolation dependency. Two names and the drop-in could land on the dead one.
if [ "${#units[@]}" -ne 1 ]; then
  echo "expected exactly one actions.runner.* unit, found ${#units[@]}: ${units[*]:-none}" >&2
  exit 1
fi
unit=${units[0]}
install -d "/etc/systemd/system/${unit}.d"
printf '[Unit]\nRequires=ci-isolation.service\nAfter=ci-isolation.service docker.service\n\n[Service]\nTimeoutStopSec=120\nKillMode=mixed\n' \
  >"/etc/systemd/system/${unit}.d/graceful.conf"
systemctl daemon-reload
systemctl restart "$unit"
GUEST
limactl shell "$VM" sudo bash -c "cd $RUNNER_DIR && ./svc.sh status" | sed -n '1,6p'
trap - ERR

echo
gh api "repos/${REPO}/actions/runners" \
  --jq '.runners[] | "\(.name)  status=\(.status)  busy=\(.busy)  labels=\([.labels[].name]|join(","))"'
