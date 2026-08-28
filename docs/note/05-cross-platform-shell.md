# 跨平台 Shell 技术方案

## 1. 目标与边界

当前 [src/coding/tools/bash.ts](../../src/coding/tools/bash.ts) 将 Shell 固定为 `zsh -c`。macOS/Linux 通常内置 zsh，但 Windows 默认没有 zsh，因此需要引入跨平台 Shell 解析逻辑。

本方案的目标是让 `bash` 工具在 Windows 上开箱可用，同时保留 Unix 环境中的现有行为。

固定规则如下：

```text
Windows 未配置 HELIXENT_SHELL:
  pwsh.exe
  -> powershell.exe
  -> cmd.exe

Windows 已配置 HELIXENT_SHELL:
  只使用指定 Shell
  Shell 不存在时返回 SHELL_NOT_FOUND
  不自动回退

macOS/Linux 未配置 HELIXENT_SHELL:
  zsh
  -> bash
  -> sh

Git Bash / WSL:
  只允许通过 HELIXENT_SHELL 显式启用
  不参与 Windows 默认回退
  不做跨 Shell 命令翻译
```

保留现有工具名 `bash`、参数结构和结果格式，避免破坏 Agent 与工具之间的协议。

## 2. 环境变量协议

新增环境变量：

```text
HELIXENT_SHELL
```

支持的值：

| 值             | 含义                        |
| -------------- | --------------------------- |
| `auto`       | 使用当前平台的默认探测顺序  |
| `pwsh`       | PowerShell 7                |
| `powershell` | Windows PowerShell 5.1      |
| `cmd`        | Windows Command Prompt      |
| `zsh`        | zsh                         |
| `bash`       | bash                        |
| `sh`         | POSIX sh                    |
| `git-bash`   | Git for Windows 提供的 bash |
| `wsl`        | WSL 默认发行版中的 bash     |

约定：

- 环境变量未设置或为空时，等同于 `auto`。
- 值忽略首尾空格，并采用大小写不敏感匹配。
- 第一版只接受上述受控 Shell 名称，不接受任意可执行文件路径。
- 自定义 Shell 路径需要用户先加入系统 `PATH`。
- 不支持的值返回 `SHELL_INVALID`。
- 显式指定的 Shell 不存在时返回 `SHELL_NOT_FOUND`，不能切换到其他 Shell。

示例：

```powershell
$env:HELIXENT_SHELL = "git-bash"
helixent
```

```powershell
$env:HELIXENT_SHELL = "wsl"
helixent
```

```bash
HELIXENT_SHELL=bash helixent
```

## 3. 修改文件清单

| 文件                                         | 修改内容                                            |
| -------------------------------------------- | --------------------------------------------------- |
| `src/coding/tools/shell.ts`                | 新增 Shell 类型、可执行文件探测和解析逻辑           |
| `src/coding/tools/bash.ts`                 | 使用 Shell resolver，并改造成支持`cwd` 的工具工厂 |
| `src/coding/agents/lead-agent.ts`          | 按 Agent 的`cwd` 创建 bash 工具                   |
| `src/coding/tools/__tests__/shell.test.ts` | 新增 Shell resolver 单元测试                        |
| `src/coding/tools/__tests__/bash.test.ts`  | 改为跨平台执行测试                                  |
| `.github/workflows/check.yml`              | 增加 macOS、Windows CI                              |
| `README.md`                                | 增加 Shell 配置说明                                 |
| `README.zh.md`                             | 增加中文 Shell 配置说明                             |
| `docs/tutorial/13-search-system-tools.md`  | 更新原有`zsh -c` 说明                             |

当前需要重点修改的位置：

- [src/coding/tools/bash.ts](../../src/coding/tools/bash.ts)
- [src/coding/agents/lead-agent.ts](../../src/coding/agents/lead-agent.ts)
- [src/coding/tools/__tests__/bash.test.ts](../../src/coding/tools/__tests__/bash.test.ts)

## 4. Shell resolver 设计

新增 `src/coding/tools/shell.ts`，集中处理平台判断、环境变量和可执行文件探测。

建议的类型定义：

```ts
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
  buildArgs: (command: string, cwd: string) => string[];
};

export type ShellResolution =
  | { ok: true; shell: ShellSpec }
  | {
      ok: false;
      code: "SHELL_INVALID" | "SHELL_NOT_FOUND";
      message: string;
    };
```

核心函数：

```ts
export function resolveShell(options?: {
  platform?: string;
  env?: Record<string, string | undefined>;
  findExecutable?: (name: string) => string | undefined;
}): ShellResolution;
```

`platform`、`env` 和 `findExecutable` 采用依赖注入，便于测试不同操作系统、环境变量和 PATH，而不需要修改真实的 `process.platform` 或进程环境。

### 4.1 自动探测

Windows 自动探测：

```text
pwsh.exe -> powershell.exe -> cmd.exe
```

macOS/Linux 自动探测：

```text
zsh -> bash -> sh
```

每个候选 Shell 通过 `Bun.which()` 或等价的 PATH 查找逻辑检查。找不到任何候选时返回 `SHELL_NOT_FOUND`。

Windows 的 `cmd` 优先使用：

```ts
process.env.ComSpec ?? "cmd.exe"
```

### 4.2 显式配置

当 `HELIXENT_SHELL` 设置为非空值且不是 `auto` 时，只解析该值：

```text
HELIXENT_SHELL=pwsh       -> 只查找 pwsh
HELIXENT_SHELL=git-bash   -> 只查找 Git Bash
HELIXENT_SHELL=wsl        -> 只查找 wsl.exe
```

显式配置失败时不得执行默认回退。例如：

```text
HELIXENT_SHELL=git-bash
Git Bash 不存在
结果：SHELL_NOT_FOUND
行为：不能回退到 pwsh 或 powershell.exe
```

### 4.3 Git Bash 探测

只有 `HELIXENT_SHELL=git-bash` 时才查找 Git Bash，候选顺序建议为：

```text
bash.exe
C:\Program Files\Git\bin\bash.exe
C:\Program Files\Git\usr\bin\bash.exe
C:\Program Files (x86)\Git\bin\bash.exe
```

Git Bash 不参与 Windows 默认 Shell 的自动探测。

### 4.4 WSL 探测

只有 `HELIXENT_SHELL=wsl` 时才查找 `wsl.exe`。第一版使用 WSL 默认发行版，不增加发行版选择配置。

WSL 不翻译用户提供的命令内容，只负责启动 Linux bash，并设置工作目录。

## 5. 各 Shell 的启动参数

### 5.1 zsh、bash、sh

保持当前 Unix 行为：

```ts
["-c", command]
```

### 5.2 PowerShell 7

```ts
[
  "-NoLogo",
  "-NoProfile",
  "-NonInteractive",
  "-Command",
  powershellCommand,
]
```

建议在命令前设置 UTF-8 输出：

```powershell
[Console]::OutputEncoding = [Text.Encoding]::UTF8;
$OutputEncoding = [Text.Encoding]::UTF8;
<原始 command>
```

### 5.3 Windows PowerShell 5.1

启动参数与 PowerShell 7 保持一致：

```ts
[
  "-NoLogo",
  "-NoProfile",
  "-NonInteractive",
  "-Command",
  powershellCommand,
]
```

### 5.4 cmd.exe

```ts
[
  "/d",
  "/s",
  "/c",
  `chcp 65001>nul & ${command}`,
]
```

其中：

- `/d` 禁用注册表 AutoRun，避免用户配置影响执行。
- `/s` 使用标准的 `/c` 引号处理规则。
- `chcp 65001` 尽量统一命令输出编码。

### 5.5 Git Bash

```ts
[
  "--noprofile",
  "--norc",
  "-c",
  command,
]
```

### 5.6 WSL

```ts
[
  "--cd",
  cwd,
  "--",
  "bash",
  "--noprofile",
  "--norc",
  "-c",
  command,
]
```

`--cd` 用于将 Windows 项目目录传递给 WSL。命令文本本身不做转换。如果工作目录无法映射，应返回 `SHELL_CWD_UNSUPPORTED`，不能静默切换到 WSL 用户主目录。

## 6. `bash.ts` 修改设计

当前文件导出固定的全局工具：

```ts
export const bashTool = defineTool(...);
```

建议改为工具工厂，同时保留原有导出以兼容现有使用方：

```ts
export function createBashTool(options?: {
  cwd?: string;
}): FunctionTool {
  // 使用 Shell resolver 创建工具
}

export const bashTool = createBashTool();
```

`invoke` 的执行流程：

```text
1. 读取 HELIXENT_SHELL
2. 调用 resolveShell()
3. 解析失败时返回 SHELL_INVALID 或 SHELL_NOT_FOUND
4. 根据 ShellSpec 生成命令参数
5. Bun.spawn({ cmd, cwd, stdout: "pipe", stderr: "pipe" })
6. 注册 AbortSignal
7. 并行读取 stdout、stderr 和 proc.exited
8. exitCode 非 0 时返回现有 Error 字符串
9. 成功时返回 stdout
```

建议并行读取 stdout、stderr 和退出码，避免 stderr 输出量较大时造成管道阻塞：

```ts
const [output, stderr, exitCode] = await Promise.all([
  new Response(proc.stdout).text(),
  new Response(proc.stderr).text(),
  proc.exited,
]);
```

取消逻辑继续保留：

```ts
const onAbort = () => proc.kill();
signal.addEventListener("abort", onAbort, { once: true });
void proc.exited.then(() => signal.removeEventListener("abort", onAbort));
```

还应处理 `signal` 在启动前已经 aborted 的情况，避免无意义地启动子进程。

## 7. `cwd` 传递

当前 [lead-agent.ts](../../src/coding/agents/lead-agent.ts) 接收了 `cwd`，但全局 `bashTool` 没有使用它。

修改导入：

```ts
import { createBashTool } from "../tools/bash";
```

在 `createCodingAgent` 中创建当前 Agent 专用的工具：

```ts
const bashTool = createBashTool({ cwd });
```

再将该局部工具放入 `tools` 数组。

这样可以保证：

```ts
createCodingAgent({ cwd: "D:\\project" });
```

执行 bash 命令时，Shell 的实际工作目录也是 `D:\\project`。

## 8. Agent Prompt 与工具描述

在 [lead-agent.ts](../../src/coding/agents/lead-agent.ts) 的系统提示中增加：

```text
<shell>
The bash tool executes commands using the configured platform shell.

- HELIXENT_SHELL controls the shell explicitly.
- On Windows without HELIXENT_SHELL, the order is PowerShell 7,
  Windows PowerShell 5.1, then cmd.exe.
- On macOS/Linux without HELIXENT_SHELL, the order is zsh, bash, then sh.
- Git Bash and WSL are never selected automatically.
- Command syntax is not translated between shells.
- Use PowerShell syntax when the active shell is PowerShell.
- Use POSIX syntax only when Git Bash, WSL, bash, zsh, or sh is selected.
</shell>
```

工具描述从：

```text
Execute a bash command in a unix-like environment
```

修改为：

```text
Execute a command through the configured platform shell.
On Windows, PowerShell is used by default.
Use HELIXENT_SHELL=git-bash or HELIXENT_SHELL=wsl for POSIX shell syntax.
```

参数 `command` 的描述修改为：

```text
The command to execute using the active shell syntax.
```

## 9. 错误处理

保留当前非零退出的兼容格式：

```text
Error: Command <command> failed with exit code <code>: <stderr>
```

新增错误类型：

```text
Error: SHELL_INVALID: unsupported HELIXENT_SHELL value 'xxx'.
Error: SHELL_NOT_FOUND: configured shell 'git-bash' is not available.
Error: SHELL_EXEC_FAILED: failed to start shell 'pwsh'.
Error: SHELL_CWD_UNSUPPORTED: unable to use cwd with WSL.
```

本次不将 `bash` 改成 `errorToolResult`，因为当前 bash 工具成功时返回 stdout 字符串、失败时返回 `Error:` 字符串，已有 Agent 逻辑和文档依赖这一行为。结构化错误可以在后续独立版本中迁移。

## 10. 测试设计

### 10.1 `shell.test.ts`

覆盖以下 resolver 场景：

1. Windows 自动选择 `pwsh`。
2. 没有 `pwsh` 时选择 `powershell`。
3. 两个 PowerShell 都不可用时选择 `cmd`。
4. Unix 自动选择 `zsh`。
5. Unix 没有 zsh 时选择 `bash`。
6. Unix 只有 `sh` 时选择 `sh`。
7. `HELIXENT_SHELL=git-bash` 时只查找 Git Bash。
8. Git Bash 不存在时返回 `SHELL_NOT_FOUND`。
9. `HELIXENT_SHELL=wsl` 不存在时不回退到 PowerShell。
10. 未知配置值返回 `SHELL_INVALID`。
11. Shell 名称大小写和首尾空格可以正常处理。

测试使用注入的 `platform`、`env` 和 `findExecutable`，不依赖当前机器真实安装了哪些 Shell。

### 10.2 `bash.test.ts`

删除当前仅检查 `/bin/zsh` 和 `/usr/bin/zsh` 的 `zshOnPath()` 逻辑，改为跨平台测试：

- 使用当前平台默认 Shell 执行成功命令。
- 执行非零退出命令。
- 验证传入的 `cwd` 生效。
- 验证 AbortSignal 可以终止子进程。
- Windows 使用 PowerShell/cmd 语法，Unix 使用 POSIX 语法。
- Git Bash 和 WSL 只在显式配置且环境存在时测试。

成功结果不应强制要求换行格式完全一致：

```ts
expect(result.trim()).toBe("hi");
```

PowerShell 和 cmd 可能产生 `\r\n`，而 Unix Shell 通常产生 `\n`。

## 11. CI 修改

当前 `.github/workflows/check.yml` 只运行 Ubuntu。建议改为矩阵：

```yaml
strategy:
  matrix:
    os:
      - ubuntu-latest
      - macos-latest
      - windows-latest

runs-on: ${{ matrix.os }}
```

Windows CI 不应要求 Git Bash 或 WSL 存在，因为它们不是默认依赖。默认 Shell 测试只验证 PowerShell 和 cmd 的选择逻辑。

## 12. 文档修改

README 和教程应说明：

- Windows 默认 Shell 顺序是 PowerShell 7、Windows PowerShell 5.1、cmd.exe。
- macOS/Linux 默认 Shell 顺序是 zsh、bash、sh。
- Git Bash 和 WSL 需要通过 `HELIXENT_SHELL` 显式启用。
- Shell 语法不会自动转换。
- PowerShell、cmd 和 POSIX Shell 的命令语法不同。
- `HELIXENT_SHELL` 只支持受控 Shell 名称。

教程中类似下面的固定实现描述：

```ts
cmd: ["zsh", "-c", command]
```

应更新为 Shell resolver 的平台无关描述。

## 13. 兼容性与安全性

兼容性策略：

- 保留 `bashTool` 导出。
- 保留 `description` 和 `command` 参数。
- 保留成功时返回 stdout 的行为。
- 保留非零退出时的 `Error: Command ...` 格式。
- Unix 未配置环境变量时仍优先使用 zsh。
- 不修改 `grep_search` 的直接 `rg` 执行逻辑。

安全策略：

- `HELIXENT_SHELL` 由宿主环境控制，不允许模型通过工具参数修改。
- PowerShell 使用 `-NoProfile`。
- cmd 使用 `/d` 禁用 AutoRun。
- 不接受任意 Shell 路径，避免配置行为不可预测。
- 现有 bash 工具审批机制继续生效。

需要明确：Shell 工具本身仍然可以执行任意命令，Shell resolver 只解决执行环境选择，不替代现有的审批和权限控制。

## 14. 实施顺序

### P0：核心能力

1. 新增 `src/coding/tools/shell.ts`。
2. 实现 `HELIXENT_SHELL` 解析和默认探测顺序。
3. 修改 `bash.ts`，支持 ShellSpec、错误码和 `cwd`。
4. 修改 `lead-agent.ts`，使用 `createBashTool({ cwd })`。
5. 增加 resolver 单元测试。
6. 更新 bash 跨平台执行测试。

### P1：工程化支持

1. 更新 Agent prompt。
2. 更新工具描述。
3. 更新 README 和教程。
4. 扩展 Ubuntu、macOS、Windows CI 矩阵。

### P2：后续扩展

1. 在正式配置文件中持久化 Shell 设置。
2. 支持自定义 Shell 可执行文件路径。
3. 支持 WSL 发行版选择。
4. 将 bash 工具结果迁移为结构化错误结果。

## 15. 验收标准

实现完成后必须满足：

1. Windows 安装 PowerShell 7 时优先使用 `pwsh.exe`。
2. 没有 PowerShell 7 时自动使用 `powershell.exe`。
3. 两个 PowerShell 都不可用时使用 `cmd.exe`。
4. `HELIXENT_SHELL=git-bash` 时不会使用 PowerShell。
5. Git Bash 不存在时返回 `SHELL_NOT_FOUND`，不会回退。
6. `HELIXENT_SHELL=wsl` 时不会自动转换命令内容。
7. `createCodingAgent({ cwd })` 中的 bash 命令使用指定目录。
8. macOS/Linux 的默认 zsh 行为保持不变。
9. 成功、失败、取消和中文输出均有跨平台测试。
10. Ubuntu、macOS、Windows CI 均能通过。

## 16. 测试与修复记录

### 16.1 定向测试

执行命令：

```powershell
bun test src/coding/tools/__tests__/shell.test.ts src/coding/tools/__tests__/bash.test.ts
```

结果：通过，15 个测试全部通过，0 个失败。

### 16.2 完整测试与质量检查（第一次）

并行执行：

```powershell
bun test
bun run check:types
bun run lint
```

结果：完整测试 236/236 通过，类型检查通过；ESLint 失败于
`src/agent/tool-result-runtime.ts:15` 的既有裸表达式
`};formatToolResultForMessage`。同时 `shell.ts` 报告了函数类型参数未使用的警告。

### 16.3 修复

1. 删除 `tool-result-runtime.ts` 第 15 行多余的 `formatToolResultForMessage` 文本，使类型声明恢复为 `};`。
2. 在 `shell.ts` 的函数类型参数位置增加局部 ESLint 忽略注释，消除 resolver 新增的无用参数警告，不改变运行时行为。

修复后需重新执行完整测试和质量检查，直到所有命令返回成功。

### 16.4 补充中文输出测试

对照验收标准复核时发现，原测试虽然覆盖成功、失败、`cwd` 和取消，但没有单独验证中文输出。已在 `bash.test.ts` 中增加中文 stdout 测试，并按当前 Shell 选择 PowerShell、cmd 或 POSIX 命令。

### 16.5 最终验证

执行项目验收命令：

```powershell
bun run check
```

结果：通过。`tsc --noEmit`、`eslint . --ext .ts` 和完整测试均成功；完整测试统计为 237 个通过、0 个失败。
