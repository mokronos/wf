import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import path from "node:path"
import { defineConfig } from "vite"
import { workflowArtifactToGraph } from "../../packages/wf/src/sdk/graph"
import { createSqliteWorkflowRepository } from "../../packages/wf/src/sdk/sqlite"

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
        const repository = createSqliteWorkflowRepository({
          rootDir: path.resolve(import.meta.dirname, "../..")
        })

        server.middlewares.use("/api", async (request, response, next) => {
          const url = new URL(request.url ?? "/", "http://localhost")
          const pathname = url.pathname.startsWith("/api/")
            ? url.pathname.slice("/api".length)
            : url.pathname
          try {
            if (pathname === "/workflows") {
              const artifacts = await repository.list()
              const workflows = await Promise.all(
                artifacts.map((artifact) => workflowArtifactToGraph(artifact, { maxNodes: 120 }))
              )

              json(response, 200, {
                generatedAt: new Date().toISOString(),
                workflows
              })
              return
            }

            if (pathname === "/runs") {
              json(response, 200, {
                generatedAt: new Date().toISOString(),
                runs: await repository.listRuns()
              })
              return
            }

            const eventsMatch = /^\/runs\/([^/]+)\/events$/.exec(pathname)
            if (eventsMatch !== null) {
              const run = await repository.getRun(decodeURIComponent(eventsMatch[1]!))
              if (run === undefined) {
                json(response, 404, { error: "Run not found" })
                return
              }

              json(response, 200, {
                generatedAt: new Date().toISOString(),
                run,
                events: await repository.listRunEvents(run.id)
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
    fs: {
      allow: [path.resolve(import.meta.dirname, "../..")]
    }
  }
})
