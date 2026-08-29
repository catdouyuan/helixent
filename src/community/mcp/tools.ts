import type { Tool as McpTool } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { defineTool, type Tool } from "@/foundation";

import type {
  McpConnectionManager,
  McpDiscoveredResource,
  McpDiscoveredTool,
} from "./connection-manager";
import { buildMcpToolName } from "./names";
import { callMcpToolWithRetry, normalizeMcpResourceResult } from "./result";

export const MAX_MCP_DESCRIPTION_LENGTH = 2048;

export interface CreateMcpToolsOptions {
  maxDescriptionLength?: number;
}

/**
 * Connects to every configured server in parallel and builds `foundation.Tool[]`
 * from the discovered MCP tools plus two built-in resource tools
 * (`list_mcp_resources` / `read_mcp_resource`) when any server exposes resources.
 * Failed servers degrade gracefully: they are skipped, with state recorded for diagnostics.
 */
export async function createMcpTools(manager: McpConnectionManager, options: CreateMcpToolsOptions = {}): Promise<Tool[]> {
  const names = manager.serverNames();
  if (names.length === 0) return [];

  await Promise.allSettled(names.map((name) => manager.ensure(name)));

  const maxDescription = options.maxDescriptionLength ?? MAX_MCP_DESCRIPTION_LENGTH;
  const tools: Tool[] = [];
  const resourceServers: string[] = [];

  for (const name of names) {
    const state = manager.getState(name);
    if (!state || state.status !== "connected") continue;
    // Discovery failures degrade gracefully (like connect failures): mark the
    // server as errored and keep going instead of failing the whole startup.
    try {
      const discoveredTools = await fetchToolsForClient(manager, name);
      for (const tool of discoveredTools) {
        tools.push(toFunctionTool(manager, name, tool, maxDescription));
      }
      const resources = await fetchResourcesForClient(manager, name);
      if (resources.length > 0) {
        resourceServers.push(name);
      }
    } catch (error) {
      state.status = "error";
      state.errorMessage = error instanceof Error ? error.message : String(error);
    }
  }

  if (resourceServers.length > 0) {
    tools.push(listMcpResourcesTool(manager), readMcpResourceTool(manager));
  }
  return tools;
}

/**
 * Fetches (and caches) the tools a server exposes. The cache is invalidated on
 * close or `notifications/tools/list_changed`.
 */
export async function fetchToolsForClient(manager: McpConnectionManager, server: string): Promise<McpDiscoveredTool[]> {
  const state = manager.getState(server);
  if (!state) return [];
  // Cache by a "fetched" flag, not by length: a server that declares the tools
  // capability but exposes zero tools must not be re-queried on every call.
  if (state.toolsFetched) return state.tools;

  const handle = await manager.ensure(server);
  const capabilities = handle.client.getServerCapabilities();
  if (!capabilities?.tools) {
    state.toolsFetched = true;
    return [];
  }

  const result = await handle.client.listTools();
  state.tools = result.tools.map(toDiscoveredTool);
  state.toolsFetched = true;
  return state.tools;
}

/**
 * Fetches (and caches) the resources a server exposes, when it declares the
 * `resources` capability. The cache is invalidated on close or
 * `notifications/resources/list_changed`.
 */
export async function fetchResourcesForClient(manager: McpConnectionManager, server: string): Promise<McpDiscoveredResource[]> {
  const state = manager.getState(server);
  if (!state) return [];
  if (state.resourcesFetched) return state.resources;

  const handle = await manager.ensure(server);
  const capabilities = handle.client.getServerCapabilities();
  if (!capabilities?.resources) {
    state.resourcesFetched = true;
    return [];
  }

  const result = await handle.client.listResources();
  state.resources = result.resources.map((resource) => ({
    uri: resource.uri,
    name: resource.name,
    ...(resource.description !== undefined ? { description: resource.description } : {}),
    ...(resource.mimeType !== undefined ? { mimeType: resource.mimeType } : {}),
  }));
  state.resourcesFetched = true;
  return state.resources;
}

function toFunctionTool(manager: McpConnectionManager, server: string, tool: McpDiscoveredTool, maxDescription: number): Tool {
  const name = buildMcpToolName(server, tool.name);
  return defineTool({
    name,
    description: truncateDescription(tool.description ?? "", maxDescription),
    // Real schema is passed through via `inputSchema`; this is only a fallback.
    parameters: z.record(z.string(), z.unknown()),
    inputSchema: tool.inputSchema,
    invoke: async (input, signal) => {
      return callMcpToolWithRetry(manager, server, tool.name, input, signal);
    },
  });
}

function listMcpResourcesTool(manager: McpConnectionManager): Tool {
  return defineTool({
    name: "list_mcp_resources",
    description: "List MCP resources exposed by connected MCP servers. Optionally filter by server name.",
    parameters: z.object({
      server: z.string().optional().describe("Optional MCP server name to filter resources by."),
    }),
    invoke: async (input) => {
      const names = manager.serverNames();
      await Promise.allSettled(names.map((name) => manager.ensure(name)));
      const rows: string[] = [];
      for (const name of names) {
        const state = manager.getState(name);
        if (!state) continue;
        for (const resource of state.resources) {
          if (input.server && name !== input.server) continue;
          rows.push(`${name}\t${resource.uri}\t${resource.name}\t${resource.mimeType ?? ""}\t${resource.description ?? ""}`);
        }
      }
      if (rows.length === 0) {
        return input.server ? `No MCP resources found for server "${input.server}".` : "No MCP resources found.";
      }
      return ["server\turi\tname\tmimeType\tdescription", ...rows].join("\n");
    },
  });
}

function readMcpResourceTool(manager: McpConnectionManager): Tool {
  return defineTool({
    name: "read_mcp_resource",
    description: "Read a resource from a connected MCP server by URI.",
    parameters: z.object({
      server: z.string().describe("The MCP server name."),
      uri: z.string().describe("The resource URI to read."),
    }),
    invoke: async (input, signal) => {
      const handle = await manager.ensure(input.server);
      const result = await handle.client.readResource({ uri: input.uri }, { signal });
      return normalizeMcpResourceResult(result, input.server);
    },
  });
}

function toDiscoveredTool(tool: McpTool): McpDiscoveredTool {
  return {
    name: tool.name,
    ...(tool.description !== undefined ? { description: tool.description } : {}),
    ...(tool.inputSchema !== undefined ? { inputSchema: tool.inputSchema as Record<string, unknown> } : {}),
    ...(tool.annotations !== undefined ? { annotations: tool.annotations } : {}),
  };
}

function truncateDescription(description: string, maxChars: number): string {
  if (description.length <= maxChars) return description;
  return `${description.slice(0, maxChars)}\n... [truncated ${description.length - maxChars} chars]`;
}
