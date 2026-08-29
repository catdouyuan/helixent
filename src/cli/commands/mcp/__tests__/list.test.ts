import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import { loadMcpConfig } from "@/community/mcp";

import { collectServerStates } from "../index";

describe("helixent mcp list state collection", () => {
  let tempDir: string | null = null;

  afterEach(async () => {
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
      tempDir = null;
    }
  });

  test("discovers tools and resources counts for connected servers", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "helixent-mcp-list-"));
    const fixture = join(import.meta.dir, "../../../../community/mcp/__tests__/fixtures/echo-server.ts");
    await writeFile(
      join(tempDir, ".mcp.json"),
      JSON.stringify({ mcpServers: { echo: { command: process.execPath, args: [fixture] } } }),
    );

    const loaded = await loadMcpConfig({ cwd: tempDir });
    const states = await collectServerStates(loaded.config, {
      errors: loaded.errors,
      connectTimeoutMs: 15_000,
      manageProcessExit: false,
    });

    const echo = states.find((s) => s.name === "echo");
    expect(echo?.status).toBe("connected");
    expect(echo?.tools.map((t) => t.name)).toEqual(["echo", "fail"]);
    expect(echo?.resources.map((r) => r.uri)).toEqual(["echo://hello"]);
  });

  test("reports failed servers without aborting the collection", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "helixent-mcp-list-"));
    await writeFile(
      join(tempDir, ".mcp.json"),
      JSON.stringify({ mcpServers: { missing: { command: "definitely-not-a-real-command-xyz", args: [] } } }),
    );

    const loaded = await loadMcpConfig({ cwd: tempDir });
    const states = await collectServerStates(loaded.config, {
      errors: loaded.errors,
      connectTimeoutMs: 5_000,
      manageProcessExit: false,
    });

    const missing = states.find((s) => s.name === "missing");
    expect(missing?.status).toBe("error");
    expect(missing?.errorMessage).toContain("executable not found");
  });
});
