import {
  defaultArgumentRetentionDays,
  defaultGatewayPort,
  writeGatewayConfig
} from "./config.ts"
import { createGateway } from "./host.ts"
import type { Gateway } from "./host.ts"
import { createGatewayHandler } from "./http/handler.ts"
import type { GatewayRequestContext } from "./http/handler.ts"
import { isLoopbackAddress, mayBorrowLocalCredential } from "./http/loopback.ts"
import { gatewayRoutes } from "./http/api.ts"
import { startMaintenanceLoop } from "./maintenance.ts"
import { createOAuthSessions } from "./oauth-sessions.ts"
import { generateApiKey, newClientId } from "./keys.ts"
import { integrationsHome } from "./paths.ts"
import { createGatewayStore } from "./store.ts"
import type { GatewayStore } from "./store.ts"
import { createWebAssets } from "./web-assets.ts"

/** The client the local machine uses. Created on first start with mayMutate so
 *  an agent authoring workflows can discover and connect, with the human needed
 *  only for the one auth step. Keys issued to sandboxes do not get this. */
export const localClientName = "local"

export interface GatewayService {
  readonly home: string
  readonly store: GatewayStore
  readonly gateway: Gateway
  readonly handle: (request: Request, context?: GatewayRequestContext) => Promise<Response>
  close(): Promise<void>
}

export interface GatewayServiceOptions {
  readonly home?: string
  readonly retentionDays?: number
  /** Overrides integrations.sh for a private or test registry. */
  readonly registryUrl?: string
}

export const createGatewayService = async (
  options: GatewayServiceOptions = {}
): Promise<GatewayService> => {
  const home = options.home ?? integrationsHome()
  const store = await createGatewayStore(`${home}/gateway.sqlite`)
  const gateway = createGateway({ directory: home })
  const oauth = createOAuthSessions(gateway.executor)
  const maintenance = startMaintenanceLoop(store)
  const routes = gatewayRoutes({
    store,
    executor: gateway.executor,
    retentionDays: options.retentionDays ?? defaultArgumentRetentionDays,
    oauth,
    registryUrl: options.registryUrl
  })
  return {
    home,
    store,
    gateway,
    handle: createGatewayHandler({ store, routes }),
    close: async () => {
      maintenance.stop()
      oauth.stop()
      await gateway.close()
      await store.close()
    }
  }
}

/** Ensures the local client exists and has a live key, then records where the
 * gateway is listening. Idempotent apart from key issue: a fresh key is minted
 * whenever the recorded one is missing, so losing the config file is
 * recoverable without losing the client's grants. */
export const ensureLocalCredential = async (
  service: GatewayService,
  port: number
): Promise<string> => {
  const existing = await service.store.findClientByName(localClientName)
  const client = existing ?? await service.store.createClient({
    id: newClientId(),
    name: localClientName,
    mayMutate: true
  })
  const key = generateApiKey()
  await service.store.addApiKey({ id: key.id, clientId: client.id, hash: key.hash })
  await writeGatewayConfig(service.home, {
    port,
    url: `http://127.0.0.1:${port}`,
    apiKey: key.secret
  })
  return key.secret
}

export interface ServeOptions {
  readonly port?: number
  readonly hostname?: string
  readonly home?: string
  /** Overrides integrations.sh for a private or test registry. */
  readonly registryUrl?: string
  /** Serve the control plane at `/`. On by default; a headless gateway can turn
   *  it off so the only thing on the port is the API. */
  readonly web?: boolean
}

export interface RunningGateway {
  readonly port: number
  readonly url: string
  readonly service: GatewayService
  /** Where the control plane is being served from, or `undefined` when it is
   *  not being served at all. */
  readonly web: string | undefined
  stop(): Promise<void>
}

/** Binds to 127.0.0.1 unless told otherwise. What crosses this wire is a
 * credential that unlocks every connection a client holds, so exposing it
 * externally has to be a deliberate act rather than a default. */
export const serveGateway = async (options: ServeOptions = {}): Promise<RunningGateway> => {
  const service = await createGatewayService({
    home: options.home,
    registryUrl: options.registryUrl
  })
  const hostname = options.hostname ?? "127.0.0.1"
  const boundToLoopback = isLoopbackAddress(hostname)
  const web = options.web === false ? undefined : await createWebAssets()

  // The local key is minted below, once the port is known. Until then there is
  // nothing to borrow and a browser gets the same 401 as anyone else.
  let localSecret: string | undefined

  const server = Bun.serve({
    hostname,
    port: options.port ?? defaultGatewayPort,
    fetch: async (request, running) => {
      const pathname = new URL(request.url).pathname
      if (web !== undefined && !pathname.startsWith("/v1/")) {
        const asset = await web.respond(pathname)
        if (asset !== undefined) return asset
      }
      const local = localSecret
      const borrow = local !== undefined && mayBorrowLocalCredential(request, {
        boundToLoopback,
        port: Number(running.port),
        remoteAddress: running.requestIP(request)?.address
      })
      return await service.handle(request, borrow && local !== undefined ? { localSecret: local } : {})
    }
  })
  const port = Number(server.port)
  localSecret = await ensureLocalCredential(service, port)
  return {
    port,
    url: `http://${hostname}:${port}`,
    service,
    web: web?.directory,
    stop: async () => {
      server.stop(true)
      await service.close()
    }
  }
}
