// Standalone mock API server so the workflow can be driven from the wf CLI:
//
//   bun run serve-api.ts [port]     (default 8788)
//
// Check GET /state for a summary of stock, reservations, charges, shipments.

import { startMockApi } from "./mock-api"

const port = Number.parseInt(process.argv[2] ?? "8788", 10)
const api = startMockApi({ port })
console.log(`mock order API listening on ${api.url} (GET ${api.url}/state for a summary)`)
