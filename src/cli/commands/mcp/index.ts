import type { Command } from "commander";

import {
  fetchResourcesForClient,
  fetchToolsForClient,
  loadMcpConfig,
  McpConnectionManager,
  type McpConfig,
  type McpConnectionManagerOptions,
  type McpServerState,
} from "@/community/mcp";

export function registerMcpCommands(parent: Command): void {
  const mcp = parent.command("mcp").description("Manage MCP (Model Context Protocol) servers");
  registerListCommand(mcp);
}

function registerListCommand(parent: Command): void {
  parent
    .command("list")
    .description("List MCP servers with connection status, tools, and resources")
    .action(async () => {
      const result = await loadMcpConfig({ cwd: process.cwd() });
      for (const error of result.errors) {
        console.warn(`[mcp] ${error.message}`);
      }
      for (const warning of result.warnings) {
        console.warn(`[mcp] ${warning.message}`);
      }

      if (!result.configPath) {
        console.info("No .mcp.json found in this project (or its parents). MCP is disabled.");
        return;
      }
      if (Object.keys(result.config.mcpServers).length === 0) {
        console.info(`No MCP servers configured in ${result.configPath}.`);
        return;
      }

      const states = await collectServerStates(result.config, {
        errors: result.errors,
        // Non-interactive: keep the command snappy.
        connectTimeoutMs: 5_000,
      });
      printServerTable(states);
    });
}

/**
 * Connects to every configured server and discovers its tools/resources so the
 * `mcp list` table shows real counts. Mirrors the TUI startup discovery path
 * (`fetchToolsForClient` / `fetchResourcesForClient`); failed servers degrade
 * gracefully without aborting the command.
 */
export async function collectServerStates(
  config: McpConfig,
  options: McpConnectionManagerOptions = {},
): Promise<McpServerState[]> {
  const manager = new McpConnectionManager(config, options);
  await Promise.allSettled(manager.serverNames().map((name) => manager.ensure(name)));
  for (const name of manager.serverNames()) {
    const state = manager.getState(name);
    if (!state || state.status !== "connected") continue;
    await Promise.allSettled([fetchToolsForClient(manager, name), fetchResourcesForClient(manager, name)]);
  }
  // Snapshot before closeAll(): closing would flip statuses to "closed".
  const states = manager.listStates().map((state) => ({ ...state, tools: [...state.tools], resources: [...state.resources] }));
  await manager.closeAll();
  return states;
}

function printServerTable(states: McpServerState[]): void {
  const header = ["SERVER", "TYPE", "STATUS", "TOOLS", "RESOURCES", "ERROR"];
  const rows = states
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((state) => [
      state.name,
      state.type,
      state.status,
      state.status === "connected" ? String(state.tools.length) : "-",
      state.status === "connected" ? String(state.resources.length) : "-",
      state.errorMessage ?? "",
    ]);
  const widths = header.map((heading, index) => Math.max(heading.length, ...rows.map((row) => (row[index] ?? "").length)));
  const format = (cells: string[]) => cells.map((cell, index) => cell.padEnd(widths[index] ?? 0)).join("  ").trimEnd();
  console.info();
  console.info(format(header));
  console.info(format(header.map((_heading, index) => "-".repeat(widths[index] ?? 0))));
  for (const row of rows) {
    console.info(format(row));
  }
}