import type { CallToolResult, ReadResourceResult } from "@modelcontextprotocol/sdk/types.js";

import { truncateText } from "@/foundation";

import type { McpConnectionManager, ServerHandle } from "./connection-manager";
import { envInt } from "./env";

/** Default maximum characters for a normalized MCP tool result. */
export const MAX_MCP_OUTPUT_CHARS = envInt("HELIXENT_MCP_MAX_OUTPUT_CHARS", 24_000);

/**
 * Calls an MCP tool and normalizes the result to a single string.
 * The SDK call is aborted when the outer signal aborts or the per-call timeout
 * fires (HTTP requests are cancelled for real; stdio requests can only be
 * discarded client-side since the request is already in flight).
 * @param handle - The connected server handle.
 * @param toolName - The MCP tool name (unprefixed).
 * @param input - The tool arguments.
 * @param signal - Optional abort signal forwarded to the SDK.
 * @returns The normalized tool result text.
 */
export async function callMcpTool(handle: ServerHandle, toolName: string, input: unknown, signal?: AbortSignal): Promise<string> {
  const timeoutMs = handle.toolTimeoutMs ?? 0;
  const timeoutMessage = `Timed out calling MCP tool "${toolName}" on server "${handle.name}"`;

  // A controller we control: abort it when the outer signal aborts OR when the
  // tool timeout fires, so the SDK call is actually cancelled (not just timed out).
  const controller = new AbortController();
  const onOuterAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) {
      controller.abort();
    } else {
      signal.addEventListener("abort", onOuterAbort, { once: true });
    }
  }

  const call = handle.client.callTool(
    { name: toolName, arguments: (input ?? {}) as Record<string, unknown> },
    undefined,
    { signal: controller.signal },
  );

  let timer: ReturnType<typeof setTimeout> | undefined;
  // When the timeout fires, abort the SDK call AND settle with our message in
  // the same tick (so callers get a deterministic "Timed out" even if the
  // transport ignores the abort signal, e.g. stdio edge cases).
  const pending =
    timeoutMs > 0
      ? Promise.race([
          call,
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => {
              const error = new Error(timeoutMessage);
              controller.abort(error);
              reject(error);
            }, timeoutMs);
          }),
        ])
      : call;

  try {
    const raw = await pending;
    return normalizeMcpResult(toCallToolResult(raw), handle.name);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    signal?.removeEventListener("abort", onOuterAbort);
  }
}

/**
 * Calls an MCP tool with a single retry when the connection turned stale
 * mid-call (server restarted / network dropped). Only transport-level
 * "connection closed" errors trigger the retry: the cached handle is invalidated,
 * the connection is rebuilt, and the tool is called once more. Server-side tool
 * errors and `isError` results are never retried. A second failure is thrown as-is.
 */
export async function callMcpToolWithRetry(
  manager: McpConnectionManager,
  server: string,
  toolName: string,
  input: unknown,
  signal?: AbortSignal,
): Promise<string> {
  let handle = await manager.ensure(server);
  try {
    return await callMcpTool(handle, toolName, input, signal);
  } catch (error) {
    if (!isConnectionClosedError(error)) throw error;
    manager.invalidate(server);
    handle = await manager.ensure(server);
    return callMcpTool(handle, toolName, input, signal);
  }
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

/**
 * Detects transport-level "connection closed" failures (stale handle, server
 * restart, network drop). These are the only errors eligible for a one-shot retry.
 */
function isConnectionClosedError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const e = error as { code?: unknown; message?: unknown };
  if (e.code === -32000) return true;
  const message = typeof e.message === "string" ? e.message : "";
  return /connection closed|connection lost|transport closed|not connected/i.test(message);
}
