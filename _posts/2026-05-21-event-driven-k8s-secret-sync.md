---
title: event-driven k8s secret sync with lambda and eventbridge
---

Spent the day building out a Terraform module that automatically syncs AWS Secrets Manager changes into Kubernetes secrets — no `terraform apply` needed when someone adds a key.

## The problem

The usual pattern for getting AWS secrets into k8s is to hardcode each key in a `kubernetes_secret_v1` resource using `jsondecode`:

```hcl
data = {
  SLACK_BOT_TOKEN = jsondecode(data.aws_secretsmanager_secret_version.secret.secret_string).SLACK_BOT_TOKEN
  SLACK_APP_TOKEN = jsondecode(data.aws_secretsmanager_secret_version.secret.secret_string).SLACK_APP_TOKEN
}
```

This works, but every time someone adds a new key to the AWS secret, someone else has to open a PR, get it reviewed, and run `terraform apply`. For a service where devs add secrets regularly, that's a lot of friction.

One alternative is to replace the hardcoded map with a dynamic decode:

```hcl
data = jsondecode(data.aws_secretsmanager_secret_version.secret.secret_string)
```

That removes the per-key boilerplate, but it still requires an apply to pick up new keys.

## The module: a Lambda triggered by EventBridge

The cleaner solution is a small Lambda that gets triggered automatically whenever `PutSecretValue` is called on the target secret. EventBridge watches CloudTrail for that exact API call:

```json
{
  "source": ["aws.secretsmanager"],
  "detail-type": ["AWS API Call via CloudTrail"],
  "detail": {
    "eventSource": ["secretsmanager.amazonaws.com"],
    "eventName": ["PutSecretValue"],
    "requestParameters": {
      "secretId": ["arn:aws:secretsmanager:..."]
    }
  }
}
```

The Lambda reads all keys from the AWS secret and merges them into the k8s secret. Merge semantics: adds and updates from AWS, leaves k8s-only keys alone. The whole thing is packaged as a Terraform module that takes a few inputs:

```hcl
module "midway" {
  source = "git@github.com:.../terraform-modules.git//aws/midway?ref=..."

  service         = local.service_name
  environment     = terraform.workspace
  aws_tags        = local.common_tags
  vpc_id          = data.terraform_remote_state.vpc.outputs["vpc-id"]
  aws_secret_name = aws_secretsmanager_secret.app_secret.name
  k8s_namespace   = "my-namespace"
  k8s_secret_name = "my-app-creds"
}
```

The module creates the Lambda, IAM role/policy, EventBridge rule, and the necessary RBAC in the cluster (a Role scoped to just that one secret, plus a RoleBinding).

We kept the existing `kubernetes_secret_v1` resource alongside the module so nothing is destroyed during the migration — the static resource seeds initial values, midway handles everything after that.

## Two bugs found during testing

**Bug 1 — IAM policy: double suffix on secret ARN**

The module's IAM policy was built like this:

```hcl
Resource = ["${data.aws_secretsmanager_secret.target.arn}-*"]
```

The comment said "Secrets Manager appends a 6-char random suffix" — but the data source's `.arn` attribute *already includes* that suffix (e.g. `...secret:myapp/secret-aO8ZEV`). Appending `-*` produced `...secret:myapp/secret-aO8ZEV-*` which never matched, causing `AccessDeniedException` on every invocation. Fix: use the ARN directly without the wildcard.

**Bug 2 — k8s Python client: wrong key name for bearer token**

The Lambda builds a Kubernetes client and sets the bearer token like this:

```python
# wrong
configuration.api_key = {"authorization": f"Bearer {token}"}

# correct
configuration.api_key = {"BearerToken": f"Bearer {token}"}
```

The kubernetes Python client's `api_key` dict is keyed by *security scheme name* from the OpenAPI spec, not by HTTP header name. The scheme is named `BearerToken`. Using `"authorization"` caused `get_api_key_with_prefix("BearerToken")` to return an empty string, so every request went out with no auth header — always 401 from the k8s API server.

## EKS auth without aws-iam-authenticator

The Lambda authenticates to EKS using a pre-signed STS `GetCallerIdentity` URL, which is exactly what `aws eks get-token` produces. The token is generated in Python using botocore directly:

```python
url = f"https://sts.{region}.amazonaws.com/?Action=GetCallerIdentity&Version=2011-06-15"
request = botocore.awsrequest.AWSRequest(
    method="GET", url=url,
    headers={"x-k8s-aws-id": cluster_name},
)
signer = botocore.auth.SigV4QueryAuth(credentials, "sts", region, expires=14*60)
signer.add_auth(request)
token = "k8s-aws-v1." + base64.urlsafe_b64encode(request.url.encode()).rstrip(b"=").decode()
```

The EKS access entry (set up by the module via `aws_eks_access_entry`) maps the Lambda's IAM role to a k8s username, and a scoped RBAC Role handles authorization for that user.

## Testing

Added a test key to the AWS secret → Lambda fired, key appeared in the k8s secret within seconds. Removed the key from AWS → Lambda fired again, key stayed in k8s (merge semantics, not overwrite). Deployed to two environments — both synced correctly on first apply.
