import { defineConfig } from "astro/config"

const repository = process.env.GITHUB_REPOSITORY?.split("/")[1]
const base = process.env.BASE_PATH ?? (repository === undefined ? "/" : `/${repository}`)

export default defineConfig({
  site: process.env.SITE_URL ?? "https://mokronos.github.io",
  base,
  output: "static"
})
