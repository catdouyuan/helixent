import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import { expandEnvVars, findMcpConfigPath, loadMcpConfig, parseMcpConfigText } from "../config";

const createdDirs: string[] = [];

async function makeTempDir(prefix = "helixent-mcp-config-"): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  createdDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(createdDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("findMcpConfigPath", () => {
  test("finds the nearest .mcp.json by walking up", async () => {
    const root = await makeTempDir();
    const nested = join(root, "a", "b");
    await mkdir(nested, { recursive: true });
    await writeFile(join(root, ".mcp.json"), '{"mcpServers":{}}');

    expect(await findMcpConfigPath(nested)).toBe(join(root, ".mcp.json"));
    expect(await findMcpConfigPath(root)).toBe(join(root, ".mcp.json"));

    await writeFile(join(nested, ".mcp.json"), '{"mcpServers":{}}');
    expect(await findMcpConfigPath(nested)).toBe(join(nested, ".mcp.json"));
  });

  test("returns null when no .mcp.json exists", async () => {
    const dir = await makeTempDir();
    expect(await findMcpConfigPath(dir)).toBeNull();
  });
});

describe("loadMcpConfig", () => {
  test("returns an empty config when no file is found", async () => {
    const dir = await makeTempDir();
    const result = await loadMcpConfig({ cwd: dir });
    expect(result.configPath).toBeNull();
    expect(result.config).toEqual({ mcpServers: {} });
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  test("loads and expands ${VAR} / ${VAR:-default} across stdio and http servers", async () => {
    const dir = await makeTempDir();
    await writeFile(
      join(dir, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          fs: { command: "node", args: ["${MCP_ARGS}", "${MCP_DEFAULTED:-fallback}"], env: { TOKEN: "${MCP_TOKEN}" } },
          http: {
            type: "http",
            url: "https://example.com/${MCP_PATH}",
            headers: { Authorization: "Bearer ${MCP_TOKEN}" },
          },
        },
      }),
    );

    const result = await loadMcpConfig({
      cwd: dir,
      env: { MCP_ARGS: "server.js", MCP_TOKEN: "secret", MCP_PATH: "mcp" },
    });

    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(result.config.mcpServers.fs).toMatchObject({
      command: "node",
      args: ["server.js", "fallback"],
      env: { TOKEN: "secret" },
    });
    expect(result.config.mcpServers.http).toMatchObject({
      url: "https://example.com/mcp",
      headers: { Authorization: "Bearer secret" },
    });
  });

  test("drops servers with missing env vars and records a structured error", async () => {
    const dir = await makeTempDir();
    await writeFile(join(dir, ".mcp.json"), JSON.stringify({ mcpServers: { fs: { command: "${MISSING_VAR}" } } }));

    const result = await loadMcpConfig({ cwd: dir, env: {} });

    expect(result.config.mcpServers.fs).toBeUndefined();
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatchObject({ serverName: "fs", severity: "error", serverType: "stdio" });
    expect(result.errors[0]!.message).toContain("MISSING_VAR");
  });

  test("reports invalid JSON with the file path", async () => {
    const dir = await makeTempDir();
    await writeFile(join(dir, ".mcp.json"), "{ not json");

    const result = await loadMcpConfig({ cwd: dir });

    expect(result.config.mcpServers).toEqual({});
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]!.message).toContain("Invalid JSON");
    expect(result.errors[0]!.path).toBe(join(dir, ".mcp.json"));
  });

  test("reports schema validation errors", async () => {
    const dir = await makeTempDir();
    await writeFile(join(dir, ".mcp.json"), JSON.stringify({ mcpServers: { fs: { command: 123 } } }));

    const result = await loadMcpConfig({ cwd: dir });

    expect(result.config.mcpServers).toEqual({});
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]!.message).toContain("schema");
  });
});

describe("expandEnvVars", () => {
  test("expands ${VAR} and ${VAR:-default}", () => {
    expect(expandEnvVars("${A}", { A: "1" })).toEqual({ value: "1", missing: [] });
    expect(expandEnvVars("pre-${A}-post", { A: "x" })).toEqual({ value: "pre-x-post", missing: [] });
    expect(expandEnvVars("${A:-d}", {})).toEqual({ value: "d", missing: [] });
    expect(expandEnvVars("${A:-d}", { A: "x" })).toEqual({ value: "x", missing: [] });
  });

  test("records missing vars without a default", () => {
    expect(expandEnvVars("${A}", {})).toEqual({ value: "${A}", missing: ["A"] });
  });
});

describe("parseMcpConfigText (Windows npx hint)", () => {
  test("warns for bare npx on win32 only", () => {
    const raw = JSON.stringify({ mcpServers: { fs: { command: "npx" } } });

    const win = parseMcpConfigText(raw, "C:\\project\\.mcp.json", {}, "win32");
    expect(win.warnings).toHaveLength(1);
    expect(win.warnings[0]!.message).toContain("npx.cmd");
    expect(win.warnings[0]!).toMatchObject({ serverName: "fs", severity: "warning" });

    const linux = parseMcpConfigText(raw, "/project/.mcp.json", {}, "linux");
    expect(linux.warnings).toEqual([]);
  });
});

describe("loadMcpConfig (UTF-8 BOM)", () => {
  test("tolerates a leading BOM written by Windows editors / PowerShell", async () => {
    const dir = await makeTempDir();
    await writeFile(join(dir, ".mcp.json"), "\uFEFF" + JSON.stringify({ mcpServers: { fs: { command: "node" } } }));
    const result = await loadMcpConfig({ cwd: dir });
    expect(result.errors).toEqual([]);
    expect(result.config.mcpServers.fs).toMatchObject({ command: "node" });
  });
});
