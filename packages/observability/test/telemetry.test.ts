import { assert, describe, it } from "@effect/vitest"
import { ConfigProvider, Effect, Layer, Tracer } from "effect"
import { HttpClient, HttpClientResponse } from "effect/unstable/http"
import {
  telemetryAuthorizationConfigKey,
  telemetryEndpointConfigKey,
  telemetryLayer
} from "../src/telemetry.ts"

/** Telemetry only needs *an* HttpClient to build its exporters; the suite is
 *  about which layer gets built, so requests are answered without a socket. */
const stubHttpClient = Layer.succeed(
  HttpClient.HttpClient,
  HttpClient.make((request) =>
    Effect.succeed(HttpClientResponse.fromWeb(request, new Response(null, { status: 200 })))
  )
)

const withConfig = (entries: Record<string, string>) =>
  ConfigProvider.layer(ConfigProvider.fromEnvRecord(entries))

/** "Off" means the layer left the default tracer in place, so nothing is
 *  exported and no caller has to branch on whether tracing is enabled. */
const exportsTraces = (
  options: Parameters<typeof telemetryLayer>[0],
  entries: Record<string, string> = {}
) =>
  Effect.map(Tracer.Tracer, (tracer) => tracer !== Tracer.nativeTracer).pipe(
    Effect.provide(
      telemetryLayer(options).pipe(
        Layer.provide(stubHttpClient),
        Layer.provide(withConfig(entries))
      )
    )
  )

describe("telemetryLayer", () => {
  it.effect("stays off when no endpoint resolves", () =>
    Effect.gen(function* () {
      assert.isFalse(yield* exportsTraces({ serviceName: "test" }))
    }))

  it.effect("treats a blank configured endpoint as off", () =>
    Effect.gen(function* () {
      assert.isFalse(
        yield* exportsTraces({ serviceName: "test" }, { [telemetryEndpointConfigKey]: "   " })
      )
    }))

  it.effect("installs an exporting tracer for a configured endpoint", () =>
    Effect.gen(function* () {
      assert.isTrue(
        yield* exportsTraces(
          { serviceName: "test" },
          { [telemetryEndpointConfigKey]: "  http://127.0.0.1:27686/  " }
        )
      )
    }))

  it.effect("an explicit endpoint option wins over configuration", () =>
    Effect.gen(function* () {
      assert.isTrue(
        yield* exportsTraces({ serviceName: "test", endpoint: "http://127.0.0.1:27686" })
      )
    }))

  it.effect("a configured authorization does not by itself enable export", () =>
    Effect.gen(function* () {
      assert.isFalse(
        yield* exportsTraces(
          { serviceName: "test" },
          { [telemetryAuthorizationConfigKey]: "Basic dXNlcjpwYXNz" }
        )
      )
    }))
})
