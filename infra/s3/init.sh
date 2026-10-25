#!/bin/sh
set -eu

# Use the existing AWS CLI image without starting another LocalStack server.
awslocal() {
  aws --endpoint-url "$AWS_ENDPOINT_URL" "$@"
}
. /create-resources.sh
