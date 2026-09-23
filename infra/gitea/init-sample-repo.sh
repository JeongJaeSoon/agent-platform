#!/bin/sh
# Creates the repository the example catalog runs sessions against
# (config/repositories.yaml: sample-app → http://gitea:3000/agent/sample-app.git).
# Run once per `up` by the compose `gitea-init` service, next to a healthy
# `gitea` and on its data volume; every step is skipped when already done,
# so a restarted stack keeps its repository and its history.
#
# The repository is public on purpose: workers clone it anonymously, since a
# catalog URL may not carry a credential (94S-132). The account below is a
# local-stack login for browsing and pushing, not a secret; override
# GITEA_AGENT_PASSWORD before the first `up` on anything shared.
set -eu

user=agent
repo=sample-app
base=http://gitea:3000
config=/data/gitea/conf/app.ini

if ! gitea --config "$config" admin user list | awk 'NR > 1 { print $2 }' | grep -qx "$user"; then
  gitea --config "$config" admin user create --username "$user" \
    --password "$GITEA_AGENT_PASSWORD" --email "$user@example.test" \
    --must-change-password=false
fi

if wget -q -O /dev/null "$base/api/v1/repos/$user/$repo" 2>/dev/null; then
  echo "gitea-init: $user/$repo already exists"
  exit 0
fi
wget -q -O /dev/null \
  --header "Authorization: Basic $(printf '%s:%s' "$user" "$GITEA_AGENT_PASSWORD" | base64 | tr -d "\n")" \
  --header "Content-Type: application/json" \
  --post-data "{\"name\":\"$repo\",\"auto_init\":true,\"default_branch\":\"main\",\"private\":false}" \
  "$base/api/v1/user/repos"
echo "gitea-init: created $user/$repo"
