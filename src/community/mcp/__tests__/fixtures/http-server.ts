// HTTP (streamable) MCP server fixture used by e2e tests.
// Prints {"port": <n>} to stdout once listening, then serves MCP over HTTP.
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const server = new Server(
  { name: "http-echo-server", version: "1.0.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "echo",
      description: "Echo the provided text back over HTTP.",
      inputSchema: { type: "object", properties: { text: { type: "string" } } },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  if (name === "echo") {
    return { content: [{ type: "text", text: `http echo: ${(args as { text?: string } | undefined)?.text ?? ""}` }] };
  }
  return { content: [{ type: "text", text: `unknown tool: ${name}` }] };
});

const transport = new WebStandardStreamableHTTPServerTransport({
  sessionIdGenerator: () => "e2e-session",
});
await server.connect(transport);

const bunServer = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(request) {
    return transport.handleRequest(request);
  },
});

console.info(JSON.stringify({ port: bunServer.port }));

process.on("SIGTERM", () => {
  void transport.close().finally(() => bunServer.stop());
});
