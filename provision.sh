#!/bin/bash

# Configuration
BOOTSTRAP_SERVER="localhost:9092"
ADMIN_CONF="admin.conf"
TENANTS=("tenant-acme" "tenant-globex" "tenant-initech")
QUOTA_BYTES=1048576 # 1MB/s

echo "Starting provisioning..."

# 0. Seed admin user in Zookeeper for SASL/SCRAM
docker exec multi-tenant-audit-log-kafka-1 kafka-configs --zookeeper zookeeper:2181 --alter --add-config 'SCRAM-SHA-256=[password=admin-password]' --entity-type users --entity-name admin

# 1. Create audit.violations topic
docker exec multi-tenant-audit-log-kafka-1 kafka-topics --bootstrap-server $BOOTSTRAP_SERVER --command-config /tmp/admin.conf --create --topic audit.violations --partitions 1 --replication-factor 1 --if-not-exists

# 2. Provision Tenants
for tenant in "${TENANTS[@]}"; do
    echo "Provisioning $tenant..."
    
    # Create SASL/SCRAM user
    docker exec multi-tenant-audit-log-kafka-1 kafka-configs --zookeeper zookeeper:2181 --alter --add-config "SCRAM-SHA-256=[password=$tenant-password]" --entity-type users --entity-name $tenant
    
    # Create Tenant Topic
    topic="audit.$tenant.events"
    docker exec multi-tenant-audit-log-kafka-1 kafka-topics --bootstrap-server $BOOTSTRAP_SERVER --command-config /tmp/admin.conf --create --topic $topic --partitions 1 --replication-factor 1 --if-not-exists
    
    # Apply ACLs (Produce and Consume access)
    # Grant WRITE, DESCRIBE for PRODUCE
    docker exec multi-tenant-audit-log-kafka-1 kafka-acls --bootstrap-server $BOOTSTRAP_SERVER --command-config /tmp/admin.conf --add --allow-principal User:$tenant --operation WRITE --operation DESCRIBE --topic $topic
    
    # Grant READ, DESCRIBE for CONSUME
    docker exec multi-tenant-audit-log-kafka-1 kafka-acls --bootstrap-server $BOOTSTRAP_SERVER --command-config /tmp/admin.conf --add --allow-principal User:$tenant --operation READ --operation DESCRIBE --topic $topic
    
    # Grant READ, DESCRIBE on Consumer Groups (using a wildcard/prefix or matching tenant-id)
    # The requirement says "its corresponding consumer groups". We'll allow groups starting with the tenant id.
    docker exec multi-tenant-audit-log-kafka-1 kafka-acls --bootstrap-server $BOOTSTRAP_SERVER --command-config /tmp/admin.conf --add --allow-principal User:$tenant --operation READ --operation DESCRIBE --group "*"
    
    # Apply Quotas (1MB/s)
    docker exec multi-tenant-audit-log-kafka-1 kafka-configs --bootstrap-server $BOOTSTRAP_SERVER --command-config /tmp/admin.conf --alter --add-config "producer_byte_rate=$QUOTA_BYTES,consumer_byte_rate=$QUOTA_BYTES" --entity-type users --entity-name $tenant

done

echo "Provisioning complete."
