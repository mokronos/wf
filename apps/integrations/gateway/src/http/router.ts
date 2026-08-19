import { Schema } from "effect"
import type { Client } from "../domain.ts"

/** Routes are data rather than an if-chain over pathnames, so the surface can
 * be enumerated, access-classified, and tested without a socket.
 *
 * This deliberately does not use Effect's HttpApi: the gateway is published,
 * and pinning it to a beta HTTP surface would propagate that instability to
 * every consumer. What the if-chain actually cost us was type safety at the
 * boundary, and a route table with Schema-decoded bodies buys that back. */
export type HttpVerb = "GET" | "POST" | "DELETE"

/** `delegated` needs any live key; `privileged` additionally needs mayMutate.
 * Classification lives on the route so a new endpoint cannot forget to be
 * guarded — the dispatcher reads this, not the handler. */
export type RouteAccess = "delegated" | "privileged"

export interface RouteRequest {
  readonly params: Readonly<Record<string, string>>
  readonly query: URLSearchParams
  /** Already parsed from the request's JSON text by the handler, so a route
   *  never sees a raw string. */
  readonly body: Schema.Json
  /** The authenticated caller. Present for every route: there are no
   *  unauthenticated endpoints. */
  readonly client: Client
  readonly secret: string
}

/** A value on its way out through JSON.stringify.
 *
 *  Wider than Schema.Json on purpose: the handlers return decoded domain
 *  records, and those carry Dates (which stringify turns into ISO strings) and
 *  optional properties typed `| undefined` (which stringify drops). Naming that
 *  is the difference between a response contract and `unknown`. */
export type JsonEncodable =
  | Schema.Json
  | undefined
  | Date
  | ReadonlyArray<JsonEncodable>
  | { readonly [key: string]: JsonEncodable }

export interface RouteResult {
  readonly status: number
  readonly body: JsonEncodable
}

export interface Route {
  readonly method: HttpVerb
  /** Segments prefixed with `:` are captured, e.g. `/v1/grants/:id/revoke`. */
  readonly path: string
  readonly access: RouteAccess
  readonly handle: (request: RouteRequest) => Promise<RouteResult>
}

export const ok = (body: JsonEncodable): RouteResult => ({ status: 200, body })
export const created = (body: JsonEncodable): RouteResult => ({ status: 201, body })
export const badRequest = (message: string): RouteResult => ({
  status: 400,
  body: { error: message }
})
export const notFound = (message: string): RouteResult => ({
  status: 404,
  body: { error: message }
})

export interface RouteMatch {
  readonly route: Route
  readonly params: Readonly<Record<string, string>>
}

const segments = (path: string): ReadonlyArray<string> =>
  path.split("/").filter((segment) => segment.length > 0)

export const matchRoute = (
  routes: ReadonlyArray<Route>,
  method: string,
  pathname: string
): RouteMatch | undefined => {
  const requested = segments(pathname)
  for (const route of routes) {
    if (route.method !== method) continue
    const pattern = segments(route.path)
    if (pattern.length !== requested.length) continue
    const params: Record<string, string> = {}
    let matched = true
    for (const [index, part] of pattern.entries()) {
      const actual = requested[index]
      if (actual === undefined) {
        matched = false
        break
      }
      if (part.startsWith(":")) {
        params[part.slice(1)] = decodeURIComponent(actual)
        continue
      }
      if (part !== actual) {
        matched = false
        break
      }
    }
    if (matched) return { route, params }
  }
  return undefined
}

/** Whether any route exists at this path under a different verb, so a wrong
 *  method reports 405 rather than a misleading 404. */
export const pathExists = (
  routes: ReadonlyArray<Route>,
  pathname: string
): boolean =>
  routes.some((route) => matchRoute([route], route.method, pathname) !== undefined)

export class RequestBodyError extends Error {}

/** Decodes a request body at the boundary. Handlers receive parsed values and
 *  never inspect `unknown`. */
export const decodeBody = <A>(schema: Schema.Codec<A>, body: Schema.Json): A => {
  try {
    return Schema.decodeUnknownSync(schema)(body)
  } catch (error) {
    throw new RequestBodyError(
      error instanceof Error ? error.message : "Request body did not match the expected shape"
    )
  }
}
