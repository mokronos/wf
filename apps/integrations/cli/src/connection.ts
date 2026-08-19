import { Data, Predicate } from "effect"
import { createGatewayClient, GatewayError, resolveClientConnection } from "@mokronos/integrations-client"
import type { GatewayClient } from "@mokronos/integrations-client"

export class IntegrationsCliError extends Data.TaggedError("IntegrationsCliError")<{
  readonly message: string
}> {}

export const cliError = (message: string): IntegrationsCliError =>
  new IntegrationsCliError({ message })

/** Whether a refusal is about what this key *may do* rather than about what it
 *  asked for. Only that one is worth explaining rather than restating, because
 *  the fix is a different key rather than a different request — and saying so
 *  about an ordinary denial sends the reader after the wrong thing. */
const isCapabilityRefusal = (error: GatewayError): boolean =>
  error.status === 403 &&
  Predicate.isObjectOrArray(error.body) &&
  "code" in error.body &&
  error.body["code"] === "not-permitted"

// A caught value. TypeScript types every catch binding as unknown because
// JavaScript lets any value be thrown, so there is nothing narrower to accept.
// oxlint-disable-next-line anti-slop/no-unknown-parameters
export const describeError = (error: unknown): string => {
  if (error instanceof IntegrationsCliError) return error.message
  if (error instanceof GatewayError) {
    return isCapabilityRefusal(error)
      ? `${error.message} (use a key whose client may mutate)`
      : error.message
  }
  return error instanceof Error ? error.message : String(error)
}

/** Every command goes through the gateway; there is no local fallback. If the
 * daemon is not running there is nothing sensible to do, because the
 * credentials live behind it. */
export const connectToGateway = async (): Promise<GatewayClient> => {
  const connection = await resolveClientConnection()
  if (connection === undefined) {
    throw cliError(
      "No gateway found. Start one with `integrations serve`, or set INTEGRATIONS_URL and INTEGRATIONS_API_KEY."
    )
  }
  return createGatewayClient(connection)
}

export const openBrowser = (url: string): void => {
  const command = process.platform === "darwin"
    ? ["open", url]
    : process.platform === "win32"
      ? ["cmd", "/c", "start", "", url]
      : ["xdg-open", url]
  Bun.spawn(command, { stdout: "ignore", stderr: "ignore" })
}
