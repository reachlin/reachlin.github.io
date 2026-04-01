---
title: building the autofix triage pipeline
---

Full build day on the autonomous bug-fixing service. The design from last week is now running end-to-end: S3 download, watch engine pre-filter, qwen triage, Slack alerts. A few things were harder than expected.

## Starting with S3 instead of Fluent Bit

Real-time log ingest via Fluent Bit HTTP output is the eventual plan, but for an MVP it's easier to just poll S3. The ECS services already write all logs there via FireLens. Each file follows a date-structured key:

```
<prefix>/YYYY/MM/DD/<filename>
```

The first naive implementation listed the entire bucket prefix to find the latest file. That took 218 seconds. The fix was obvious in hindsight: scope the listing to today's date prefix, fall back to yesterday if empty. That got it down to about 3 seconds.

Files come out gzip-compressed. Added transparent decompression on magic bytes `\x1f\x8b` — no need to check the file extension.

## The watch engine + qwen handoff

The watch engine design from the design doc worked well in practice. It holds a set of rules (label, match spec, threshold, sliding window), counts matching log lines, and escalates when a threshold is crossed. Rules are JSON objects like:

```json
{"action": "watch", "label": "http_5xx_spike",
 "match": {"field": "status", "gte": "500"},
 "threshold": 10, "window_seconds": 60}
```

The flow each run:
1. If no rules exist yet, ask qwen to seed some from a sample of log lines
2. Run every line through the watch engine (synchronous, fast)
3. Lines that don't match any rule go to per-line triage via qwen
4. After processing, send qwen the watch engine's current state (count/threshold/window for each rule) so it can tune or add rules for the next batch

The watch engine reporting its state back to qwen was the key piece. qwen sees "status_401 has fired 2187 times in 120 seconds against a threshold of 5" and can decide to adjust the window, raise the threshold, or add a new rule.

## Getting qwen to actually generate rules

This took most of the day. The init call kept returning 0 rules even when qwen wasn't timing out.

The first problem was the log sample. Raw FireLens lines are 3–6 KB each — a full order object serialized to JSON wrapped in an envelope. Sending 20 of those to qwen as a prompt context produced a 60KB prompt. qwen either timed out or got confused by the business data and returned nothing useful.

The fix was a format-aware pre-processor. Each log line goes through `_parse_line`, which:
- Detects the format: firelens-nested (outer JSON envelope with an inner `log` field that's also JSON), flat JSON, or plain text
- For firelens-nested, merges the outer envelope fields with the inner log fields
- Drops noisy keys: container IDs, ECS task ARNs, trace IDs, SQL queries, order data
- Keeps only scalar fields (strings, numbers) truncated to 120 chars

A 5KB line becomes something like:

```json
{"container_name": "nginx-proxy", "log_source": "nginx",
 "status": "401", "host": "api.internal",
 "request": "GET /api/v1/notifications HTTP/1.1"}
```

That reduced the init prompt from ~60KB to ~5KB. qwen started returning rules reliably.

The second problem was subtler. qwen with `format: json` enabled sometimes returns a bare array `[...]` and sometimes wraps it: `{"watch_rules": [...]}`. The code expected a bare array, so it was discarding the rules every time qwen used the wrapper form. One-line fix: if the response is a single-key dict whose value is a list, unwrap it.

## Ollama cold start

`qwen2.5:3b` takes about 110 seconds to load on first use. With a 60-second timeout (later bumped to 120s, then 300s) the init prompt would time out while the model was still loading. Per-line triage calls worked fine afterward because the model was already warm.

Added a startup ping on server boot: send a tiny "reply with ok" prompt, retry up to 3 times with a 200-second timeout each. If all three fail, the scheduler stops and `/health` reports the failure. In practice the first attempt succeeds once the model finishes loading — it just takes patience.

## FastAPI server + scheduler

Wrapped the pipeline in a FastAPI server with a scheduler that runs every 10 minutes by default. A few API endpoints:

```
GET  /health        → server status + ollama status
GET  /status        → scheduler state + active watch rules
POST /scheduler/run-now  → trigger a run immediately
PATCH /scheduler    → adjust frequency or set a duration
```

The scheduler shares a single watch engine instance across all runs. Rules accumulate and improve over time rather than being re-seeded from scratch each cycle.

One thing I got wrong initially: the stop/start cycle had a race condition where `/status` would show `running: false` immediately after `POST /scheduler/start` because the async task hadn't started yet. Fixed it by setting `running = True` eagerly in the endpoint before creating the task.

## Noise reduction

Watch engine threshold hits were going to Slack. The problem: a 401 flood produces thousands of threshold hits in a few minutes. Moved those to `logger.warning` only — Slack alerts are now reserved for per-line triage flags (actual errors qwen detects and marks as `flag: true`).

Also added a run number to every Slack message — `[R1]`, `[R2]` etc. — so it's clear which messages belong to the same pipeline run when multiple runs' alerts appear in the same channel.

## Where it stands

The pipeline runs. Watch rules get seeded, lines get filtered, qwen triages the rest, Slack gets notified. The watch engine currently has three live rules — HTTP 5xx rate, 4xx spike, warning rate — and the 401 flood from the nginx proxy is being caught and counted without spamming alerts.

The per-line triage is slow when all lines miss the watch rules (one qwen call per line). That gets better as the rules improve. Next step is probably the LSTM bootstrap to replace the static counters with something that learns the normal baseline, or jump straight to the investigation stage with Claude Opus.
