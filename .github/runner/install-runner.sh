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
# replaces.
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

limactl shell "$VM" sudo bash -c "cd $RUNNER_DIR && ./svc.sh install runner && ./svc.sh start" >/dev/null
limactl shell "$VM" sudo bash -c "cd $RUNNER_DIR && ./svc.sh status" | sed -n '1,6p'

echo
gh api "repos/${REPO}/actions/runners" \
  --jq '.runners[] | "\(.name)  status=\(.status)  busy=\(.busy)  labels=\([.labels[].name]|join(","))"'
