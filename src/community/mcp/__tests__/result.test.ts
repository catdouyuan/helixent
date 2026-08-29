import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { CallToolResult, ReadResourceResult } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, test } from "bun:test";

import type { McpConnectionManager, ServerHandle } from "../connection-manager";
import { callMcpTool, callMcpToolWithRetry, normalizeMcpResourceResult, normalizeMcpResult } from "../result";

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

  test("aborts the SDK call when the tool timeout fires", async () => {
    let capturedSignal: AbortSignal | undefined;
    const handle = fakeHandle(
      {
        callTool: async (_req, _schema, options) => {
          capturedSignal = options?.signal;
          await new Promise<never>((_resolve, reject) => {
            capturedSignal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
          });
          throw new Error("unreachable");
        },
      },
      50,
    );
    await expect(callMcpTool(handle, "echo", {})).rejects.toThrow("Timed out");
    expect(capturedSignal?.aborted).toBe(true);
  });
});

describe("callMcpToolWithRetry", () => {
  test("retries once after a stale connection", async () => {
    let ensureCount = 0;
    let invalidated = false;
    const staleHandle = fakeHandle({
      callTool: async () => {
        throw Object.assign(new Error("MCP error -32000: Connection closed"), { code: -32000 });
      },
    });
    const freshHandle = fakeHandle({
      callTool: async () => ({ content: [{ type: "text", text: "ok" }] }),
    });
    const manager = {
      ensure: async () => (ensureCount++ === 0 ? staleHandle : freshHandle),
      invalidate: () => {
        invalidated = true;
      },
    };

    expect(await callMcpToolWithRetry(manager as unknown as McpConnectionManager, "echo", "echo", {})).toBe("ok");
    expect(ensureCount).toBe(2);
    expect(invalidated).toBe(true);
  });

  test("does not retry on non-connection errors", async () => {
    let ensureCount = 0;
    const handle = fakeHandle({
      callTool: async () => {
        throw new Error("boom");
      },
    });
    const manager = {
      ensure: async () => {
        ensureCount++;
        return handle;
      },
      invalidate: () => {},
    };

    await expect(callMcpToolWithRetry(manager as unknown as McpConnectionManager, "echo", "echo", {})).rejects.toThrow("boom");
    expect(ensureCount).toBe(1);
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
