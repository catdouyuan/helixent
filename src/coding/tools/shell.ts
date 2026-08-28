import { existsSync } from "node:fs";

export type ShellId =
  | "zsh"
  | "bash"
  | "sh"
  | "pwsh"
  | "powershell"
  | "cmd"
  | "git-bash"
  | "wsl";

export type ShellSpec = {
  id: ShellId;
  executable: string;
  // eslint-disable-next-line no-unused-vars
  buildArgs: (command: string, cwd: string) => string[];
};

export type ShellResolution =
  | { ok: true; shell: ShellSpec }
  | {
      ok: false;
      code: "SHELL_INVALID" | "SHELL_NOT_FOUND";
      message: string;
    };

export type ShellResolverOptions = {
  platform?: string;
  env?: Record<string, string | undefined>;
  // eslint-disable-next-line no-unused-vars
  findExecutable?: (name: string) => string | undefined;
};

/**
 * WSL accepts absolute POSIX paths and Windows drive paths for `--cd`.
 * Relative paths and UNC/device paths cannot be mapped reliably.
 */
export function isWslCwdSupported(cwd: string): boolean {
  const value = cwd.trim();
  if (!value || /^\\\\|^\/\//.test(value)) {
    return false;
  }
  return value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value);
}

const gitBashCandidates = [
  "bash.exe",
  "C:\\Program Files\\Git\\bin\\bash.exe",
  "C:\\Program Files\\Git\\usr\\bin\\bash.exe",
  "C:\\Program Files (x86)\\Git\\bin\\bash.exe",
];

const shellIds: ShellId[] = ["zsh", "bash", "sh", "pwsh", "powershell", "cmd", "git-bash", "wsl"];

function defaultFindExecutable(name: string) {
  const found = Bun.which(name);
  if (found) {
    return found;
  }
  if (/^[A-Za-z]:[\\/]/.test(name) || name.startsWith("\\\\")) {
    return existsSync(name) ? name : undefined;
  }
  return undefined;
}

function powershellCommand(command: string) {
  return `[Console]::OutputEncoding = [Text.Encoding]::UTF8; $OutputEncoding = [Text.Encoding]::UTF8; ${command}`;
}

function buildArgs(id: ShellId, command: string, cwd: string): string[] {
  switch (id) {
    case "pwsh":
    case "powershell":
      return ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", powershellCommand(command)];
    case "cmd":
      return ["/d", "/s", "/c", `chcp 65001>nul & ${command}`];
    case "git-bash":
      return ["--noprofile", "--norc", "-c", command];
    case "wsl":
      return ["--cd", cwd, "--", "bash", "--noprofile", "--norc", "-c", command];
    case "zsh":
    case "bash":
    case "sh":
      return ["-c", command];
  }

  const unhandledShell: never = id;
  return unhandledShell;
}

function createShellSpec(id: ShellId, executable: string): ShellSpec {
  return {
    id,
    executable,
    buildArgs: (command, cwd) => buildArgs(id, command, cwd),
  };
}

function getComSpec(env: Record<string, string | undefined>) {
  return env.ComSpec?.trim() || env.COMSPEC?.trim() || "cmd.exe";
}

function resolveCandidate(
  id: ShellId,
  candidates: string[],
  // eslint-disable-next-line no-unused-vars
  findExecutable: (name: string) => string | undefined,
): ShellSpec | undefined {
  for (const candidate of candidates) {
    const executable = findExecutable(candidate);
    if (executable) {
      return createShellSpec(id, executable);
    }
  }
  return undefined;
}

function notFound(id?: ShellId): ShellResolution {
  if (id) {
    return {
      ok: false,
      code: "SHELL_NOT_FOUND",
      message: `configured shell '${id}' is not available.`,
    };
  }
  return {
    ok: false,
    code: "SHELL_NOT_FOUND",
    message: "no supported shell is available.",
  };
}

function resolveExplicitShell(
  id: ShellId,
  platform: string,
  env: Record<string, string | undefined>,
  // eslint-disable-next-line no-unused-vars
  findExecutable: (name: string) => string | undefined,
): ShellResolution {
  let candidates: string[] = [];
  switch (id) {
    case "pwsh":
      candidates = [platform === "win32" ? "pwsh.exe" : "pwsh"];
      break;
    case "powershell":
      candidates = [platform === "win32" ? "powershell.exe" : "powershell"];
      break;
    case "cmd":
      candidates = [platform === "win32" ? getComSpec(env) : "cmd.exe"];
      break;
    case "wsl":
      candidates = ["wsl.exe"];
      break;
    case "git-bash":
      candidates = gitBashCandidates;
      break;
    case "zsh":
    case "bash":
    case "sh":
      candidates = [id];
      break;
  }

  const shell = resolveCandidate(id, candidates, findExecutable);
  return shell ? { ok: true, shell } : notFound(id);
}

export function resolveShell(options: ShellResolverOptions = {}): ShellResolution {
  const platform = (options.platform ?? process.platform).trim().toLowerCase();
  const env = options.env ?? process.env;
  const findExecutable = options.findExecutable ?? defaultFindExecutable;
  const configured = env.HELIXENT_SHELL?.trim() ?? "";
  const normalized = configured.toLowerCase();

  if (normalized && normalized !== "auto") {
    if (!shellIds.includes(normalized as ShellId)) {
      return {
        ok: false,
        code: "SHELL_INVALID",
        message: `unsupported HELIXENT_SHELL value '${configured}'.`,
      };
    }
    return resolveExplicitShell(normalized as ShellId, platform, env, findExecutable);
  }

  const candidates: Array<[ShellId, string[]]> =
    platform === "win32"
      ? [
          ["pwsh", ["pwsh.exe"]],
          ["powershell", ["powershell.exe"]],
          ["cmd", [getComSpec(env)]],
        ]
      : [
          ["zsh", ["zsh"]],
          ["bash", ["bash"]],
          ["sh", ["sh"]],
        ];

  for (const [id, names] of candidates) {
    const shell = resolveCandidate(id, names, findExecutable);
    if (shell) {
      return { ok: true, shell };
    }
  }
  return notFound();
}
