import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import { createMcpTools, loadMcpConfig, McpConnectionManager } from "..";

describe("MCP e2e (stdio, integration)", () => {
  let tempDir: string | null = null;
  let manager: McpConnectionManager | null = null;

  afterEach(async () => {
    await manager?.closeAll();
    manager = null;
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
      tempDir = null;
    }
  });

  test("connects, discovers tools/resources, and invokes through a real .mcp.json", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "helixent-mcp-e2e-"));
    const fixture = join(import.meta.dir, "fixtures", "echo-server.ts");
    await writeFile(
      join(tempDir, ".mcp.json"),
      JSON.stringify({ mcpServers: { echo: { command: process.execPath, args: [fixture] } } }),
    );

    const loaded = await loadMcpConfig({ cwd: tempDir });
    expect(loaded.errors).toEqual([]);
    expect(loaded.config.mcpServers.echo).toBeDefined();

    manager = new McpConnectionManager(loaded.config, { connectTimeoutMs: 15_000, manageProcessExit: false });
    const tools = await createMcpTools(manager);

    const echoTool = tools.find((t) => t.name === "mcp__echo__echo");
    const failTool = tools.find((t) => t.name === "mcp__echo__fail");
    expect(echoTool).toBeDefined();
    expect(failTool).toBeDefined();

    // inputSchema is passed through untouched.
    expect((echoTool as { inputSchema?: unknown }).inputSchema).toMatchObject({ type: "object" });

    expect(await echoTool!.invoke({ text: "hello" })).toBe("echo: hello");
    expect(await failTool!.invoke({})).toBe("Error: boom");

    // Resource capabilities produce the two built-in tools.
    const listTool = tools.find((t) => t.name === "list_mcp_resources");
    const readTool = tools.find((t) => t.name === "read_mcp_resource");
    expect(listTool).toBeDefined();
    expect(readTool).toBeDefined();

    expect(await listTool!.invoke({})).toContain("echo://hello");
    expect(await readTool!.invoke({ server: "echo", uri: "echo://hello" })).toContain("Hello world");

    const state = manager.getState("echo");
    expect(state?.status).toBe("connected");
    expect(state?.tools).toHaveLength(2);
    expect(state?.resources).toHaveLength(1);
  });

  test("reports a missing stdio command as ENOENT with a clear message", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "helixent-mcp-e2e-"));
    await writeFile(
      join(tempDir, ".mcp.json"),
      JSON.stringify({ mcpServers: { missing: { command: "definitely-not-a-real-command-xyz", args: [] } } }),
    );

    const loaded = await loadMcpConfig({ cwd: tempDir });
    manager = new McpConnectionManager(loaded.config, { connectTimeoutMs: 5_000, manageProcessExit: false });
    await expect(manager.ensure("missing")).rejects.toThrow();

    const state = manager.getState("missing");
    expect(state?.status).toBe("error");
    expect(state?.errorMessage).toContain("executable not found");
  });
});

describe("MCP e2e (http, integration)", () => {
  let proc: ReturnType<typeof Bun.spawn> | null = null;
  let manager: McpConnectionManager | null = null;

  afterEach(async () => {
    await manager?.closeAll();
    manager = null;
    proc?.kill();
    proc = null;
  });

  async function startHttpFixture(): Promise<string> {
    const fixture = join(import.meta.dir, "fixtures", "http-server.ts");
    proc = Bun.spawn([process.execPath, fixture], { stdout: "pipe", stderr: "pipe" });

    const stdout = proc.stdout as ReadableStream<Uint8Array>;
    const reader = stdout.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const line = buffer.split("\n").find((l) => l.trim().startsWith("{"));
      if (line) {
        const { port } = JSON.parse(line) as { port: number };
        return `http://127.0.0.1:${port}/mcp`;
      }
    }
    throw new Error("HTTP fixture did not report a port in time");
  }

  test("connects over streamable HTTP and invokes a tool", async () => {
    const url = await startHttpFixture();

    manager = new McpConnectionManager(
      { mcpServers: { http_echo: { type: "http", url, headers: {} } } },
      { connectTimeoutMs: 15_000, manageProcessExit: false },
    );
    const tools = await createMcpTools(manager);

    const echoTool = tools.find((t) => t.name === "mcp__http_echo__echo");
    expect(echoTool).toBeDefined();
    expect(await echoTool!.invoke({ text: "hi" })).toBe("http echo: hi");

    expect(manager.getState("http_echo")?.status).toBe("connected");
  }, { timeout: 30_000 });
});
