# SDK Friction Resolution Log

- Signal discovery: resolved by `client.pendingSignals(executionId)`, which returns open signal waits with name, invocation, activity name, and timeout.
- Zero-config secrets: resolved by `envSecretResolver({ fallback: "" })`, used by the shared example runtime so unset credentials fall back to fixture/local adapters.
- SQLite multi-process contention: reduced by SDK `PRAGMA busy_timeout` support and documented as a single-live-owner flow (`main.ts` exits after suspension; `review.ts` owns resume).
- Signal-resume secret resolver: resolved by installing the configured secret resolver in the durable `deliverSignal` resume path.
