import { describe, expect, test } from "bun:test";

import { buildMcpToolName, mcpInfoFromString, normalizeNameForMCP } from "../names";

describe("normalizeNameForMCP", () => {
  test("keeps alphanumerics, underscore, and dash", () => {
    expect(normalizeNameForMCP("my_server-2")).toBe("my_server-2");
  });

  test("replaces other characters with underscore", () => {
    expect(normalizeNameForMCP("my server/tool.name!")).toBe("my_server_tool_name_");
  });
});

describe("buildMcpToolName", () => {
  test("builds mcp__<server>__<tool>", () => {
    expect(buildMcpToolName("my server", "do thing")).toBe("mcp__my_server__do_thing");
  });
});

describe("mcpInfoFromString", () => {
  test("parses simple names", () => {
    expect(mcpInfoFromString("mcp__github__create_issue")).toEqual({ server: "github", tool: "create_issue" });
  });

  test("preserves __ inside the tool name", () => {
    expect(mcpInfoFromString("mcp__server__tool__with__sep")).toEqual({ server: "server", tool: "tool__with__sep" });
  });

  test("returns null for non-MCP or malformed names", () => {
    expect(mcpInfoFromString("bash")).toBeNull();
    expect(mcpInfoFromString("mcp__only_server")).toBeNull();
    expect(mcpInfoFromString("")).toBeNull();
  });
});
