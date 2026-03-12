---
title: airbyte production deployment - lessons from a shared database host
---

Following up on [yesterday's staging deployment]({% post_url 2026-03-11-deploying-airbyte-2-on-eks %}), today we promoted Airbyte 2.0.1 to production. The infra is the same — EKS + Terraform + Helm — but production introduced a new constraint: we share a PostgreSQL host with an existing running Airbyte instance. That created a series of cascading issues, each one only visible after the previous was fixed.

## What went wrong, in order

### 1. Terraform timed out waiting for the PVC to bind

The Airbyte staging setup pre-creates a PVC for the embedded Postgres. On production, the StorageClass uses `WaitForFirstConsumer` binding mode, meaning the volume isn't provisioned until a pod actually mounts it. Terraform's default behavior is to wait for the PVC to reach `Bound` status, which it never will on its own.

**Fix:** set `wait_until_bound = false` on the Terraform PVC resource. The PVC binds automatically once the StatefulSet pod is scheduled.

### 2. Bootloader couldn't reach the database

The Helm chart renders `DATABASE_HOST` from `global.database.host` in values — not from the Kubernetes secret. If `global.database.host` is not set, it defaults to the internal embedded Postgres service name. Passing the external host only via a K8s secret has no effect.

**Fix:** explicitly set `global.database.host` in the Helm values template, sourced from the credentials store.

### 3. Wrong database name

We named our production database something other than the chart's default to avoid colliding with the existing Airbyte instance on the same host. The database name needs to be set in two places: the JDBC URL in the K8s secret, and `global.database.name` in the Helm values. Both were initially pointing at the default name.

**Fix:** made the database name configurable and wired it through both the K8s secret and the Helm values.

### 4. Temporal tried to create databases it didn't have permission to create

Temporal's auto-setup script always attempts to `CREATE DATABASE` on startup. The `airbyte` user lacked the `CREATEDB` privilege, so this failed immediately.

**Fix:** `ALTER USER airbyte CREATEDB`.

### 5. Temporal databases already existed — but were owned by the old instance

The existing `temporal` and `temporal_visibility` databases on the shared host belong to the previous Airbyte deployment, which is still live. Two separate Temporal instances cannot safely share the same database — workflow history would be mixed.

**Fix:** create dedicated databases (`temporal_production`, `temporal_visibility_production`) and configure Temporal to use them via the `DBNAME` and `VISIBILITY_DBNAME` environment variables, injected through `temporal.extraEnv` in the Helm values.

### 6. Helm release name collision on re-apply

After several failed attempts, the Helm release was left in a failed state. Terraform couldn't re-create it without `helm uninstall` first.

**Fix:** `helm uninstall airbyte -n airbyte` before re-running `terraform apply`.

## Takeaways

- When sharing a database host between multiple deployments, every database name needs to be explicitly namespaced — including Temporal's internal databases, which default to generic names.
- The Airbyte Helm chart reads database host from values, not from secrets. The secret only carries credentials.
- Terraform's `wait_until_bound` should be set to `false` when using a `WaitForFirstConsumer` StorageClass, otherwise applies will time out.
- Failed Helm releases need to be manually uninstalled before Terraform can retry.

All pods came up healthy after working through the above. The deployment is running on Airbyte 2.0.1 (chart 2.0.19) with an external PostgreSQL database and S3 log storage via IRSA.
