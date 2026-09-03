import { cp, lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, stat } from "node:fs/promises"
import { homedir } from "node:os"
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const MARKETPLACE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const VERSION_PATTERN = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/
const ENV_PATTERN = /^[A-Z_][A-Z0-9_]*$/

export const REGISTRY_PATH = resolve(MARKETPLACE_ROOT, "registry.json")
const AGENTS = {
  claude: {
    installPaths: {
      project: [".claude", "skills"],
      user: [".claude", "skills"],
    },
    environmentReference: (name) => `\${${name}}`,
    renderMcp: (server) => mcpJsonDocument(server, "claude", "mcpServers"),
  },
  codex: {
    installPaths: {
      project: [".agents", "skills"],
      user: [".agents", "skills"],
    },
    renderMcp: mcpCodexConfig,
  },
  opencode: {
    installPaths: {
      project: [".opencode", "skills"],
      user: [".config", "opencode", "skills"],
    },
    environmentReference: (name) => `{env:${name}}`,
    renderMcp: (server) => mcpJsonDocument(server, "opencode", "mcp"),
  },
  hermes: {
    installPaths: {
      project: [".hermes", "skills"],
      user: [".hermes", "skills"],
    },
    environmentReference: (name) => `\${${name}}`,
    renderMcp: mcpHermesConfig,
  },
}
export const SUPPORTED_AGENTS = Object.keys(AGENTS)

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

function hasOnlyKeys(value, allowedKeys, label, errors) {
  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) errors.push(`${label}.${key} is not allowed`)
  }
}

function validateString(value, label, errors) {
  if (typeof value !== "string" || value.length === 0) {
    errors.push(`${label} must be a non-empty string`)
    return false
  }
  return true
}

function validateName(value, label, errors) {
  if (!validateString(value, label, errors)) return false
  if (value.length > 64) {
    errors.push(`${label} must be at most 64 characters`)
    return false
  }
  if (!NAME_PATTERN.test(value)) {
    errors.push(`${label} must contain lowercase letters, numbers, and single hyphens only`)
    return false
  }
  return true
}

function validateVersion(value, label, errors) {
  if (typeof value !== "string" || !VERSION_PATTERN.test(value)) {
    errors.push(`${label} must be a semantic version`)
  }
}

function validateAgents(agents, label, errors) {
  if (!Array.isArray(agents) || agents.length === 0) {
    errors.push(`${label} must be a non-empty array`)
    return
  }
  const seen = new Set()
  for (const agent of agents) {
    if (!SUPPORTED_AGENTS.includes(agent)) errors.push(`${label} contains unsupported agent ${agent}`)
    if (seen.has(agent)) errors.push(`${label} contains duplicate agent ${agent}`)
    seen.add(agent)
  }
}

function isInside(parent, child) {
  const path = relative(parent, child)
  return path === "" || (!path.startsWith("..") && !isAbsolute(path))
}

async function validateDirectory(rootDir, path, label, errors) {
  if (!validateString(path, label, errors)) return null
  if (isAbsolute(path)) {
    errors.push(`${label} must be relative to the registry`)
    return null
  }
  const unresolvedPath = resolve(rootDir, path)
  if (!isInside(rootDir, unresolvedPath)) {
    errors.push(`${label} must stay inside the registry directory`)
    return null
  }
  try {
    const resolvedPath = await realpath(unresolvedPath)
    if (!isInside(rootDir, resolvedPath)) {
      errors.push(`${label} resolves outside the registry directory`)
      return null
    }
    if (!(await stat(resolvedPath)).isDirectory()) {
      errors.push(`${label} must point to a directory`)
      return null
    }
    return resolvedPath
  } catch {
    errors.push(`${label} does not exist`)
    return null
  }
}

function readFrontmatterValue(frontmatter, key) {
  const match = new RegExp(`^${key}:\\s*(.+)$`, "m").exec(frontmatter)
  if (!match) return null
  const value = match[1].trim()
  if (value.startsWith('"') && value.endsWith('"')) {
    try {
      return JSON.parse(value)
    } catch {
      return null
    }
  }
  if (value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1).replaceAll("''", "'")
  return value
}

async function validateSkill(rootDir, skill, label, errors) {
  if (!isObject(skill)) {
    errors.push(`${label} must be an object`)
    return null
  }
  hasOnlyKeys(skill, new Set(["name", "path", "description"]), label, errors)
  validateName(skill.name, `${label}.name`, errors)
  if (validateString(skill.description, `${label}.description`, errors) && skill.description.length > 1024) {
    errors.push(`${label}.description must be at most 1024 characters`)
  }
  const skillDir = await validateDirectory(rootDir, skill.path, `${label}.path`, errors)
  if (!skillDir) return null
  if (basename(skillDir) !== skill.name) {
    errors.push(`${label}.name must match its directory name`)
  }
  try {
    const text = await readFile(resolve(skillDir, "SKILL.md"), "utf8")
    const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text)?.[1]
    if (!frontmatter) {
      errors.push(`${label}.path must contain SKILL.md with YAML frontmatter`)
      return skillDir
    }
    if (readFrontmatterValue(frontmatter, "name") !== skill.name) {
      errors.push(`${label}.name must match SKILL.md frontmatter`)
    }
    if (readFrontmatterValue(frontmatter, "description") !== skill.description) {
      errors.push(`${label}.description must match SKILL.md frontmatter`)
    }
  } catch {
    errors.push(`${label}.path must contain SKILL.md`)
  }
  return skillDir
}

function packagePayloadPaths(entry) {
  return [
    ...(Array.isArray(entry.skills) ? entry.skills.map((skill) => skill?.path) : []),
    ...(Array.isArray(entry.resources) ? entry.resources : []),
  ].filter((path) => typeof path === "string")
}

async function validatePackage(rootDir, entry, index, errors) {
  const label = `registry.packages[${index}]`
  if (!isObject(entry)) {
    errors.push(`${label} must be an object`)
    return
  }
  hasOnlyKeys(
    entry,
    new Set([
      "name",
      "display_name",
      "description",
      "version",
      "license",
      "agents",
      "skills",
      "resources",
    ]),
    label,
    errors,
  )
  validateName(entry.name, `${label}.name`, errors)
  validateString(entry.display_name, `${label}.display_name`, errors)
  validateString(entry.description, `${label}.description`, errors)
  validateVersion(entry.version, `${label}.version`, errors)
  validateString(entry.license, `${label}.license`, errors)
  validateAgents(entry.agents, `${label}.agents`, errors)
  const packageRoot = resolve(rootDir, "plugins", entry.name ?? "")

  const skills = Array.isArray(entry.skills) ? entry.skills : []
  if (skills.length === 0) {
    errors.push(`${label}.skills must be a non-empty array`)
  } else {
    const names = new Set()
    for (const [skillIndex, skill] of skills.entries()) {
      const skillDir = await validateSkill(rootDir, skill, `${label}.skills[${skillIndex}]`, errors)
      if (skillDir && !isInside(packageRoot, skillDir)) {
        errors.push(`${label}.skills[${skillIndex}].path must stay inside plugins/${entry.name}`)
      }
      const name = skill?.name
      if (name !== undefined && names.has(name)) errors.push(`${label}.skills contains duplicate name ${name}`)
      if (name !== undefined) names.add(name)
    }
  }

  if (!Array.isArray(entry.resources)) {
    errors.push(`${label}.resources must be an array`)
  } else {
    for (const [resourceIndex, resource] of entry.resources.entries()) {
      const resourceDir = await validateDirectory(rootDir, resource, `${label}.resources[${resourceIndex}]`, errors)
      if (resourceDir && !isInside(packageRoot, resourceDir)) {
        errors.push(`${label}.resources[${resourceIndex}] must stay inside plugins/${entry.name}`)
      }
    }
  }

  const installNames = new Set()
  for (const path of packagePayloadPaths(entry)) {
    const installName = basename(path)
    if (installNames.has(installName)) {
      errors.push(`${label} installs more than one directory named ${installName}`)
    }
    installNames.add(installName)
  }
}

function validateEnvironmentName(value, label, errors) {
  if (typeof value !== "string" || !ENV_PATTERN.test(value)) {
    errors.push(`${label} must be an uppercase environment variable name`)
  }
}

function validateMcpServer(server, index, errors) {
  const label = `registry.mcp_servers[${index}]`
  if (!isObject(server)) {
    errors.push(`${label} must be an object`)
    return
  }
  hasOnlyKeys(server, new Set(["name", "description", "version", "agents", "transport"]), label, errors)
  validateName(server.name, `${label}.name`, errors)
  validateString(server.description, `${label}.description`, errors)
  validateVersion(server.version, `${label}.version`, errors)
  validateAgents(server.agents, `${label}.agents`, errors)

  if (!isObject(server.transport)) {
    errors.push(`${label}.transport must be an object`)
    return
  }
  const transport = server.transport
  if (transport.type === "stdio") {
    hasOnlyKeys(transport, new Set(["type", "command", "environment"]), `${label}.transport`, errors)
    if (!Array.isArray(transport.command) || transport.command.length === 0) {
      errors.push(`${label}.transport.command must be a non-empty array`)
    } else {
      transport.command.forEach((part, partIndex) => {
        validateString(part, `${label}.transport.command[${partIndex}]`, errors)
      })
    }
    if (transport.environment !== undefined) {
      if (!Array.isArray(transport.environment)) {
        errors.push(`${label}.transport.environment must be an array`)
      } else {
        const seen = new Set()
        transport.environment.forEach((name, environmentIndex) => {
          validateEnvironmentName(name, `${label}.transport.environment[${environmentIndex}]`, errors)
          if (seen.has(name)) errors.push(`${label}.transport.environment contains duplicate ${name}`)
          seen.add(name)
        })
      }
    }
    return
  }
  if (transport.type === "http") {
    hasOnlyKeys(
      transport,
      new Set(["type", "url", "bearer_token_env", "headers"]),
      `${label}.transport`,
      errors,
    )
    try {
      const url = new URL(transport.url)
      if (!new Set(["http:", "https:"]).has(url.protocol)) throw new Error()
    } catch {
      errors.push(`${label}.transport.url must be a valid URL`)
    }
    if (transport.bearer_token_env !== undefined) {
      validateEnvironmentName(transport.bearer_token_env, `${label}.transport.bearer_token_env`, errors)
    }
    if (transport.headers !== undefined) {
      if (!isObject(transport.headers)) {
        errors.push(`${label}.transport.headers must be an object`)
      } else {
        const headerNames = new Set()
        for (const [header, environmentName] of Object.entries(transport.headers)) {
          if (header.length === 0) errors.push(`${label}.transport.headers contains an empty header name`)
          const normalizedHeader = header.toLowerCase()
          if (headerNames.has(normalizedHeader)) {
            errors.push(`${label}.transport.headers contains duplicate header ${header}`)
          }
          headerNames.add(normalizedHeader)
          validateEnvironmentName(environmentName, `${label}.transport.headers.${header}`, errors)
        }
      }
    }
    if (transport.bearer_token_env
      && Object.keys(transport.headers ?? {}).some((header) => header.toLowerCase() === "authorization")) {
      errors.push(`${label}.transport must not define Authorization twice`)
    }
    return
  }
  errors.push(`${label}.transport.type must be stdio or http`)
}

export async function validateRegistry(registry, { rootDir = MARKETPLACE_ROOT } = {}) {
  const errors = []
  if (!isObject(registry)) return ["registry must be an object"]
  let canonicalRoot
  try {
    canonicalRoot = await realpath(rootDir)
  } catch {
    canonicalRoot = resolve(rootDir)
    errors.push("registry directory does not exist")
  }
  hasOnlyKeys(
    registry,
    new Set(["$schema", "schema_version", "name", "description", "repository", "packages", "mcp_servers"]),
    "registry",
    errors,
  )
  if (registry.$schema !== undefined) validateString(registry.$schema, "registry.$schema", errors)
  if (registry.schema_version !== 1) errors.push("registry.schema_version must equal 1")
  validateName(registry.name, "registry.name", errors)
  validateString(registry.description, "registry.description", errors)
  try {
    new URL(registry.repository)
  } catch {
    errors.push("registry.repository must be a valid URL")
  }

  if (!Array.isArray(registry.packages)) {
    errors.push("registry.packages must be an array")
  } else {
    const names = new Set()
    for (const [index, entry] of registry.packages.entries()) {
      await validatePackage(canonicalRoot, entry, index, errors)
      const name = entry?.name
      if (name !== undefined && names.has(name)) errors.push(`registry.packages contains duplicate name ${name}`)
      if (name !== undefined) names.add(name)
    }
    const installNames = new Map()
    for (const entry of registry.packages) {
      if (!isObject(entry)) continue
      for (const path of packagePayloadPaths(entry)) {
        const installName = basename(path)
        if (installNames.has(installName) && installNames.get(installName) !== entry.name) {
          errors.push(
            `registry packages ${installNames.get(installName)} and ${entry.name} both install ${installName}`,
          )
        } else {
          installNames.set(installName, entry.name)
        }
      }
    }
  }

  if (!Array.isArray(registry.mcp_servers)) {
    errors.push("registry.mcp_servers must be an array")
  } else {
    const names = new Set()
    for (const [index, server] of registry.mcp_servers.entries()) {
      validateMcpServer(server, index, errors)
      const name = server?.name
      if (name !== undefined && names.has(name)) errors.push(`registry.mcp_servers contains duplicate name ${name}`)
      if (name !== undefined) names.add(name)
    }
  }
  return errors
}

export async function loadRegistry(filePath = REGISTRY_PATH) {
  const resolvedPath = resolve(filePath)
  let registry
  try {
    registry = JSON.parse(await readFile(resolvedPath, "utf8"))
  } catch (error) {
    throw new Error(`Could not read registry: ${error.message}`)
  }
  const rootDir = dirname(resolvedPath)
  const errors = await validateRegistry(registry, { rootDir })
  if (errors.length > 0) throw new Error(`Registry validation failed:\n${errors.map((error) => `- ${error}`).join("\n")}`)
  return { registry, rootDir }
}

async function pathExists(path) {
  try {
    await lstat(path)
    return true
  } catch (error) {
    if (error.code === "ENOENT") return false
    throw error
  }
}

export function getSkillInstallRoot(agent, {
  scope = "project",
  projectRoot = process.cwd(),
  userHome = homedir(),
} = {}) {
  if (!SUPPORTED_AGENTS.includes(agent)) throw new Error(`Unsupported agent: ${agent}`)
  if (!new Set(["project", "user"]).has(scope)) throw new Error(`Unsupported scope: ${scope}`)
  const base = scope === "project" ? projectRoot : userHome
  return resolve(base, ...AGENTS[agent].installPaths[scope])
}

export async function installPackage(registry, packageName, {
  agent,
  rootDir = MARKETPLACE_ROOT,
  scope = "project",
  projectRoot = process.cwd(),
  userHome = homedir(),
} = {}) {
  const packageEntry = registry.packages.find((entry) => entry.name === packageName)
  if (!packageEntry) throw new Error(`Unknown package: ${packageName}`)
  if (!packageEntry.agents.includes(agent)) {
    throw new Error(`${packageName} does not support ${agent}`)
  }
  const installRoot = getSkillInstallRoot(agent, { projectRoot, scope, userHome })
  const entries = packagePayloadPaths(packageEntry).map((sourcePath) => ({
    destination: resolve(installRoot, basename(sourcePath)),
    source: resolve(rootDir, sourcePath),
  }))

  const existingPaths = await Promise.all(entries.map((entry) => pathExists(entry.destination)))
  const collisions = entries
    .filter((entry, index) => existingPaths[index])
    .map((entry) => entry.destination)
  if (collisions.length > 0) {
    throw new Error(`Refusing to overwrite existing paths:\n${collisions.map((path) => `- ${path}`).join("\n")}`)
  }

  await mkdir(installRoot, { recursive: true })
  const stagingRoot = await mkdtemp(join(installRoot, ".kinoshita-install-"))
  const stagedEntries = entries.map((entry) => ({
    ...entry,
    staged: resolve(stagingRoot, basename(entry.source)),
  }))
  const installed = []
  try {
    for (const entry of stagedEntries) {
      await cp(entry.source, entry.staged, { errorOnExist: true, force: false, recursive: true })
    }
    for (const entry of stagedEntries) {
      await rename(entry.staged, entry.destination)
      installed.push(entry.destination)
    }
    await rm(stagingRoot, { force: true, recursive: true })
  } catch (error) {
    await Promise.allSettled([
      ...installed.map((path) => rm(path, { force: true, recursive: true })),
      rm(stagingRoot, { force: true, recursive: true }),
    ])
    throw new Error(`Package installation failed: ${error.message}`)
  }
  return { installRoot, installed }
}

function environmentReference(name, agent) {
  return AGENTS[agent].environmentReference(name)
}

function mcpJsonConfig(server, agent) {
  const transport = server.transport
  if (transport.type === "stdio") {
    const environment = Object.fromEntries(
      (transport.environment ?? []).map((name) => [name, environmentReference(name, agent)]),
    )
    if (agent === "opencode") {
      return {
        type: "local",
        command: transport.command,
        ...(Object.keys(environment).length > 0 ? { environment } : {}),
        enabled: true,
      }
    }
    return {
      command: transport.command[0],
      ...(transport.command.length > 1 ? { args: transport.command.slice(1) } : {}),
      ...(Object.keys(environment).length > 0 ? { env: environment } : {}),
    }
  }

  const headers = Object.fromEntries(
    Object.entries(transport.headers ?? {}).map(([header, environmentName]) => [
      header,
      environmentReference(environmentName, agent),
    ]),
  )
  if (transport.bearer_token_env) {
    headers.Authorization = `Bearer ${environmentReference(transport.bearer_token_env, agent)}`
  }
  return {
    type: agent === "opencode" ? "remote" : "http",
    url: transport.url,
    ...(Object.keys(headers).length > 0 ? { headers } : {}),
    ...(agent === "opencode" ? { enabled: true } : {}),
  }
}

function tomlString(value) {
  return JSON.stringify(value)
}

function mcpCodexConfig(server) {
  const transport = server.transport
  const lines = [`[mcp_servers.${tomlString(server.name)}]`]
  if (transport.type === "stdio") {
    lines.push(`command = ${tomlString(transport.command[0])}`)
    if (transport.command.length > 1) lines.push(`args = ${JSON.stringify(transport.command.slice(1))}`)
    if (transport.environment?.length > 0) {
      lines.push(`env_vars = ${JSON.stringify(transport.environment)}`)
    }
  } else {
    lines.push(`url = ${tomlString(transport.url)}`)
    if (transport.bearer_token_env) {
      lines.push(`bearer_token_env_var = ${tomlString(transport.bearer_token_env)}`)
    }
    const headers = Object.entries(transport.headers ?? {})
    if (headers.length > 0) {
      const values = headers
        .map(([header, environmentName]) => `${tomlString(header)} = ${tomlString(environmentName)}`)
        .join(", ")
      lines.push(`env_http_headers = { ${values} }`)
    }
  }
  lines.push("enabled = true")
  return `${lines.join("\n")}\n`
}

function mcpJsonDocument(server, agent, rootKey) {
  const config = mcpJsonConfig(server, agent)
  return `${JSON.stringify({ [rootKey]: { [server.name]: config } }, null, 2)}\n`
}

function appendYamlMapping(lines, value, depth = 0) {
  const indentation = "  ".repeat(depth)
  for (const [key, child] of Object.entries(value)) {
    const renderedKey = depth === 0 ? key : JSON.stringify(key)
    if (isObject(child)) {
      lines.push(`${indentation}${renderedKey}:`)
      appendYamlMapping(lines, child, depth + 1)
    } else {
      lines.push(`${indentation}${renderedKey}: ${JSON.stringify(child)}`)
    }
  }
}

function mcpHermesConfig(server) {
  const config = mcpJsonConfig(server, "hermes")
  delete config.type
  config.enabled = true
  const lines = []
  appendYamlMapping(lines, { mcp_servers: { [server.name]: config } })
  return `${lines.join("\n")}\n`
}

export function renderMcpConfig(server, agent) {
  if (!SUPPORTED_AGENTS.includes(agent)) throw new Error(`Unsupported agent: ${agent}`)
  if (!server.agents.includes(agent)) throw new Error(`${server.name} does not support ${agent}`)
  return AGENTS[agent].renderMcp(server)
}
