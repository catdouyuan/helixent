import type { CallToolResult, ReadResourceResult } from "@modelcontextprotocol/sdk/types.js";

import { truncateText } from "@/foundation";

import type { ServerHandle } from "./connection-manager";
import { envInt } from "./env";

/** Default maximum characters for a normalized MCP tool result. */
export const MAX_MCP_OUTPUT_CHARS = envInt("HELIXENT_MCP_MAX_OUTPUT_CHARS", 24_000);

/**
 * Calls an MCP tool and normalizes the result to a single string.
 * @param handle - The connected server handle.
 * @param toolName - The MCP tool name (unprefixed).
 * @param input - The tool arguments.
 * @param signal - Optional abort signal forwarded to the SDK.
 * @returns The normalized tool result text.
 */
export async function callMcpTool(handle: ServerHandle, toolName: string, input: unknown, signal?: AbortSignal): Promise<string> {
  const call = handle.client.callTool(
    { name: toolName, arguments: (input ?? {}) as Record<string, unknown> },
    undefined,
    { signal },
  );
  const raw =
    handle.toolTimeoutMs !== undefined && handle.toolTimeoutMs > 0
      ? await withTimeout(call, handle.toolTimeoutMs, `Timed out calling MCP tool "${toolName}" on server "${handle.name}"`)
      : await call;
  return normalizeMcpResult(toCallToolResult(raw), handle.name);
}

/**
 * Normalizes an MCP `CallToolResult` into a single string.
 * - `isError` → `Error: <text>` (recognized as a failure by the existing result pipeline)
 * - `structuredContent` → pretty JSON
 * - `content[]` → per-block text joined with newlines
 * Oversized output is truncated.
 */
export function normalizeMcpResult(result: CallToolResult, server: string, maxChars = MAX_MCP_OUTPUT_CHARS): string {
  if (result.isError) {
    const text = contentToText(result.content, server);
    const detail =
      text.trim() !== ""
        ? text
        : result.structuredContent !== undefined
          ? JSON.stringify(result.structuredContent, null, 2)
          : "MCP tool failed";
    return `Error: ${truncateMcpText(detail, maxChars)}`;
  }
  if (result.structuredContent !== undefined) {
    return truncateMcpText(JSON.stringify(result.structuredContent, null, 2), maxChars);
  }
  return truncateMcpText(contentToText(result.content, server), maxChars);
}

/**
 * Normalizes an MCP `ReadResourceResult` into a single string.
 * Text resources are inlined; blob (base64) resources are omitted (not written to disk).
 */
export function normalizeMcpResourceResult(result: ReadResourceResult, server: string, maxChars = MAX_MCP_OUTPUT_CHARS): string {
  const parts = result.contents.map((content) => {
    if ("text" in content) {
      return `[Resource from ${server} at ${content.uri}] ${content.text}`;
    }
    return `[binary resource ${content.uri} omitted]`;
  });
  return truncateMcpText(parts.join("\n"), maxChars);
}

function toCallToolResult(value: unknown): CallToolResult {
  if (isCallToolResult(value)) return value;
  // Task-based execution results are not used by this build; surface them as text.
  const toolResult = (value as { toolResult?: unknown } | null)?.toolResult;
  return { content: [{ type: "text", text: toolResult === undefined ? "" : JSON.stringify(toolResult) }] };
}

function isCallToolResult(value: unknown): value is CallToolResult {
  return typeof value === "object" && value !== null && "content" in value && Array.isArray((value as { content?: unknown }).content);
}

function contentToText(content: CallToolResult["content"], server: string): string {
  const parts: string[] = [];
  for (const block of content) {
    parts.push(contentBlockToText(block, server));
  }
  return parts.join("\n");
}

function contentBlockToText(block: CallToolResult["content"][number], server: string): string {
  switch (block.type) {
    case "text":
      return block.text;
    case "resource": {
      const resource = block.resource;
      if ("text" in resource) {
        return `[Resource from ${server} at ${resource.uri}] ${resource.text}`;
      }
      return `[binary resource ${resource.uri} omitted]`;
    }
    case "resource_link":
      return `[Resource link from ${server} at ${block.uri}]${block.title ? ` ${block.title}` : ""}`;
    case "image":
      return `[image from ${server} omitted]`;
    case "audio":
      return `[audio from ${server} omitted]`;
    default:
      return "";
  }
}

function truncateMcpText(text: string, maxChars: number): string {
  const limited = truncateText(text, maxChars);
  if (!limited.truncated) return limited.text;
  return `${limited.text}\n[OUTPUT TRUNCATED]`;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise<T>((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => rejectPromise(new Error(message)), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolvePromise(value);
      },
      (error) => {
        clearTimeout(timer);
        rejectPromise(error);
      },
    );
  });
}
