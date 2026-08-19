import { whenPresent } from "@mokronos/wfkit"
import { IntegrationSlug } from "@executor-js/sdk/core"
import { Option, Schema } from "effect"
import { runExecutor } from "./default-host.ts"
import type { ExecutorRunner } from "./host.ts"
import {
  ExecutorDetection,
  ExecutorIntegration,
  ExecutorMcpProbe,
  ExecutorOpenApiPreview
} from "./schemas.ts"

export interface ExecutorCatalog {
  readonly detectIntegration: (url: string) => Promise<ReadonlyArray<ExecutorDetection>>
  readonly probeMcp: (url: string) => Promise<ExecutorMcpProbe>
  readonly previewOpenApi: (spec: string) => Promise<ExecutorOpenApiPreview>
  readonly addMcp: (options: {
    readonly endpoint: string
    readonly name: string
    readonly slug: string
    readonly auth: "none" | "oauth2" | "bearer"
  }) => Promise<string>
  readonly addOpenApi: (options: {
    readonly spec: string
    readonly slug: string
    readonly name?: string
    readonly description?: string
    readonly baseUrl?: string
  }) => Promise<string>
  readonly list: () => Promise<ReadonlyArray<ExecutorIntegration>>
  readonly find: (slug: string) => Promise<ExecutorIntegration | undefined>
}

/** Catalog operations bound to an explicit host/runner. */
export const createExecutorCatalog = (runner: ExecutorRunner): ExecutorCatalog => {
  const list = async (): Promise<ReadonlyArray<ExecutorIntegration>> =>
    await runner.run((executor) => executor.integrations.list()).then((integrations) =>
      Schema.decodeUnknownSync(Schema.Array(ExecutorIntegration))(
        integrations.filter((integration) => integration.kind !== "built-in")
      )
    )

  const catalog: ExecutorCatalog = {
    detectIntegration: async (url) => Schema.decodeUnknownSync(Schema.Array(ExecutorDetection))(
      await runner.run((executor) => executor.integrations.detect(url))
    ),
    probeMcp: async (url) => Schema.decodeUnknownSync(ExecutorMcpProbe)(
      await runner.run((executor) => executor.mcp.probeEndpoint(url))
    ),
    previewOpenApi: async (spec) => {
      const preview = await runner.run((executor) => executor.openapi.previewSpec(spec))
      return Schema.decodeUnknownSync(ExecutorOpenApiPreview)({
        title: Option.getOrNull(preview.title),
        description: Option.getOrNull(preview.description),
        version: Option.getOrNull(preview.version),
        operationCount: preview.operationCount,
        operations: preview.operations.map((operation) => ({
          operationId: operation.operationId,
          method: operation.method,
          path: operation.path,
          summary: Option.getOrNull(operation.summary),
          tags: operation.tags,
          deprecated: operation.deprecated
        })),
        tags: preview.tags,
        servers: preview.servers.map((server) => ({
          url: server.url,
          description: Option.getOrNull(server.description)
        })),
        securitySchemes: preview.securitySchemes.map((scheme) => ({
          name: scheme.name,
          type: scheme.type,
          scheme: Option.getOrNull(scheme.scheme),
          bearerFormat: Option.getOrNull(scheme.bearerFormat),
          in: Option.getOrNull(scheme.in),
          headerName: Option.getOrNull(scheme.headerName),
          description: Option.getOrNull(scheme.description),
          openIdConnectUrl: Option.getOrNull(scheme.openIdConnectUrl)
        }))
      })
    },
    addMcp: async (options) =>
      await runner.run((executor) => executor.mcp.addServer({
        transport: "remote",
        endpoint: options.endpoint,
        name: options.name,
        slug: options.slug,
        auth: options.auth === "bearer"
          ? { kind: "header", headerName: "Authorization", prefix: "Bearer " }
          : { kind: options.auth }
      })).then((result) => result.slug),
    addOpenApi: async (options) =>
      await runner.run((executor) => executor.openapi.addSpec({
        spec: { kind: "url", url: options.spec },
        slug: options.slug,
        ...whenPresent("name", options.name),
        ...whenPresent("description", options.description),
        ...whenPresent("baseUrl", options.baseUrl)
      })).then((result) => String(result.slug)),
    list,
    find: async (slug) => {
      const integration = await runner.run((executor) =>
        executor.integrations.get(IntegrationSlug.make(slug))
      )
      if (integration === null || integration.kind === "built-in") return undefined
      return Schema.decodeUnknownSync(ExecutorIntegration)(integration)
    }
  }
  return catalog
}

const defaultCatalog = createExecutorCatalog({ run: runExecutor })

/** Read-only endpoint detection. It neither installs the integration nor creates
 * a connection. */
export const detectExecutorIntegration = defaultCatalog.detectIntegration

/** Read-only MCP endpoint inspection. */
export const probeExecutorMcp = defaultCatalog.probeMcp

/** Read-only OpenAPI document inspection. */
export const previewExecutorOpenApi = defaultCatalog.previewOpenApi

/** Installs an MCP endpoint in the persisted integration catalog. */
export const addExecutorMcp = defaultCatalog.addMcp

/** Installs an OpenAPI document in the persisted integration catalog. */
export const addExecutorOpenApi = defaultCatalog.addOpenApi

/** Lists integrations already installed in the persisted catalog. */
export const listExecutorIntegrations = defaultCatalog.list

/** Resolves one installed integration without coupling callers to list/filter
 * details. */
export const findExecutorIntegration = defaultCatalog.find
