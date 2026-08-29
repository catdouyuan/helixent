import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { z } from "zod";

/** Zod schema for a stdio MCP server entry (Claude Code compatible). */
export const stdioServerSchema = z.object({
  type: z.literal("stdio").optional(),
  command: z.string().min(1),
  args: z.array(z.string()).optional().default([]),
  env: z.record(z.string(), z.string()).optional().default({}),
});

/** Zod schema for a Streamable HTTP MCP server entry. */
export const httpServerSchema = z.object({
  type: z.literal("http"),
  url: z.string().url(),
  headers: z.record(z.string(), z.string()).optional().default({}),
});

/** Zod schema for the project-level `.mcp.json` file. */
export const mcpConfigSchema = z.object({
  mcpServers: z.record(z.string().min(1), z.union([stdioServerSchema, httpServerSchema])),
});

export type McpStdioServerConfig = z.infer<typeof stdioServerSchema>;
export type McpHttpServerConfig = z.infer<typeof httpServerSchema>;
export type McpServerConfig = McpStdioServerConfig | McpHttpServerConfig;
export type McpConfig = z.infer<typeof mcpConfigSchema>;

/** Structured error/warning metadata for MCP configuration and connection issues. */
export interface McpErrorMetadata {
  scope: "project";
  severity: "error" | "warning";
  serverName?: string;
  serverType?: "stdio" | "http";
  path?: string;
  message: string;
}

export interface McpConfigLoadResult {
  config: McpConfig;
  configPath: string | null;
  errors: McpErrorMetadata[];
  warnings: McpErrorMetadata[];
}

const MCP_CONFIG_FILE = ".mcp.json";
const ENV_VAR_PATTERN = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g;

/**
 * Finds the nearest `.mcp.json` by walking up from `cwd`.
 * @param cwd - The directory to start searching from.
 * @returns The absolute path of the nearest `.mcp.json`, or null.
 */
export async function findMcpConfigPath(cwd: string): Promise<string | null> {
  let dir = resolve(cwd);
  for (;;) {
    const candidate = join(dir, MCP_CONFIG_FILE);
    try {
      await readFile(candidate, "utf8");
      return candidate;
    } catch {
      // Not present here; keep walking up.
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Expands `${VAR}` and `${VAR:-default}` references in a string using `env`.
 * Missing variables without a default are reported (the original text is kept).
 * @param value - The string to expand.
 * @param env - The environment to read from.
 * @returns The expanded value plus any missing variable names.
 */
export function expandEnvVars(value: string, env: Record<string, string | undefined> = process.env): { value: string; missing: string[] } {
  const missing: string[] = [];
  const expanded = value.replace(ENV_VAR_PATTERN, (_match, name: string, fallback: string | undefined) => {
    const raw = env[name];
    if (raw !== undefined && raw !== "") {
      return raw;
    }
    if (fallback !== undefined) {
      return fallback;
    }
    missing.push(name);
    return _match;
  });
  return { value: expanded, missing };
}

/**
 * Loads the nearest project-level `.mcp.json` from `cwd`.
 * Missing file yields an empty config; parse/schema failures degrade to no MCP
 * with a structured error so startup is never blocked.
 */
export async function loadMcpConfig({
  cwd = process.cwd(),
  env = process.env,
}: { cwd?: string; env?: Record<string, string | undefined> } = {}): Promise<McpConfigLoadResult> {
  const configPath = await findMcpConfigPath(cwd);
  if (!configPath) {
    return { config: { mcpServers: {} }, configPath: null, errors: [], warnings: [] };
  }

  let raw: string;
  try {
    raw = await readFile(configPath, "utf8");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      config: { mcpServers: {} },
      configPath,
      errors: [{ scope: "project", severity: "error", path: configPath, message: `Failed to read .mcp.json: ${message}` }],
      warnings: [],
    };
  }

  return parseMcpConfigText(raw, configPath, env);
}

/**
 * Parses `.mcp.json` text: JSON + zod validation, env var expansion, and Windows npx hints.
 * Servers with missing environment variables are dropped and reported as errors.
 */
export function parseMcpConfigText(
  raw: string,
  configPath: string,
  env: Record<string, string | undefined> = process.env,
  platform: NodeJS.Platform = process.platform,
): McpConfigLoadResult {
  const errors: McpErrorMetadata[] = [];
  const text = raw.replace(/^\uFEFF/, "");
  const warnings: McpErrorMetadata[] = [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      config: { mcpServers: {} },
      configPath,
      errors: [{ scope: "project", severity: "error", path: configPath, message: `Invalid JSON in .mcp.json: ${message}` }],
      warnings,
    };
  }

  const result = mcpConfigSchema.safeParse(parsed);
  if (!result.success) {
    const issue = result.error.issues[0];
    const where = issue && issue.path.length > 0 ? ` (at ${issue.path.join(".")})` : "";
    return {
      config: { mcpServers: {} },
      configPath,
      errors: [
        {
          scope: "project",
          severity: "error",
          path: configPath,
          message: `Invalid .mcp.json schema${where}: ${issue?.message ?? "unknown error"}`,
        },
      ],
      warnings,
    };
  }

  const mcpServers: Record<string, McpServerConfig> = {};
  for (const [name, server] of Object.entries(result.data.mcpServers)) {
    if (server.type === "http") {
      const url = expandEnvVars(server.url, env);
      const headers: Record<string, string> = {};
      const missing = [...url.missing];
      for (const [key, value] of Object.entries(server.headers)) {
        const expanded = expandEnvVars(value, env);
        headers[key] = expanded.value;
        missing.push(...expanded.missing);
      }
      if (missing.length > 0) {
        errors.push(missingEnvError(name, "http", configPath, missing));
        continue;
      }
      mcpServers[name] = { ...server, url: url.value, headers };
      continue;
    }

    const command = expandEnvVars(server.command, env);
    const args: string[] = [];
    const missing = [...command.missing];
    for (const arg of server.args) {
      const expanded = expandEnvVars(arg, env);
      args.push(expanded.value);
      missing.push(...expanded.missing);
    }
    const envExpanded: Record<string, string> = {};
    for (const [key, value] of Object.entries(server.env)) {
      const expanded = expandEnvVars(value, env);
      envExpanded[key] = expanded.value;
      missing.push(...expanded.missing);
    }
    if (missing.length > 0) {
      errors.push(missingEnvError(name, "stdio", configPath, missing));
      continue;
    }
    mcpServers[name] = { ...server, command: command.value, args, env: envExpanded };
    warnWindowsNpx(name, command.value, configPath, warnings, platform);
  }

  return { config: { mcpServers }, configPath, errors, warnings };
}

function missingEnvError(name: string, serverType: "stdio" | "http", configPath: string, missing: string[]): McpErrorMetadata {
  const list = [...new Set(missing)].map((v) => `\`${v}\``).join(", ");
  return {
    scope: "project",
    severity: "error",
    serverName: name,
    serverType,
    path: configPath,
    message: `MCP server "${name}" is missing environment variables: ${list}. Set them or provide a default with \${VAR:-default}.`,
  };
}

function warnWindowsNpx(name: string, command: string, configPath: string, warnings: McpErrorMetadata[], platform: NodeJS.Platform): void {
  if (platform !== "win32") return;
  if (command !== "npx" && command !== "npm") return;
  warnings.push({
    scope: "project",
    severity: "warning",
    serverName: name,
    path: configPath,
    message: `MCP server "${name}" uses bare \`${command}\`. On Windows prefer \`${command}.cmd\` or \`cmd /c ${command} ...\` to avoid spawn failures.`,
  });
}
