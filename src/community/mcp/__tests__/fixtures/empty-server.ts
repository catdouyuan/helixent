// MCP server fixture (stdio) that declares capabilities but exposes zero tools/resources.
// Writes one "LT" (listTools) / "LR" (listResources) marker to stderr per call so
// tests can observe how many discovery round-trips happened.
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const server = new Server(
  { name: "empty-server", version: "1.0.0" },
  { capabilities: { tools: {}, resources: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  console.error("LT");
  return { tools: [] };
});

server.setRequestHandler(ListResourcesRequestSchema, async () => {
  console.error("LR");
  return { resources: [] };
});

const transport = new StdioServerTransport();
await server.connect(transport);
