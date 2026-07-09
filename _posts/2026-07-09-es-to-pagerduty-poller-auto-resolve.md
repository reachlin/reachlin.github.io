---
title: teaching a self-service alert path to auto-resolve
---

Started the day with a simple complaint: an alert fired to PagerDuty, the underlying condition cleared, but the incident just sat there open. Ended up digging through a small internal tool's architecture, patching it, and then watching the fix play out live across log tunnels, task schedulers, and a PagerDuty incident feed.

## The tool

We run a small scheduled Lambda — one per environment — that polls Elasticsearch on a fixed interval and turns query results into PagerDuty pages. It has two ways to define what pages:

1. **A reviewed path** — alert rules committed to a JSON file in the repo, PR'd and redeployed. Every run, the Lambda re-runs each rule's ES query and reflects the *current* state: breach → trigger, no breach → resolve. Since PagerDuty's Events API already dedups on a `dedup_key`, there's no state table needed — the Lambda just says what's true right now, every run.
2. **A self-service path** — teams can wire their own Kibana alerting rule directly to an ES index the poller also watches, no PR required. Kibana's `.es-query` rule type can write a small JSON document into that index whenever its own condition matches. The poller picks it up, forwards it to PagerDuty, marks it processed.

The self-service path was the old design carried over from a predecessor script, and it only ever *triggered*. A one-shot indexed document has no ongoing query to re-evaluate against, so there was never a natural place to hang a resolve off of. Anyone using the self-service path just had to remember to close their own PagerDuty incidents by hand.

## The fix

Kibana's alerting rules actually have a second action group most people don't reach for: **recovered**, which fires exactly once when a rule transitions from active back to healthy. So the fix was:

- Let the self-service index accept a `resolved` status document, not just `new`.
- Have the poller branch: `new` → trigger, `resolved` → resolve.
- Correlate the two using a stable key written into the document itself (rule id + alert instance id) instead of the ES document's own `_id` — a trigger doc and its later resolve doc are two separate documents, so they need a shared handle to reference the same PagerDuty incident.
- Wire the Kibana rule with two actions instead of one: the existing "query matched" action, plus a new "recovered" action pointing at the same connector, writing the resolved status and the same correlation key.

Old docs without the new key still fall back to using their own `_id`, so nothing already wired up breaks.

## Debugging the rollout

Getting the code merged and deployed was the easy part. Verifying it actually worked end-to-end was more interesting:

- Read the alerting rule's raw definition directly out of the search engine's internal system index (rules, connectors, and their config all live there as regular documents) to confirm exactly what action wiring was live, rather than trusting the UI's summary view.
- Watched the self-service index for the trigger document to show up, then watched it flip from `new` to `processed` once the poller's next scheduled run picked it up.
- Manually resolved the one incident that had already fired *before* the fix was live — its stored key was the old document-id-based one, since it predated the new correlation-key logic, so it needed a one-off manual nudge.
- After the rule's condition actually cleared, watched two, then four, "resolved" documents appear (the recovery action group fired more than once for the same transition — worth a follow-up, but harmless since resolving an already-resolved incident is a no-op and they all shared the same key).
- Tailed the function's logs across the full window, matching invocation timestamps against document timestamps to make sure `pagerduty.resolve()` had actually fired on schedule and hadn't hit an error.

One fun tangent: a batch of `ResourceNotFoundException` errors around secret retrieval showed up in the logs from earlier in the day, before any of today's changes. Traced them to a five-minute window and confirmed they'd self-resolved and never recurred — an unrelated, already-healed blip, not a symptom of the change.

## Takeaway

"No state store" designs are elegant until you remember that *reflecting current state every run* only works if there's a run that actually re-evaluates the state. A one-shot event has nothing to re-evaluate against by definition — the fix isn't cleverer polling, it's giving the upstream system (Kibana, in this case) a second, explicit action to say "this got better," and giving the poller a stable key to tie that message back to the page it's closing.
