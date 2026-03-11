---
title: deploying airbyte 2.0 on eks
---

This is a write-up of deploying Airbyte 2.0.1 on EKS using Terraform and Helm. The chart had several undocumented rough edges that took a while to debug. Here's what went wrong and how each issue was fixed.

## Setup

- EKS cluster on AWS, arm64 nodes (`t4g.medium`)
- Helm chart `airbyte/airbyte` version `2.0.19` (app version `2.0.1`)
- Staging uses embedded PostgreSQL, production uses external RDS
- Terraform manages everything: namespace, PVC, Helm release, ALB ingress, Route53
- Nodes are dedicated with label `group=airbyte` and taint `dedicated=airbyte:NoSchedule`

## Issue 1: PostgreSQL PVC Has No StorageClass

The embedded postgres pod gets stuck in `Pending`:

```
NAME                             STATUS    STORAGECLASS
airbyte-volume-db-airbyte-db-0   Pending   <unset>
```

Looking at the chart template `airbyte-db.yaml`, the `volumeClaimTemplate` is completely hardcoded:

```yaml
volumeClaimTemplates:
- metadata:
    name: airbyte-volume-db
  spec:
    accessModes: [ "ReadWriteOnce" ]
    resources:
      requests:
        storage: 500Mi
```

No `storageClassName`, no configurable size. Any values under `postgresql.primary.persistence` are silently ignored.

**Fix:** Pre-create the PVC via Terraform before the Helm release runs. StatefulSets adopt a pre-existing PVC that matches their naming pattern (`<volumeClaimTemplate.name>-<statefulset-name>-<ordinal>`):

```hcl
resource "kubernetes_persistent_volume_claim_v1" "airbyte_db" {
  metadata {
    name      = "airbyte-volume-db-airbyte-db-0"
    namespace = "airbyte"
  }
  spec {
    access_modes       = ["ReadWriteOnce"]
    storage_class_name = "your-storage-class"
    resources {
      requests = { storage = "5Gi" }
    }
  }
  lifecycle {
    prevent_destroy = true
  }
}
```

Add a `depends_on` in the `helm_release` resource so the PVC is created first.

## Issue 2: Bootloader Connects to Wrong Database Name

The bootloader fails with:

```
FATAL: database "db-airbyte" does not exist
```

The postgres container was initialized with `POSTGRES_DB=airbyte` (from `postgresql.postgresqlDatabase: "airbyte"` in helm values), but the Airbyte bootloader hardcodes `db-airbyte` as the target database name regardless.

**Fix:**

```yaml
postgresql:
  postgresqlDatabase: "db-airbyte"
```

Also make sure any external secret or connection string uses the correct service name and database — the embedded postgres service is named `airbyte-db-svc`, not `airbyte-postgresql`.

## Issue 3: Bootloader Race Condition with Postgres Startup

Even after fixing the database name, the bootloader dies with `Connection reset`. The bootloader and the postgres StatefulSet are both `pre-install` hooks with the same hook weight (`-1`), so they start at the same time. PostgreSQL does an internal restart during first-time data directory initialization, and the bootloader catches that restart mid-transaction.

This isn't a code fix — just retry after postgres has fully initialized. On subsequent installs with the PVC already populated, postgres starts immediately without reinitializing and the bootloader succeeds.

## Issue 4: Webapp Image Does Not Exist

After the bootloader succeeds, the webapp pod sits in `ImagePullBackOff`:

```
Failed to pull image "airbyte/webapp:2.0.1": not found
```

The `airbyte/webapp` Docker Hub image was discontinued after version 1.7.x. In Airbyte 1.8+, the UI was merged into `airbyte-server`. The chart 2.0.19 still references the old image — this is a known upstream bug.

**Fix:**

```yaml
# webapp was removed in Airbyte 1.8+, UI is now served by airbyte-server
webapp:
  enabled: false
```

Update any ingress to point to the server service on port `8001` instead of the webapp service on port `80`.

## Issue 5: Server Killed by Liveness Probe

The server pod keeps restarting (exit code 143 = SIGTERM) with:

```
Liveness probe failed: Get "http://...:8001/api/v1/health": connection refused
```

The JVM takes time to initialize — connecting to postgres, waiting for Temporal, loading connector definitions. The default liveness probe fires too early and kills the pod before it is ready.

**Fix:**

```yaml
server:
  livenessProbe:
    initialDelaySeconds: 120
    periodSeconds: 10
    failureThreshold: 6
  readinessProbe:
    initialDelaySeconds: 120
    periodSeconds: 10
    failureThreshold: 6
```

## Getting the Admin Password

The bootloader auto-generates credentials on first install and stores them in a Kubernetes secret:

```bash
kubectl get secret -n airbyte airbyte-auth-secrets \
  -o jsonpath='{.data.instance-admin-password}' | base64 -d
```

The default username is `airbyte`.

## Summary of Chart Bugs in 2.0.19

| Issue | Root Cause | Fix |
|---|---|---|
| PVC has no StorageClass | `volumeClaimTemplate` hardcoded in chart | Pre-create PVC via Terraform |
| Bootloader can't connect to DB | Chart expects `db-airbyte`, not `airbyte` | Set `postgresqlDatabase: "db-airbyte"` |
| Webapp `ImagePullBackOff` | `airbyte/webapp` image removed in 1.8+ | `webapp: enabled: false` |
| Server killed before ready | Liveness probe fires too early | `initialDelaySeconds: 120` |

Hopefully this saves someone a few hours.
