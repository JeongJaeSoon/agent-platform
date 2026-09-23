#!/bin/sh
set -eu

# Checkpoint objects are pinned by version and held after finalize, so the
# bucket needs versioning and Object Lock (CHECKPOINT_OBJECT_PROTECTION=locked,
# the API default). Creating it with Object Lock turns versioning on too.
if ! awslocal s3api head-bucket --bucket claude-sessions >/dev/null 2>&1; then
  awslocal s3api create-bucket \
    --bucket claude-sessions \
    --create-bucket-configuration "LocationConstraint=${AWS_DEFAULT_REGION}" \
    --object-lock-enabled-for-bucket
fi

# A bucket left in the localstack-data volume by an older compose file has
# neither. Only then turn both on: once Object Lock is configured, S3 refuses
# any PutBucketVersioning, even one that changes nothing. Objects written
# before this stay unversioned, and a locked API refuses the checkpoints that
# name them.
lock=$(awslocal s3api get-object-lock-configuration \
  --bucket claude-sessions \
  --query ObjectLockConfiguration.ObjectLockEnabled \
  --output text 2>/dev/null || true)
if [ "$lock" != "Enabled" ]; then
  awslocal s3api put-bucket-versioning \
    --bucket claude-sessions \
    --versioning-configuration Status=Enabled
  awslocal s3api put-object-lock-configuration \
    --bucket claude-sessions \
    --object-lock-configuration ObjectLockEnabled=Enabled
fi
