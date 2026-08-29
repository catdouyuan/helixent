// Echo MCP server fixture (stdio) used by e2e tests.
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const server = new Server(
  { name: "echo-server", version: "1.0.0" },
  { capabilities: { tools: {}, resources: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "echo",
      description: "Echo the provided text back.",
      inputSchema: { type: "object", properties: { text: { type: "string" } } },
    },
    {
      name: "fail",
      description: "Always fails.",
      inputSchema: { type: "object" },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  switch (name) {
    case "echo":
      return { content: [{ type: "text", text: `echo: ${(args as { text?: string } | undefined)?.text ?? ""}` }] };
    case "fail":
      return { content: [{ type: "text", text: "boom" }], isError: true };
    default:
      return { content: [{ type: "text", text: `unknown tool: ${name}` }] };
  }
});

server.setRequestHandler(ListResourcesRequestSchema, async () => ({
  resources: [{ uri: "echo://hello", name: "hello", description: "A greeting", mimeType: "text/plain" }],
}));

server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  if (request.params.uri === "echo://hello") {
    return { contents: [{ uri: "echo://hello", text: "Hello world", mimeType: "text/plain" }] };
  }
  return { contents: [{ uri: request.params.uri, blob: "aGVsbG8gd29ybGQ=" }] };
});

const transport = new StdioServerTransport();
await server.connect(transport);
