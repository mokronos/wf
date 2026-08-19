import { whenPresent } from "@mokronos/wfkit"
import { randomUUID } from "node:crypto"
import type { ExecutorAuthMethod, ExecutorConnection, ExecutorServices } from "@mokronos/wfkit-executor"
import { authorizeExecutorInBrowser } from "./oauth.ts"

export type OAuthSessionState =
  | { readonly status: "pending"; readonly authorizationUrl: string }
  | { readonly status: "connected"; readonly connection: ExecutorConnection }
  | { readonly status: "failed"; readonly message: string }

export type OAuthSession = {
  readonly id: string
  readonly integration: string
  readonly connection: string
  readonly state: OAuthSessionState
}

export interface OAuthSessions {
  start(input: {
    readonly integration: string
    readonly connection: string
    readonly authMethod: ExecutorAuthMethod
    readonly clientId?: string
    readonly clientSecret?: string
    readonly timeoutMs?: number
  }): Promise<OAuthSession>
  get(id: string): OAuthSession | undefined
  stop(): void
}

/** Sessions live in memory only. An in-flight browser redirect cannot survive a
 * daemon restart anyway — the ephemeral callback listener goes with it — so
 * persisting them would just create rows that can never complete.
 *
 * The gateway runs the flow and the caller polls, which is what lets the CLI
 * exit instead of holding a process open across a human's browser trip. */
export const createOAuthSessions = (
  executor: Pick<ExecutorServices, "auth">
): OAuthSessions => {
  const sessions = new Map<string, OAuthSession>()
  let stopped = false

  const put = (session: OAuthSession): void => {
    sessions.set(session.id, session)
  }

  return {
    start: async (input) => {
      if (stopped) throw new Error("The gateway is shutting down")
      const id = randomUUID()
      // Resolves once the provider's authorization URL is known, which is well
      // before the human finishes authorizing.
      const announced = Promise.withResolvers<string>()

      const flow = authorizeExecutorInBrowser({
        integration: input.integration,
        connection: input.connection,
        authMethod: input.authMethod,
        ...whenPresent("clientId", input.clientId),
        ...whenPresent("clientSecret", input.clientSecret),
        ...whenPresent("timeoutMs", input.timeoutMs),
        onAuthorizationUrl: (url) => announced.resolve(url)
      }, executor.auth)

      flow.then(
        (connection) => {
          const existing = sessions.get(id)
          if (existing === undefined) return
          put({ ...existing, state: { status: "connected", connection } })
          // A provider that short-circuits to an existing connection never
          // announces a URL, so unblock the caller either way.
          announced.resolve("")
        },
        (error) => {
          const message = error instanceof Error ? error.message : "OAuth authorization failed"
          const existing = sessions.get(id)
          if (existing !== undefined) {
            put({ ...existing, state: { status: "failed", message } })
          }
          announced.resolve("")
        }
      )

      const authorizationUrl = await announced.promise
      const session: OAuthSession = sessions.get(id) ?? {
        id,
        integration: input.integration,
        connection: input.connection,
        state: { status: "pending", authorizationUrl }
      }
      put(session)
      return session
    },

    get: (id) => sessions.get(id),

    stop: () => {
      stopped = true
      sessions.clear()
    }
  }
}
