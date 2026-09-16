import { HttpClient } from "effect/unstable/http"
import { OtlpLogger, OtlpSerialization, OtlpTracer } from "effect/unstable/observability"
import { Config, Effect, Layer, Option } from "effect"

/** The spread form of "include this field only when the value is there", kept
 *  beside the telemetry code that uses it rather than reaching into wfkit. */
const whenPresent = <K extends string, V>(
  key: K,
  value: V | null | undefined
): { readonly [P in K]?: V } =>
  Option.match(Option.fromNullishOr(value), {
    onNone: () => ({}),
    onSome: (present) => {
      const field: { [P in K]?: V } = {}
      field[key] = present
      return field
    }
  })

/** The config key holding the OTLP/HTTP base URL an app exports to, e.g.
 *  motel's `http://127.0.0.1:27686`. Unset or blank means telemetry is off:
 *  the layer below degrades to `Layer.empty` so callers never branch on
 *  whether tracing is enabled. */
export const telemetryEndpointConfigKey = "WF_OTLP_ENDPOINT"

/** The config key holding the raw value of the `authorization` header sent on
 *  every export request, e.g. Grafana Cloud's `Basic <base64(instance-id:token)>`.
 *  Ignored when {@link TelemetryOptions.headers} already carries its own
 *  `authorization`. */
export const telemetryAuthorizationConfigKey = "WF_OTLP_AUTHORIZATION"

export interface TelemetryOptions {
  /** `service.name` reported with every span and log record. */
  readonly serviceName: string
  readonly serviceVersion?: string | undefined
  /** OTLP/HTTP base URL. Defaults to {@link telemetryEndpointConfigKey};
   *  absent disables export entirely (no exporter is built). */
  readonly endpoint?: string | undefined
  /** Extra headers on every export request — how hosted endpoints authenticate
   *  (Grafana Cloud wants `authorization: Basic <base64(id:token)>`). Merged
   *  over {@link telemetryAuthorizationConfigKey}. */
  readonly headers?: Record<string, string> | undefined
}

/** Blank is the same as absent, so an exported-but-empty variable in a shell
 *  profile or systemd unit reads as "telemetry off" rather than as a bad URL. */
const presentText = (key: string): Effect.Effect<string | undefined> =>
  Config.String(key).pipe(
    Config.map((value) => value.trim()),
    Config.option,
    Config.map(Option.filter((value) => value.length > 0)),
    Config.map(Option.getOrUndefined),
    Effect.orElseSucceed(() => undefined)
  )

/** The one telemetry layer: OTLP traces + logs over HTTP/JSON, off unless an
 *  endpoint resolves. Logs merge with whatever logger already exists, so
 *  console output survives when export turns on. Metrics are deliberately not
 *  exported — usage analytics is queries over spans and logs.
 *
 *  Provide it at composition roots with `Layer.provideMerge` (or a plain
 *  merge), so the built tracer lands in the root environment: provided-only
 *  layers satisfy engine requirements but leave the outermost span on the
 *  no-op default tracer, which exports nothing. */
export const telemetryLayer = (
  options: TelemetryOptions
): Layer.Layer<never, never, HttpClient.HttpClient> =>
  Layer.unwrap(Effect.gen(function* () {
    const endpoint = options.endpoint ?? (yield* presentText(telemetryEndpointConfigKey))
    const url = endpoint?.trim().replace(/\/+$/, "")
    if (url === undefined || url.length === 0) return Layer.empty

    // Explicit option headers win; the configured authorization only fills a
    // gap, so a caller can override it without unsetting the variable.
    const authorization = options.headers?.["authorization"]
      ?? (yield* presentText(telemetryAuthorizationConfigKey))
    const headers = { ...options.headers, ...whenPresent("authorization", authorization) }
    const resource = {
      serviceName: options.serviceName,
      serviceVersion: options.serviceVersion
    }
    const exporter = {
      resource,
      ...whenPresent("headers", Object.keys(headers).length === 0 ? undefined : headers)
    }

    return Layer.merge(
      OtlpTracer.layer({ url: `${url}/v1/traces`, ...exporter }),
      OtlpLogger.layer({ url: `${url}/v1/logs`, ...exporter })
    ).pipe(Layer.provide(OtlpSerialization.layerJson))
  }))
