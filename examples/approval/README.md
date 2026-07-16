# approval

Human-in-the-loop expense approval on the durable sqlite backend. The workflow
(`approval.ts`) holds budget, notifies an approver, then suspends on
`ctx.waitForSignal("approval", ...)` until a human decides:

- **approve** → posts to the ledger and completes
- **reject** → fails with a typed `ApprovalRejectedError`; the budget hold is
  compensated
- **timeout** (optional, via `reviewTimeoutMillis` input) → escalates to a
  manager and waits again without a deadline
- **cancel** → unwinds completed steps via compensation

## Scripted demo

```bash
bun run main.ts demo
```

Runs four scenarios (approve, reject, timeout→escalate→approve, cancel while
suspended) against a throwaway database and validates history event counts,
signal payloads/actors, compensation, and durable-timer latency. Non-zero exit
on failure.

## Pause → process exit → resume

The durable engine persists a suspended run, so a different process can pick it
up later:

```bash
bun run main.ts start            # starts a run, exits while it is suspended
bun run main.ts pending <id>     # what is it waiting for?
bun run main.ts approve <id>     # fresh process: deliver the decision, print the result
bun run main.ts status <id>
```

Steps completed before the suspension are replayed from persisted results, not
re-executed — only the ledger step runs in the resuming process. State lives in
`.wf/approval.sqlite` next to this file.

## Run via the wf CLI

From the repository root:

```bash
bun run cli -- create approval --file examples/approval/approval.ts
bun run cli -- run approval '{"requestId":"exp-1","requester":"sam","amountCents":4200}'
# suspends, prints the expected payload schema, and a ready-to-run resume command
# with a sample payload, e.g.:
#   Resume with: bun run cli -- signal <run-id> approval '{"approved":true,"approver":"sample"}'

bun run cli -- signal <run-id> approval '{"approved":true,"approver":"kim"}' --actor kim
# or reject (compensates the budget hold, non-zero exit):
bun run cli -- signal <run-id> approval '{"approved":false,"approver":"kim","comment":"too much"}'

bun run cli -- history <run-id>
```

Signal payloads are schema-validated at delivery — a payload that does not
match `ApprovalDecision` is rejected and the run keeps waiting.
