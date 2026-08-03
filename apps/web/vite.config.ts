import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import path from "node:path"
import { defineConfig } from "vite"
import { homedir } from "node:os"
import { workflowArtifactToGraph } from "../../packages/wf/src/sdk/graph"
import { createDirectoryWorkflowCatalog } from "../../packages/wf/src/sdk/catalog"

const wfHome = process.env["WF_HOME"] ?? path.join(homedir(), ".wf")

// Run state lives in the engine database behind a Bun-only client, and this dev
// server runs under Node. Workflows are plain files, so they are served here;
// anything about runs is proxied to `wf daemon --foreground`.
const daemonTarget = process.env["WF_DAEMON_URL"] ?? "http://127.0.0.1:4787"

const json = (response: { statusCode: number; setHeader: (name: string, value: string) => void; end: (body: string) => void }, statusCode: number, body: unknown) => {
  response.statusCode = statusCode
  response.setHeader("Content-Type", "application/json")
  response.end(JSON.stringify(body))
}

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    {
      name: "wf-dashboard-api",
      configureServer(server) {
        const catalog = createDirectoryWorkflowCatalog({
          directory: path.join(wfHome, "workflows")
        })

        server.middlewares.use("/api", async (request, response, next) => {
          const url = new URL(request.url ?? "/", "http://localhost")
          const pathname = url.pathname.startsWith("/api/")
            ? url.pathname.slice("/api".length)
            : url.pathname
          try {
            if (pathname === "/workflows") {
              const artifacts = await catalog.list()
              const workflows = await Promise.all(
                artifacts.map((artifact) => workflowArtifactToGraph(artifact, { maxNodes: 120 }))
              )

              json(response, 200, {
                generatedAt: new Date().toISOString(),
                workflows
              })
              return
            }

            next()
          } catch (error) {
            json(response, 500, {
              error: error instanceof Error ? error.message : String(error)
            })
          }
        })
      }
    }
  ],
  clearScreen: false,
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "./src")
    }
  },
  server: {
    proxy: {
      "/api/runs": {
        target: daemonTarget,
        changeOrigin: true
      }
    },
    fs: {
      allow: [path.resolve(import.meta.dirname, "../..")]
    }
  }
})
