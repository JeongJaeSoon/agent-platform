#!/bin/sh
set -eu

# The provider key [REDACTED] references.
# A placeholder: the fake Messages API accepts any key.
if ! awslocal secretsmanager describe-secret --secret-id werft/local/fake-messages >/dev/null 2>&1; then
  awslocal secretsmanager create-secret \
    --name werft/local/fake-messages \
    --secret-string local-placeholder-key >/dev/null
fi

# The service-account bearer [REDACTED] references;
# the compose fake-mcp service accepts exactly this one.
if ! awslocal secretsmanager describe-secret --secret-id werft/local/fake-mcp >/dev/null 2>&1; then
  awslocal secretsmanager create-secret \
    --name werft/local/fake-mcp \
    --secret-string local-fake-mcp-service-account >/dev/null
fi
