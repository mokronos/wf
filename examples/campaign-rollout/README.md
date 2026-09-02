# campaign-rollout

A local-only campaign release workflow that keeps all its simulated side
effects in process. It is a single workflow file, so it also imports directly
into the `wf` catalog.

It demonstrates:

- `ctx.code` for a journaled release plan and launch-code calculation
- `ctx.all` for parallel slot reservation and channel preparation
- step retry and a per-campaign concurrency limit
- a normal TypeScript loop that schedules every audience
- `ctx.now` and `ctx.random` for replay-safe values
- `ctx.sleep`, a human approval signal, typed failure, and reverse-order compensation
- `step.fail` for an invalid audience

## Run

```bash
bun run main.ts
```

The runner uses a local SQLite database at `.wf/campaign-rollout.sqlite`, waits
for the approval signal, sends an approval itself, and prints the result and
history size.

## Run via the wf CLI

```bash
wf create campaign-rollout --file examples/campaign-rollout/workflow.ts

# Complete without waiting for a human:
wf run campaign-rollout '{"campaignId":"spring-release","audiences":[{"name":"early-access","recipients":120},{"name":"general","recipients":850}],"requireApproval":false}'

# Or omit requireApproval, then use the resume command printed by wf run:
wf signal <run-id> rolloutApproval '{"approved":true,"reviewer":"kim"}' --actor kim
```
