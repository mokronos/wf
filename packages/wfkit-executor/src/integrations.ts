/** Compatibility barrel for integration-facing APIs. Discovery, connection
 * policy, projections, and validation are implemented independently. */
export {
  createIntegrationDiscovery,
  inspectIntegration
} from "./discovery.ts"
export type { IntegrationDiscoveryDependencies } from "./discovery.ts"
export {
  createIntegrationProvisioning,
  discoverIntegration,
  installIntegration
} from "./provisioning.ts"
export type { IntegrationProvisioningDependencies } from "./provisioning.ts"
export {
  IntegrationDiscovery,
  IntegrationInspection,
  IntegrationKind,
  IntegrationNodeConfig,
  IntegrationValidationFinding,
  IntegrationValidationReport
} from "./integration-model.ts"
export type { DiscoverIntegrationsOptions } from "./integration-model.ts"
export { createIntegrationOverview, listIntegrationOverviews } from "./overview.ts"
export type { IntegrationOverviewDependencies } from "./overview.ts"
export {
  createIntegrationValidation,
  validateExecutorToolAddress,
  validateExecutorToolAddresses,
  validateIntegrationNode
} from "./validation.ts"
export type { IntegrationValidationDependencies } from "./validation.ts"
