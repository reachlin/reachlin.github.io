---
title: designing an autonomous bug-fixing service
---

Started a new project today: a web service that watches a live system's logs, detects errors, and automatically generates and submits code fixes. Nothing built yet — this was a full design day. Worth writing down while it's fresh.

## The basic idea

The service takes four inputs: a log stream, a source code repository, the commit SHA currently deployed, and a descriptor that explains what the service does. From those it produces a patch — either as a pull request or a dry-run diff.

The interesting part isn't the patching, it's the triage. Most log volume is noise. You need something cheap to watch everything and something expensive that only fires when it matters.

## Log routing: tap into Fluent Bit

The services I'm working with already route all container logs through FireLens and Fluent Bit — to Elasticsearch for search, S3 for archival, and Datadog for critical alerts. No Kinesis or Firehose, just Fluent Bit output plugins.

The cleanest tap point is a new `http` output block in the existing Fluent Bit config:

```ini
[OUTPUT]
    Name        http
    Match       *
    Host        autofix.internal
    Port        8080
    URI         /ingest
    Format      json_lines
    Retry_Limit 3
```

Match `*` — catch everything, let the service decide what matters. The ECS task definitions already set `enable-ecs-log-metadata: true`, so each log line carries the service name and task metadata automatically. No new AWS infrastructure needed.

## Two-stage triage

The triage layer has two parts that work together.

**Layer 1 is a watch engine** — pure code, in-memory sliding window counters. It holds a registry of active watches, each with a pattern to match, a window size, and a threshold. When a watch's counter hits its threshold, it escalates to the investigation stage. When a watch window expires without hitting the threshold, it discards quietly.

**Layer 2 is a local LLM** — `qwen2.5:3b` running via Ollama on CPU. It reads each incoming log batch (every 50 lines or 10 seconds) and decides what to do next. It outputs one of three actions:

```json
{ "action": "ignore" }

{ "action": "watch",
  "label": "http_5xx_spike",
  "match": { "field": "status", "gte": 500 },
  "window_seconds": 60,
  "threshold": 10,
  "summary": "Seeing isolated 5xx — watching for spike" }

{ "action": "investigate",
  "summary": "Unhandled exception in order handler" }
```

The key insight here: qwen doesn't just classify logs as good or bad. It acts as a dynamic rule configurator for Layer 1. When it sees a 5xx response, it doesn't immediately escalate — it tells the watch engine to start counting. If more 5xx errors follow within the window, the watch engine escalates. If they stop, the watch expires and nothing happens.

This handles the awkward middle case: a few 5xx errors is normal; many in a short window is a problem. An LLM reading a single batch can't make that call reliably (it has no memory across batches), but the watch engine can count across time.

## Why a local model for triage

`qwen2.5:3b` runs via Ollama with no GPU — about 1.9GB model weight in Q4 quantization, comfortable in 8GB RAM on 2–4 vCPU. No API calls, no cost, no network dependency. Since triage runs on every log batch, you want it as cheap and fast as possible. The local model fits that constraint well.

The expensive model — Claude Opus — only comes in for Stage 2 investigation, after the watch engine has confirmed a real signal. By then you have enough context (surrounding log lines, the relevant source files at the deployed commit) to do meaningful root cause analysis and generate a patch.

## What's next

The design is mostly settled. Remaining open questions before building: how does the service know which repo and commit maps to each service name in the logs? That's the service descriptor registry — each service needs to be pre-registered. Also need to decide on the fix strategy defaults (PR vs. dry-run) and the dedup window to avoid re-investigating the same error repeatedly.

Going to start with the scaffold and data models next session.
