---
title: Building Vigil — an LLM-based alert scoring agent
---

Spent the last couple days building **Vigil**, a standalone Lambda that scores incoming alerts on a 0-10 scale using GPT-4.1 + historical context from DynamoDB. It's now running in staging and scoring real PagerDuty incidents for the team.

## Problem

The team's on-call Slack channel was drowning in alerts — some critical, some noise. We needed a way to distinguish signal from noise automatically. Tried vector DB similarity search earlier (Pinecone), but abandoned it. Decided to go with an LLM approach that learns from feedback.

## The Approach

**Architecture:**
- Standalone Lambda exposed via API Gateway with token auth
- Receives alerts as JSON: `{source, title, description, service, severity, timestamp}`
- Queries DynamoDB for recent alerts (last 4 hours same-source, last 30 min all sources) for context
- Feeds alert + history to GPT-4.1 which returns score 0-10 with a reason
- Stores alert in DynamoDB, notifies Slack if score >= 7

**Scoring logic:**
- 0-2: noise (known flapping, maintenance)
- 3-4: low (minor issues)
- 5-6: medium (worth attention)
- 7-8: high (likely customer-impacting)
- 9-10: critical

GPT also detects patterns: novel alerts from a service that rarely fires get higher scores, and a volume spike (5+ alerts in 30min) adds +1 to +2 bonus.

## The Feedback Loop

Users can reply in a PD alert thread with `@dude vigil: <score> <reason>` to correct a score. Dude extracts the alert context from the thread and POSTs feedback to vigil's API. Vigil stores corrections in DynamoDB and includes them in future GPT prompts as "team corrections" — GPT weights these heavily and adjusts scoring accordingly.

This is the key insight: every correction is a training signal. Over 8 months, we'll accumulate enough labeled data to fine-tune a smaller model and go fully self-hosted.

## Wiring into Dude

PagerDuty → API Gateway → Vigil Lambda → DynamoDB

When dude posts a PD incident to Slack, it now also POSTs to vigil's API, gets back a score, and replies in the thread. No duplicate messages since vigil skips its own Slack notification when called from dude.

## Results

Tested with real alerts:
- Critical latency alert on a payment endpoint: scored 9/10 ✓
- Snowflake warehouse auto-suspend: scored 1/10 (noise) ✓
- Repeated CPU spike (4x in 30min): score 6/10 with volume bonus ✓
- After feedback correction: same alert re-scored to match human judgment ✓

Team mentions (`@infrateam`) fire for score >= 8.

## Next Steps

No production deployment yet — letting it bake in staging for a few weeks. The real value is in the feedback loop. Once we have enough corrected alerts, we can fine-tune a smaller model (Qwen3-8B, Llama 4 Scout) on AWS Bedrock or SageMaker to replace GPT-4.1. The swap is one-line in `scorer.py`.

The DynamoDB table has 8-month TTL so we're building a training dataset passively — no extra work, just normal usage and feedback corrections.

## What I'd Do Differently

The original Pinecone approach was on the right track but lacked the feedback mechanism. Turns out you don't need vector similarity — GPT can just look at the recent alert history directly and make better decisions. Simpler infrastructure, smarter scoring.

---

Shipped PR #277 with full tests and docs (architecture diagram, API spec, deployment steps, distillation roadmap). Ready to run it for real once the team has a gut feel for the scores.
