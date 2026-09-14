#!/bin/sh
set -eu

if ! awslocal s3api head-bucket --bucket claude-sessions >/dev/null 2>&1; then
  awslocal s3api create-bucket \
    --bucket claude-sessions \
    --create-bucket-configuration "LocationConstraint=${AWS_DEFAULT_REGION}"
fi
