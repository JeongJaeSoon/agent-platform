#!/bin/sh
# Creates the repository the example catalog runs sessions against
# (config/repositories.yaml: sample-app → http://gitea:3000/agent/sample-app.git).
# Run once per `up` by the compose `gitea-init` service, next to a healthy
# `gitea` and on its data volume; every step is skipped when already done,
# so a restarted stack keeps its repository and its history.
#
# The repository is public on purpose: workers clone it anonymously, since a
# catalog URL may not carry a credential (94S-132). Its owner can push, and
# workers reach Gitea through the egress proxy, so the owner's password is
# never a known default: unless GITEA_AGENT_PASSWORD is set, it is random and
# printed nowhere. Set a known one with
# `docker compose exec -u git gitea gitea admin user change-password -u agent -p <password>`.
set -eu

user=agent
repo=sample-app
base=http://gitea:3000
config=/data/gitea/conf/app.ini

if wget -q -O /dev/null "$base/api/v1/repos/$user/$repo" 2>/dev/null; then
  echo "gitea-init: $user/$repo already exists"
  exit 0
fi

password="${GITEA_AGENT_PASSWORD:-}"
[ -n "$password" ] || password="$(head -c 24 /dev/urandom | base64 | tr -d '/+=\n')"
if ! gitea --config "$config" admin user list | awk 'NR > 1 { print $2 }' | grep -qx "$user"; then
  gitea --config "$config" admin user create --username "$user" \
    --password "$password" --email "$user@example.test" \
    --must-change-password=false >/dev/null
  echo "gitea-init: created user $user"
elif [ -z "${GITEA_AGENT_PASSWORD:-}" ]; then
  # The user is there but the repository is not, and the random password
  # of the run that made the user is gone: replace it to create the repository.
  gitea --config "$config" admin user change-password --username "$user" \
    --password "$password" --must-change-password=false >/dev/null
fi
wget -q -O /dev/null \
  --header "Authorization: Basic $(printf '%s:%s' "$user" "$password" | base64 | tr -d "\n")" \
  --header "Content-Type: application/json" \
  --post-data "{\"name\":\"$repo\",\"auto_init\":true,\"default_branch\":\"main\",\"private\":false}" \
  "$base/api/v1/user/repos"
echo "gitea-init: created $user/$repo"
