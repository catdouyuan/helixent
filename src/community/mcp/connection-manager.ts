import { access } from "node:fs/promises";
import { resolve } from "node:path";
import { TextDecoder } from "node:util";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  ResourceListChangedNotificationSchema,
  ToolListChangedNotificationSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";

import type { McpConfig, McpErrorMetadata, McpHttpServerConfig, McpServerConfig, McpStdioServerConfig } from "./config";
import { envInt } from "./env";

export type McpTransportType = "stdio" | "http";

export type McpServerStatus = "connecting" | "connected" | "error" | "needs-auth" | "closed";

export interface McpDiscoveredTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  /** Server-declared annotations (readOnlyHint/destructiveHint/...), recorded for future approval/concurrency use. */
  annotations?: ToolAnnotations;
}

export interface McpDiscoveredResource {
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
}

export interface McpServerState {
  name: string;
  type: McpTransportType;
  status: McpServerStatus;
  tools: McpDiscoveredTool[];
  resources: McpDiscoveredResource[];
  errorMessage?: string;
  stderrTail?: string;
  /** Whether tools/resources discovery has completed (even when the result was empty). */
  toolsFetched?: boolean;
  resourcesFetched?: boolean;
}

/** A live client connection to a single MCP server. */
export interface ServerHandle {
  name: string;
  type: McpTransportType;
  client: Client;
  /** Optional per-call timeout; stdio calls cannot be truly cancelled, late results are discarded. */
  toolTimeoutMs?: number;
  close(): Promise<void>;
}

export interface McpConnectionManagerOptions {
  connectTimeoutMs?: number;
  toolTimeoutMs?: number;
  maxStderrBytes?: number;
  /** Config-level errors (e.g. missing env vars) to surface as pre-failed server states. */
  errors?: McpErrorMetadata[];
  manageProcessExit?: boolean;
}

export const DEFAULT_MCP_CONNECT_TIMEOUT_MS = 15_000;
export const DEFAULT_MCP_STDERR_TAIL_BYTES = 64 * 1024;

const MCP_CLIENT_NAME = "helixent";
const MCP_CLIENT_VERSION = "1.3.1";

/**
 * Owns MCP server connections: memoized per server, with status tracking,
 * timeout handling, failure degradation, and cache invalidation on close or
 * `list_changed` notifications.
 */
export class McpConnectionManager {
  private readonly _config: Record<string, McpServerConfig>;
  private readonly _options: McpConnectionManagerOptions;
  private readonly _entries = new Map<string, Promise<ServerHandle>>();
  private readonly _states = new Map<string, McpServerState>();
  private _closing = false;
  private _exitHandlersAttached = false;

  constructor(config: McpConfig, options: McpConnectionManagerOptions = {}) {
    this._config = config.mcpServers;
    this._options = options;
    if (options.manageProcessExit !== false) {
      this._attachExitHandlers();
    }
    for (const error of options.errors ?? []) {
      if (!error.serverName) continue;
      this._states.set(error.serverName, {
        name: error.serverName,
        type: error.serverType ?? "stdio",
        status: "error",
        tools: [],
        resources: [],
        errorMessage: error.message,
      });
    }
  }

  /** Returns the names of all configured servers. */
  serverNames(): string[] {
    return Object.keys(this._config);
  }

  /** Returns the current state record for a server, if any. */
  getState(name: string): McpServerState | undefined {
    return this._states.get(name);
  }

  /** Returns state records for every known server (configured + pre-failed). */
  listStates(): McpServerState[] {
    return [...this._states.values()];
  }

  /**
   * Returns the memoized connection for a server, connecting on first use.
   * Failed/timed-out connects are removed from the cache so the next call rebuilds.
   */
  ensure(name: string): Promise<ServerHandle> {
    const cfg = this._config[name];
    if (!cfg) {
      throw new Error(`Unknown MCP server: ${name}`);
    }
    const key = this._key(name);
    const existing = this._entries.get(key);
    if (existing) return existing;

    const connecting = this._connect(name, cfg);
    this._entries.set(key, connecting);
    connecting.catch(() => {
      if (this._entries.get(key) === connecting) {
        this._entries.delete(key);
      }
    });
    return connecting;
  }

  /** Invalidates cached connection, tools, and resources for a server. */
  invalidate(name: string): void {
    this._entries.delete(this._key(name));
    const state = this._states.get(name);
    if (state) {
      state.tools = [];
      state.resources = [];
      state.toolsFetched = false;
      state.resourcesFetched = false;
    }
  }

  /** Closes every live connection (stdio transports terminate their child processes). */
  async closeAll(): Promise<void> {
    if (this._closing) return;
    this._closing = true;
    const handles = [...new Set([...this._entries.values()])];
    await Promise.allSettled(handles.map((promise) => promise.then((handle) => handle.close(), () => undefined)));
    this._entries.clear();
    for (const state of this._states.values()) {
      if (state.status === "connected" || state.status === "connecting") {
        state.status = "closed";
      }
    }
  }

  private async _connect(name: string, cfg: McpServerConfig): Promise<ServerHandle> {
    const state = this._stateFor(name, cfg);
    state.status = "connecting";
    state.errorMessage = undefined;
    state.stderrTail = undefined;

    const client = new Client({ name: MCP_CLIENT_NAME, version: MCP_CLIENT_VERSION });
    const handle: ServerHandle = {
      name,
      type: transportTypeOf(cfg),
      client,
      ...(this._options.toolTimeoutMs !== undefined
        ? { toolTimeoutMs: this._options.toolTimeoutMs }
        : { toolTimeoutMs: envInt("HELIXENT_MCP_TOOL_TIMEOUT_MS", 0) }),
      close: () => client.close(),
    };

    try {
      const transport =
        cfg.type === "http" ? await this._createHttpTransport(cfg) : await this._createStdioTransport(name, cfg, state);
      const connectPromise = client.connect(transport);
      connectPromise.catch(() => {
        // Timeout/close paths clean up below; this avoids an unhandled rejection.
      });
      await this._raceConnect(connectPromise, name);

      client.onclose = () => this._handleClosed(name, state);
      client.setNotificationHandler(ToolListChangedNotificationSchema, () => this.invalidate(name));
      client.setNotificationHandler(ResourceListChangedNotificationSchema, () => this.invalidate(name));
      state.status = "connected";
      return handle;
    } catch (error) {
      await client.close().catch(() => undefined);
      state.status = classifyMcpError(error);
      state.errorMessage = describeMcpError(error, cfg);
      throw error;
    }
  }

  private async _createStdioTransport(name: string, cfg: McpStdioServerConfig, state: McpServerState): Promise<StdioClientTransport> {
    await assertCommandExists(cfg.command);
    const transport = new StdioClientTransport({
      command: cfg.command,
      args: cfg.args,
      env: { ...process.env, ...cfg.env } as Record<string, string>,
      stderr: "pipe",
    });
    const maxBytes = this._options.maxStderrBytes ?? DEFAULT_MCP_STDERR_TAIL_BYTES;
    const ring = new RingBuffer(maxBytes);
    transport.stderr?.on("data", (chunk: Buffer) => {
      ring.push(decodeStderrChunk(chunk));
      state.stderrTail = ring.tail();
    });
    return transport;
  }

  private async _createHttpTransport(cfg: McpHttpServerConfig): Promise<StreamableHTTPClientTransport> {
    // Lazy import keeps `build:bin` free of SDK modules we never use at startup.
    const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
    return new StreamableHTTPClientTransport(new URL(cfg.url), {
      requestInit: { headers: cfg.headers },
    });
  }

  private async _raceConnect(connectPromise: Promise<void>, name: string): Promise<void> {
    const timeoutMs = this._options.connectTimeoutMs ?? envInt("HELIXENT_MCP_CONNECT_TIMEOUT_MS", DEFAULT_MCP_CONNECT_TIMEOUT_MS);
    if (timeoutMs <= 0) {
      await connectPromise;
      return;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`Timed out connecting to MCP server "${name}" after ${timeoutMs}ms`)), timeoutMs);
    });
    try {
      await Promise.race([connectPromise, timeout]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  private _handleClosed(name: string, state: McpServerState): void {
    this.invalidate(name);
    if (state.status === "connected" || state.status === "connecting") {
      state.status = "closed";
    }
  }

  private _stateFor(name: string, cfg: McpServerConfig): McpServerState {
    const existing = this._states.get(name);
    if (existing) return existing;
    const state: McpServerState = { name, type: transportTypeOf(cfg), status: "connecting", tools: [], resources: [] };
    this._states.set(name, state);
    return state;
  }

  private _key(name: string): string {
    return `${name}\u0000${JSON.stringify(this._config[name])}`;
  }

  private _attachExitHandlers(): void {
    if (this._exitHandlersAttached) return;
    this._exitHandlersAttached = true;
    process.once("exit", () => {
      void this.closeAll();
    });
    process.once("SIGINT", () => {
      void this.closeAll().finally(() => process.exit(130));
    });
    process.once("SIGTERM", () => {
      void this.closeAll().finally(() => process.exit(143));
    });
  }
}

function transportTypeOf(cfg: McpServerConfig): McpTransportType {
  return cfg.type === "http" ? "http" : "stdio";
}

function classifyMcpError(error: unknown): McpServerStatus {
  return isHttpUnauthorized(error) ? "needs-auth" : "error";
}

function describeMcpError(error: unknown, cfg: McpServerConfig): string {
  const status = httpStatusOf(error);
  if (status === 401) {
    return "HTTP 401 Unauthorized — this server requires authentication. This build supports static headers only: add an `Authorization` header to the server's `headers` in .mcp.json.";
  }
  if (status === 403) {
    return "HTTP 403 Forbidden — the server rejected the credentials/request. Check the `Authorization` header in .mcp.json.";
  }
  if (status === 404) {
    return "HTTP 404 Not Found — no MCP endpoint at this URL. Streamable HTTP servers usually expose a path such as /mcp; check the `url` in .mcp.json.";
  }
  if (status === 405) {
    return "HTTP 405 Method Not Allowed — the server does not accept MCP requests at this endpoint. Check the `url` in .mcp.json.";
  }
  if (status === 429) {
    return "HTTP 429 Too Many Requests — the server is rate limiting. Wait a moment and retry.";
  }
  if (status !== undefined && status >= 500) {
    return `HTTP ${status} — the MCP server returned a server error. Check the server logs and the "url" in .mcp.json.`;
  }
  const code = (error as { code?: unknown } | null)?.code;
  if (code === "ENOENT") {
    const command = "command" in cfg ? cfg.command : "(unknown)";
    return `Failed to spawn command "${command}": executable not found.`;
  }
  if (code === "EACCES") {
    return "Permission denied spawning the MCP server process.";
  }
  return error instanceof Error ? error.message : String(error);
}

/** Extracts an HTTP status code (400-599) from a transport/connect error, if any. */
function httpStatusOf(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined;
  const e = error as { status?: unknown; code?: unknown; response?: { status?: unknown } };
  const candidates = [e.status, e.code, e.response?.status];
  for (const candidate of candidates) {
    if (typeof candidate === "number" && candidate >= 400 && candidate < 600) return candidate;
  }
  const message = (error as { message?: unknown }).message;
  if (typeof message === "string") {
    const match = message.match(/\b([45]\d\d)\b/);
    if (match) return Number(match[1]);
  }
  return undefined;
}

function isHttpUnauthorized(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const e = error as { status?: unknown; code?: unknown; message?: unknown };
  if (e.status === 401 || e.code === 401) return true;
  return typeof e.message === "string" && /401|unauthorized/i.test(e.message);
}

/** Bounded string buffer used to keep a tail of server stderr for diagnostics. */
class RingBuffer {
  private _buffer = "";
  private readonly _capacity: number;

  constructor(capacity: number) {
    this._capacity = capacity;
  }

  push(text: string): void {
    this._buffer = (this._buffer + text).slice(-this._capacity);
  }

  tail(): string {
    return this._buffer;
  }
}

/**
 * Pre-flights a stdio `command` so a missing executable fails fast with a clear
 * ENOENT-style error. On Bun + Windows the SDK's stdio transport surfaces spawn
 * failures only as a generic "Connection closed" protocol error (cmd.exe writes
 * the real reason to stderr and exits), so we resolve the command ourselves.
 * `Bun.which` covers PATH + PATHEXT (e.g. `npx` -> `npx.cmd`) and absolute paths;
 * relative paths with separators fall back to a direct existence check.
 */
async function assertCommandExists(command: string): Promise<void> {
  if ((await Bun.which(command)) !== null) return;
  if (command.includes("/") || command.includes("\\")) {
    try {
      await access(resolve(command));
      return;
    } catch {
      // Not a resolvable path; fall through to ENOENT below.
    }
  }
  const error = new Error(`Failed to spawn command "${command}": executable not found.`);
  (error as { code?: string }).code = "ENOENT";
  throw error;
}

/**
 * Decodes a stderr chunk from an MCP server process. Windows console output is
 * typically GBK (cmd.exe error messages), which UTF-8 decoding mangles into
 * replacement characters; fall back to GBK when that happens.
 */
function decodeStderrChunk(chunk: Buffer): string {
  const utf8 = chunk.toString("utf8");
  if (!utf8.includes("\uFFFD")) return utf8;
  try {
    return new TextDecoder("gbk").decode(chunk);
  } catch {
    return utf8;
  }
}
