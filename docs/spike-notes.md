# Phase 1 spike notes

Source checked: installed `@effect/workflow@0.18.2` and `@effect/cluster@0.59.0` package source under `node_modules/.bun`. Context7 did not have `@effect/workflow` indexed.

## Activity naming constraints

- `Activity.make({ name })` accepts an arbitrary string and uses it as the persisted activity name.
- `Activity.idempotencyKey(name)` hashes `executionId + "-" + name`; there is no source-level validation that rejects `#`.
- Built-in names already use separators such as `/` (`Activity/${name}`, `DurableClock/${name}`), so wrapper names like `chargePayment#1` are safe at the library API level.

## `Workflow.withCompensation`

- `Workflow.withCompensation(effect, compensation)` registers the finalizer only after `effect` succeeds.
- Compensation is called only when the whole workflow exits with failure; successful workflows do not run compensation.
- Finalizers are stored on the workflow scope, so completed top-level `ctx.run` calls unwind in normal scope-finalizer order (LIFO).
- The package note says compensation does not work for nested activities. The wrapper must attach `withCompensation` directly around the top-level effect returned by `ctx.run`, not inside the activity body.

## `DurableDeferred` succeed-before-await

- `DurableDeferred.await` calls `engine.deferredResult`; if a result exists, it returns the stored exit immediately. If no result exists, it suspends the workflow.
- `DurableDeferred.succeed/fail/done` call `engine.deferredDone` with workflow name, execution ID, deferred name, and exit.
- This strongly suggests succeed-before-await can work when the caller already has a valid token naming the workflow/execution/deferred. Phase 3 still needs an integration test through the client path because external signal delivery must know or derive the exact deferred name before the workflow reaches the wait point.

## `WorkflowEngine.interrupt`

- `Workflow.Workflow` exposes `interrupt(executionId)`, forwarding to `engine.interrupt(workflow, executionId)`.
- `ClusterWorkflowEngine.interrupt` checks the current persisted `run` reply. If the run is not currently suspended, it returns without interrupting.
- If the workflow is suspended, the engine completes an internal `InterruptSignal`, clears clocks, marks the instance interrupted on resume, and interrupts the fiber.
- Mid-activity behavior is separate: activity execution catches client-requested interrupts and stores the activity as `Suspended`; `Activity.make` also has an `interruptRetryPolicy` and retries interrupted activity execution by default before dying after retries are exhausted.
- Phase 4 cancel semantics need an explicit policy decision for non-suspended workflows: the substrate interrupt API is suspension-oriented, not a hard "stop this running workflow now" primitive.

## Phase 2 determinism journal

- A replay journal can be represented as internal durable activities keyed by ordinal position (`determinism#1`, `determinism#2`, ...). First execution stores the orchestration call tuple; replay reads the stored tuple and compares it with the call the current body is about to make.
- This detects divergence before the target step/sleep/now/random executes. The only durable operation before detection is the journal activity itself.
- `ctx.now` and `ctx.random` fit the same model as user steps: they are micro-activities named `now#n` / `random#n`, so the engine persists their first values and replays them later.

## Phase 3 signal delivery path

- The Phase 3 `deliverSignal(executionId, name, payload)` entry point deliberately matches the future `client.signal(executionId, name, payload)` shape.
- Delivery-side schema validation is possible once a workflow has registered a wait schema for `(executionId, signalName)`. Signals delivered before the wait is registered are buffered FIFO and decoded when the wait point is reached.
- For the durable engine path, a fully external process will eventually need Phase 4 client/runtime context to route delivery through the engine. `DurableDeferred` tokens require workflow name, execution ID, and deferred name; `executionId + signalName` alone is enough for the in-process Phase 3 hub but not for a remote durable delivery API.
- Timed waits are modeled as a business outcome (`{ type: "timeout" }`), not an exception. The current test path time-skips by resolving timeout immediately when no buffered signal exists.

## Phase 4 cancellation behavior

- The implemented client can cancel an execution parked on the Phase 3 in-process signal wait. `compensate: true` rejects the wait with `Cancelled` and lets the core compensation stack unwind; `compensate: false` marks the cancellation as hard and skips unwind.
- The current in-memory client does not interrupt a currently-running step body. This matches the earlier substrate finding that `WorkflowEngine.interrupt` is suspension-oriented; true mid-activity interruption needs the later durable engine client/runtime integration policy.

## Phase 4b/5 durable runtime notes

- Durable signal delivery on the SQLite backend routes through `WorkflowEngine.deferredDone` with the pinned workflow definition, execution ID, and the deferred name emitted by `signal.waiting`. This works across a second runtime created over the same SQLite file, but the runtime surface still has no explicit shutdown primitive for a clean in-process restart test.
- Version pinning requires the authored engine workflow name to include the version (`name@vN`). That is already true in `defineWorkflow`; the durable client stores both logical name and pinned numeric version on every execution row and resolves resumes through that exact pair.
- Durable `cancel({ compensate: true })` is still not closed: `WorkflowEngine.interrupt` can wake a suspended workflow, but the current SQLite client does not inject a typed `Cancelled` failure into the workflow scope, so it cannot reliably drive the wrapper's LIFO compensation stack. Closing this likely needs a wrapper-level durable cancellation marker checked at every suspension boundary, not just a direct engine interrupt call.

## Phase 8: durable cancellation — CLOSED (plus substrate findings)

Durable `cancel({ compensate: true })` now works: a reserved per-execution deferred
(`wf:cancel`, see `cancellationDeferredName` in core.ts) is raced at every suspension
point (sleep, signal wait). The client completes it via `deliverSignal`; the woken
execution fails with a typed `Cancelled` (moved to core.ts), which drives the normal
`withCompensation` LIFO unwind. `compensate: false` stays a hard `WorkflowEngine.interrupt`
with no unwind. Timed signal waits were also fixed: the old durable path slept the timeout
and could never receive the signal; both now race durably with signal > timeout priority
falling out of delivery timing.

Substrate landmines hit on the way (all @effect/workflow 0.18.2 / @effect/cluster 0.59.0):

- **`DurableDeferred.raceAll` replay is broken for plain winners.** Its replay path runs
  `Effect.flatten(storedExit)`, which dies with `Not a valid effect: <winner>` unless the
  winner value is itself an Effect. `DurableDeferred.await` does the correct single
  `yield*` unwrap. We hand-roll the race (`raceDurable` in core.ts): poll
  `engine.deferredResult`, single-unwrap a persisted winner, else
  `DurableDeferred.into(Effect.raceAll(...))`.
- **`DurableClock.sleep`'s `inMemoryThreshold: 0` is silently ignored** (falsy check);
  pass `"1 milli"` to force the durable schedule-and-suspend path.
- **In-memory sleeps hold the entity mailbox.** Sleeps ≤ 60s run as an in-process
  activity, so the `run` RPC stays busy and queued `deferred` RPCs (signal deliveries,
  cancellations) are not processed until the sleep ends. Consequence: signal timeouts
  MUST use a durable clock (we force `inMemoryThreshold: "1 milli"` for the timeout
  branch); plain `ctx.sleep` keeps the in-memory optimization, so a cancellation during
  a short sleep is consumed at the next suspension point (bounded by 60s).
- **One engine per runtime.** Building a cluster env per call (execute/signal/interrupt)
  puts several `SingleRunner` nodes on the same SQLite store; they fight over shard
  ownership and message processing becomes arbitrarily late. `createWorkflowRuntime` now
  holds a single `ManagedRuntime`, rebuilt only when the registered workflow set changes.
- **Entity fibers don't inherit caller FiberRefs.** With a shared engine, the per-call
  FiberRef event sink / secret resolver no longer reach workflow code. Both are now also
  registered per executionId in module-level registries (events.ts, core.ts) that
  `emitWorkflowEvent` / `ctx.run` consult first; the runtime registers them in
  `execute`/`deliverSignal` and cleans up on terminal.
- **`deferredDone` only resumes a run whose `Suspended` reply is already persisted.** A
  delivery racing the suspension write is stored but never wakes the run. `deliverSignal`
  nudges `engine.resume` a few times (5 × 100ms) after `deferredDone`; resume is a no-op
  unless the run is recorded as suspended, so the nudge is safe.
- **Effect version skew warning** ("Effect versioned 3.21.4 with a Runtime of 3.21.2")
  was fixed by bumping `effect` to ^3.21.4 and reinstalling; it was NOT the cause of the
  signal-delivery hang (the mailbox blocking above was), but mismatched runtimes are a
  real footgun — keep effect deduped.
