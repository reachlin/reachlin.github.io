---
title: wiring a kubernetes action bot into slack chatops
---

Spent today extending a small SNS-triggered Lambda I'd built earlier — it lists pods and restarts Deployments against a Kubernetes cluster — so it could actually be triggered from an internal Slack ops bot instead of only via direct SNS publish.

## The shape of the problem

The two systems didn't share much:

- The k8s action Lambda is deployed once per environment/cluster, VPC-bound, since the cluster's API server has no public endpoint. Every environment lives in its own AWS account, so there's no way for a single Lambda to reach all of them.
- The Slack ops bot has one long-lived `argparse` parser shared by every command it understands, and I wanted to bolt kubernetes actions onto it without touching the flags every other (ECS-focused) command already depends on.

First decision: don't reuse flags that already mean something incompatible. Two of the ones I originally wanted to reuse turned out to already be typed for a totally different purpose. Cheap to catch by just reading the parser before touching it, expensive to discover in production. Ended up adding one new long-flag-only option instead of overloading an existing short flag.

Second decision: default to the safe, read-only action. If a namespace/deployment pair is given without an explicit "mutate" flag, the bot lists pods. Only an explicit flag triggers a Deployment restart, and that one routes through the existing Slack approval flow (a message with Approve/Reject buttons, gated to a list of approvers) before anything actually happens.

## The gnarly bit: surviving the approval round-trip

The bot already had an approval flow for other mutating actions, but it was built assuming the action would run and reply synchronously, right there in the button-click handler. The kubernetes action Lambda is asynchronous — it replies to Slack itself, later, over its own path — so by the time someone clicks "Approve," the handler needs to know who *originally* asked, not just who approved, so both names can show up in the eventual result.

The existing approval button's `value` field was a bare `channel:thread:command` string, parsed positionally. Rather than risk breaking every other command sharing that format, I added a second, prefixed format used only by the new path: `PREFIX:channel:thread:requester:command`, detected by its prefix and parsed separately. Same button, same click handler, two coexisting formats. A one-line "startswith" check gates which parser runs — everything else in that handler is untouched.

## A robustness fix while testing

Wanted the k8s action Lambda to be defensive about being triggered against the wrong environment entirely — a mistyped topic ARN, for instance. Every deployment of it already knows its own environment name, set from the deploy tool's workspace variable. Added a corresponding attribute to the trigger message, checked against that Lambda's own env var, and discard-not-retry on mismatch.

Initially reached for reusing an *existing* field on the message that happens to look environment-like — realized mid-implementation that field actually means something else entirely (a target namespace, not an environment) and would silently break real usage the moment anyone used the tool against something other than the exact namespace in my test fixture. Worth saying out loud before wiring up a safety check: does this field actually mean what I'm about to assume it means, or does it just happen to coincide in the one case I've tested?

## Tested end to end

Stood up a disposable two-replica nginx Deployment, then drove it entirely through Slack:

- listed its pods, confirmed replica count/status/node placement
- fired the restart action through the approval flow, approved it, watched the reply land back in the right thread
- confirmed via `kubectl` that the restart actually happened — new pod hashes, fresh ages, a real new ReplicaSet — not just a green checkmark in Slack

Also cleaned up the pod-listing output along the way — went from one emoji-prefixed line per pod to an actual `NAME/READY/STATUS/RESTARTS/AGE` table, closer to what `kubectl get pods` already gives you, with the node name indented underneath each row since it's usually too long to sit on the same line without wrapping badly in a chat client.

## Takeaway

Two systems built at different times, with different assumptions about synchronicity, don't compose for free. The interesting work today wasn't the kubernetes calls themselves — it was making sure identity and context survive an async hop through a message queue and a human clicking a button, without touching the format the other already-working commands still depend on.
