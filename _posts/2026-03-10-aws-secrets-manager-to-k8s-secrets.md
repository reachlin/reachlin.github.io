---
title: syncing aws secrets manager to kubernetes secrets with lambda
---

This is a write-up of a Terraform module I built to automatically sync AWS Secrets Manager secrets into Kubernetes secrets on EKS. The idea is simple: whenever a secret is updated in Secrets Manager, a Lambda fires and pushes the new value into the corresponding Kubernetes secret — no manual `kubectl` commands, no restarts needed.

## Why Not Just Use External Secrets Operator?

[External Secrets Operator](https://external-secrets.io/) is the standard answer and works great. But sometimes you want something lighter that doesn't require installing a CRD-based operator into the cluster, especially when you just need a handful of secrets synced. A Lambda triggered by EventBridge is a minimal, auditable alternative.

## Architecture

```
Secrets Manager (PutSecretValue)
        |
   EventBridge rule
        |
      Lambda
        |
   EKS API (via pre-signed STS URL)
        |
  Kubernetes Secret (create or patch)
```

The Lambda authenticates to EKS using a pre-signed STS `GetCallerIdentity` URL — the same token-based auth that `aws eks get-token` produces. No `aws-iam-authenticator` binary needed inside the Lambda runtime.

## Lambda Auth to EKS

The trickiest part is getting the Lambda to talk to the EKS API server. EKS uses IAM authentication via a bearer token that encodes a pre-signed STS URL:

```python
import boto3, base64, json
from botocore.auth import SigV4Auth
from botocore.awsrequest import AWSRequest
from botocore.credentials import Credentials

def get_eks_token(cluster_name, region):
    session = boto3.session.Session()
    credentials = session.get_credentials().get_frozen_credentials()

    url = (
        f"https://sts.{region}.amazonaws.com/"
        f"?Action=GetCallerIdentity&Version=2011-06-15"
        f"&X-Amz-Expires=60"
    )
    request = AWSRequest(method="GET", url=url, headers={
        "x-k8s-aws-id": cluster_name
    })
    SigV4Auth(credentials, "sts", region).add_auth(request)

    token = "k8s-aws-v1." + base64.urlsafe_b64encode(
        request.url.encode()
    ).decode().rstrip("=")
    return token
```

This token is passed as a `Bearer` header to the EKS API server, which validates it against IAM.

## Syncing the Secret

Once authenticated, the Lambda reads the secret value from Secrets Manager and creates or patches the Kubernetes secret:

```python
def sync_secret(secret_arn, k8s_namespace, k8s_secret_name):
    # Read from Secrets Manager
    sm = boto3.client("secretsmanager")
    value = sm.get_secret_value(SecretId=secret_arn)["SecretString"]
    data = json.loads(value)

    # Encode values as base64 for Kubernetes
    encoded = {k: base64.b64encode(v.encode()).decode() for k, v in data.items()}

    # Patch or create the Kubernetes secret
    body = {
        "apiVersion": "v1",
        "kind": "Secret",
        "metadata": {"name": k8s_secret_name, "namespace": k8s_namespace},
        "data": encoded,
    }
    # PUT to /api/v1/namespaces/{namespace}/secrets/{name}
    # falls back to POST if 404
    ...
```

The merge logic is additive by default — existing keys not present in the Secrets Manager secret are preserved. This avoids wiping unrelated keys that other systems might have written.

## IAM Permissions

The Lambda needs two things:

1. **Secrets Manager read access** — `secretsmanager:GetSecretValue` on the target secrets
2. **EKS API access** — an `aws_eks_access_entry` plus a Kubernetes `ClusterRole` that allows `create`, `get`, `update`, `patch` on secrets in the target namespaces

The Terraform module wires all of this up automatically, including the EKS access entry and the RBAC ClusterRoleBinding.

## Terraform Module Structure

```
aws/midway/
├── iam.tf        # Lambda execution role, Secrets Manager policy
├── lambda.tf     # Lambda function, EventBridge rule + target
├── rbac.tf       # Kubernetes ClusterRole + ClusterRoleBinding
├── sg.tf         # Security group for Lambda VPC access
├── variable.tf   # cluster_name, region, secret mappings
├── versions.tf   # provider pins
└── src/
    ├── lambda_handler.py
    └── midway/
        ├── aws_secrets.py
        ├── core.py
        ├── eks.py
        ├── k8s_secret.py
        ├── merge.py
        └── slack.py   # optional Slack notifications on sync
```

The Lambda code is packaged at plan time using a `null_resource` that runs `pip install` into a `.build/` directory, then zipped with `archive_file`. No Docker build step needed.

## EventBridge Rule

```hcl
resource "aws_cloudwatch_event_rule" "secret_change" {
  event_pattern = jsonencode({
    source      = ["aws.secretsmanager"]
    detail-type = ["AWS API Call via CloudTrail"]
    detail = {
      eventSource = ["secretsmanager.amazonaws.com"]
      eventName   = ["PutSecretValue"]
      requestParameters = {
        secretId = [{ prefix = var.secret_prefix }]
      }
    }
  })
}
```

This triggers on any `PutSecretValue` call for secrets matching the configured prefix. CloudTrail must be enabled for this to work.

## Slack Notifications

The module optionally posts to Slack on every sync, which makes it easy to audit what changed and when. The message includes the secret name, target namespace/secret, and whether it was a create or update.

## Limitations

- Only supports JSON-formatted secrets (not plain string values)
- Lambda must be in the same VPC as the EKS cluster (or have network access to the API server endpoint)
- CloudTrail must be enabled for EventBridge to receive Secrets Manager events
- Token TTL is 60 seconds — Lambda cold starts on large functions occasionally approach this

Overall this is a clean pattern for lightweight secret syncing without adding a full operator to your cluster.
