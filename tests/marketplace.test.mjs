import assert from "node:assert/strict"
import { access, mkdtemp, readFile, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"
import {
  getSkillInstallRoot,
  installPackage,
  loadRegistry,
  renderMcpConfig,
  validateRegistry,
} from "../lib/marketplace.mjs"

const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..")

async function createTempDirectory(t) {
  const path = await mkdtemp(join(tmpdir(), "kinoshita-marketplace-"))
  t.after(() => rm(path, { force: true, recursive: true }))
  return path
}

test("checked-in registry is valid", async () => {
  const { registry, rootDir } = await loadRegistry()
  const schema = JSON.parse(await readFile(join(ROOT_DIR, "registry.schema.json"), "utf8"))

  assert.equal(rootDir, ROOT_DIR)
  assert.equal(schema.$id, "https://github.com/hwangseonu/kinoshita-skills/blob/main/registry.schema.json")
  assert.equal(registry.packages[0].name, "personal-finance")
  assert.deepEqual(registry.packages[0].agents, ["claude", "codex", "opencode", "hermes"])
})

test("Claude marketplace, plugin manifests, and registry use the same identity", async () => {
  const { registry } = await loadRegistry()
  const marketplace = JSON.parse(
    await readFile(join(ROOT_DIR, ".claude-plugin", "marketplace.json"), "utf8"),
  )
  const claudePackages = registry.packages.filter((entry) => entry.agents.includes("claude"))

  assert.equal(marketplace.plugins.length, claudePackages.length)
  for (const packageEntry of claudePackages) {
    const marketplaceEntry = marketplace.plugins.find((entry) => entry.name === packageEntry.name)
    assert.ok(marketplaceEntry)
    assert.equal(marketplaceEntry.version, packageEntry.version)
    assert.equal(marketplaceEntry.source, `./plugins/${packageEntry.name}`)

    const plugin = JSON.parse(
      await readFile(
        join(ROOT_DIR, "plugins", packageEntry.name, ".claude-plugin", "plugin.json"),
        "utf8",
      ),
    )
    assert.equal(plugin.name, packageEntry.name)
    assert.equal(plugin.version, packageEntry.version)
  }
})

test("registry descriptions must match SKILL.md frontmatter", async () => {
  const { registry } = await loadRegistry()
  const invalidRegistry = structuredClone(registry)
  invalidRegistry.packages[0].skills[0].description = "Outdated description"

  const errors = await validateRegistry(invalidRegistry, { rootDir: ROOT_DIR })

  assert.ok(errors.some((error) => error.includes("description must match SKILL.md frontmatter")))
})

test("registry paths cannot escape the marketplace", async () => {
  const { registry } = await loadRegistry()
  const invalidRegistry = structuredClone(registry)
  invalidRegistry.packages[0].resources = ["../outside"]

  const errors = await validateRegistry(invalidRegistry, { rootDir: ROOT_DIR })

  assert.ok(errors.some((error) => error.includes("must stay inside the registry directory")))
})

test("registry package paths must stay inside their plugin", async () => {
  const { registry } = await loadRegistry()
  const invalidRegistry = structuredClone(registry)
  invalidRegistry.packages[0].resources = ["plugins"]

  const errors = await validateRegistry(invalidRegistry, { rootDir: ROOT_DIR })

  assert.ok(errors.some((error) => error.includes("must stay inside plugins/personal-finance")))
})

test("registry enforces Agent Skills metadata lengths", async () => {
  const { registry } = await loadRegistry()
  const invalidRegistry = structuredClone(registry)
  invalidRegistry.packages[0].skills[0].name = "a".repeat(65)
  invalidRegistry.packages[0].skills[1].description = "a".repeat(1025)

  const errors = await validateRegistry(invalidRegistry, { rootDir: ROOT_DIR })

  assert.ok(errors.some((error) => error.includes("name must be at most 64 characters")))
  assert.ok(errors.some((error) => error.includes("description must be at most 1024 characters")))
})

test("registry validation reports malformed package fields instead of throwing", async () => {
  const { registry } = await loadRegistry()
  const invalidRegistry = structuredClone(registry)
  invalidRegistry.packages[0].skills = {}
  invalidRegistry.packages[0].resources = [1]

  const errors = await validateRegistry(invalidRegistry, { rootDir: ROOT_DIR })

  assert.ok(errors.includes("registry.packages[0].skills must be a non-empty array"))
  assert.ok(errors.includes("registry.packages[0].resources[0] must be a non-empty string"))
})

test("registry validation handles repeated null entries", async () => {
  const { registry } = await loadRegistry()
  const invalidRegistry = structuredClone(registry)
  invalidRegistry.packages.push(null, null)
  invalidRegistry.packages[0].skills.push(null, null)
  invalidRegistry.mcp_servers.push(null, null)

  const errors = await validateRegistry(invalidRegistry, { rootDir: ROOT_DIR })

  assert.ok(errors.includes("registry.packages[1] must be an object"))
  assert.ok(errors.includes("registry.packages[0].skills[2] must be an object"))
  assert.ok(errors.includes("registry.mcp_servers[1] must be an object"))
})

test("registry rejects install-name collisions across packages", async () => {
  const { registry } = await loadRegistry()
  const invalidRegistry = structuredClone(registry)
  const duplicate = structuredClone(invalidRegistry.packages[0])
  duplicate.name = "another-package"
  invalidRegistry.packages.push(duplicate)

  const errors = await validateRegistry(invalidRegistry, { rootDir: ROOT_DIR })

  assert.ok(errors.some((error) => error.includes("both install personal-finance-onboarding")))
})

test("registry rejects case-insensitive Authorization conflicts", async () => {
  const { registry } = await loadRegistry()
  const invalidRegistry = structuredClone(registry)
  invalidRegistry.mcp_servers.push({
    name: "remote-mcp",
    description: "Remote MCP server",
    version: "1.0.0",
    agents: ["claude"],
    transport: {
      type: "http",
      url: "https://mcp.example.com/mcp",
      bearer_token_env: "MCP_TOKEN",
      headers: { authorization: "OTHER_TOKEN" },
    },
  })

  const errors = await validateRegistry(invalidRegistry, { rootDir: ROOT_DIR })

  assert.ok(errors.some((error) => error.includes("must not define Authorization twice")))
})

test("installs a package and its shared resources for Hermes", async (t) => {
  const projectRoot = await createTempDirectory(t)
  const { registry, rootDir } = await loadRegistry()

  const result = await installPackage(registry, "personal-finance", {
    agent: "hermes",
    projectRoot,
    rootDir,
  })

  assert.equal(result.installRoot, join(projectRoot, ".hermes", "skills"))
  assert.equal(result.installed.length, 3)
  await access(join(result.installRoot, "personal-finance-core", "SPEC.md"))
  const skill = await readFile(
    join(result.installRoot, "personal-finance-onboarding", "SKILL.md"),
    "utf8",
  )
  assert.match(skill, /\.\.\/personal-finance-core\/SPEC\.md/)
})

test("does not overwrite an existing skill installation", async (t) => {
  const projectRoot = await createTempDirectory(t)
  const { registry, rootDir } = await loadRegistry()
  const options = { agent: "opencode", projectRoot, rootDir }
  await installPackage(registry, "personal-finance", options)

  await assert.rejects(
    installPackage(registry, "personal-finance", options),
    /Refusing to overwrite existing paths/,
  )
})

test("does not leave partial installations when a source copy fails", async (t) => {
  const projectRoot = await createTempDirectory(t)
  const { registry, rootDir } = await loadRegistry()
  const invalidRegistry = structuredClone(registry)
  invalidRegistry.packages[0].resources.push("skills/missing-resource")

  await assert.rejects(
    installPackage(invalidRegistry, "personal-finance", {
      agent: "claude",
      projectRoot,
      rootDir,
    }),
    /Package installation failed/,
  )

  const installRoot = join(projectRoot, ".claude", "skills")
  assert.deepEqual(await readdir(installRoot), [])
})

test("uses each agent's documented skill directory", () => {
  assert.equal(
    getSkillInstallRoot("claude", { projectRoot: "/project" }),
    resolve("/project/.claude/skills"),
  )
  assert.equal(
    getSkillInstallRoot("codex", { projectRoot: "/project" }),
    resolve("/project/.agents/skills"),
  )
  assert.equal(
    getSkillInstallRoot("opencode", { projectRoot: "/project" }),
    resolve("/project/.opencode/skills"),
  )
  assert.equal(
    getSkillInstallRoot("opencode", { scope: "user", userHome: "/home/user" }),
    resolve("/home/user/.config/opencode/skills"),
  )
  assert.equal(
    getSkillInstallRoot("hermes", { projectRoot: "/project" }),
    resolve("/project/.hermes/skills"),
  )
  assert.equal(
    getSkillInstallRoot("hermes", { scope: "user", userHome: "/home/user" }),
    resolve("/home/user/.hermes/skills"),
  )
})

test("renders stdio MCP configuration for every agent", () => {
  const server = {
    name: "example-mcp",
    agents: ["claude", "codex", "opencode", "hermes"],
    transport: {
      type: "stdio",
      command: ["npx", "-y", "@example/mcp"],
      environment: ["EXAMPLE_TOKEN"],
    },
  }

  assert.deepEqual(JSON.parse(renderMcpConfig(server, "claude")), {
    mcpServers: {
      "example-mcp": {
        command: "npx",
        args: ["-y", "@example/mcp"],
        env: { EXAMPLE_TOKEN: "${EXAMPLE_TOKEN}" },
      },
    },
  })
  assert.equal(
    renderMcpConfig(server, "codex"),
    `[mcp_servers."example-mcp"]\ncommand = "npx"\nargs = ["-y","@example/mcp"]\nenv_vars = ["EXAMPLE_TOKEN"]\nenabled = true\n`,
  )
  assert.deepEqual(JSON.parse(renderMcpConfig(server, "opencode")), {
    mcp: {
      "example-mcp": {
        type: "local",
        command: ["npx", "-y", "@example/mcp"],
        environment: { EXAMPLE_TOKEN: "{env:EXAMPLE_TOKEN}" },
        enabled: true,
      },
    },
  })
  assert.equal(
    renderMcpConfig(server, "hermes"),
    `mcp_servers:\n  "example-mcp":\n    "command": "npx"\n    "args": ["-y","@example/mcp"]\n    "env":\n      "EXAMPLE_TOKEN": "\${EXAMPLE_TOKEN}"\n    "enabled": true\n`,
  )
})

test("renders HTTP MCP authentication without embedding secrets", () => {
  const server = {
    name: "remote-mcp",
    agents: ["claude", "codex", "opencode", "hermes"],
    transport: {
      type: "http",
      url: "https://mcp.example.com/mcp",
      bearer_token_env: "MCP_TOKEN",
      headers: { "X-Tenant": "MCP_TENANT" },
    },
  }

  assert.deepEqual(JSON.parse(renderMcpConfig(server, "claude")), {
    mcpServers: {
      "remote-mcp": {
        type: "http",
        url: "https://mcp.example.com/mcp",
        headers: {
          "X-Tenant": "${MCP_TENANT}",
          Authorization: "Bearer ${MCP_TOKEN}",
        },
      },
    },
  })
  assert.equal(
    renderMcpConfig(server, "codex"),
    `[mcp_servers."remote-mcp"]\nurl = "https://mcp.example.com/mcp"\nbearer_token_env_var = "MCP_TOKEN"\nenv_http_headers = { "X-Tenant" = "MCP_TENANT" }\nenabled = true\n`,
  )
  assert.deepEqual(JSON.parse(renderMcpConfig(server, "opencode")), {
    mcp: {
      "remote-mcp": {
        type: "remote",
        url: "https://mcp.example.com/mcp",
        headers: {
          "X-Tenant": "{env:MCP_TENANT}",
          Authorization: "Bearer {env:MCP_TOKEN}",
        },
        enabled: true,
      },
    },
  })
  assert.equal(
    renderMcpConfig(server, "hermes"),
    `mcp_servers:\n  "remote-mcp":\n    "url": "https://mcp.example.com/mcp"\n    "headers":\n      "X-Tenant": "\${MCP_TENANT}"\n      "Authorization": "Bearer \${MCP_TOKEN}"\n    "enabled": true\n`,
  )
})
