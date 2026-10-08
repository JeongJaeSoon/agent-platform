#!/bin/sh
set -eu

# The provider key config/fake-model/profiles.yaml references.
# A placeholder: the fake Messages API accepts any key.
if ! awslocal secretsmanager describe-secret --secret-id agent-platform/local/fake-messages >/dev/null 2>&1; then
  awslocal secretsmanager create-secret \
    --name agent-platform/local/fake-messages \
    --secret-string local-placeholder-key >/dev/null
fi
