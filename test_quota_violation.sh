#!/bin/bash

BOOTSTRAP_SERVER="localhost:9092"
TOPIC="audit.tenant-initech.events"

echo "Flooding $TOPIC as User:tenant-initech to trigger quota throttling..."

# Generate ~10MB of data (10000 lines of 1KB each)
# Then pipe to producer
# Use --producer-property client.id to make it easier to find in logs
dd if=/dev/zero bs=1024 count=10000 2>/dev/null | tr '\0' 'x' | \
docker exec -i multi-tenant-audit-log-kafka-1 kafka-console-producer \
  --bootstrap-server $BOOTSTRAP_SERVER \
  --producer.config /tmp/client-initech.conf \
  --topic $TOPIC \
  --producer-property client.id=quota-test-client

echo "Flood complete. Checking Kafka broker logs for throttling..."

# Wait a few seconds for metrics to propagate
sleep 5

docker logs multi-tenant-audit-log-kafka-1 2>&1 | grep "produce-throttle-time-avg"

echo "Verification: If the broker logs show 'produce-throttle-time-avg' > 0, the quota is working."
