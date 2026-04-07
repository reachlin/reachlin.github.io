---
title: fixing two ECS deployment issues — dubbo port SG and ECR naming conflict
---

Two separate bugs surfaced while setting up a Dubbo RPC service as a dedicated ECS service alongside the existing web service. Both were straightforward once identified, but each had a non-obvious root cause.

## Issue 1: Dubbo ECS service stuck in a health check restart loop

The new `dubbo` ECS service was configured to listen on port `20880` (the standard Dubbo RPC port), with an NLB TCP target group doing health checks against that port. The service kept cycling — tasks would start, fail the health check, and get replaced.

The problem: the ECS task's security group only allowed inbound traffic on port `8085` (the web API port). The NLB health check probes were hitting port `20880` and being dropped at the SG level, so from the NLB's perspective the targets were always unhealthy.

The fix was a new security group scoped specifically to the dubbo service:

```hcl
resource "aws_security_group" "ordering_dubbo" {
  name   = "ordering-dubbo-${terraform.workspace}"
  vpc_id = data.terraform_remote_state.vpc.outputs.vpc-id

  ingress {
    from_port   = 20880
    to_port     = 20880
    protocol    = "tcp"
    cidr_blocks = [data.terraform_remote_state.vpc.outputs.vpc-cidr]
  }
}
```

The key detail: the ECS module supports per-service `security_groups` overrides inside the `ecs_cluster_tasks` map. This meant I could attach the new SG only to the dubbo service without touching the web service's SG configuration:

```hcl
dubbo = {
  type            = "web"
  app_container   = "ordering"
  app_port        = local.dubbo_port
  target_groups   = [module.dubbo-nlb-target.aws_nlb_target_group.arn]
  security_groups = [
    data.terraform_remote_state.vpc.outputs.sg-private-default-id,
    data.terraform_remote_state.vpc.outputs.sg-internal-routing-id,
    aws_security_group.ordering_dubbo.id,
  ]
}
```

## Issue 2: Cloud image being pushed to the wrong ECR

The GitHub Actions workflow was pushing the cloud Docker image to an ECR repository that was shared with another deployment pipeline. This caused image tag conflicts — one pipeline's push would overwrite what another had just deployed.

The fix was simple: create a dedicated ECR repository for the cloud image and point the workflow and task definitions at it exclusively.

```hcl
resource "aws_ecr_repository" "ordering-cloud" {
  name                 = "ordering-cloud"
  image_tag_mutability = "MUTABLE"

  image_scanning_configuration {
    scan_on_push = true
  }
}

resource "aws_ecr_lifecycle_policy" "ordering-cloud" {
  repository = aws_ecr_repository.ordering-cloud.name
  policy = <<EOF
{
  "rules": [{
    "rulePriority": 1,
    "selection": {
      "tagStatus": "any",
      "countType": "imageCountMoreThan",
      "countNumber": ${terraform.workspace == "production" ? 30 : 100}
    },
    "action": { "type": "expire" }
  }]
}
EOF
}
```

The workflow's `app_ecr_name` was updated to `ordering-cloud`, and all task definitions were updated to reference `aws_ecr_repository.ordering-cloud.repository_url` instead of the shared one.

## A subtle Terraform locals bug found along the way

While cleaning up, I noticed the `env_lookup` map was being looked up by `local.env_short` (the first segment of the workspace name, e.g. `"staging"` for `staging-01`) but the map keys were the full workspace names (`staging-01`, `staging-02`). This would have caused a Terraform error at plan time on any staging workspace. Fixed by switching the lookup to use `terraform.workspace` directly — which also makes the map more explicit and easier to extend.
