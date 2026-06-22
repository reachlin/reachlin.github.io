---
title: debugging a MongoDB replica set init failure on ECS
---

Spent the day tracking down why `rs.initiate()` kept failing on a new MongoDB cluster in one staging environment, while the exact same setup worked fine in two others.

## The symptom

A newly deployed MongoDB container on ECS (EC2 launch type, awsvpc networking) refused to initialize its replica set:

```
MongoServerError: No host described in new configuration with
{version: 1, term: 0} for replica set rs0 maps to this node
```

The mongod was running fine on port 27017. The NLB target was healthy. DNS records existed. But `rs.initiate()` with the NLB DNS name and NLB port (60017) kept failing.

## The rabbit hole

My first theory was a port mismatch. The entrypoint script hardcodes `mongod` to listen on 27017/27117/27217 (the default service's ports), while the NLB listener for this service was on 60017. During `rs.initiate`, MongoDB's `isSelf` check compares the member's port against the local bind port — 60017 ≠ 27017, so it fails.

Logical. Coherent. And wrong.

The same port mismatch exists on every other environment where it works fine. When someone tells you "it works elsewhere with the same config," that's evidence against your theory, not something to explain away.

## The actual root causes

Testing from **inside the container** revealed two problems stacked on top of each other:

### 1. `/etc/hosts` override

```bash
$ getent hosts mongodb-svc-a-staging.example.com
10.3.103.54     mongodb-svc-a-staging.example.com
```

The hostname resolved to the container's own IP instead of the NLB. Turns out `/etc/hosts` had a static entry mapping the DNS name directly to the container IP. In the working environment, the same lookup returned three NLB IPs.

After removing the entry, DNS resolved correctly — but `rs.initiate` still failed.

### 2. Security group outbound rules

The MongoDB security group's **outbound** rules only allowed ports 27017, 27117, 27217 (the default service ports). Port 60017 was blocked outbound. The container couldn't reach the NLB on the service-specific port.

```
Outbound rules:
  TCP 27017  →  0.0.0.0/0      ✓
  TCP 27117  →  10.x.0.0/16    ✓
  TCP 27217  →  10.x.0.0/16    ✓
  TCP 60017  →  (missing)       ✗
```

Adding an outbound rule for TCP 60017 fixed it.

## What I should have done differently

The fix took 5 minutes. Finding it took hours. Here's the investigation playbook I wish I'd followed from the start:

**1. Test from inside the container first.**

```bash
cat /etc/hosts
getent hosts <dns-name>
mongosh <nlb-ip>:<port>
```

Don't theorize about DNS infrastructure from the AWS console. Run `getent hosts` from inside the container and you'll know in seconds whether DNS is the problem.

**2. Check outbound SG rules, not just inbound.**

I looked at the inbound rules early and saw 27017 was allowed. Never checked outbound until the very end.

**3. Compare working vs broken environments side by side.**

Running `getent hosts` on both the working and broken containers would have immediately shown the DNS difference. I should have done this comparison within the first 10 minutes.

**4. When someone says "it works elsewhere" — believe them.**

That's a falsification of your current theory. Pivot to investigating what's different about the broken environment specifically, rather than defending the theory.

## The MongoDB `isSelf` check

For reference, here's what happens during `rs.initiate()`:

1. MongoDB resolves the member hostname
2. If it resolves to a local interface IP, it checks if the port matches the bind port
3. If the IP is non-local, it tries a connection-based check (connects to the address to verify it reaches itself)
4. If neither check confirms "this is me," the init fails

In this case: DNS resolved to the container IP (local), port 60017 ≠ bind port 27017, connection fallback was blocked by the SG. Two independent failures, both needed fixing.

## Takeaway

Infrastructure debugging is about narrowing scope, not building theories. Start at the actual failure point (inside the container), verify each hop in the network path, and compare with a working environment early. The answer is usually mundane — a hosts file entry, a missing SG rule — not an exotic NLB hairpin NAT issue.
