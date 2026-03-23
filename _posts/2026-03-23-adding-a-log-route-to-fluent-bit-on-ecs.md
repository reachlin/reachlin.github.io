---
title: adding a log route to fluent bit on ecs fargate
---

Today I added a new client-side log route to an existing Fluent Bit logging pipeline running on ECS Fargate. Straightforward change, but it touched more pieces than expected — worth writing down the full picture.

## Architecture overview

The logging pipeline collects client-side logs (web, iOS, Android) and fans them out to both Elasticsearch and Kafka. The rough flow:

```
Client (browser/app)
  → Kong API Gateway (auth + routing)
  → Internal ALB (routes by HTTP header)
  → ECS Fargate task
      └─ nginx proxy (routes by URL path)
          └─ Fluent Bit container (HTTP input → ES + Kafka)
```

Each log source gets its own dedicated Fluent Bit container within a shared ECS task. The nginx proxy sits in front and routes incoming requests to the right container by URL path. Each container listens on a different port and writes to a separate Elasticsearch index and Kafka topic.

The ECS task definition is templated in JSON and rendered by Terraform. Fluent Bit config is base64-encoded and passed in as an environment variable, decoded at container startup.

## What the change involved

Adding a new log route required touching four places:

**1. nginx config** — add a new `location` block pointing to the new port:
```nginx
location /adyen-web {
  proxy_pass http://localhost:9887;
}
```

**2. ECS task definition** — add a new container entry with the right port, ES index, and service name. The container decodes its config at startup:
```bash
echo $CONF_FILE | base64 -d > fluent-bit.conf
fluent-bit -c fluent-bit.conf
```

**3. Terraform variables** — add the new ES index name, with separate values for production vs staging.

**4. Kong gateway config** — add a consumer with an API key and a `request-transformer` plugin that rewrites the URI and injects the routing header:
```yaml
- name: request-transformer
  consumer: "a-web"
  config:
    replace:
      uri: /a-web
    add:
      headers:
      - "x-route-logs-target:weblogs"
```

The API key itself is stored in AWS Secrets Manager and injected into the Kong ECS container at startup via the ECS `secrets` field, then substituted into the Kong declarative config YAML by `envsubst` in the Docker entrypoint.
