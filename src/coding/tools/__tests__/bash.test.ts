import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { createBashTool } from "../bash";
import { resolveShell, type ShellId } from "../shell";

let originalConfiguredShell: string | undefined;

beforeEach(() => {
  originalConfiguredShell = process.env.HELIXENT_SHELL;
  process.env.HELIXENT_SHELL = "auto";
});

afterEach(() => {
  if (originalConfiguredShell === undefined) {
    delete process.env.HELIXENT_SHELL;
  } else {
    process.env.HELIXENT_SHELL = originalConfiguredShell;
  }
});

function defaultShellId(): ShellId {
  const resolution = resolveShell();
  if (!resolution.ok) {
    throw new Error(resolution.message);
  }
  return resolution.shell.id;
}

function commandForShell(commands: {
  powershell: string;
  cmd: string;
  posix: string;
}): string {
  switch (defaultShellId()) {
    case "pwsh":
    case "powershell":
      return commands.powershell;
    case "cmd":
      return commands.cmd;
    case "zsh":
    case "bash":
    case "sh":
      return commands.posix;
    case "git-bash":
    case "wsl":
      throw new Error("The default shell must not resolve to Git Bash or WSL");
  }
}

function comparablePath(path: string): string {
  const normalized = resolve(path.trim()).replaceAll("\\", "/");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

describe("createBashTool", () => {
  test("returns stdout for a successful command", async () => {
    const command = commandForShell({
      powershell: "Write-Output hi",
      cmd: "echo hi",
      posix: "printf 'hi\\n'",
    });
    const result = await createBashTool().invoke({
      description: "Echo greeting",
      command,
    });

    expect(result.trim()).toBe("hi");
  });

  test("preserves Chinese stdout across the active shell", async () => {
    const command = commandForShell({
      powershell: 'Write-Output "你好，世界"',
      cmd: "echo 你好，世界",
      posix: "printf '你好，世界\\n'",
    });
    const result = await createBashTool().invoke({
      description: "Print Chinese output",
      command,
    });

    expect(result.trim()).toBe("你好，世界");
  });

  test("returns an error string when the command fails", async () => {
    const command = commandForShell({
      powershell: "Write-Error 'failure'; exit 42",
      cmd: "echo failure 1>&2 & exit /b 42",
      posix: "printf 'failure\\n' >&2; exit 42",
    });
    const result = await createBashTool().invoke({
      description: "Force non-zero exit",
      command,
    });

    expect(result.startsWith(`Error: Command ${command} failed with exit code 42:`)).toBe(true);
    expect(result).toContain("failure");
  });

  test("executes the command in the configured cwd", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "helixent-bash-"));
    try {
      const command = commandForShell({
        powershell: "(Get-Location).Path",
        cmd: "cd",
        posix: "pwd",
      });
      const result = await createBashTool({ cwd }).invoke({
        description: "Print working directory",
        command,
      });

      expect(comparablePath(result)).toBe(comparablePath(cwd));
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("terminates the child process when aborted", async () => {
    const command = commandForShell({
      powershell: "while ($true) { }",
      cmd: "for /L %i in (1,1,2147483647) do @rem",
      posix: "while :; do :; done",
    });
    const controller = new AbortController();
    const resultPromise = createBashTool().invoke(
      {
        description: "Run until cancelled",
        command,
      },
      controller.signal,
    );

    setTimeout(() => controller.abort(), 100);

    const result = await resultPromise;
    expect(controller.signal.aborted).toBe(true);
    expect(result.startsWith("Error:")).toBe(true);
  });
});
