# Multi-Tenant Audit Log System (Apache Kafka)

A production-grade, secure, and scalable audit logging infrastructure built with **Apache Kafka**, **Node.js**, and **MinIO**. This system demonstrates industrial best practices for multi-tenancy, specifically focusing on **Data Isolation (ACLs)** and **Resource Management (Quotas)**.

---

## 🏗️ Tech Stack
- **Message Broker**: [Apache Kafka](https://kafka.apache.org/) (Confluent-Platform 7.4.0)
- **Metadata Management**: [Zookeeper](https://zookeeper.apache.org/)
- **API Gateway & Worker**: [Node.js](https://nodejs.org/) (Express, KafkaJS, AWS SDK v3)
- **Object Storage**: [MinIO](https://min.io/) (S3-Compatible Archival)
- **Security**: SASL/SCRAM Authentication, Authorizer ACLs, Client Quotas
- **Orchestration**: [Docker Compose](https://docs.docker.com/compose/)

---

## 📂 Project Architecture & Workflow

The system provides a unified ingestion point for multiple tenants while ensuring physical and logical separation of their audit data.

### 1. The Request Lifecycle
1.  **Ingestion**: An external service sends an audit event to the **HTTP Gateway** (`POST /events`) with an `X-Tenant-ID` header.
2.  **Authorization**: The Gateway validates the tenant ID. If invalid, it logs a **Security Violation** to the `audit.violations` topic and returns `401 Unauthorized`.
3.  **Secure Routing**: For valid tenants, the Gateway uses **Tenant-Specific SASL Credentials** to produce the message to the tenant's private Kafka topic: `audit.{tenant-id}.events`.
4.  **Broker Enforcement**: The Kafka broker intercepts the request and enforces:
    -   **ACL Checks**: Ensures the principal (identity) only has permissions for their specific namespace.
    -   **Quotas**: Checks if the producer is exceeding the **1MB/s byte-rate limit**.
5.  **Data Archival**: A background **Archival Worker** monitors all tenant topics. When a message is older than the configured threshold (e.g., 5 minutes), it is moved to **MinIO** storage in a structured JSON path for long-term compliance.

---

## 📁 File Structure
```text
.
├── app/
│   ├── index.js             # Unified Gateway (Express) & Archival Worker
│   ├── package.json         # Node.js dependencies (kafkajs, aws-sdk)
│   └── Dockerfile           # Multi-stage Node.js build
├── docker-compose.yml       # Full stack: Zookeeper, Kafka, MinIO, App, MC
├── provision.sh             # [MANDATORY] Bash script for Kafka bootstrapping
├── test_acl_violation.sh    # Reproducible script for security verification
├── test_quota_violation.sh  # Reproducible script for resource verification
├── SECURITY.md              # Security posture and rotation analysis
├── .env.example             # Environment variable template
├── *.conf                   # SASL/SCRAM JAAS & Client configuration files
└── README.md                # System documentation
```

---

## 🔒 Security Model (Multi-Tenancy)

### Identity & Isolation
We use **SASL/SCRAM-SHA-256** for user authentication. Instead of a shared "superuser", every tenant has their own credential. **ACLs (Access Control Lists)** are applied to restrict users:
-   `User:tenant-acme` can **WRITE/READ** to `audit.tenant-acme.events`.
-   `User:tenant-acme` is **DENIED** all access to any other topic.

### Resource Fairness (Quotas)
To prevent the "Noisy Neighbor" problem, we enforce **Byte-Rate Quotas**:
-   **Producer Quota**: 1,048,576 bytes/sec (1MB/s)
-   **Consumer Quota**: 1,048,576 bytes/sec (1MB/s)

---

## 🚀 Getting Started

### 1. Build and Start Infrastructure
```bash
docker compose up -d --build
```
*Wait ~30 seconds for all services to report "Healthy".*

### 2. Provisioning (Mandatory)
Initialize the topics, users, and security policies. (Windows users should use **Git Bash**).
```bash
bash provision.sh
```

---

## 🧪 Verification & Testing (Follow this Flow)

### Step 1: Monitor the Dashboard
Open your browser and navigate to the live terminal log viewer:
👉 **[http://localhost:8080/dashboard](http://localhost:8080/dashboard)**

### Step 2: Test Valid Ingestion
Send a valid event for `tenant-acme` using `curl`.
```bash
curl -X POST http://localhost:8080/events \
  -H "X-Tenant-ID: tenant-acme" \
  -H "Content-Type: application/json" \
  -d '{"actor_id": "user_01", "action": "LOGIN", "timestamp": "2026-05-02T10:00:00Z"}'
```
*Result: Status 202 Accepted. Log appears in Green on the dashboard.*

### Step 3: Test Security (ACL Violation)
Attempt to write to Acme's topic using Globex's credentials.
```bash
bash test_acl_violation.sh
```
*Result: Script exits with TopicAuthorizationException.*

### Step 4: Test Security (Gateway Violation)
Attempt to send an event with an invalid tenant ID.
```bash
curl -X POST http://localhost:8080/events \
  -H "X-Tenant-ID: unknown-tenant" \
  -H "Content-Type: application/json" \
  -d '{"data": "malicious"}'
```
*Result: Status 401 Unauthorized. Violation appears in Red on the dashboard.*

### Step 5: Test Quotas (Throttling)
Flood the broker to trigger the 1MB/s throttling.
```bash
bash test_quota_violation.sh
```
*Result: Broker logs show 'ThrottledChannelReaper-Produce'.*

### Step 6: Verify S3 Archival (MinIO)
Wait for 1 minute, then check the MinIO storage.
```bash
docker run --rm --network multi-tenant-audit-log_default --entrypoint /bin/sh minio/mc:latest -c "mc alias set myminio http://minio:9000 minioadmin minioadmin; mc ls myminio/kafka-archive --recursive"
```

---

## 🛡️ Security
See [SECURITY.md](SECURITY.md) for details on credential rotation and threat mitigation.
