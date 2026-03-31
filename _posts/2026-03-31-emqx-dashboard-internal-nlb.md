---
title: exposing the emqx dashboard through an internal nlb
---

Spent today getting the EMQX dashboard accessible via an SSM tunnel without breaking anything. Turned into a good lesson in how AWS NLB proxy protocol interacts with plain HTTP services.

## The original problem

The EMQX dashboard service was configured as `ClusterIP` — only reachable inside the Kubernetes cluster. The existing tunnel script pointed at the MQTT broker's hostname on port `8080`, which was wrong on two counts: wrong host (that's the MQTT NLB, not the dashboard) and wrong port (dashboard runs on `18083`). End result: connection refused or a 400.

## Why not just add the dashboard port to the existing internal NLB?

The existing internal NLB for MQTT traffic has `aws-load-balancer-proxy-protocol: "*"` set. This annotation applies to every port on that service — including any new ones you add. Proxy Protocol prepends a TCP header with the original client IP before the payload. MQTT listeners understand this. The EMQX dashboard's HTTP server does not. So tunneling through that NLB on a new port gives you an immediate `400 Bad Request` because the HTTP server sees garbage before the GET request.

The fix: a separate Kubernetes service for the dashboard with no proxy protocol annotation.

```yaml
apiVersion: v1
kind: Service
metadata:
  name: emqx-dashboard-internal
  annotations:
    service.beta.kubernetes.io/aws-load-balancer-type: "external"
    service.beta.kubernetes.io/aws-load-balancer-nlb-target-type: "ip"
    service.beta.kubernetes.io/aws-load-balancer-scheme: "internal"
    service.beta.kubernetes.io/aws-load-balancer-backend-protocol: "tcp"
    # no proxy-protocol here
spec:
  type: LoadBalancer
  ports:
    - port: 8080
      targetPort: 18083
```

Port `8080` on the NLB maps to `18083` on the pod. The `8080` is needed because the SSM session policy restricts which destination ports are allowed — `18083` isn't on the list, `8080` is.

## The SSM policy double-constraint

The SSM `StartPortForwardingSessionToRemoteHost` document has two allowlists:
- **Hostnames**: only certain patterns are permitted (e.g. `*.company.com`, internal VPC domains)
- **Ports**: only specific ports are allowed (443, 8080, 6379, 9200, etc.)

The raw ELB hostname (`*.elb.us-east-2.amazonaws.com`) fails the hostname check. So you need a proper DNS record under an allowed domain. A Route53 internal alias record pointing at the NLB does the job — it resolves correctly from inside the VPC where the jumpbox lives.

## Terraform after kubectl

The apply order matters here. The NLB is provisioned by Kubernetes when you apply the service manifest. Terraform then looks it up by tag:

```hcl
data "aws_lb" "emqx_dashboard_internal_nlb" {
  tags = {
    "elbv2.k8s.aws/cluster" = "eks-${terraform.workspace}"
    "service.k8s.aws/stack" = "emqx/emqx-dashboard-internal"
  }
}
```

If you run `terraform apply` before `kubectl apply`, the data source lookup fails. One-way dependency: K8s creates the NLB, Terraform creates the DNS record. No loop.

## What ended up shipping

- New `emqx-dashboard-internal` service in the K8s manifest template (generated, not hand-edited)
- Route53 internal alias `emqx-dashboard-<env>.company.com` → dashboard NLB
- Tunnel script updated to use the new hostname and correct port
- Tested on staging first; other environments follow the same template

The dashboard is now reachable with a single command through the existing SSM jumpbox infrastructure, with no changes to the SSM policy or security groups.
