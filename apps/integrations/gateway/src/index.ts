export { gatewayDatabasePath, integrationsHome } from "./paths.ts"
export { createGateway } from "./host.ts"
export type { Gateway } from "./host.ts"

export {
  Alias,
  ApiKey,
  ApiKeyHash,
  ApiKeyId,
  ApprovalId,
  ApprovalStatus,
  AuditArguments,
  AuditId,
  AuditOutcome,
  AuditRecord,
  Authorization,
  Client,
  ClientId,
  connectionSubject,
  ConnectionName,
  ConnectionRef,
  describeAuthorization,
  DriftEntry,
  DriftKind,
  Grant,
  GrantDecision,
  GrantId,
  IntegrationSlug,
  OwnerTier,
  PendingApproval,
  SubjectId,
  TenantId,
  ToolName,
  ToolSnapshot
} from "./domain.ts"

export {
  generateApiKey,
  hashApiKey,
  newApprovalId,
  newAuditId,
  newClientId,
  newGrantId
} from "./keys.ts"
export type { IssuedApiKey } from "./keys.ts"

export { createGatewayStore } from "./store.ts"
export type {
  CreateApprovalInput,
  CreateClientInput,
  CreateGrantInput,
  GatewayStore,
  RecordAuditInput
} from "./store.ts"

export { authenticateClient, authorizeInvocation, authorizeMutation } from "./authorize.ts"
export type { ClientAuthentication, MutationAuthorization } from "./authorize.ts"

export {
  defaultApprovalExpiryHours,
  defaultArgumentRetentionDays,
  defaultGatewayPort,
  gatewayConfigPath,
  GatewayConfigFile,
  readGatewayConfig,
  resolveClientConnection,
  writeGatewayConfig
} from "./config.ts"
export type { ClientConnection } from "./config.ts"

export {
  executeAuthorized,
  grantToolAddress,
  invokeThroughGateway,
  listGrantedTools
} from "./invoke.ts"
export type { InvocationOutcome, InvokeDependencies } from "./invoke.ts"

export { diffSnapshots, refreshIntegrationSnapshot } from "./drift.ts"
export type { ToolCatalogReader } from "./drift.ts"
export type { DriftReport } from "./drift.ts"
export { runMaintenance, startMaintenanceLoop } from "./maintenance.ts"
export type { MaintenanceLoop, MaintenanceResult } from "./maintenance.ts"
export { createOAuthSessions } from "./oauth-sessions.ts"
export type { OAuthSession, OAuthSessions, OAuthSessionState } from "./oauth-sessions.ts"

export { gatewayRoutes } from "./http/api.ts"
export type { ApiDependencies } from "./http/api.ts"
export { createGatewayHandler } from "./http/handler.ts"
export type { GatewayRequestContext } from "./http/handler.ts"
export {
  isLoopbackAddress,
  isLoopbackHostHeader,
  mayBorrowLocalCredential
} from "./http/loopback.ts"
export type { LoopbackBootstrap } from "./http/loopback.ts"
export { createWebAssets } from "./web-assets.ts"
export type { WebAssets, WebAssetsOptions } from "./web-assets.ts"
export { matchRoute } from "./http/router.ts"
export type { Route, RouteAccess, RouteRequest, RouteResult } from "./http/router.ts"

export {
  createGatewayService,
  ensureLocalCredential,
  localClientName,
  serveGateway
} from "./service.ts"
export type {
  GatewayService,
  GatewayServiceOptions,
  RunningGateway,
  ServeOptions
} from "./service.ts"

// Re-exported so consumers compose Executor through the gateway rather than
// reaching for the host package directly. `wfkit-executor` is an internal
// dependency of the gateway from here on.
export {
  createExecutorHost,
  createExecutorServices
} from "@mokronos/wfkit-executor"
export type {
  ExecutorHost,
  ExecutorServices
} from "@mokronos/wfkit-executor"
