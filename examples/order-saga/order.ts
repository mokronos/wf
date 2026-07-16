import { defineStep, defineWorkflow, t } from "wf"

// Terminal (business) failures. Anything else a step throws is treated as
// transient and retried according to the step's retry policy.
const OutOfStockError = t.taggedStruct("OutOfStockError", {
  sku: t.string,
  requested: t.number,
  available: t.number
})

const UndeliverableAddressError = t.taggedStruct("UndeliverableAddressError", {
  orderId: t.string,
  address: t.string
})

const OrderError = t.union([OutOfStockError, UndeliverableAddressError])

const postJson = async (url: string, body: Record<string, string | number>) => {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  })
  return { status: response.status, body: await response.json() }
}

const reserveInventory = defineStep({
  name: "ReserveInventory",
  input: t.struct({ apiUrl: t.string, orderId: t.string, sku: t.string, quantity: t.number }),
  output: t.struct({ reservationId: t.string }),
  errors: OutOfStockError,
  execute: async (input, step) => {
    const { status, body } = await postJson(`${input.apiUrl}/inventory/reserve`, {
      orderId: input.orderId,
      sku: input.sku,
      quantity: input.quantity
    })
    if (status === 409) {
      return step.fail({
        _tag: "OutOfStockError",
        sku: input.sku,
        requested: input.quantity,
        available: body.available
      })
    }
    if (status !== 200) {
      throw new Error(`inventory/reserve failed with status ${status}`)
    }
    return body
  },
  compensate: async (result, input) => {
    await postJson(`${input.apiUrl}/inventory/release`, { reservationId: result.reservationId })
  }
})

const chargePayment = defineStep({
  name: "ChargePayment",
  input: t.struct({ apiUrl: t.string, orderId: t.string, amountCents: t.number }),
  output: t.struct({ chargeId: t.string }),
  retry: { attempts: 3, backoff: "exponential" },
  execute: async (input) => {
    const { status, body } = await postJson(`${input.apiUrl}/payments/charge`, {
      orderId: input.orderId,
      amountCents: input.amountCents
    })
    if (status !== 200) {
      throw new Error(`payments/charge failed with status ${status}`)
    }
    return body
  },
  compensate: async (result, input) => {
    await postJson(`${input.apiUrl}/payments/refund`, { chargeId: result.chargeId })
  }
})

const dispatchShipment = defineStep({
  name: "DispatchShipment",
  input: t.struct({ apiUrl: t.string, orderId: t.string, address: t.string }),
  output: t.struct({ trackingId: t.string }),
  errors: UndeliverableAddressError,
  execute: async (input, step) => {
    const { status, body } = await postJson(`${input.apiUrl}/shipping/dispatch`, {
      orderId: input.orderId,
      address: input.address
    })
    if (status === 422) {
      return step.fail({
        _tag: "UndeliverableAddressError",
        orderId: input.orderId,
        address: input.address
      })
    }
    if (status !== 200) {
      throw new Error(`shipping/dispatch failed with status ${status}`)
    }
    return body
  }
})

export const OrderWorkflow = defineWorkflow({
  name: "OrderWorkflow",
  version: 1,
  input: t.struct({
    apiUrl: t.string,
    orderId: t.string,
    sku: t.string,
    quantity: t.number,
    unitPriceCents: t.number,
    address: t.string
  }),
  output: t.struct({
    reservationId: t.string,
    chargeId: t.string,
    trackingId: t.string,
    totalCents: t.number
  }),
  errors: OrderError,
  run: function* (input, ctx) {
    const totalCents = yield* ctx.code("compute-total", {
      reason: "Order total is quantity times unit price",
      run: () => input.quantity * input.unitPriceCents
    })

    const reservation = yield* ctx.run(reserveInventory, {
      apiUrl: input.apiUrl,
      orderId: input.orderId,
      sku: input.sku,
      quantity: input.quantity
    })

    const charge = yield* ctx.run(chargePayment, {
      apiUrl: input.apiUrl,
      orderId: input.orderId,
      amountCents: totalCents
    })

    // A short settlement window before dispatch, so the saga also exercises
    // durable sleep events.
    yield* ctx.sleep("1 second", "settlement-window")

    const shipment = yield* ctx.run(dispatchShipment, {
      apiUrl: input.apiUrl,
      orderId: input.orderId,
      address: input.address
    })

    return {
      reservationId: reservation.reservationId,
      chargeId: charge.chargeId,
      trackingId: shipment.trackingId,
      totalCents
    }
  }
})
