// A self-contained mock of the three services the order saga talks to:
// inventory, payments, and shipping. Runs on a random localhost port via
// Bun.serve, keeps all state in memory, and exposes a snapshot for the
// validation harness. No external API involved.

export interface Reservation {
  readonly reservationId: string
  readonly orderId: string
  readonly sku: string
  readonly quantity: number
  status: "reserved" | "released"
}

export interface Charge {
  readonly chargeId: string
  readonly orderId: string
  readonly amountCents: number
  status: "charged" | "refunded"
}

export interface Shipment {
  readonly trackingId: string
  readonly orderId: string
  readonly address: string
}

export interface MockApiSnapshot {
  readonly stock: Record<string, number>
  readonly reservations: ReadonlyArray<Reservation>
  readonly charges: ReadonlyArray<Charge>
  readonly shipments: ReadonlyArray<Shipment>
  readonly requestLog: ReadonlyArray<string>
}

export interface MockApi {
  readonly url: string
  snapshot(): MockApiSnapshot
  stop(): void
}

interface JsonBody {
  readonly [key: string]: string | number | boolean | null | JsonBody
}

const json = (status: number, body: JsonBody): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  })

export const startMockApi = (options: {
  readonly initialStock?: Record<string, number>
  /** Fixed port to listen on; defaults to a random free port. */
  readonly port?: number
} = {}): MockApi => {
  const stock = new Map<string, number>(Object.entries(options.initialStock ?? { "sku-widget": 10 }))
  const reservations = new Map<string, Reservation>()
  const charges = new Map<string, Charge>()
  const shipments = new Map<string, Shipment>()
  const requestLog: string[] = []
  // The first charge attempt per order fails with 503 so the saga's retry
  // policy is exercised deterministically.
  const chargeAttempts = new Map<string, number>()
  let sequence = 0
  const nextId = (prefix: string) => `${prefix}-${++sequence}`

  const readBody = async (request: Request): Promise<Record<string, string | number>> => {
    const parsed = await request.json()
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("Mock API expects a JSON object body")
    }
    const entries = Object.entries(parsed).filter(
      (entry): entry is [string, string | number] =>
        typeof entry[1] === "string" || typeof entry[1] === "number"
    )
    return Object.fromEntries(entries)
  }

  const requireString = (body: Record<string, string | number>, key: string): string => {
    const value = body[key]
    if (typeof value !== "string") {
      throw new Error(`Mock API expected string field "${key}"`)
    }
    return value
  }

  const requireNumber = (body: Record<string, string | number>, key: string): number => {
    const value = body[key]
    if (typeof value !== "number") {
      throw new Error(`Mock API expected number field "${key}"`)
    }
    return value
  }

  const server = Bun.serve({
    port: options.port ?? 0,
    fetch: async (request) => {
      const path = new URL(request.url).pathname
      requestLog.push(`${request.method} ${path}`)

      if (request.method === "GET" && path === "/state") {
        const countByStatus = <Status extends string>(
          entries: Iterable<{ readonly status: Status }>,
          status: Status
        ): number => Array.from(entries).filter((entry) => entry.status === status).length
        return json(200, {
          stock: Object.fromEntries(stock),
          reservations: {
            reserved: countByStatus(reservations.values(), "reserved"),
            released: countByStatus(reservations.values(), "released")
          },
          charges: {
            charged: countByStatus(charges.values(), "charged"),
            refunded: countByStatus(charges.values(), "refunded")
          },
          shipments: shipments.size
        })
      }

      if (request.method !== "POST") {
        return json(404, { error: "not found" })
      }

      const body = await readBody(request)

      switch (path) {
        case "/inventory/reserve": {
          const sku = requireString(body, "sku")
          const orderId = requireString(body, "orderId")
          const quantity = requireNumber(body, "quantity")
          const available = stock.get(sku) ?? 0
          if (available < quantity) {
            return json(409, { error: "out of stock", sku, available })
          }
          stock.set(sku, available - quantity)
          const reservation: Reservation = {
            reservationId: nextId("res"),
            orderId,
            sku,
            quantity,
            status: "reserved"
          }
          reservations.set(reservation.reservationId, reservation)
          return json(200, { reservationId: reservation.reservationId })
        }

        case "/inventory/release": {
          const reservationId = requireString(body, "reservationId")
          const reservation = reservations.get(reservationId)
          if (reservation === undefined) {
            return json(404, { error: "unknown reservation", reservationId })
          }
          if (reservation.status === "reserved") {
            reservation.status = "released"
            stock.set(reservation.sku, (stock.get(reservation.sku) ?? 0) + reservation.quantity)
          }
          return json(200, { reservationId, status: reservation.status })
        }

        case "/payments/charge": {
          const orderId = requireString(body, "orderId")
          const amountCents = requireNumber(body, "amountCents")
          const attempt = (chargeAttempts.get(orderId) ?? 0) + 1
          chargeAttempts.set(orderId, attempt)
          if (attempt === 1) {
            return json(503, { error: "payment gateway warming up, retry" })
          }
          const charge: Charge = {
            chargeId: nextId("ch"),
            orderId,
            amountCents,
            status: "charged"
          }
          charges.set(charge.chargeId, charge)
          return json(200, { chargeId: charge.chargeId })
        }

        case "/payments/refund": {
          const chargeId = requireString(body, "chargeId")
          const charge = charges.get(chargeId)
          if (charge === undefined) {
            return json(404, { error: "unknown charge", chargeId })
          }
          charge.status = "refunded"
          return json(200, { chargeId, status: charge.status })
        }

        case "/shipping/dispatch": {
          const orderId = requireString(body, "orderId")
          const address = requireString(body, "address")
          if (address.toLowerCase().includes("nowhere")) {
            return json(422, { error: "undeliverable address", address })
          }
          const shipment: Shipment = {
            trackingId: nextId("trk"),
            orderId,
            address
          }
          shipments.set(shipment.trackingId, shipment)
          return json(200, { trackingId: shipment.trackingId })
        }

        default:
          return json(404, { error: "not found", path })
      }
    }
  })

  return {
    url: `http://localhost:${server.port}`,
    snapshot: () => ({
      stock: Object.fromEntries(stock),
      reservations: Array.from(reservations.values()),
      charges: Array.from(charges.values()),
      shipments: Array.from(shipments.values()),
      requestLog: [...requestLog]
    }),
    stop: () => {
      server.stop(true)
    }
  }
}
