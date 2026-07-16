# order-saga

An order-fulfillment saga that needs no external service: `mock-api.ts` runs an
in-process mock of inventory, payments, and shipping on a random localhost port
(`Bun.serve`), and the workflow talks to it over plain HTTP.

The workflow (`order.ts`) exercises most orchestration primitives:

- `ctx.code` — computing the order total
- `ctx.run` with retries — `/payments/charge` deterministically fails its first
  attempt per order with a 503, so `ChargePayment` always retries once
- terminal (typed) errors — out-of-stock (409) and undeliverable address (422)
  fail the step via `step.fail(...)` without burning retries
- `ctx.sleep` — a short settlement window before dispatch
- compensation — `ReserveInventory` releases stock and `ChargePayment` refunds
  when a later step fails

## Run

```bash
bun run main.ts
```

`main.ts` is a self-validating harness on the durable sqlite backend. It runs
three scenarios and asserts on the recorded history plus the mock API's final
state:

1. **Happy path** — completes; charge retried exactly once; no compensation.
2. **Undeliverable address** — dispatch fails terminally; the saga refunds the
   charge and releases the reservation in reverse order; stock is restored.
3. **Out of stock** — the first step fails fast with a typed error; nothing is
   compensated and payment is never attempted.

Exit code is non-zero if any check fails.

## Run via the wf CLI

The workflow file is self-contained (imports only from `wf`), so it can be
registered and driven from the CLI. Start the mock API first, from this
directory:

```bash
bun run serve-api.ts          # mock services on http://localhost:8788
```

Then, from the repository root:

```bash
bun run cli -- create order-saga --file examples/order-saga/order.ts
bun run cli -- run order-saga '{"apiUrl":"http://localhost:8788","orderId":"o-1","sku":"sku-widget","quantity":2,"unitPriceCents":250,"address":"42 Sunny Lane"}'

# compensation path (refund + release, non-zero exit):
bun run cli -- run order-saga '{"apiUrl":"http://localhost:8788","orderId":"o-2","sku":"sku-widget","quantity":1,"unitPriceCents":250,"address":"1 Nowhere Street"}'

bun run cli -- runs
bun run cli -- history <run-id>
curl -s localhost:8788/state   # mock-side summary
```
