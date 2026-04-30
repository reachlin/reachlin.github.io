---
title: investigating a cloudflare 1020 block — building a skill to automate it
---

A staging endpoint was returning 403 with `error code: 1020`. Spent the session diagnosing it, then turned the whole workflow into a reusable Claude skill so I never have to do it manually again.

## Diagnosing a 1020

Error 1020 specifically means Cloudflare's Firewall Rules (legacy) or WAF Custom Rules fired a block — not a rate limit, not an IP ban, not a bot score. The tell is in the response:

```
HTTP/2 403
server: cloudflare
cf-ray: 9f4543c4289bd780-NRT

error code: 1020
```

The `cf-ray` header is the key. Every request through Cloudflare gets a unique Ray ID, and that ID is indexed in the security event logs. To find the specific rule that matched, you query the Cloudflare GraphQL Analytics API:

```graphql
{
  viewer {
    zones(filter: { zoneTag: "ZONE_ID" }) {
      firewallEventsAdaptive(
        filter: {
          action: "block"
          datetime_geq: "..."
          datetime_leq: "..."
          clientRequestPath: "/api/internal/test"
        }
        limit: 10
        orderBy: [datetime_DESC]
      ) {
        action
        rayName
        ruleId
        source
        clientIP
        datetime
        metadata { key value }
      }
    }
  }
}
```

A few things I learned about this dataset:

- **Filter by `action: "block"` explicitly.** Without it, the query defaults to returning `log` events, which are far more numerous and will bury the block.
- **`rayName` filtering is unreliable.** The field exists but queries against it return empty even when the event is clearly there. Filter by path + time window instead — much more reliable.
- **Events take ~1 minute to appear.** There's a propagation delay between when Cloudflare blocks a request and when it shows up in the analytics API. Build in a retry.
- **The `firewallrules` source means legacy Firewall Rules**, not the newer WAF Custom Rules. Both show up in this dataset but under different `source` values.

The result came back:

```
Rule ID : d0c88b552eec4c2fb5e3a274a3117188
Source  : firewallrules
Filter  : 0ba4b89ba3e349088f9e7fb829e6e3c6
```

## The GraphQL rate limit mystery

The first few queries hit an immediate "budget depleted" error. The Cloudflare GraphQL Analytics API uses a complexity budget — 300 points per 5-minute rolling window — and the budget was already gone before I ran a single query.

Digging into the firewall event logs revealed the cause: two Adyen webhook IPs (`147.12.16.11`, `147.12.16.12`) were generating ~400 log events per minute against a "Non-Supported Countries" rule. Adyen's servers are in the Netherlands, which isn't in the rule's allowed country list (US, CA, CN, HK, TW). The rule action was `log` so payments weren't affected, but every Adyen webhook call generated a log event, and querying any window of analytics over that volume consumed the entire complexity budget in one shot.

The fix was simple: disable the country rule (it was outdated anyway). The Adyen IPs resolve to `930c100b/c.adyen.com` — easy to verify with a quick `ipinfo.io` lookup.

## The token permission list

Getting the right API token permissions took a few iterations. For this kind of investigation you need:

| Permission | What it unlocks |
|---|---|
| Zone → Zone → Read | Scope queries to a zone |
| Zone → Analytics → Read | GraphQL `firewallEventsAdaptive` queries |
| Zone → Zone WAF → Read | Fetch ruleset and rule details by ID |
| Account → Account Settings → Read | Account audit logs |

The audit logs turned out to be write-only from an observability standpoint — they record config changes (token creates, ruleset updates) but not API read activity, so you can't use them to see who's consuming your analytics budget.

## Building it into a skill

The whole workflow — curl the URL, extract the Ray ID, query GraphQL, display the rule — is now a Claude skill (`cf-block-check`). It auto-triggers on phrases like "is this blocked by CF" and runs the full investigation automatically. The narrow time window query keeps it cheap even when the zone is noisy.

The main script is ~150 lines of Python using `python-dotenv` to load credentials and `urllib` for the API calls. No dependencies beyond the stdlib plus dotenv.
