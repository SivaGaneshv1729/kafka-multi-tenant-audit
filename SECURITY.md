# Security Analysis: Multi-Tenant Audit Log System

This document analyzes the security posture of the Kafka-based multi-tenant audit logging system.

#### Credential Rotation Strategy
In the current implementation, we use SASL/SCRAM with static passwords stored in Zookeeper. A robust rotation strategy involves:
1. **Admin Trigger**: The `provision.sh` script or an automated service account manager executes `kafka-configs.sh` to update the user's password.
2. **Grace Period**: Kafka supports multiple SCRAM mechanisms or overlapping credentials in some configurations, but typically, rotation requires a client restart. To avoid downtime, the Gateway should support a "blue-green" credential pool or a dynamic refresh from a vault (like HashiCorp Vault).
3. **Vault Integration**: Move credentials out of `.env` files and into a centralized secret management system that handles rotation and leases.

#### Credential Leak Impact and Mitigation
- **Impact**: If a tenant's credentials (e.g., `tenant-acme`) are leaked, the attacker gains the ability to:
    - Write fake audit logs to `audit.tenant-acme.events`.
    - Read all historical data for `tenant-acme` still on the Kafka cluster.
- **Mitigation**:
    - **ACL Scoping**: Even with leaked credentials, the attacker *cannot* access `tenant-globex` or any other tenant's data due to broker-side ACL enforcement.
    - **Quotas**: The 1MB/s quota prevents the attacker from performing a volumetric Denial of Service (DoS) on the entire cluster.
    - **Rapid Revocation**: Immediate removal of the SASL user via `kafka-configs.sh` stops all access instantly.

#### Gaps for Enterprise Multi-Tenancy
To be truly enterprise-ready, the following improvements are needed:
1. **Network Isolation**: Use VPC Peering or PrivateLink to ensure that Kafka traffic never traverses the public internet.
2. **Encryption at Rest**: Enable EBS volume encryption or Kafka's native Transparent Data Encryption (TDE) for the log segments.
3. **Advanced Quotas**: Implement **Request Rate Quotas** (not just byte-rate) to prevent clients from overwhelming the broker with high-frequency empty requests.
4. **OIDC/OAuth Integration**: Replace SASL/SCRAM with OIDC-based authentication to leverage enterprise IAM (Okta, Azure AD) for identity.
5. **Audit API Rate Limiting**: Implement application-level rate limiting at the Gateway (e.g., using Redis) before the request even hits the Kafka producer.
