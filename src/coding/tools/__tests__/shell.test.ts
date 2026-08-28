import { describe, expect, test } from "bun:test";

import { resolveShell, type ShellId } from "../shell";

type Resolution = ReturnType<typeof resolveShell>;
type ResolutionErrorCode = Extract<Resolution, { ok: false }>["code"];

function expectShell(resolution: Resolution, id: ShellId, executable: string) {
  expect(resolution.ok).toBe(true);
  if (!resolution.ok) {
    throw new Error(resolution.message);
  }
  expect(resolution.shell.id).toBe(id);
  expect(resolution.shell.executable).toBe(executable);
}

function expectResolutionError(resolution: Resolution, code: ResolutionErrorCode) {
  expect(resolution.ok).toBe(false);
  if (resolution.ok) {
    throw new Error(`Expected ${code}, but resolved ${resolution.shell.id}`);
  }
  expect(resolution.code).toBe(code);
}

describe("resolveShell", () => {
  test("selects pwsh first on Windows", () => {
    const requested: string[] = [];
    const resolution = resolveShell({
      platform: "win32",
      env: {},
      findExecutable: (name) => {
        requested.push(name);
        return name === "pwsh.exe" ? "C:\\Tools\\pwsh.exe" : undefined;
      },
    });

    expectShell(resolution, "pwsh", "C:\\Tools\\pwsh.exe");
    expect(requested).toEqual(["pwsh.exe"]);
  });

  test("falls back to Windows PowerShell when pwsh is unavailable", () => {
    const requested: string[] = [];
    const resolution = resolveShell({
      platform: "win32",
      env: {},
      findExecutable: (name) => {
        requested.push(name);
        return name === "powershell.exe"
          ? "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"
          : undefined;
      },
    });

    expectShell(
      resolution,
      "powershell",
      "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    );
    expect(requested).toEqual(["pwsh.exe", "powershell.exe"]);
  });

  test("falls back to cmd when both PowerShell variants are unavailable", () => {
    const comSpec = "C:\\Windows\\System32\\cmd.exe";
    const requested: string[] = [];
    const resolution = resolveShell({
      platform: "win32",
      env: { ComSpec: comSpec },
      findExecutable: (name) => {
        requested.push(name);
        return name === comSpec ? comSpec : undefined;
      },
    });

    expectShell(resolution, "cmd", comSpec);
    expect(requested).toEqual(["pwsh.exe", "powershell.exe", comSpec]);
  });

  test("selects zsh first on Unix", () => {
    const requested: string[] = [];
    const resolution = resolveShell({
      platform: "linux",
      env: {},
      findExecutable: (name) => {
        requested.push(name);
        return name === "zsh" ? "/bin/zsh" : undefined;
      },
    });

    expectShell(resolution, "zsh", "/bin/zsh");
    expect(requested).toEqual(["zsh"]);
  });

  test("falls back to bash on Unix when zsh is unavailable", () => {
    const requested: string[] = [];
    const resolution = resolveShell({
      platform: "darwin",
      env: {},
      findExecutable: (name) => {
        requested.push(name);
        return name === "bash" ? "/bin/bash" : undefined;
      },
    });

    expectShell(resolution, "bash", "/bin/bash");
    expect(requested).toEqual(["zsh", "bash"]);
  });

  test("falls back to sh on Unix when it is the only available shell", () => {
    const requested: string[] = [];
    const resolution = resolveShell({
      platform: "linux",
      env: {},
      findExecutable: (name) => {
        requested.push(name);
        return name === "sh" ? "/bin/sh" : undefined;
      },
    });

    expectShell(resolution, "sh", "/bin/sh");
    expect(requested).toEqual(["zsh", "bash", "sh"]);
  });

  test("only searches Git Bash candidates when explicitly configured", () => {
    const gitBash = "C:\\Program Files\\Git\\bin\\bash.exe";
    const requested: string[] = [];
    const resolution = resolveShell({
      platform: "win32",
      env: { HELIXENT_SHELL: "git-bash" },
      findExecutable: (name) => {
        requested.push(name);
        if (name === gitBash) return gitBash;
        if (name === "pwsh.exe") return "C:\\Tools\\pwsh.exe";
        return undefined;
      },
    });

    expectShell(resolution, "git-bash", gitBash);
    expect(requested).toEqual(["bash.exe", gitBash]);
  });

  test("returns SHELL_NOT_FOUND when explicitly configured Git Bash is unavailable", () => {
    const resolution = resolveShell({
      platform: "win32",
      env: { HELIXENT_SHELL: "git-bash" },
      findExecutable: () => undefined,
    });

    expectResolutionError(resolution, "SHELL_NOT_FOUND");
  });

  test("does not fall back to PowerShell when explicitly configured WSL is unavailable", () => {
    const requested: string[] = [];
    const resolution = resolveShell({
      platform: "win32",
      env: { HELIXENT_SHELL: "wsl" },
      findExecutable: (name) => {
        requested.push(name);
        return name === "pwsh.exe" ? "C:\\Tools\\pwsh.exe" : undefined;
      },
    });

    expectResolutionError(resolution, "SHELL_NOT_FOUND");
    expect(requested).toEqual(["wsl.exe"]);
  });

  test("returns SHELL_INVALID for an unsupported configured value", () => {
    const requested: string[] = [];
    const resolution = resolveShell({
      platform: "linux",
      env: { HELIXENT_SHELL: "fish" },
      findExecutable: (name) => {
        requested.push(name);
        return "/usr/bin/fish";
      },
    });

    expectResolutionError(resolution, "SHELL_INVALID");
    expect(requested).toEqual([]);
  });

  test("normalizes configured shell casing and surrounding whitespace", () => {
    const resolution = resolveShell({
      platform: "linux",
      env: { HELIXENT_SHELL: "  BaSh  " },
      findExecutable: (name) => (name === "bash" ? "/bin/bash" : undefined),
    });

    expectShell(resolution, "bash", "/bin/bash");
  });
});
