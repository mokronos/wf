import { Schema } from "effect"
import {
  completeExecutorOAuth,
  createExecutorOAuthClient,
  ExecutorAuthMethod,
  ExecutorConnection,
  probeExecutorOAuth,
  registerExecutorOAuthClient,
  startExecutorOAuth
} from "@mokronos/wfkit"

export const openBrowser = (url: string): void => {
  const command = process.platform === "darwin"
    ? ["open", url]
    : process.platform === "win32"
      ? ["cmd", "/c", "start", "", url]
      : ["xdg-open", url]
  Bun.spawn(command, { stdout: "ignore", stderr: "ignore" })
}

const AuthorizeExecutorOptions = Schema.Struct({
  integration: Schema.String,
  connection: Schema.String,
  authMethod: ExecutorAuthMethod,
  scopes: Schema.optional(Schema.Array(Schema.String)),
  clientId: Schema.optional(Schema.String),
  clientSecret: Schema.optional(Schema.String),
  timeoutMs: Schema.optional(Schema.Number)
})
type AuthorizeExecutorOptions = typeof AuthorizeExecutorOptions.Type

const browserResponse = (options: {
  readonly title: string
  readonly message: string
  readonly status?: number
}): Response => new Response(`<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${options.title}</title></head>
<body style="font:16px system-ui,sans-serif;max-width:38rem;margin:12vh auto;padding:0 1.5rem;line-height:1.5">
<h1>${options.title}</h1><p>${options.message}</p>
</body>
</html>`, {
  status: options.status ?? 200,
  headers: { "content-type": "text/html; charset=utf-8" }
})

export const authorizeExecutorInBrowser = async (
  input: AuthorizeExecutorOptions & {
    readonly open?: (url: string) => void | Promise<void>
    readonly onAuthorizationUrl?: (url: string) => void
  }
): Promise<ExecutorConnection> => {
  const options = Schema.decodeUnknownSync(AuthorizeExecutorOptions)(input)
  if (options.authMethod.kind !== "oauth" || options.authMethod.oauth === undefined) {
    throw new Error(`Auth method ${options.authMethod.id} is not OAuth`)
  }
  const completion = Promise.withResolvers<ExecutorConnection>()
  let callbackStarted = false
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request): Promise<Response> {
      const url = new URL(request.url)
      if (request.method !== "GET" || url.pathname !== "/oauth/callback") {
        return new Response("Not found", { status: 404 })
      }
      if (callbackStarted) {
        return browserResponse({
          title: "Authorization unavailable",
          message: "This authorization callback is no longer active. Return to the terminal and try again.",
          status: 409
        })
      }
      callbackStarted = true
      const state = url.searchParams.get("state")
      const code = url.searchParams.get("code")
      if (state === null || code === null) {
        const error = new Error(url.searchParams.get("error_description") ?? "OAuth callback is missing state or code")
        setTimeout(() => completion.reject(error), 0)
        return browserResponse({
          title: "Authorization failed",
          message: "The provider did not return a usable authorization code.",
          status: 400
        })
      }
      try {
        const connection = await completeExecutorOAuth({
          state,
          code,
          callbackDomain: url.searchParams.get("domain") ?? url.searchParams.get("site")
        })
        setTimeout(() => completion.resolve(connection), 0)
        return browserResponse({
          title: "Account connected",
          message: "Authorization completed. You can close this window and return to wf."
        })
      } catch (error) {
        setTimeout(() => completion.reject(error), 0)
        return browserResponse({
          title: "Authorization failed",
          message: "The callback could not be verified. Return to the terminal for details and try again.",
          status: 400
        })
      }
    }
  })
  const timeoutMs = Math.max(1_000, options.timeoutMs ?? 300_000)
  const timeout = setTimeout(
    () => completion.reject(new Error(`OAuth authorization timed out after ${Math.ceil(timeoutMs / 1000)} seconds`)),
    timeoutMs
  )
  try {
    const redirectUri = `http://127.0.0.1:${server.port}/oauth/callback`
    const oauth = options.authMethod.oauth
    const discovered = oauth.discoveryUrl === undefined
      ? undefined
      : await probeExecutorOAuth(oauth.discoveryUrl)
    const authorizationUrl = oauth.authorizationUrl ?? discovered?.authorizationUrl
    const tokenUrl = oauth.tokenUrl ?? discovered?.tokenUrl
    const resource = oauth.resource ?? discovered?.resource
    if (authorizationUrl === undefined || tokenUrl === undefined) {
      throw new Error("Executor could not discover OAuth authorization and token endpoints")
    }
    const clientSlug = `${options.integration}-wf`
    let client: string
    if (options.clientId !== undefined) {
      client = await createExecutorOAuthClient({
        slug: clientSlug,
        integration: options.integration,
        authorizationUrl,
        tokenUrl,
        clientId: options.clientId,
        ...(options.clientSecret === undefined ? {} : { clientSecret: options.clientSecret }),
        ...(resource === undefined ? {} : { resource })
      })
    } else {
      const registrationEndpoint = oauth.registrationEndpoint ?? discovered?.registrationEndpoint
      if (registrationEndpoint === null || registrationEndpoint === undefined) {
        throw new Error("OAuth server does not support dynamic registration; provide --client-id")
      }
      client = await registerExecutorOAuthClient({
        slug: clientSlug,
        integration: options.integration,
        redirectUri,
        registrationEndpoint,
        authorizationUrl,
        tokenUrl,
        scopes: options.scopes ?? oauth.scopes ?? discovered?.scopesSupported ?? [],
        ...(discovered?.issuer === undefined ? {} : { issuer: discovered.issuer }),
        ...(resource === undefined ? {} : { resource }),
        ...(discovered?.tokenEndpointAuthMethodsSupported === undefined
          ? {}
          : {
              tokenEndpointAuthMethodsSupported:
                discovered.tokenEndpointAuthMethodsSupported
            })
      })
    }
    const started = await startExecutorOAuth({
      client,
      integration: options.integration,
      connection: options.connection,
      template: options.authMethod.template,
      redirectUri
    })
    if (started.status === "connected") {
      return {
        owner: started.connection.owner,
        name: String(started.connection.name),
        integration: String(started.connection.integration),
        template: String(started.connection.template),
        address: String(started.connection.address),
        ...(started.connection.identityLabel === undefined
          ? {}
          : { identityLabel: started.connection.identityLabel }),
        ...(started.connection.expiresAt === undefined
          ? {}
          : { expiresAt: started.connection.expiresAt })
      }
    }
    input.onAuthorizationUrl?.(started.authorizationUrl)
    await (input.open ?? openBrowser)(started.authorizationUrl)
    return await completion.promise
  } finally {
    clearTimeout(timeout)
    server.stop(true)
  }
}
