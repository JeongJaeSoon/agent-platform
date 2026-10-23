#!/bin/sh
set -eu

# The provider key config/fake-model/profiles.yaml references.
# A placeholder: the fake Messages API accepts any key.
if ! awslocal secretsmanager describe-secret --secret-id agent-platform/local/fake-messages >/dev/null 2>&1; then
  awslocal secretsmanager create-secret \
    --name agent-platform/local/fake-messages \
    --secret-string local-placeholder-key >/dev/null
fi

# The service-account bearer config/fake-model/mcp-servers.yaml references;
# the compose fake-mcp service accepts exactly this one.
if ! awslocal secretsmanager describe-secret --secret-id agent-platform/local/fake-mcp >/dev/null 2>&1; then
  awslocal secretsmanager create-secret \
    --name agent-platform/local/fake-mcp \
    --secret-string local-fake-mcp-service-account >/dev/null
fi
