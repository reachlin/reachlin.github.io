---
title: web service 499 Spike Investigation
---

## Summary

Cloudflare logs showed recurring spikes of HTTP 499 errors on `web-api.bigbus.com/health-check`. Investigation confirmed the issue is a **stale connection race condition between Cloudflare and AWS ALB** — not a problem with the web app, AWS infrastructure, or web devices.

---

## Symptoms

- **6,778 total 499s** over 7 days on `web-api.bigbus.com/health-check`
- Peak spike: **1,614 errors in a single 5-min bucket** at 04:25 GMT+8 (20:25 UTC) on 2026-05-20
- 499s not visible in AWS logs (ALB or app)
- No corresponding 5xx or errors on the AWS side

---

## Investigation

### Cloudflare GraphQL Analysis
- 100% of 499s have `originResponseStatus = 0` — Cloudflare **never received any response from AWS origin**
- Average TTFB for 200 OK responses: **46ms** — origin is fast, ruling out slow backend
- 99.998% of health-check requests return 200 OK normally

### AWS ALB Access Logs (20:25 UTC spike window)
- **73,101 health-check requests** logged in the spike window from the ALB's perspective
- **100% returned 200/200** (elb=200, target=200), response times 0–4ms
- ALB has **zero record** of the 499 requests — they never reached AWS

### App Logs (web-firelens, 636 files scanned)
- Only **31 error-level log entries** across the full 2-hour spike window
- No crashes, no panics, no elevated error rate around the spike time
- App is healthy

### CloudWatch (ALB metrics)
- `TargetResponseTime`: flat **10ms** throughout the spike — no origin slowness
- `HTTPCode_Target_5XX_Count`: single digits per 5-min bucket — negligible

---

## Root Cause

**Stale keep-alive connection race condition between Cloudflare edge and AWS ALB.**

```
web iPad → CF Edge → [HTTP/2 persistent connection pool] → AWS ALB → ECS pod
```

- Cloudflare maintains a pool of persistent HTTP/2 connections to the ALB origin
- CF's internal origin keepalive: **~90 seconds**
- ALB idle timeout: **65 seconds** ← shorter than CF's keepalive

When a pooled connection sits idle for >65s, ALB silently closes it. CF doesn't know and tries to reuse the dead connection for the next health-check request → receives TCP RST → logs 499 with `origin_status=0`. The web device never sees the failure as CF retries or the next request succeeds.

The spike pattern (large burst, then back to normal) indicates multiple CF connections went stale simultaneously — consistent with a brief CF edge POP event causing connections to pile up idle and expire together.

---

## Fix

**Increase ALB idle timeout from 65s to 120s** (must exceed CF's ~90s keepalive).

> AWS Console → EC2 → Load Balancers → `vpc-production` → Attributes → **Connection idle timeout → 120**

This ensures ALB never closes a connection before CF does, eliminating the race condition.

| Setting | Current | Target |
|---|---|---|
| ALB idle timeout | 65s | 120s |
| CF proxy_read_timeout | 100s | no change |
| CF http2 to origin | on | no change |

**Impact:** None. Read-only attribute change, no downtime, takes effect immediately.

---

## Non-Issues Ruled Out

- web client timeout — 499 is logged at CF edge, not by the device
- App crash or slowness — app logs and CloudWatch clean
- AWS network issue — ALB responded 200 to all requests it received
- ECS deployment or task replacement — no deployment at spike time
- Database or downstream errors — no correlated errors in app logs
