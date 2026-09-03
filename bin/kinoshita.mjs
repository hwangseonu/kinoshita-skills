#!/usr/bin/env node

import { resolve } from "node:path"
import {
  installPackage,
  loadRegistry,
  renderMcpConfig,
  SUPPORTED_AGENTS,
} from "../lib/marketplace.mjs"

const USAGE = `Usage:
  kinoshita list
  kinoshita validate
  kinoshita install <package> --agent <agent> [--scope project|user] [--project <path>]
  kinoshita mcp-config <server> --agent <agent>

Agents: ${SUPPORTED_AGENTS.join(", ")}`

function parseArguments(args) {
  const positionals = []
  const options = {}
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    if (!argument.startsWith("--")) {
      positionals.push(argument)
      continue
    }
    const key = argument.slice(2)
    if (!new Set(["agent", "scope", "project"]).has(key)) throw new Error(`Unknown option: ${argument}`)
    const value = args[index + 1]
    if (!value || value.startsWith("--")) throw new Error(`${argument} requires a value`)
    if (options[key] !== undefined) throw new Error(`${argument} was provided more than once`)
    options[key] = value
    index += 1
  }
  return { options, positionals }
}

function requireAgent(agent) {
  if (!agent) throw new Error("--agent is required")
  if (!SUPPORTED_AGENTS.includes(agent)) throw new Error(`Unsupported agent: ${agent}`)
}

function printRegistry(registry) {
  console.log(`${registry.name}: ${registry.description}`)
  console.log("\nPackages")
  if (registry.packages.length === 0) console.log("  (none)")
  for (const entry of registry.packages) {
    console.log(`  ${entry.name} ${entry.version} [${entry.agents.join(", ")}]`)
    console.log(`    ${entry.description}`)
    for (const skill of entry.skills) console.log(`    - ${skill.name}`)
  }
  console.log("\nMCP servers")
  if (registry.mcp_servers.length === 0) console.log("  (none)")
  for (const server of registry.mcp_servers) {
    console.log(`  ${server.name} ${server.version} [${server.agents.join(", ")}]`)
    console.log(`    ${server.description}`)
  }
}

async function main() {
  const [command, ...args] = process.argv.slice(2)
  if (!command || new Set(["help", "--help", "-h"]).has(command)) {
    console.log(USAGE)
    return
  }
  const { registry, rootDir } = await loadRegistry()
  if (command === "list") {
    if (args.length > 0) throw new Error("list does not accept arguments")
    printRegistry(registry)
    return
  }
  if (command === "validate") {
    if (args.length > 0) throw new Error("validate does not accept arguments")
    console.log("Registry is valid")
    return
  }

  const { options, positionals } = parseArguments(args)
  if (command === "install") {
    if (positionals.length !== 1) throw new Error("install requires one package name")
    requireAgent(options.agent)
    const scope = options.scope ?? "project"
    if (options.project && scope !== "project") {
      throw new Error("--project can only be used with project scope")
    }
    const result = await installPackage(registry, positionals[0], {
      agent: options.agent,
      projectRoot: options.project ? resolve(options.project) : process.cwd(),
      rootDir,
      scope,
    })
    console.log(`Installed ${positionals[0]} for ${options.agent} (${scope})`)
    for (const path of result.installed) console.log(`  ${path}`)
    return
  }
  if (command === "mcp-config") {
    if (positionals.length !== 1) throw new Error("mcp-config requires one server name")
    if (options.scope || options.project) throw new Error("mcp-config only accepts --agent")
    requireAgent(options.agent)
    const server = registry.mcp_servers.find((entry) => entry.name === positionals[0])
    if (!server) throw new Error(`Unknown MCP server: ${positionals[0]}`)
    process.stdout.write(renderMcpConfig(server, options.agent))
    return
  }
  throw new Error(`Unknown command: ${command}`)
}

main().catch((error) => {
  console.error(error.message)
  console.error(`\n${USAGE}`)
  process.exitCode = 1
})
