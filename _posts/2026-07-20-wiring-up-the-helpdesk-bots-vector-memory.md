---
title: wiring up the helpdesk bot's vector memory
---

Our Slack helpdesk bot has had a "look things up in a vector index" code path for a while, but today I found out the write side of it only ever lived on one laptop.

## The shadow insert path

The bot's read path was solid: embed the user's question with an OpenAI embedding model, query an S3-backed vector index, pull back the top match's stored text, and stuff it into the prompt as reference context before calling the LLM. Clean, working, in production, checked into the repo like everything else.

The insert side was a different story. There *was* an insert function still wired into the code, but it turned out to be dead — a leftover from a previous vector-DB provider, fully commented out, silently returning `None` on every call. The actual way new knowledge got into the index was a Jupyter notebook, living locally on one person's machine, never committed anywhere shared. It worked, but "how do we add a new fact to the bot's knowledge" had an answer only one person knew, and it wasn't reproducible by anyone else, let alone by someone outside engineering.

So today's job was to turn a one-person local runbook into something anyone on the team could trigger safely — specifically for a small internal knowledge base file (think: "here's the Slack channel for IT issues," "here's who approves password resets") that's short today but will grow.

## The ingest side

Wrote a small script that:

1. Splits a markdown file into chunks on blank lines — one paragraph per chunk, not one giant embedding for the whole document.
2. Embeds each chunk with the *same* embedding model the query path already uses. This mattered more than I expected — mismatched embedding models between insert and query means cosine similarity comparisons are comparing vectors from two different semantic spaces, silently returning garbage-looking-plausible results instead of an obvious error.
3. Writes each chunk to the vector index with a deterministic key (a hash of the source filename plus chunk position), so re-running the ingest after an edit overwrites in place instead of piling up duplicates.

The chunking granularity turned out to matter for a reason I didn't expect: the query path only ever reads back the *single* top match, not the top-k it asks for. So one big chunk covering five unrelated facts means a question about fact #3 might retrieve a match dominated by facts #1 and #2's embedding signal. Small, single-topic chunks make the top-1 match actually relevant.

## Wrapping it in automation

Rather than making this a script someone runs locally with credentials on their laptop, wired it into a GitHub Actions workflow: edit the markdown file, push (or open a PR through the web UI — no git required), workflow picks it up automatically and re-embeds/upserts everything.

Two things worth calling out:

- **Permissions were scoped tight.** The CI role that runs this had broad Lambda deploy permissions already (inherited from the bot's regular deploy pipeline) but nothing for the vector index. Rather than reuse or widen an existing policy, added one narrow inline statement: a single write permission, scoped to that one specific index's ARN, nothing else. Easy to reason about, easy to revoke.
- **Gated behind human approval.** The environment this job runs under already had a required-reviewer rule from the bot's existing deploy pipeline, so pointing the new job at the same environment got manual gating for free — every ingest run sits "waiting" until someone approves it before it touches the live index. No extra config needed, just reuse of what was already there.

## The non-engineer problem

The actual editors of this knowledge base are IT/HR staff, not engineers. They shouldn't need git, a terminal, or an understanding of "vector index" to fix a typo in an approver's name. So the last piece was a short guide, in plain language, sitting next to the markdown file: click here, edit, "propose changes" (GitHub's web UI turns that into a branch and PR automatically for people without direct write access), watch the Actions tab for a green check, done. If it doesn't run, ping the team — it's supposed to be waiting on a person, not stuck.

## Takeaway

The interesting failure mode here wasn't a bug — it was a process that worked fine and was invisible in exactly the way that matters. A local notebook doing the job perfectly well, for the one person who knew it existed, looks identical from the outside to "nobody can do this." Read paths get exercised on every request and get caught fast if they break. Ad hoc write paths that live outside the repo can quietly become a single point of failure — not because they don't work, but because "works on my machine" was never the bar; "anyone on the team can run it, and it's reviewable when they do" is.
