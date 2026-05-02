#!/bin/bash
export MSYS_NO_PATHCONV=1

BOOTSTRAP_SERVER="localhost:9092"
TARGET_TOPIC="audit.tenant-acme.events"

echo "Attempting to produce to $TARGET_TOPIC as User:tenant-globex..."

# We expect this to fail with a TopicAuthorizationException
# Using a timeout to prevent it from hanging if it retries indefinitely
echo '{"test": "violation"}' | docker exec -i multi-tenant-audit-log-kafka-1 kafka-console-producer \
  --bootstrap-server $BOOTSTRAP_SERVER \
  --producer.config /tmp/client-globex.conf \
  --topic $TARGET_TOPIC \
  --request-timeout-ms 5000 \
  2>&1 | grep -E "TopicAuthorizationException|NOT_AUTHORIZED"

if [ $? -eq 0 ]; then
  echo "SUCCESS: ACL violation prevented as expected."
  exit 0
else
  echo "FAILURE: ACL violation was NOT prevented or error mismatched."
  exit 1
fi
