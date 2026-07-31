#!/usr/bin/env node
const childProcess = require("node:child_process")
const fs = require("node:fs")
const path = require("node:path")
const os = require("node:os")

const binary = process.platform === "win32" ? "wf.exe" : "wf"
const platform = process.platform === "win32" ? "windows" : process.platform
const arch = os.arch()
const base = `@mokronos/wf-${platform}-${arch}`
const isMusl = () => {
  if (platform !== "linux") return false
  try {
    return process.report.getReport().header.glibcVersionRuntime === undefined
  } catch {
    return false
  }
}
const candidates = platform === "linux"
  ? (isMusl() ? [`${base}-musl`, base] : [base, `${base}-musl`])
  : [base]

const run = (targets, index = 0) => {
  const target = targets[index]
  const child = childProcess.spawn(target, process.argv.slice(2), { stdio: "inherit" })
  let retrying = false
  const forwardSignal = (signal) => {
    if (!child.killed) child.kill(signal)
  }
  const onSigint = () => forwardSignal("SIGINT")
  const onSigterm = () => forwardSignal("SIGTERM")
  const onSighup = () => forwardSignal("SIGHUP")
  const removeSignalHandlers = () => {
    process.off("SIGINT", onSigint)
    process.off("SIGTERM", onSigterm)
    process.off("SIGHUP", onSighup)
  }
  process.on("SIGINT", onSigint)
  process.on("SIGTERM", onSigterm)
  process.on("SIGHUP", onSighup)
  child.on("error", (error) => {
    removeSignalHandlers()
    if (error.code === "ENOENT" && index + 1 < targets.length) {
      retrying = true
      run(targets, index + 1)
      return
    }
    console.error(error.message)
    process.exit(1)
  })
  child.on("exit", (code, signal) => {
    removeSignalHandlers()
    if (retrying) return
    if (signal) process.kill(process.pid, signal)
    process.exit(typeof code === "number" ? code : 1)
  })
}

if (process.env.WF_BIN_PATH) { run([process.env.WF_BIN_PATH]) }
else {
  const targets = []
  for (const name of candidates) {
    try {
      const pkg = require.resolve(`${name}/package.json`)
      const candidate = path.join(path.dirname(pkg), "bin", binary)
      if (fs.existsSync(candidate)) targets.push(candidate)
    } catch {}
  }
  if (targets.length > 0) run(targets)
  else {
    console.error(`wf does not provide a binary for ${platform}-${arch}. Reinstall @mokronos/wf or set WF_BIN_PATH to a compatible binary.`)
    process.exit(1)
  }
}
