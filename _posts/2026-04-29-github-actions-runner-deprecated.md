---
title: debugging a stuck GitHub Actions job — deprecated runner version and helm array pitfall
---

A deploy job sat queued for 24 minutes today with "no runner" — even though the runner pods were clearly running in the cluster. Turned out to be two separate issues stacked on top of each other.

## The symptom

A GitHub Actions deploy job targeting a self-hosted runner on a staging EKS cluster was stuck waiting. The runner scale set showed pods cycling — `ContainerCreating` → `Running` → `Completed` every few seconds. The listener kept scaling up new ephemeral runners, but the job never got picked up.

## Root cause 1: runner v2.330.0 is deprecated

GitHub deprecated older runner versions at the broker level. When the runner pod started, it would register with GitHub fine, but the first `GET /message` call to `broker.actions.githubusercontent.com` returned HTTP 403:

```
Runner version v2.330.0 is deprecated and cannot receive messages.
Runner listener exit with terminated error, stop the service, no retry needed.
```

The pod exits, the listener sees it gone, spins up a new one — infinite loop. The tell was in the pod logs: started and finished in the same second, exit code 0, but with that deprecation error right before exit.

The fix: update the custom runner image tag from `latest` to `stable`. The `latest` tag had drifted to a deprecated version; `stable` tracks a known-good supported build.

## Root cause 2: `helm upgrade --set` with array indices strips fields

My first fix attempt used `--set` to update just the image tag:

```bash
helm upgrade <release> \
  --reuse-values \
  --set "template.spec.containers[0].name=runner" \
  --set "template.spec.containers[0].image=<ecr-url>:stable" \
  ...
```

This looked right but silently broke things. When you `--set` an array index in Helm, it **replaces the entire array element** with only the fields you specified — stripping `command` and `env`. With `--reuse-values`, Helm merges at the top level but array elements are replaced wholesale.

The result: pods started with no `command`, ran the Docker `ENTRYPOINT` instead of `/home/runner/run.sh`, and exited with code 0 immediately. No error, just nothing.

The runner phase in the `EphemeralRunner` CRD was still `Pending` — the runner registered with GitHub but never actually picked up the job. The listener stats showed `totalBusyRunners: 1` while the pod had already completed. Confusing until you realize the runner claimed the job token and then exited before executing anything.

**Always use a values file for Helm upgrades that touch array fields:**

```bash
helm upgrade <release> -f values.yaml ...
```

Pass the full container spec — `name`, `image`, `command`, `env`, `imagePullPolicy` — not just the field you're changing.

## Config drift: Terraform already had the fix

After resolving it, I checked the infrastructure-as-code repo. The `:stable` tag was already committed to `main` — someone had fixed it weeks ago. But `terraform apply` was never run for the staging-02 workspace, so the cluster kept running the old Helm release with `:latest`.

This is a classic config drift scenario. The source of truth said one thing; the cluster was doing another. Running `terraform apply` for that workspace would have caught it the moment the change landed.

## How ARC's ephemeral runner loop works

For anyone debugging this pattern: the Actions Runner Controller uses a 3-layer architecture:

- **Controller** registers the runner scale set with GitHub on install, gets back a scale set ID
- **Listener pod** holds a long-poll connection to GitHub's message broker, receives `JobAvailable` / `JobAssigned` / `JobCompleted` events, and patches the `EphemeralRunnerSet` replica count accordingly
- **Ephemeral runner pods** start, get a JIT token from the controller, register with GitHub, run one job, exit — never reused

When the listener restarts (e.g. after a Helm upgrade), it reconnects and replays from the last message ID. Any jobs assigned during the gap get requeued. The `lastMessageID: 0` in the listener logs is a reliable indicator of a fresh start.

The `runs-on:` label in the workflow maps directly to the Helm release name of the runner scale set — that's the only coupling between the workflow and the infrastructure.
