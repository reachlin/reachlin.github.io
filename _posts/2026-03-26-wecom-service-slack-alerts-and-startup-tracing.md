---
title: logging pipeline wiring and wecom observability improvements
---

Today split across two tracks: finishing up a client-side logging pipeline, and tightening observability on a WeCom integration service.

## Logging pipeline: wiring up a new client

The logging pipeline fans client-side logs (browser, mobile) out to Elasticsearch and Kafka. Each client gets its own Fluent Bit container, nginx route, and Kong consumer. I added a new client today — the work touched four repos:

**Internal logging config** — added a new nginx location block and a new Fluent Bit container listening on a dedicated port, writing to its own ES index. Similar to a previous client setup done earlier in the week.

**Kong gateway** — added a new consumer with an API key pulled from AWS Secrets Manager, plus a `request-transformer` plugin that rewrites the URI and injects the routing header that directs traffic to the right Fluent Bit container. The ECS task definition also needed a new secrets entry to inject the API key at container startup — stored in Secrets Manager and substituted into the Kong declarative config via `envsubst` in the Docker entrypoint.

**Frontend deploy workflow** — the client app reads the log API key at build time, so it needs the key injected as a build arg. Added it from GitHub secrets across all four environments (three staging + production), with each environment using its own secret so staging and production stay isolated.

## WeCom service: reducing alert boilerplate

The WeCom service had a pattern repeated seven times across two route files — every error path wrapped a Slack notification in its own try/catch block. Extracted it to a small `alertSlack()` helper that never throws, so each call site went from 6 lines to 1.

Also added alerts to two retry cases that were previously silent — when a user creation request comes back with an invalid phone number or invalid manager ID, the service retries without that field but now also sends a Slack alert first, so data quality issues upstream are visible.

## WeCom service: baking the commit SHA into the image

After a rollout it was hard to confirm exactly which build was running. Added a `GITHUB_COMMIT` Docker build arg that gets passed in from CI and baked into the image as an env var. On startup the app sends a Slack message that includes the commit SHA — so every deploy announces itself and you can immediately correlate errors to a specific build.

## Fixing the EKS tunnel skill

The kubectl tunnel skill was using a background process to start the SSM port-forward session. This doesn't work — the SSM plugin needs a real TTY to complete the handshake. The session would start but the port never opened.

Fixed by switching to a named tmux window instead. The tmux window gives the SSM plugin a proper terminal, and naming the window makes it easy to find and kill when done. After launching, a quick port check confirms it's actually listening before running any kubectl commands.
