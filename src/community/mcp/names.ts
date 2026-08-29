/**
 * Normalizes an MCP server or tool name for use in a helixent tool name.
 * Only `[a-zA-Z0-9_-]` are preserved; everything else becomes `_`.
 * @param name - The raw name to normalize.
 * @returns The normalized name.
 */
export function normalizeNameForMCP(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, "_");
}

/**
 * Builds a helixent tool name for an MCP tool: `mcp__<server>__<tool>`.
 * @param server - The MCP server name.
 * @param tool - The MCP tool name.
 * @returns The namespaced helixent tool name.
 */
export function buildMcpToolName(server: string, tool: string): string {
  return `mcp__${normalizeNameForMCP(server)}__${normalizeNameForMCP(tool)}`;
}

export interface McpToolInfo {
  server: string;
  tool: string;
}

/**
 * Parses an `mcp__<server>__<tool>` name back into its parts.
 * Splits on the first `__` after the `mcp__` prefix; `__` inside the tool name is preserved.
 * @param name - The helixent tool name to parse.
 * @returns The server/tool parts, or null if the name is not MCP-namespaced.
 */
export function mcpInfoFromString(name: string): McpToolInfo | null {
  if (!name.startsWith("mcp__")) return null;
  const rest = name.slice("mcp__".length);
  const first = rest.indexOf("__");
  if (first === -1) return null;
  // Only the first `__` after the `mcp__` prefix splits server/tool; `__` inside the tool name is preserved.
  return { server: rest.slice(0, first), tool: rest.slice(first + 2) };
}
