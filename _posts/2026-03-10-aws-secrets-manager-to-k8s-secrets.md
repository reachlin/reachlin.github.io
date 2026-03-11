---
title: syncing aws secrets manager to kubernetes secrets with lambda
---

This is a write-up of a Terraform module I built to automatically sync a single AWS Secrets Manager secret into a Kubernetes secret on EKS. The idea is simple: whenever the secret is updated in Secrets Manager, a Lambda fires and pushes the new value into the corresponding Kubernetes secret.

## Why Not Just Use External Secrets Operator?

[External Secrets Operator](https://external-secrets.io/) is the standard answer and works great. But it runs as a long-lived service inside the cluster with broad read access to many secrets. The motivation here was the opposite: **one Lambda per secret, with the minimum possible permissions on both the AWS and Kubernetes sides**. A Lambda triggered by EventBridge is also simpler to audit — each invocation has a clear trigger and a CloudWatch log entry.

## Architecture

```
Secrets Manager (PutSecretValue)
        |
   EventBridge rule (exact secret ARN match)
        |
      Lambda
        |
   EKS API (pre-signed STS token)
        |
  Kubernetes Secret (create or patch in one namespace)
```

Each instance of this module manages exactly one secret-to-secret mapping. If you need five secrets synced, you instantiate the module five times — five Lambdas, five IAM roles, five RBAC bindings, each with no access beyond its own secret.

## Tight Permissions by Design

### AWS Side

The IAM policy is locked to a single secret ARN:

```hcl
{
  Sid    = "SecretsManager"
  Effect = "Allow"
  Action = ["secretsmanager:GetSecretValue"]
  # Secrets Manager appends a 6-char random suffix to ARNs
  Resource = ["${data.aws_secretsmanager_secret.target.arn}-*"]
}
```

The EventBridge rule also matches by exact ARN, not a prefix or wildcard:

```hcl
event_pattern = jsonencode({
  source      = ["aws.secretsmanager"]
  detail-type = ["AWS API Call via CloudTrail"]
  detail = {
    eventSource = ["secretsmanager.amazonaws.com"]
    eventName   = ["PutSecretValue"]
    requestParameters = {
      secretId = [data.aws_secretsmanager_secret.target.arn]
    }
  }
})
```

### Kubernetes Side

The Kubernetes RBAC uses a namespace-scoped `Role` (not a `ClusterRole`) with `resource_names` locked to the single target secret:

```hcl
resource "kubernetes_role_v1" "midway_secret_writer" {
  metadata {
    name      = "${var.service}-${var.environment}-midway"
    namespace = var.k8s_namespace
  }
  rule {
    api_groups     = [""]
    resources      = ["secrets"]
    resource_names = [var.k8s_secret_name]   # one specific secret
    verbs          = ["get", "create", "update", "patch"]
  }
}
```

The Lambda's IAM role is registered as an EKS access entry and bound to this Role — so it can only touch that one Kubernetes secret in that one namespace.

## EKS Authentication from Lambda

The Lambda authenticates to EKS using a pre-signed STS `GetCallerIdentity` URL — the same mechanism as `aws eks get-token`. No `aws-iam-authenticator` binary needed.

```python
import base64
import boto3
import botocore.auth
import botocore.awsrequest

TOKEN_EXPIRY_SECONDS = 14 * 60  # EKS maximum is 15 minutes

def _get_token(cluster_name, region, session):
    credentials = session.get_credentials().get_frozen_credentials()

    url = (
        f"https://sts.{region}.amazonaws.com/"
        "?Action=GetCallerIdentity&Version=2011-06-15"
    )
    request = botocore.awsrequest.AWSRequest(
        method="GET",
        url=url,
        headers={"x-k8s-aws-id": cluster_name},
    )
    signer = botocore.auth.SigV4QueryAuth(
        credentials, "sts", region, expires=TOKEN_EXPIRY_SECONDS
    )
    signer.add_auth(request)

    token = (
        "k8s-aws-v1."
        + base64.urlsafe_b64encode(request.url.encode()).rstrip(b"=").decode()
    )
    return token
```

The cluster CA certificate is written to a temp file (the Kubernetes Python client requires a file path, not raw bytes), then deleted after the sync completes.

## Secret Sync and Merge Logic

The sync is additive: AWS keys are added or updated in the Kubernetes secret, but keys that already exist in Kubernetes and are not present in the AWS secret are left untouched. This avoids wiping keys written by other systems.

```python
def compute_merge(existing: dict, incoming: dict) -> dict:
    incoming = {k: str(v) for k, v in incoming.items()}
    added     = sorted(k for k in incoming if k not in existing)
    updated   = sorted(k for k in incoming if k in existing and incoming[k] != existing[k])
    unchanged = sorted(k for k in incoming if k in existing and incoming[k] == existing[k])
    kept      = sorted(k for k in existing if k not in incoming)
    merged    = {**existing, **incoming}
    return {"merged": merged, "added": added, "updated": updated,
            "unchanged": unchanged, "kept": kept}
```

Both JSON and plain string secrets are supported. If the secret value isn't valid JSON, it's wrapped as `{"value": "<raw string>"}`.

## Lambda Build — No Docker Required

The Lambda package is built at Terraform plan time using a `null_resource`:

```hcl
resource "null_resource" "build_lambda" {
  triggers = {
    requirements = filemd5("${path.module}/src/requirements.txt")
    source_hash  = md5(join("", [
      for f in sort(fileset("${path.module}/src/midway", "**/*.py")) :
      filemd5("${path.module}/src/midway/${f}")
    ]))
    handler_hash = filemd5("${path.module}/src/lambda_handler.py")
  }
  provisioner "local-exec" {
    command = <<-EOT
      BUILD_DIR="${path.root}/.build/midway"
      rm -rf "$BUILD_DIR" && mkdir -p "$BUILD_DIR"
      pip install -r "${path.module}/src/requirements.txt" -t "$BUILD_DIR" --quiet
      cp -r "${path.module}/src/midway" "$BUILD_DIR/"
      cp "${path.module}/src/lambda_handler.py" "$BUILD_DIR/"
    EOT
  }
}
```

The trigger hashes mean the package only rebuilds when the source actually changes.

## Summary

The key design decisions:

- **One module instance = one secret**. No shared service with broad access.
- **IAM locked to a single secret ARN** — no wildcards.
- **RBAC is a namespace-scoped `Role` with `resource_names`** — the Lambda literally cannot touch any other Kubernetes secret.
- **EventBridge triggers on exact ARN match** — no accidental cross-secret triggers.
- **Additive merge** — existing Kubernetes keys not in the AWS secret are preserved.

It's more infrastructure per secret than a shared operator, but the blast radius of any compromise is bounded to exactly one secret.
