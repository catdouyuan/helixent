import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { CallToolResult, ReadResourceResult } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, test } from "bun:test";

import type { ServerHandle } from "../connection-manager";
import { callMcpTool, normalizeMcpResourceResult, normalizeMcpResult } from "../result";

function resultOf(partial: Partial<CallToolResult>): CallToolResult {
  return { content: [], ...partial };
}

describe("normalizeMcpResult", () => {
  test("maps isError to an Error: prefix", () => {
    const result = resultOf({ content: [{ type: "text", text: "boom" }], isError: true });
    expect(normalizeMcpResult(result, "github")).toBe("Error: boom");
  });

  test("uses structuredContent when content is empty on error", () => {
    const result = resultOf({ structuredContent: { message: "denied" }, isError: true });
    expect(normalizeMcpResult(result, "github")).toBe('Error: {\n  "message": "denied"\n}');
  });

  test("stringifies structuredContent", () => {
    const result = resultOf({ structuredContent: { ok: true, count: 2 } });
    expect(normalizeMcpResult(result, "github")).toBe('{\n  "ok": true,\n  "count": 2\n}');
  });

  test("joins content blocks with newlines", () => {
    const result = resultOf({
      content: [
        { type: "text", text: "line1" },
        { type: "text", text: "line2" },
      ],
    });
    expect(normalizeMcpResult(result, "github")).toBe("line1\nline2");
  });

  test("formats text resources", () => {
    const result = resultOf({
      content: [{ type: "resource", resource: { uri: "echo://hello", text: "Hello world", mimeType: "text/plain" } }],
    });
    expect(normalizeMcpResult(result, "echo")).toBe("[Resource from echo at echo://hello] Hello world");
  });

  test("omits blob resources", () => {
    const result = resultOf({
      content: [{ type: "resource", resource: { uri: "echo://blob", blob: "aGVsbG8=" } }],
    });
    expect(normalizeMcpResult(result, "echo")).toBe("[binary resource echo://blob omitted]");
  });

  test("omits image and audio blocks", () => {
    const result = resultOf({
      content: [
        { type: "image", data: "AAAA", mimeType: "image/png" },
        { type: "audio", data: "BBBB", mimeType: "audio/wav" },
      ],
    });
    expect(normalizeMcpResult(result, "echo")).toBe("[image from echo omitted]\n[audio from echo omitted]");
  });

  test("formats resource links", () => {
    const result = resultOf({
      content: [{ uri: "echo://linked", name: "linked", type: "resource_link", title: "A linked doc" }],
    });
    expect(normalizeMcpResult(result, "echo")).toBe("[Resource link from echo at echo://linked] A linked doc");
  });

  test("truncates oversized output and marks it", () => {
    const result = resultOf({ content: [{ type: "text", text: "x".repeat(100) }] });
    const normalized = normalizeMcpResult(result, "echo", 50);
    expect(normalized.startsWith("x".repeat(50))).toBe(true);
    expect(normalized).toContain("[OUTPUT TRUNCATED]");
    expect(normalized).not.toContain("x".repeat(51));
  });
});

describe("normalizeMcpResourceResult", () => {
  test("inlines text contents and omits blobs", () => {
    const result: ReadResourceResult = {
      contents: [
        { uri: "echo://hello", text: "Hello world", mimeType: "text/plain" },
        { uri: "echo://blob", blob: "aGVsbG8=" },
      ],
    };
    expect(normalizeMcpResourceResult(result, "echo")).toBe(
      "[Resource from echo at echo://hello] Hello world\n[binary resource echo://blob omitted]",
    );
  });
});

describe("callMcpTool", () => {
  test("invokes the client and normalizes the result", async () => {
    const handle = fakeHandle({
      callTool: async () => ({ content: [{ type: "text", text: "hi" }] }),
    });
    expect(await callMcpTool(handle, "echo", { text: "x" })).toBe("hi");
  });

  test("enforces the configured tool timeout", async () => {
    const handle = fakeHandle(
      {
        callTool: () => new Promise(() => {}),
      },
      50,
    );
    await expect(callMcpTool(handle, "echo", {})).rejects.toThrow("Timed out");
  });
});

function fakeHandle(client: Pick<Client, "callTool">, toolTimeoutMs?: number): ServerHandle {
  return {
    name: "echo",
    type: "stdio",
    client: client as unknown as Client,
    ...(toolTimeoutMs !== undefined ? { toolTimeoutMs } : {}),
    close: async () => {},
  };
}
