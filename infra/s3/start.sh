#!/bin/sh
set -eu
umask 077
if [ ! -s /data/encryption-seed ]; then
  head -c 32 /dev/urandom | base64 > /data/encryption-seed
fi
WEED_S3_SSE_KEY=$(cat /data/encryption-seed)
export WEED_S3_SSE_KEY
exec weed mini -dir=/data -ip=127.0.0.1 -ip.bind=0.0.0.0 \
  -s3.port=4566 -webdav=false -admin.ui=false -master.telemetry=false \
  -s3.port.iceberg=0 -s3.port.lance=0 -s3.autoCreateBucket=false
