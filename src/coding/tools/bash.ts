import z from "zod";

import { defineTool } from "@/foundation";

import { isWslCwdSupported, resolveShell } from "./shell";

export type BashToolOptions = {
  cwd?: string;
};

const bashParameters = z.object({
  description: z
    .string()
    .describe("Explain why you want to execute the command. Always place `description` as the first parameter."),
  command: z.string().describe("The command to execute using the active shell syntax."),
});

function shellError(code: string, message: string) {
  return `Error: ${code}: ${message}`;
}

export function createBashTool(options: BashToolOptions = {}) {
  const configuredCwd = options.cwd;

  return defineTool({
    name: "bash",
    description:
      "Execute a command through the configured platform shell.\nOn Windows, PowerShell is used by default.\nUse HELIXENT_SHELL=git-bash or HELIXENT_SHELL=wsl for POSIX shell syntax.",
    parameters: bashParameters,
    invoke: async ({ command }, signal) => {
      if (signal?.aborted) {
        throw new DOMException("Aborted", "AbortError");
      }

      const resolution = resolveShell();
      if (!resolution.ok) {
        return shellError(resolution.code, resolution.message);
      }

      const cwd = configuredCwd ?? process.cwd();
      if (resolution.shell.id === "wsl" && !isWslCwdSupported(cwd)) {
        return shellError("SHELL_CWD_UNSUPPORTED", "unable to use cwd with WSL.");
      }

      let proc: Bun.Subprocess<"ignore", "pipe", "pipe">;
      try {
        proc = Bun.spawn({
          cmd: [resolution.shell.executable, ...resolution.shell.buildArgs(command, cwd)],
          cwd: configuredCwd,
          stdout: "pipe",
          stderr: "pipe",
        });
      } catch {
        if (resolution.shell.id === "wsl") {
          return shellError("SHELL_CWD_UNSUPPORTED", "unable to use cwd with WSL.");
        }
        return shellError("SHELL_EXEC_FAILED", `failed to start shell '${resolution.shell.id}'.`);
      }

      let onAbort: (() => void) | undefined;
      if (signal) {
        let killed = false;
        onAbort = () => {
          if (!killed) {
            killed = true;
            proc.kill();
          }
        };
        signal.addEventListener("abort", onAbort, { once: true });
        if (signal.aborted) {
          onAbort();
        }
      }

      try {
        const [output, stderr, exitCode] = await Promise.all([
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
          proc.exited,
        ]);

        if (exitCode !== 0) {
          if (resolution.shell.id === "wsl" && isWslCwdFailure(stderr)) {
            return shellError("SHELL_CWD_UNSUPPORTED", "unable to use cwd with WSL.");
          }
          return `Error: Command ${command} failed with exit code ${exitCode}: ${stderr}`;
        }
        return output;
      } catch {
        return shellError("SHELL_EXEC_FAILED", `failed to start shell '${resolution.shell.id}'.`);
      } finally {
        if (signal && onAbort) {
          signal.removeEventListener("abort", onAbort);
        }
      }
    },
  });
}

function isWslCwdFailure(stderr: string) {
  const message = stderr.toLowerCase();
  return (
    message.includes("failed to translate") ||
    (message.includes("chdir(") && (message.includes("failed") || message.includes("no such"))) ||
    message.includes("error_path_not_found") ||
    message.includes("specified path was not found") ||
    message.includes("system cannot find the path specified")
  );
}

export const bashTool = createBashTool();
