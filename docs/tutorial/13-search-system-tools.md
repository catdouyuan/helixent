# 第 13 节：搜索与系统工具 —— bash / glob / grep / list_files / file_info / mkdir / move_path

> 本节属于 **第四部分 · Coding 层（面向编程的专用 Agent）**。[第 12 节](./12-tool-foundation-file-io.md) 铺好了两块「地基」（[tool-utils.ts](../../src/coding/tools/tool-utils.ts) / [tool-result.ts](../../src/coding/tools/tool-result.ts)）和三个「操作已知路径」的文件工具（`read_file`/`write_file`/`str_replace`）。但它在结尾抛出了一个尖锐的问题：**Agent 刚进入一个陌生项目时，它对文件系统一无所知**——有哪些目录？某个函数定义在哪？符合 `*.test.ts` 的文件有几个？它需要一批「探索环境」的工具。
>
> 对应 roadmap 为本节设定的**核心问题**：
>
>> 这些「探索环境」的工具分别解决什么问题？为什么 `bash` 要这样处理输出和中断？
>>
>
> **一句边界声明**：本节精讲 **7 个工具文件**——万能逃生舱 [bash.ts](../../src/coding/tools/bash.ts)（36 行），三个「搜索/浏览」工具 [glob-search.ts](../../src/coding/tools/glob-search.ts)、[grep-search.ts](../../src/coding/tools/grep-search.ts)、[list-files.ts](../../src/coding/tools/list-files.ts)，以及三个「元信息/系统操作」工具 [file-info.ts](../../src/coding/tools/file-info.ts)、[mkdir.ts](../../src/coding/tools/mkdir.ts)、[move-path.ts](../../src/coding/tools/move-path.ts)。它们全都**站在第 12 节的地基之上**（调 `ensureDirectoryPath`/`ensureAbsolutePath`、用 `truncateText`、返 `okToolResult`/`errorToolResult`），所以**本节必须在第 12 节之后读**。`bash` 与 `grep_search` 还会呼应 [第 5/6 节](./05-react-loop.md) 的 `AbortController`——这是本节两处独有的「可中断子进程」设计。

---

## 0. 承上启下

[第 12 节](./12-tool-foundation-file-io.md) 结尾，我们在拆完三个文件工具后，明确埋下了本节的钩子。原话是这样的：

> 本节的工具都在"**操作一个已知路径的文件**"——前提是模型**已经知道**该读/写哪个文件。可现实里，Agent 刚进入一个陌生项目时，**它对文件系统一无所知**……**它需要一批"探索环境"的工具**——列目录、按通配符找文件、按内容搜索、看文件元信息、以及那把"什么都能干"的万能钥匙 `bash`。

第 12 节还预告了这些工具的两个关键特征：

> 而这些探索工具，正是本节地基函数的**最大用户**——`list_files`/`glob_search`/`grep_search` 都要调 `ensureDirectoryPath`、都要用 `truncateText` 做上下文节流，`bash` 还要呼应 [第 5 节](./05-react-loop.md) 的 `AbortController` 实现"可中断"。

以及一个「抠门」的伏笔：

> 你会在第 13 节看到，搜索类工具（`list_files`/`glob_search`/`grep_search`）在 [第 8 节](./08-tool-result-pipeline.md) 的 policy 里被设成 `preferSummaryOnly: true`——**它们"只回摘要、不回数据"**。为什么探索工具要这么"抠门"？

本节就来兑现这三个悬念。

**先回忆三个上游结论，它们是本节的直接前提：**

1. **[第 12 节](./12-tool-foundation-file-io.md) 的地基函数。** `ensureAbsolutePath`（格式校验）、`ensureDirectoryPath`（存在性 + 是不是目录）、`truncateText`（第一级截断）、`okToolResult`/`errorToolResult`（结果封装）。本节 7 个工具**无一例外**都站在它们之上——你会看到同一套「校验 → 执行 → 截断 → 封装」的骨架被复用 7 遍。
2. **[第 8 节](./08-tool-result-pipeline.md) 的结果管线与 policy。** `getToolResultPolicy` 按工具名分级：本节的 `list_files`/`glob_search`/`grep_search`/`file_info`/`mkdir`/`move_path` **全部**被设成 `preferSummaryOnly: true`——回喂给模型时**只留一句 summary、扔掉 data**。这条策略直接决定了本节工具「结构化 data 到底给谁看」的答案（1.7 详解）。
3. **[第 5/6 节](./05-react-loop.md) 的 `AbortController`。** Agent 主循环持有一个 `_abortController`，把 `signal` 一路穿透进 `tool.invoke(input, signal)`（见 [function-tool.ts](../../src/foundation/tools/function-tool.ts#L20)、[agent.ts `_act`](../../src/agent/agent.ts#L231)）。**本节的 `bash` 和 `grep_search` 是全项目仅有的两个真正用到这个 `signal` 参数的工具**——它们要 spawn 子进程，必须能在用户按 Ctrl-C 时把子进程也杀掉。

准备好了，我们先从这批工具里**最特殊、也最危险**的那把「万能钥匙」`bash` 开始。

---

## 1. 主题内容

### 1.1 先给 7 个工具分类：它们各自解决什么问题？

写代码前先建立地图。这 7 个工具不是随机堆在一起的，按「解决什么问题」可以分成三组：

| 组别                           | 工具                                             | 解决的问题                                                | 站在哪块地基上                             | 需要`signal`？        |
| ------------------------------ | ------------------------------------------------ | --------------------------------------------------------- | ------------------------------------------ | ----------------------- |
| **A. 万能逃生舱**        | `bash`                                         | 前六个工具覆盖不到的一切（跑测试、`git`、`ls -la`…） | 无（直接`Bun.spawn`）                    | ✅ 要                   |
| **B. 搜索 / 浏览**       | `glob_search`、`grep_search`、`list_files` | 「有哪些文件 / 哪个文件含某内容 / 目录长啥样」            | `ensureDirectoryPath` + `truncateText` | `grep` ✅ / 另两个 ❌ |
| **C. 元信息 / 系统操作** | `file_info`、`mkdir`、`move_path`          | 「这个路径是啥 / 建目录 / 移动重命名」                    | `ensureAbsolutePath`                     | ❌                      |

**三组的气质差异很关键：**

- **A 组（`bash`）是"能力最全但最原始"的**——它能干任何事，但代价是**结果非结构化**（只有 stdout / 退出码）、**最危险**（能 `rm -rf`）。它是「兜底逃生舱」：当专用工具不够用时才用它。
- **B 组（搜索）是"读多、量大"的**——搜索结果动辄成百上千行，所以它们的核心矛盾是**上下文节流**（`truncateText` + policy 的 `preferSummaryOnly`）。它们要求传入的 `path` 是一个**真实存在的目录**（用 `ensureDirectoryPath`）。
- **C 组（元信息/系统）是"轻、快、结构化"的**——`file_info` 只读一点元数据，`mkdir`/`move_path` 只做一次系统调用。它们只需 `ensureAbsolutePath`（操作对象不一定是目录，存不存在交给底层 API）。

想清楚这个分类，我们**从 A 组的 `bash` 开始逐个拆**——因为它最特殊（不返回结构化结果、要处理 signal），把它讲透，后六个就都是「同一套骨架的变奏」了。

### 1.2 `bash` —— 万能逃生舱：`Bun.spawn` + `signal` 的可中断子进程（[bash.ts](../../src/coding/tools/bash.ts)）

`bash` 是本节唯一**不站在第 12 节地基上**的工具（它不校验路径、不返回 `okToolResult`）。全文只有 36 行，但每一行都值得琢磨。先看定义：

```ts
export const bashTool = defineTool({
  name: "bash",
  description: "Execute a bash command in a unix-like environment",
  parameters: z.object({
    description: z
      .string()
      .describe("Explain why you want to execute the command. Always place `description` as the first parameter."),
    command: z.string().describe("The bash command to execute."),
  }),
  invoke: async ({ command }, signal) => { /* ... */ },
});
```

**注意 `invoke` 的第二个参数 `signal`**——这是本节第一个真正用到它的工具（对比第 12 节所有工具的 `invoke` 都只有一个参数）。这个 `signal` 从哪来？回忆 [第 6 节](./06-parallel-tools.md)：Agent 在 [agent.ts `_act`](../../src/agent/agent.ts#L231) 里调 `tool.invoke(toolUse.input, signal)`，把主循环的 `AbortController.signal` 透传进来。`bash` 接住它，就能在用户中断时杀掉子进程。

**`invoke` 的执行流程，跟着代码走：**

```ts
invoke: async ({ command }, signal) => {
  const proc = Bun.spawn({
    cmd: ["zsh", "-c", command],   // ← 注意：是 zsh，不是 bash
    stdout: "pipe",
    stderr: "pipe",
  });

  if (signal) {
    const onAbort = () => proc.kill();
    signal.addEventListener("abort", onAbort, { once: true });
    void proc.exited.then(() => signal.removeEventListener("abort", onAbort));
  }

  const output = await new Response(proc.stdout).text();
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text();
    return `Error: Command ${command} failed with exit code ${exitCode}: ${stderr}`;
  }
  return output;
},
```

**四个设计点，逐个看：**

**① 用 `Bun.spawn` 启动子进程，`cmd: ["zsh", "-c", command]`。** 它把模型给的 `command` 字符串交给 `zsh -c` 去解释执行——这样管道 `|`、重定向 `>`、`&&` 等 shell 语法才能生效。**这里有个小小的"名不副实"**：工具叫 `bash`、描述说 "Execute a bash command"，但实现里用的是 **`zsh`**（macOS 默认 shell）。对绝大多数命令这没区别，但严格说这是个值得记住的实现细节（[bash.test.ts](../../src/coding/tools/__tests__/bash.test.ts#L7-L9) 的测试还专门检查了 `/bin/zsh` 或 `/usr/bin/zsh` 是否存在，存在才跑测试）。

**② 可中断：把 `abort` 事件桥接到 `proc.kill()`。** 这是本工具**最精妙的一段**，也是呼应 [第 5 节](./05-react-loop.md) `AbortController` 的落地点：

```ts
if (signal) {
  const onAbort = () => proc.kill();                       // 用户中断 → 杀子进程
  signal.addEventListener("abort", onAbort, { once: true });
  void proc.exited.then(() => signal.removeEventListener("abort", onAbort));  // 进程正常结束 → 摘掉监听器
}
```

拆开看它做了两件事：

- **订阅中断**：给 `signal` 注册一个 `abort` 监听器，一旦触发就 `proc.kill()`。`{ once: true }` 表示只触发一次就自动移除。**为什么需要它？** 想象模型跑了一条 `npm install`（要 30 秒），用户等不及按了 Ctrl-C——如果没有这段，子进程会**继续在后台跑**，成为「孤儿进程」。有了它，中断信号立刻传导到子进程、把它杀掉。
- **防泄漏地摘监听器**：`void proc.exited.then(() => signal.removeEventListener(...))`——**当进程正常结束时，主动把刚才注册的监听器摘掉**。为什么？因为 `signal`（来自 Agent 的 `AbortController`）的生命周期比单个 bash 命令**长得多**（它贯穿整个 Agent 循环）。如果每跑一条 bash 命令都往 `signal` 上挂一个监听器却不摘，跑一百条命令就积累一百个失效监听器——**内存泄漏**。这一行 `removeEventListener` 就是防这个的。`void` 前缀表示「我故意不 await 这个 Promise，让它在后台自己完成」。

**③ 先读 stdout，再等退出码，失败才读 stderr。** 注意顺序：`await new Response(proc.stdout).text()` 先把标准输出读干净，再 `await proc.exited` 拿退出码。**只有 `exitCode !== 0`（失败）时，才去读 `stderr`** 并拼进错误信息。这是「按需读取」——成功时根本不碰 stderr。

**④ 结果形状：成功吐裸 stdout，失败吐 `Error:` 前缀字符串——又一个"不返回结构化结果"的工具。** 这是 `bash` 和第 12 节 `read_file` 的**共同点**：它们都**不用** `okToolResult`/`errorToolResult`，而是直接返回字符串。

- 成功 → `return output`（裸 stdout）；
- 失败 → `return \`Error: Command ${command} failed with exit code ${exitCode}: ${stderr}\``。

**这个 `Error:` 前缀不是随便写的**——它精确对齐了 [第 8 节](./08-tool-result-pipeline.md) `normalizeToolResult` 里那条分支（[tool-result-runtime.ts](../../src/agent/tool-result-runtime.ts#L80-L89)）：

```ts
if (typeof result === "string" && result.startsWith("Error:")) {
  const error = result.slice("Error:".length).trim() || "Tool execution failed.";
  return { ok: false, summary: error, error, errorKind: "unknown", raw: result };
}
```

**看到闭环了吗？** `bash` 用 `Error:` 前缀把「失败」编码进裸字符串，第 8 节的管线就靠 `result.startsWith("Error:")` 把它识别成失败、拆出错误信息。**这正是 [第 6 节](./06-parallel-tools.md) 讲的「工具错误就地捕获成 `Error:` 文本」的容错哲学在 `bash` 里的体现**——注意 `bash` 自己**从不 throw**（子进程失败它 catch 成 `Error:` 字符串返回），万一真抛了异常，[agent.ts `_act`](../../src/agent/agent.ts#L234-L237) 的 `catch` 也会兜底成 `Error: <msg>`。[bash.test.ts](../../src/coding/tools/__tests__/bash.test.ts#L21-L28) 就断言了 `exit 42` 会返回 `/^Error: Command exit 42 failed with exit code 42:/`。

> 📌 **`bash` 是"能力核弹"，所以它排在 [第 11 节](./11-lead-agent.md) `CODING_TOOLS_REQUIRING_APPROVAL` 名单的第一位。** 它能跑 `rm -rf /`、能 `curl | sh`——任何命令。所以它执行前**必过 [第 15 节](./00-roadmap.md) 的审批**。这也解释了为什么 Helixent 要费劲写六个专用工具（`glob`/`grep`/`list`/`info`/`mkdir`/`move`）而不是「全用 bash 搞定」——专用工具**结果结构化、上下文可节流、且大部分不需要审批地狱**（`file_info`/`glob`/`grep`/`list` 都是只读的，不在审批名单里）。`bash` 是逃生舱，不是日常主力。

### 1.3 `glob_search` —— 按通配符找文件：一套「校验→扫描→截断→封装」骨架的范本（[glob-search.ts](../../src/coding/tools/glob-search.ts)）

从 `glob_search` 开始，我们进入 B 组。这三个搜索工具**共享同一套四步骨架**，`glob_search` 最干净，先把骨架讲透，后两个就快了。先看头部的两个常量和参数：

```ts
const DEFAULT_LIMIT = 200;
const DEFAULT_MAX_CHARS = 12000;

export const globSearchTool = defineTool({
  name: "glob_search",
  description: "Find files matching a glob pattern under an absolute directory.",
  parameters: z.object({
    description: z.string().describe("Explain why you want to find files. Always place `description` as the first parameter."),
    path: z.string().describe("The absolute directory path to search within."),
    pattern: z.string().describe("Glob pattern, for example **/*.ts or src/**/*.tsx."),
    limit: z.number().int().positive().describe("Maximum number of matches to return.").optional(),
    maxChars: z.number().int().positive().describe("Maximum characters to return.").optional(),
  }),
  invoke: async ({ path, pattern, limit, maxChars }) => { /* ... */ },
});
```

**注意两个"双保险"限制参数**：`limit`（最多返回几条，默认 200）和 `maxChars`（最多返回多少字符，默认 12000）。**为什么要两个？** 因为「条数少」不等于「字符少」——200 条匹配里如果每条都是超长路径，字符数照样爆。所以**`limit` 卡条数、`maxChars` 卡字符数，两道闸各管一维**。这是搜索工具「上下文节流」的第一层实现（第二层是第 8 节的 policy）。

**`invoke` 的四步骨架：**

```ts
invoke: async ({ path, pattern, limit, maxChars }) => {
  // 第①步：校验——必须是真实存在的目录
  const dirCheck = await ensureDirectoryPath(path);
  if (!dirCheck.ok) {
    return errorToolResult(dirCheck.error, "INVALID_DIRECTORY", { path, pattern });
  }

  // 第②步：执行——扫描，边扫边卡 limit
  const matches: string[] = [];
  try {
    const globber = new Bun.Glob(pattern);
    for await (const entry of globber.scan({ cwd: path, absolute: true })) {
      matches.push(entry);
      if (matches.length >= (limit ?? DEFAULT_LIMIT)) {
        break;   // ← 数够了就停，不把整个仓库扫完
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return errorToolResult(`glob_search failed for pattern ${pattern}`, "GLOB_SEARCH_FAILED", { path, pattern, message });
  }

  // 第③步 + 第④步：截断 + 封装
  const limited = truncateText(matches.join("\n"), maxChars ?? DEFAULT_MAX_CHARS);
  return okToolResult(`Found ${matches.length} files matching ${pattern}`, {
    path, pattern, matchCount: matches.length,
    truncated: limited.truncated, matches, content: limited.text,
  });
},
```

**逐步拆：**

**第①步 · 校验（复用第 12 节地基）**：`ensureDirectoryPath(path)`——这一行同时完成了三件事：绝对路径格式校验、目录存在性校验、「是不是目录」校验（回忆第 12 节 1.2）。失败就返 `INVALID_DIRECTORY`（`INVALID_` 前缀 → 第 8 节归为 `invalid_input`）。[glob-search.test.ts](../../src/coding/tools/__tests__/glob-search.test.ts#L47-L58) 专门测了「传不存在的目录返回 `INVALID_DIRECTORY`」。

**第②步 · 执行（`Bun.Glob` + 边扫边停）**：用 Bun 内置的 `Bun.Glob(pattern)` 做通配符匹配，`scan({ cwd: path, absolute: true })` 返回一个**异步迭代器**（`for await`）——**关键在 `matches.length >= limit` 就 `break`**。为什么用异步迭代 + 提前 break，而不是「扫完再切片」？因为一个大仓库可能有几万个文件，**如果先全扫完再 `slice(0, 200)`，会白白遍历几万个文件**；边扫边数、够了就停，**扫到第 200 个就收手**，省时省内存。整段包在 `try/catch` 里，异常转 `GLOB_SEARCH_FAILED`（`_FAILED` 后缀 → 第 8 节归为 `execution_failed`）。

**第③步 · 截断（复用第 12 节 `truncateText`）**：把匹配到的路径 `join("\n")` 成一坨文本，交给 `truncateText` 卡 `maxChars`。这就是第 12 节讲的「第一级截断」。

**第④步 · 封装（复用第 12 节 `okToolResult`）**：成功返回一份**信息很全**的结构化 data——`matchCount`（找到几个）、`truncated`（有没有被截断）、`matches`（路径数组）、`content`（截断后的文本）。摘要是一句人话 `Found N files matching <pattern>`。

**这套「校验→执行→截断→封装」的四步骨架，是 B 组三个工具的公共模板**——你在下面 `grep_search`/`list_files` 会看到它一模一样地重演，只有「第②步执行」的内容不同。[glob-search.test.ts](../../src/coding/tools/__tests__/glob-search.test.ts#L20-L45) 验证了 `src/**/*.ts` 能精确命中 `src/index.ts` 而排除 `.tsx` 和 `.md`。

### 1.4 `grep_search` —— 按内容搜索：依赖 `rg` 与「优雅降级」的错误处理（[grep-search.ts](../../src/coding/tools/grep-search.ts)）

`grep_search` 是 B 组里**最复杂**的一个，因为它做了两件 `glob_search` 没做的事：**（a）spawn 外部进程 `rg`（ripgrep）**，因此又要处理 `signal`；**（b）对"rg 没装"这种环境问题做优雅降级**。参数比 `glob_search` 多了 `glob`（只搜某类文件）和 `caseSensitive`（大小写敏感）：

```ts
parameters: z.object({
  description: z.string().describe("Explain why you want to search file contents. ..."),
  path: z.string().describe("The absolute directory path to search within."),
  pattern: z.string().describe("Text or regex pattern to search for."),
  glob: z.string().describe("Optional glob filter, for example *.ts.").optional(),
  caseSensitive: z.boolean().describe("Whether the search should be case-sensitive.").optional(),
  limit: z.number().int().positive().optional(),
  maxChars: z.number().int().positive().optional(),
}),
invoke: async ({ path, pattern, glob, caseSensitive, limit, maxChars }, signal) => { /* ... */ },
```

（注意 `invoke` 又带上了第二个参数 `signal`——因为它要 spawn `rg` 子进程。）

**第①步校验和 `glob_search` 一样**（`ensureDirectoryPath` → `INVALID_DIRECTORY`），跳过。重点看**第②步「拼命令 + spawn rg」**：

```ts
const cmd = ["rg", "--line-number", "--no-heading"];
if (!caseSensitive) {
  cmd.push("--ignore-case");     // 默认大小写不敏感（对模型更友好）
}
if (glob) {
  cmd.push("--glob", glob);      // 只搜匹配 glob 的文件
}
cmd.push(pattern, path);
```

它**动态拼出 `rg` 的命令行参数**：`--line-number`（带行号，方便模型后续定位）、`--no-heading`（不按文件分组、每行独立输出 `file:line:content`）；默认加 `--ignore-case`（**除非**模型显式要求大小写敏感）；有 `glob` 就加过滤。然后 spawn：

```ts
try {
  const proc = Bun.spawn({ cmd, stdout: "pipe", stderr: "pipe" });

  if (signal) {                                  // ← 和 bash 一模一样的可中断套路
    const onAbort = () => proc.kill();
    signal.addEventListener("abort", onAbort, { once: true });
    void proc.exited.then(() => signal.removeEventListener("abort", onAbort));
  }

  const stdout = await new Response(proc.stdout).text();
  const exitCode = await proc.exited;
  if (exitCode !== 0 && exitCode !== 1) {        // ← 关键：exit 1 不算错误！
    const stderr = await new Response(proc.stderr).text();
    return errorToolResult(`grep_search failed with exit code ${exitCode}`, "GREP_FAILED", { path, pattern, glob, exitCode, stderr });
  }
  // ... 处理结果（见下）
}
```

**这里有两个必须讲清的细节：**

**① 可中断套路和 `bash` 一模一样**（`onAbort → proc.kill()` + 结束后 `removeEventListener`）——这印证了 1.2 说的「spawn 子进程的工具都要处理 signal」。两处代码几乎逐字重复，是本节唯一的「刻意重复」（Q3 会讨论「为什么不抽成公共函数」）。

**② `exit 1` 不算错误——ripgrep 的约定必须懂。** 看那行 `if (exitCode !== 0 && exitCode !== 1)`。ripgrep 的退出码约定是：**`0` = 找到了匹配，`1` = 没找到任何匹配（但运行正常），`2+` = 真出错了**（比如正则语法错、权限问题）。所以**「没找到」（exit 1）绝不能当成工具失败**——它是一个完全合法的结果（「我搜了，确实没有」）。只有 `exitCode >= 2` 才返 `GREP_FAILED`。**如果不特判 exit 1，模型每次搜不到东西都会收到一个"错误"，会误以为工具坏了**——这是「理解底层工具约定」的重要性。

**第③步处理结果**（和 `glob_search` 同款，但多了 `filter(Boolean)`）：

```ts
const lines = stdout.split("\n").filter(Boolean);   // 去掉末尾空行
const capped = lines.slice(0, limit ?? DEFAULT_LIMIT);
const limited = truncateText(capped.join("\n"), maxChars ?? DEFAULT_MAX_CHARS);
return okToolResult(`Found ${lines.length} matches for ${pattern}`, {
  path, pattern, glob, caseSensitive: Boolean(caseSensitive),
  totalMatches: lines.length,        // 实际匹配总数
  shownMatches: capped.length,       // 因 limit 截断后展示的条数
  truncated: limited.truncated || capped.length < lines.length,   // ← 两种截断合并判断
  matches: capped, content: limited.text,
});
```

注意 `truncated` 的判断是 **`limited.truncated || capped.length < lines.length`**——它把**两种截断**合并成一个布尔量：字符超限（`limited.truncated`）**或** 条数超限（`capped.length < lines.length`）。任一发生，就告诉模型「结果被截了，还有更多」。`totalMatches` 和 `shownMatches` 的区分也很贴心——模型能一眼看出「一共 500 条，只给你看了 200 条」。

**最精妙的一段：`catch` 里的「优雅降级」（对标 roadmap 的亮点预告）：**

```ts
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("No such file or directory") || message.includes("not found")) {
    return errorToolResult(
      "Failed to run 'rg' (ripgrep). Please ensure ripgrep is installed and available in PATH.",
      "RG_NOT_FOUND",
      { path, pattern, message },
    );
  }
  return errorToolResult("grep_search failed to execute.", "GREP_EXEC_FAILED", { path, pattern, message });
}
```

**这段是「优雅降级」的教科书。** `grep_search` **依赖一个外部程序 `rg`**——但 `rg` 不一定装了！如果没装，`Bun.spawn` 会抛「找不到命令」的异常。这段 `catch` **专门识别这种情况**：如果错误信息里含 "No such file or directory" 或 "not found"，就返回一个**特别友好、可操作**的错误 `RG_NOT_FOUND`，并明确告诉用户「请安装 ripgrep」。其他未知异常才归为 `GREP_EXEC_FAILED`。

**为什么 `RG_NOT_FOUND` 这个错误码这么特别？** 回忆 [第 8 节](./08-tool-result-pipeline.md) 的 `inferToolErrorKind`——它有一条**专门为 `RG_NOT_FOUND` 写的分支**（[tool-result-runtime.ts](../../src/agent/tool-result-runtime.ts#L28)）：`if (code === "RG_NOT_FOUND") return "environment_missing";`。**看到了吗？** 「环境缺失」是一个**独立的错误类别**（`environment_missing`），区别于「输入错误」或「执行失败」。为什么单独分一类？因为**这类错误模型自己重试一百遍也没用**（rg 还是没装），它需要的是「告诉用户去装 rg」，而不是「换个参数重试」。**这又是一条本节工具「生产错误码」→ 第 8 节「消费错误码分类」的清晰链路**，而且是全项目**唯一**一个精确到具体错误码值的分类分支——足见作者对「环境依赖」这个特殊场景的重视。[grep-search.test.ts](../../src/coding/tools/__tests__/grep-search.test.ts#L43-L46) 的测试甚至**优雅地兼容了两种环境**：如果结果是 `RG_NOT_FOUND` 就断言错误信息含 "ripgrep"，否则断言正常搜到 2 条匹配——测试本身也在「优雅降级」。

### 1.5 `list_files` —— 列目录树：递归 `walk` 与「目录带斜杠」的排序输出（[list-files.ts](../../src/coding/tools/list-files.ts)）

`list_files` 是 B 组第三个，它回答「这个目录下有什么」。它不 spawn 进程（所以 `invoke` 没有 `signal`），核心是一个**递归遍历函数 `walk`**：

```ts
async function walk(dir: string, maxDepth: number, prefix = "", depth = 0, entries: string[] = []) {
  const items = await readdir(dir, { withFileTypes: true });
  items.sort((a, b) => a.name.localeCompare(b.name));   // ① 稳定排序

  for (const item of items) {
    const relativePath = prefix ? `${prefix}/${item.name}` : item.name;
    entries.push(item.isDirectory() ? `${relativePath}/` : relativePath);   // ② 目录带尾斜杠

    if (item.isDirectory() && depth < maxDepth) {        // ③ 深度受控的递归
      await walk(join(dir, item.name), maxDepth, relativePath, depth + 1, entries);
    }
  }
  return entries;
}
```

**三个设计点：**

**① 稳定排序**：`items.sort((a, b) => a.name.localeCompare(b.name))`——每一层都按名字字母序排。**为什么重要？** 因为 `readdir` 返回的顺序是**文件系统相关的、不保证稳定**的。排序后，同一个目录**每次列出来顺序都一样**——这对模型友好（可预测），也让测试能写死断言（[list-files.test.ts](../../src/coding/tools/__tests__/list-files.test.ts#L42) 就断言了 `entries` 精确等于 `["README.md", "src/", "src/index.ts"]`）。

**② 目录带尾斜杠**：`item.isDirectory() ? \`${relativePath}/\` : relativePath`——目录项后面加个 `/`。这样模型一眼就能区分「`src/` 是目录、`index.ts`是文件」，不用再去`file_info`挨个查。**这是一个"用一个字符传递类型信息"的极简巧思**（类似`ls -F` 的行为）。

**③ 深度受控的递归**：`if (item.isDirectory() && depth < maxDepth)`——只有当前深度小于 `maxDepth` 才继续往下钻。这防止了「递归到天荒地老」（比如 `node_modules` 深不见底）。

`walk` 之上的 `invoke` 又是**熟悉的四步骨架**：

```ts
invoke: async ({ path, recursive, maxDepth, limit, maxChars }) => {
  const dirCheck = await ensureDirectoryPath(path);        // 第①步：校验
  if (!dirCheck.ok) {
    return errorToolResult(dirCheck.error, "INVALID_DIRECTORY", { path });
  }

  const entries = await walk(path, recursive ? (maxDepth ?? 3) : 0);   // 第②步：执行
  const capped = entries.slice(0, limit ?? DEFAULT_LIMIT);             // 第③步：卡条数
  const limited = truncateText(capped.join("\n"), maxChars ?? DEFAULT_MAX_CHARS);   // 卡字符

  return okToolResult(`Listed ${capped.length} entries under ${path}`, {   // 第④步：封装
    path, totalEntries: entries.length, shownEntries: capped.length,
    truncated: limited.truncated || capped.length < entries.length,
    entries: capped, content: limited.text,
  });
},
```

**注意 `recursive ? (maxDepth ?? 3) : 0` 这个巧妙的默认值编排**：

- 不传 `recursive`（或 false）→ 传给 `walk` 的 `maxDepth` 是 **0** → `depth < 0` 永远为假 → **只列当前层，不递归**；
- 传 `recursive: true` 但不指定 `maxDepth` → 默认 **3 层**；
- 传 `recursive: true` + `maxDepth: N` → 递归 N 层。

**一个变量 `maxDepth` 同时编码了「要不要递归」和「递归多深」两个语义**——这是把「布尔开关」和「数值参数」合并的简洁设计。`truncated` 的判断和 `grep_search` 同款（字符截断 **或** 条数截断）。[list-files.test.ts](../../src/coding/tools/__tests__/list-files.test.ts#L20-L45) 验证了递归列出 3 个条目、目录带斜杠、以及不存在目录返回 `INVALID_DIRECTORY`。

### 1.6 C 组三工具：`file_info` / `mkdir` / `move_path` —— 轻量、结构化的系统操作

C 组三个工具**短小精悍**（每个都 40 行以内），且共享一个特点：**只需 `ensureAbsolutePath`（不需要目录校验）+ 一次系统调用 + try/catch 兜底**。放在一起看，正好体现「同一套防错套路的三个变奏」。

**① `file_info` —— 读元数据（[file-info.ts](../../src/coding/tools/file-info.ts)）：**

```ts
invoke: async ({ path }) => {
  const absolute = ensureAbsolutePath(path);              // 只需格式校验
  if (!absolute.ok) {
    return errorToolResult(absolute.error, "INVALID_PATH", { path });
  }
  try {
    const info = await stat(path);
    const kind = info.isDirectory() ? "directory" : info.isFile() ? "file" : "other";
    return okToolResult(`Inspected ${kind}: ${path}`, {
      path, kind, size: info.size,
      modifiedTime: info.mtime.toISOString(),      // ← Date 转 ISO 字符串
      createdTime: info.birthtime.toISOString(),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return errorToolResult(`Failed to inspect path: ${path}`, "STAT_FAILED", { path, message });
  }
},
```

它 `stat` 一下路径，把「是文件/目录/其他」（`kind`）、大小、修改/创建时间打包返回。**两个细节**：（a）`kind` 用**三目嵌套**把 `stat` 的一堆 `isXxx()` 收敛成一个字符串枚举 `"directory" | "file" | "other"`——比让模型自己解读一堆布尔标志友好；（b）时间用 `.toISOString()` 转成**字符串**——因为结果最终要 `JSON.stringify` 回喂，`Date` 对象序列化行为不可控，转成 ISO 字符串（`2026-07-23T...`）既稳定又人类可读。[file-info.test.ts](../../src/coding/tools/__tests__/file-info.test.ts#L29-L41) 断言了 `kind: "file"`、`size: 6`、时间字段含 `T`。注意 `file_info` **不在审批名单**（纯只读）。

**② `mkdir` —— 建目录（[mkdir.ts](../../src/coding/tools/mkdir.ts)）：**

```ts
invoke: async ({ path, recursive }) => {
  const absolute = ensureAbsolutePath(path);
  if (!absolute.ok) {
    return errorToolResult(absolute.error, "INVALID_PATH", { path });
  }
  try {
    await mkdir(path, { recursive: recursive ?? true });    // ← 默认 recursive: true
    return okToolResult(`Created directory: ${path}`, { path, recursive: recursive ?? true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return errorToolResult(`Failed to create directory: ${path}`, "MKDIR_FAILED", { path, message });
  }
},
```

**关键设计：`recursive` 默认为 `true`**（`recursive ?? true`）。这和第 12 节 `write_file` 自动建父目录是**同一种"贴心"哲学**——默认递归建，意味着模型想建 `/a/b/c/d` 时，即使 `a/b/c` 都不存在也能一步到位，不会因「父目录不存在」报错。`mkdir` 在审批名单里（它改动文件系统）。[mkdir.test.ts](../../src/coding/tools/__tests__/mkdir.test.ts#L20-L40) 测了递归建 `nested/child`。

**③ `move_path` —— 移动/重命名（[move-path.ts](../../src/coding/tools/move-path.ts)）：**

```ts
invoke: async ({ from, to }) => {
  const source = ensureAbsolutePath(from);                 // ← 校验两个路径
  if (!source.ok) {
    return errorToolResult(source.error, "INVALID_SOURCE_PATH", { from, to });
  }
  const target = ensureAbsolutePath(to);
  if (!target.ok) {
    return errorToolResult(target.error, "INVALID_TARGET_PATH", { from, to });
  }
  try {
    await rename(from, to);         // 一次 rename 同时实现"移动"和"重命名"
    return okToolResult(`Moved path from ${from} to ${to}`, { from, to });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return errorToolResult(`Failed to move path from ${from} to ${to}`, "MOVE_FAILED", { from, to, message });
  }
},
```

`move_path` 是 C 组唯一有**两个路径参数**（`from`/`to`）的，所以它**校验两次**，且用了**两个不同的错误码** `INVALID_SOURCE_PATH` 和 `INVALID_TARGET_PATH`——这样模型能精确知道「是源路径错了还是目标路径错了」，而不是笼统一个 `INVALID_PATH`。**底层用 `node:fs` 的 `rename`**——在文件系统层面，「移动」和「重命名」本就是同一个操作（`rename(/a/x.txt, /b/y.txt)` 既移动又改名）。`move_path` 在审批名单里。[move-path.test.ts](../../src/coding/tools/__tests__/move-path.test.ts#L42-L53) 测了相对源路径返回 `INVALID_SOURCE_PATH`。

**C 组小结**：三个工具的骨架高度一致——`ensureAbsolutePath` 校验（`move_path` 校验两次）→ try 里做一次系统调用 → 成功 `okToolResult`、失败 catch 成 `*_FAILED`。它们把 [code-convention](../code-convention.md#L55-L58) 那条「路径校验 + 结构化结果 + SCREAMING_SNAKE 错误码 + details 回显输入」的规范演绎得干净利落。

### 1.7 回收「抠门」伏笔：为什么这六个工具「只回摘要、不回数据」？（第 8 节 policy）

现在回收第 12 节埋的那个「抠门」悬念。打开 [第 8 节](./08-tool-result-pipeline.md) 的 [tool-result-policy.ts](../../src/agent/tool-result-policy.ts#L14-L27)，你会看到本节**六个工具**被归成一档：

```ts
export function getToolResultPolicy(toolName: string): ToolResultPolicy {
  switch (toolName) {
    case "list_files":
    case "glob_search":
    case "grep_search":
    case "file_info":
    case "mkdir":
    case "move_path":
      return {
        preferSummaryOnly: true,    // ← 只回摘要！
        includeData: false,         // ← 扔掉 data！
        maxStringLength: 1000,
        uiSummaryOnly: true,
      };
    // read_file / write_file / str_replace / apply_patch 是另一档（includeData: true）
  }
}
```

**这就回答了「为什么工具里辛辛苦苦攒了一大坨 data（`matches`/`entries`/`size`…），第 8 节却 `includeData: false` 扔掉」的疑问。** 结合 [tool-result-runtime.ts](../../src/agent/tool-result-runtime.ts#L127-L129) 那段：

```ts
if (policy.preferSummaryOnly || !policy.includeData) {
  return JSON.stringify({ ok: true, summary: truncateSummary(normalized.summary) });   // ← 只回喂 summary
}
```

**回喂给模型的，只有那句 `Found 42 files matching **/*.ts` 摘要，data 里那一大坨 `matches` 数组根本不进模型上下文。**

**为什么这么"抠门"？三层理由：**

1. **上下文是最稀缺的资源。** 搜索/列目录的结果动辄成百上千行，若把 `matches`/`entries` 全塞进上下文，几次搜索就把窗口撑爆，挤掉真正重要的代码内容。**「只回摘要」是最激进也最有效的节流**。
2. **摘要往往已经够用。** 模型看到 `Found 42 files matching **/*.ts` 或 `Listed 30 entries under /src`，通常已经知道下一步该干嘛（「哦，有 42 个 ts 文件，我该去 grep 具体内容」）。它**不需要**42 个完整路径都灌进脑子。
3. **真需要细节时，有更精准的工具。** 如果模型确实要看某个文件内容，它会用 `read_file`（那才是 `includeData: true` 的）。**搜索工具负责"缩小范围"，读取工具负责"看细节"——分工明确。**

**那工具里攒的那一大坨 `data` 白攒了吗？没有。** 注意 policy 里还有个 `uiSummaryOnly: true`——**data 不回喂给模型，但可以喂给 [第 19/20 节](./00-roadmap.md) 的 TUI 去渲染给人看**（比如把 `matches` 列成一个漂亮的文件列表给用户浏览）。**所以 data 是给"人的眼睛"看的，summary 是给"模型的脑子"看的——同一份结果，两个受众，各取所需。** 这是「机器可读」与「人可读」分离的精妙设计。

> 💡 **对比一下 C 组和 B 组在 policy 里的待遇。** 有意思的是：**只读的 `file_info` 和会改动世界的 `mkdir`/`move_path` 被归进了同一档**（`preferSummaryOnly`）。为什么 `mkdir` 也只回摘要？因为它的成功 data（`{ path, recursive }`）对模型的后续决策毫无新信息——模型早就知道自己要建哪个目录，一句 `Created directory: /x` 足矣。**判断"回不回 data"的标准不是"只读还是写"，而是"data 里有没有模型下一步真正需要的新信息"**——搜索类的 data 太大、系统操作类的 data 太"废话"，所以都只回摘要。而 `read_file`/`str_replace` 的 data（文件内容、替换了几处）是模型下一步推理的**刚需**，所以 `includeData: true`。

### 1.8 全景：一张「探索工具」的依赖与数据流图

把本节 7 个工具和上下游的关系画出来：

```
   【第5/6节 Agent 循环】 signal(AbortController) ──┐
                                                    │ 仅 spawn 子进程的工具接住 signal
   ┌──────────────────【coding/tools 探索工具】─────┼──────────────────────────────┐
   │                                                ▼                              │
   │  A. bash ───────────► Bun.spawn(["zsh","-c",cmd]) + onAbort→kill              │
   │     └ 成功=裸stdout / 失败="Error:..."（不走 okToolResult）                    │
   │                                                                               │
   │  B. glob_search ─┐                                                            │
   │     grep_search ─┼─► ensureDirectoryPath(第12节) → 执行 → truncateText(第12节) │
   │     list_files  ─┘   → okToolResult/errorToolResult(第12节)                    │
   │     · grep 额外：spawn rg + signal + exit1不算错 + RG_NOT_FOUND 降级           │
   │                                                                               │
   │  C. file_info / mkdir / move_path                                             │
   │     └► ensureAbsolutePath(第12节) → 一次系统调用(stat/mkdir/rename) → try/catch│
   └───────────────────────────────┬───────────────────────────────────────────────┘
                                    │ 产出结果
                                    ▼
                    【第8节 结果管线 formatToolResultForMessage】
     ├ bash 成功: 裸字符串直接回喂 / 失败: "Error:" 前缀被 normalizeToolResult 识别
     ├ B+C 六工具: policy.preferSummaryOnly=true → 只回喂 summary，扔掉 data
     │            (data 经 uiSummaryOnly 给 TUI 渲染给人看)
     └ 错误码 INVALID_*/*_FAILED/RG_NOT_FOUND → inferToolErrorKind 分类
                                    │
                                    ▼
                     拼成 tool_result 消息回喂模型（并驱动第19/20节 TUI）
```

**一句话总括**：**本节 7 个工具让 Agent 具备了"探索陌生环境"的能力——`bash` 是能力最全的逃生舱（裸字符串结果 + 可中断），B 组三个搜索工具站在第 12 节地基上用统一的"校验→执行→截断→封装"骨架回答"有什么/在哪"（并靠第 8 节 policy 只回摘要来节流），C 组三个系统工具用最轻量的"校验→一次系统调用→兜底"完成元信息读取与文件系统改动。它们生产的错误码（`INVALID_*`/`*_FAILED`/`RG_NOT_FOUND`）精确对齐第 8 节的分类器，构成又一条清晰的生产—消费链路。**

---

## 2. 亮点与关键设计

明确标注哪些是「妙笔」、哪些是「关键决策」：

1. **【核心妙笔】`bash` 用「`signal` → `proc.kill()` + 结束后 `removeEventListener`」实现可中断子进程。** 前半是「用户 Ctrl-C 能杀掉正在跑的子进程」（呼应第 5 节 `AbortController` 贯穿式取消），后半是「进程结束就摘监听器」防止长生命周期 `signal` 上累积失效监听器造成内存泄漏。一小段代码同时解决了「可中断」与「不泄漏」两个问题（1.2 ②）。
2. **【关键决策】`bash` 与 `read_file` 一样"不返回结构化结果"，成功吐裸字符串、失败用 `Error:` 前缀编码。** 这个前缀精确对齐第 8 节 `normalizeToolResult` 里 `result.startsWith("Error:")` 的识别分支——是「工具错误就地捕获成文本」容错哲学（第 6 节）在 `bash` 里的落地（1.2 ④）。
3. **【妙笔】`grep_search` 对 ripgrep 退出码的正确理解：`exit 1`（没找到）不算错误。** 只有 `exitCode >= 2` 才返 `GREP_FAILED`。若不特判，模型每次「搜不到」都会误收一个错误。这是「吃透底层工具约定」才能写对的细节（1.4 ②）。
4. **【核心妙笔】`grep_search` 对「rg 未安装」的优雅降级 → `RG_NOT_FOUND`。** 它是全项目**唯一**一个被第 8 节 `inferToolErrorKind` 精确匹配（`code === "RG_NOT_FOUND"`）、归为独立类别 `environment_missing` 的错误码。因为「环境缺失」模型重试无用，必须提示用户安装——这类错误理应和「输入错误/执行失败」区别对待（1.4、Q2）。
5. **【关键决策】搜索工具的「双保险节流」+ 第 8 节的「只回摘要」= 两级三闸的上下文防护。** 工具内 `limit`（卡条数）+ `maxChars`（卡字符）两道闸，加上第 8 节 policy 的 `preferSummaryOnly`（回喂时干脆扔掉 data）第三道闸。搜索结果再大也撑不爆上下文（1.3、1.7）。
6. **【妙笔】「data 给人看、summary 给模型看」的双受众设计（`uiSummaryOnly`）。** 六个工具攒的结构化 data 不回喂给模型（省上下文），但经 `uiSummaryOnly` 交给 TUI 渲染给人看。同一份结果、两个受众、各取所需（1.7）。
7. **【关键决策】`list_files` 的三个体贴细节：稳定排序、目录带尾斜杠、深度受控递归。** 排序让输出可预测（也让测试可断言），尾斜杠用一个字符传递「文件/目录」类型信息，`recursive ? (maxDepth ?? 3) : 0` 用一个变量编码「要不要递归 + 递归多深」（1.5）。
8. **【关键决策】用「专用工具家族 + bash 逃生舱」而非「全靠 bash」。** 六个专用工具提供结构化结果、上下文节流、且只读工具无需审批；`bash` 兜底一切但结果非结构化、且必过审批。这是「安全通道 + 逃生舱」的分层安全设计（1.1、1.2 📌、3.4）。
9. **【一致性红利】7 个工具共享第 12 节地基 → 同一套骨架复用 7 遍。** 「校验（`ensureDirectoryPath`/`ensureAbsolutePath`）→ 执行 → 截断（`truncateText`）→ 封装（`okToolResult`/`errorToolResult`）」的骨架高度一致。读懂一个就读懂一批——这正是第 12 节抽地基的回报（1.3~1.6）。

---

## 3. 工业对比

对比业界方案的做法与优缺点。

### 3.1 Claude Code 的 `Bash` / `GrepTool` / `GlobTool` / `LS` —— 高度对应的工具族

Anthropic 的 Claude Code 有一组几乎一一对应的工具：`Bash`（跑命令）、`GrepTool`（内容搜索，同样底层用 ripgrep）、`GlobTool`（通配符找文件）、`LS`（列目录）。设计思路和 Helixent 高度一致——**都倾向于「用专用的搜索/浏览工具，而不是让模型手写 `find`/`grep` 命令」**。

**共同点**：都用 ripgrep 做内容搜索（快、尊重 `.gitignore`）；都对搜索结果做条数/字符限制；`Bash` 都要求审批或有权限控制。**差异**：Claude Code 的 `Bash` 工具通常带**更丰富的安全策略**（命令黑白名单、超时控制），而 Helixent 的 `bash` 相对朴素（无超时、无命令级过滤，纯靠第 15 节的「整体审批」把关）。这个差异反映了 Helixent「代码量小、把复杂度尽量下沉到审批中间件」的取舍——它不在工具内做复杂的命令解析，而是让「人」在审批时判断。

### 3.2 OpenAI Codex CLI —— 更依赖单一 shell 工具

OpenAI 的 Codex CLI 风格更「shell 中心」——它倾向于给模型一个强大的 shell/exec 工具，让模型自己写 `ls`、`grep`、`find` 等命令来探索，而非提供一组细分的结构化搜索工具。

**取舍**：Codex 的方案**更灵活**（模型能组合任意 unix 命令），但代价是**结果非结构化**（都是 stdout，没有 `matchCount`/`totalMatches` 这类字段供程序判断）、**上下文更易爆**（`grep -r` 一个大仓库可能吐几千行，没有工具级的 `limit`/`preferSummaryOnly` 节流）。Helixent 走了**相反的路**：把最常用的探索操作（glob/grep/list/info）**固化成结构化工具**，只把「其他一切」留给 `bash`。**结论**：Helixent = 「结构化优先，bash 兜底」；Codex = 「shell 优先，灵活至上」。前者对「上下文安全」和「机器可判读」更友好，后者对「能力上限」更友好。

### 3.3 LangChain / 通用 Agent 框架 —— 有 shell 工具，但缺少「节流」与「结构化」的领域约定

LangChain 提供了 `ShellTool`、`ReadFileTool` 等，但它们大多是**对底层命令/API 的薄封装**，**不内置**「搜索结果只回摘要」「错误码分类」「limit + maxChars 双保险」这类领域约定。开发者要么自己在工具里加节流，要么承受「一次搜索撑爆上下文」的风险。

Helixent 因为**面向「编程」这个垂直领域**，才值得把「上下文节流」「错误码对齐」这些约定固化进每个工具（第 8 节 policy + 第 12 节地基）。**这再次印证 [第 1 节](./01-overview.md) 的分层思想**：通用框架给你「造工具的自由」，Helixent 的 coding 层给你「一组风格统一、自带节流与结构化结果的探索工具」。

### 3.4 裸 `bash`（全靠 shell）vs 专用工具 —— 为什么不「全用 bash」？

一个自然的疑问：既然有了万能的 `bash`，为什么还要写 `glob`/`grep`/`list`/`info`/`mkdir`/`move` 六个专用工具？直接让模型 `bash("find . -name '*.ts'")` 不就行了？**三个理由**：

1. **结构化结果**：专用工具返回 `{ ok, summary, data, code }`，程序能判读「成功/失败/错误类别」；`bash` 只有 stdout + 退出码，第 8 节无法对它做错误分类（`bash` 失败一律 `errorKind: unknown`）。
2. **上下文节流**：专用工具有 `limit`/`maxChars`/`preferSummaryOnly` 三道闸；`bash("cat huge.log")` 会把几万行直接灌进上下文。
3. **审批粒度**：只读的 `glob`/`grep`/`list`/`info` **不在审批名单**，模型可以自由探索、不打扰用户；而 `bash` 因为「能干任何事」**必过审批**——每次都弹窗确认会极大拖慢探索。**把常用只读操作从 bash 里"摘出来"做成免审批的专用工具，是一个巨大的体验优化。**

所以 `bash` 是**逃生舱**（能力最全、最危险、必审批），专用工具是**日常主力**（结构化、可节流、只读免审批）。

### 3.5 一览表

| 维度            | Helixent（本节 7 工具）             | Claude Code         | OpenAI Codex       | LangChain 通用 |
| --------------- | ----------------------------------- | ------------------- | ------------------ | -------------- |
| 内容搜索底层    | ripgrep（`grep_search`）          | ripgrep             | 多靠 shell`grep` | 视实现         |
| 结构化搜索工具  | ✅ glob/grep/list/info              | ✅ 对应工具族       | ❌ 偏 shell        | 薄封装、无约定 |
| 上下文节流      | ✅ limit+maxChars+preferSummaryOnly | ✅                  | ❌ 靠模型自觉      | 需自己做       |
| 可中断子进程    | ✅ signal→kill（bash/grep）        | ✅                  | ✅                 | 视实现         |
| 「rg 未装」降级 | ✅ RG_NOT_FOUND 独立类别            | ✅（一般也处理）    | ➖                 | ❌             |
| shell 安全策略  | 靠第 15 节整体审批                  | 命令级黑白名单+超时 | 权限模型           | 基本无         |
| 只读工具免审批  | ✅（glob/grep/list/info）           | ✅                  | ➖                 | ➖             |

---

## 4. 深度解释：为什么这样设计？不这样会怎样？

用 Q&A 形式讲清几个「为什么」，以及「不这样会出什么问题」。

### Q1：`bash` 里那行 `void proc.exited.then(() => signal.removeEventListener(...))` 到底在防什么？删了会怎样？

**它在防「长生命周期 `signal` 上累积失效监听器」的内存泄漏。**

先理清两个对象的**生命周期差异**：

- `signal` 来自 Agent 的 `_abortController`，它的寿命是**整个 Agent 会话**——用户可能连续对话几十轮，中间跑了上百条 bash 命令，这个 `signal` 一直是同一个（每次 `stream()` 会 new 一个新的 `AbortController`，但在一次 `stream` 内跑的多个工具共享同一个 signal，见 [agent.ts](../../src/agent/agent.ts#L145)）。
- 单条 bash 命令的寿命是**几秒**。

**如果删掉那行 `removeEventListener`**：每跑一条 bash 命令，都往 `signal` 上 `addEventListener("abort", onAbort)` 挂一个监听器。命令跑完了，监听器却**还挂着**（因为没人摘）。跑 100 条命令，`signal` 上就积累 100 个 `onAbort` 监听器，每个都闭包引用着一个**早已结束的 `proc`**——这些 `proc` 对象无法被 GC 回收，**内存持续增长**。更糟的是，万一后来真的 abort 了，这 100 个失效监听器会**全部触发**，对 100 个已死进程调 `.kill()`（虽然无害，但纯属浪费）。

**加上那行的效果**：进程一结束（`proc.exited` resolve），就**立刻把自己那个监听器摘掉**。于是 `signal` 上任何时刻最多只有「当前正在跑的命令」的监听器。`void` 前缀表示「这是个 fire-and-forget 的清理，我不 await 它」。**这是一个"注册了事件监听器就要记得注销"的经典最佳实践**——在长生命周期对象上尤其致命。

### Q2：`grep_search` 为什么要专门识别「rg 没装」并返回 `RG_NOT_FOUND`，而不是笼统报个错？

**因为「环境缺失」是一类模型自己无法通过重试解决的错误，必须和普通错误区别对待。**

设想不做这个特判：rg 没装时，`Bun.spawn` 抛异常，被最外层 catch 成一个笼统的 `GREP_EXEC_FAILED`（甚至更糟，一个看不懂的原始异常）。模型收到「grep 失败了」，它会怎么做？**它很可能会重试**——换个 pattern、换个目录、再搜一次……**但 rg 还是没装，每次都失败**。模型陷入「重试 → 失败 → 重试」的死循环，白白消耗 token 和步数，最后撞上 `maxSteps` 熔断（第 5 节）。

**而返回 `RG_NOT_FOUND` + 那句 "Please ensure ripgrep is installed" 后**：第 8 节的 `inferToolErrorKind` 把它归为 `environment_missing`（[tool-result-runtime.ts](../../src/agent/tool-result-runtime.ts#L28)）。这个类别的语义是明确的——**「这不是你（模型）输入的问题，是环境缺东西」**。模型（在第 11 节 `<tool_usage>` 「用 error code 决定下一步、别拿同样的烂输入死磕」的引导下）就知道：重试没用，应该**换个策略**（比如改用 `bash("grep -r ...")`）或**告诉用户去装 rg**。**错误分类的价值，就在于让模型能做出"质"不同的反应**——`invalid_input` 该改参数重试，`environment_missing` 该换路子或求助，`not_found` 该确认目标是否存在。把它们混成一个笼统的 error，就抹掉了这些指导决策的关键信息。

### Q3：`bash` 和 `grep_search` 里那段「signal → kill」的代码几乎一模一样，为什么不抽成一个公共函数？

**这是一个「重复 vs 抽象」的务实取舍——当前的少量重复是可接受的。**

事实是：这段约 4 行的「订阅 abort + 结束后注销」逻辑，在 [bash.ts](../../src/coding/tools/bash.ts#L22-L26) 和 [grep-search.ts](../../src/coding/tools/grep-search.ts#L47-L51) 里几乎逐字重复。按「DRY（Don't Repeat Yourself）」原则，似乎该抽成一个 `attachAbortToProcess(proc, signal)` 的工具函数。**但作者没抽**，这背后有几层考量：

1. **重复量极小**：只有 4 行、两处。抽象的成本（多一个文件/函数、多一层调用、读代码要跳转）**未必小于**重复的成本。「三次法则」（Rule of Three）常被引用——**重复两次时先忍着，重复到第三次再抽**。目前正好卡在两次。
2. **两处并非完全等价**：`bash` 里 signal 是可选的第二参数直接用；`grep_search` 里这段在一个更大的 `try` 块内、和 rg 的错误处理缠在一起。强行抽象可能要处理更多边界，未必更清晰。
3. **符合项目「小而清晰」的气质**：Helixent 通篇偏好「把逻辑摊平在使用处」而非「过早抽象」。第 12 节的地基函数之所以被抽出来，是因为它们被**六七个**工具复用（重复度高、收益大）；而「signal→kill」只有两处，抽象的杠杆率低。

**这给读者的启示**：**不是所有重复都该消除**。抽象有成本（认知跳转、间接层），只有当「重复的痛」超过「抽象的成本」时才值得。识别「这里的重复是刻意容忍的、还是该重构的」，是比死记 DRY 更高级的工程判断。（当然，如果未来出现第三个 spawn 子进程的工具，那就到了该抽象的时候了。）

### Q4：搜索工具的 `limit` 和 `maxChars` 两个限制是不是冗余？留一个不行吗？

**不冗余——它们限制的是两个不同的维度，缺一不可。**

- **`limit` 限制「条数」**：最多返回多少个匹配项（文件数 / 匹配行数）。
- **`maxChars` 限制「总字符数」**：最多返回多少字符。

**为什么两个都要？** 因为「条数」和「字符数」**不成正比**：

- **只有 `limit` 会漏防「长条目」**：假设 `limit: 200`，但匹配到的是 200 个**超长路径**（比如深层嵌套的 `node_modules/.../.../very-long-name.ts`），每个 200 字符——200 条就是 4 万字符，照样撑爆上下文。此时需要 `maxChars` 兜底。
- **只有 `maxChars` 会漏防「遍历开销」**：假设只有 `maxChars: 12000` 而无 `limit`——`glob_search` 得**先扫完所有匹配**（可能几万个）才能 join 后截断，浪费大量遍历时间；有了 `limit`，扫到第 200 个就 `break`，**省下遍历开销**（见 1.3 第②步的「边扫边停」）。

**所以两者是「一前一后、一维一维」的防护**：`limit` 在**收集阶段**卡条数（省遍历、省内存），`maxChars` 在**输出阶段**卡字符（防上下文爆）。再叠加第 8 节的 `preferSummaryOnly`（回喂时干脆只留摘要），构成**三道闸**。这种「多层防护」在「结果大小不可预测」的搜索场景里是必要的——你永远不知道模型会在多大的仓库里搜多宽的 pattern。

### Q5：为什么 B 组要用 `ensureDirectoryPath`（校验存在性），C 组的 `file_info`/`mkdir`/`move_path` 却只用 `ensureAbsolutePath`（只校验格式）？

**因为两组对「路径」的语义要求不同，用刚好够用的校验、不多不少。**

- **B 组（搜索）操作的是「一个用来搜的目录」**——这个目录**必须已经存在且确实是目录**，否则「在里面搜」根本无从谈起。所以用 `ensureDirectoryPath`：它不仅校验绝对路径格式，还 `stat` 确认「存在」且「是目录」（第 12 节 1.2）。如果传了个不存在的路径或一个文件，提前返 `INVALID_DIRECTORY`，避免后面 `Bun.Glob.scan` / `rg` 抛出模型看不懂的底层错误。
- **C 组操作对象「不一定存在、不一定是目录」**：
  - `file_info` 要查的路径**可能是文件、可能是目录、可能不存在**（不存在时它靠 `stat` 的异常 catch 成 `STAT_FAILED`）——用 `ensureDirectoryPath` 会**误伤**（比如查一个文件会被判「不是目录」而拒绝）。
  - `mkdir` 要建的目录**本来就还不存在**（存在还建什么）——用 `ensureDirectoryPath` 校验「必须已存在」显然自相矛盾。
  - `move_path` 的 `to` 目标**通常还不存在**（要移过去才产生）——同理不能要求它预先存在。

**所以「用哪个校验函数」是由工具的语义决定的**：需要「一个现成的目录」就用 `ensureDirectoryPath`，只需要「一个格式合法的绝对路径、存不存在交给操作本身去处理」就用 `ensureAbsolutePath`。**这正是第 12 节「地基函数分层」的用武之地**——`ensureAbsolutePath` 是轻的第一道闸，`ensureDirectoryPath` 是在它之上加了磁盘校验的重版本，工具**按需选用刚好够用的那一层**，既不欠（漏校验导致底层报错）也不过（过度校验误伤合法输入）。

---

## 5. 参考资料

**本节精讲的源码（7 个探索工具）**：

- 万能逃生舱：[bash.ts](../../src/coding/tools/bash.ts)（`Bun.spawn` [L16-L20](../../src/coding/tools/bash.ts#L16-L20)、signal→kill [L22-L26](../../src/coding/tools/bash.ts#L22-L26)、`Error:` 前缀 [L30-L34](../../src/coding/tools/bash.ts#L30-L34)）
- 通配符找文件：[glob-search.ts](../../src/coding/tools/glob-search.ts)（校验 [L24-L27](../../src/coding/tools/glob-search.ts#L24-L27)、`Bun.Glob` 边扫边停 [L29-L41](../../src/coding/tools/glob-search.ts#L29-L41)、截断+封装 [L43-L51](../../src/coding/tools/glob-search.ts#L43-L51)）
- 内容搜索：[grep-search.ts](../../src/coding/tools/grep-search.ts)（拼 rg 命令 [L31-L38](../../src/coding/tools/grep-search.ts#L31-L38)、signal [L47-L51](../../src/coding/tools/grep-search.ts#L47-L51)、exit1 特判 [L54-L64](../../src/coding/tools/grep-search.ts#L54-L64)、RG_NOT_FOUND 降级 [L80-L90](../../src/coding/tools/grep-search.ts#L80-L90)）
- 列目录：[list-files.ts](../../src/coding/tools/list-files.ts)（递归 `walk` [L14-L28](../../src/coding/tools/list-files.ts#L14-L28)、四步骨架 [L43-L60](../../src/coding/tools/list-files.ts#L43-L60)）
- 元信息：[file-info.ts](../../src/coding/tools/file-info.ts)（`stat`+`kind` [L25-L34](../../src/coding/tools/file-info.ts#L25-L34)）
- 建目录：[mkdir.ts](../../src/coding/tools/mkdir.ts)（默认 recursive [L26-L28](../../src/coding/tools/mkdir.ts#L26-L28)）
- 移动/重命名：[move-path.ts](../../src/coding/tools/move-path.ts)（双路径校验 [L21-L29](../../src/coding/tools/move-path.ts#L21-L29)、`rename` [L31-L33](../../src/coding/tools/move-path.ts#L31-L33)）

**co-located 测试（第 21 节会讲这套约定）**：

- [bash.test.ts](../../src/coding/tools/__tests__/bash.test.ts)（成功吐 stdout、失败 `Error:` 前缀、`skipIf` 无 zsh 时跳过）
- [glob-search.test.ts](../../src/coding/tools/__tests__/glob-search.test.ts)（精确命中 `*.ts`、`INVALID_DIRECTORY`）
- [grep-search.test.ts](../../src/coding/tools/__tests__/grep-search.test.ts)（`RG_NOT_FOUND` 与正常匹配双兼容、`INVALID_DIRECTORY`）
- [list-files.test.ts](../../src/coding/tools/__tests__/list-files.test.ts)（递归、排序、目录尾斜杠、`INVALID_DIRECTORY`）
- [file-info.test.ts](../../src/coding/tools/__tests__/file-info.test.ts)、[mkdir.test.ts](../../src/coding/tools/__tests__/mkdir.test.ts)、[move-path.test.ts](../../src/coding/tools/__tests__/move-path.test.ts)（各含 happy path + 结构化错误码断言）

**上游依赖章节**：

- [第 12 节 · 工具地基与文件读写](./12-tool-foundation-file-io.md)：`ensureDirectoryPath`/`ensureAbsolutePath`/`truncateText`/`okToolResult`/`errorToolResult`（本节 7 个工具的地基）
- [第 8 节 · 工具结果处理管线](./08-tool-result-pipeline.md)：`getToolResultPolicy`（六工具 `preferSummaryOnly`）、`inferToolErrorKind`（`RG_NOT_FOUND`→`environment_missing`）、`normalizeToolResult`（`bash` 的 `Error:` 前缀识别）
- [第 5/6 节 · ReAct 主循环 / 并行调度](./05-react-loop.md)：`AbortController` 与 `_act` 里 `tool.invoke(input, signal)` 的 signal 透传（`bash`/`grep_search` 的可中断来源）
- [第 11 节 · Lead Agent](./11-lead-agent.md)：这 7 个工具被装配进 `tools` 数组、`<tool_usage>` 引导（Prefer list_files/glob_search 探索）、`CODING_TOOLS_REQUIRING_APPROVAL`（`bash`/`mkdir`/`move_path` 需审批）

**关联源码（本节引用但不精讲）**：

- 审批名单：[requires-approval.ts](../../src/coding/permissions/requires-approval.ts)、装配处：[lead-agent.ts](../../src/coding/agents/lead-agent.ts#L103-L117)
- 工具签名（`invoke(input, signal?)`）：[function-tool.ts](../../src/foundation/tools/function-tool.ts#L20)
- 结果 policy 与格式化：[tool-result-policy.ts](../../src/agent/tool-result-policy.ts)、[tool-result-runtime.ts](../../src/agent/tool-result-runtime.ts)
- 工具编写规范：[code-convention.md](../code-convention.md)（`description` 第一参数、`ensureAbsolutePath` 强制、SCREAMING_SNAKE 错误码、`Bun.file` 优先）

**外部资料**：

- Bun `Bun.spawn` 子进程 API（`stdout: "pipe"`、`proc.kill()`、`proc.exited`）：[https://bun.sh/docs/api/spawn](https://bun.sh/docs/api/spawn)
- Bun `Bun.Glob` 通配符匹配（`scan`、`cwd`、`absolute`）：[https://bun.sh/docs/api/glob](https://bun.sh/docs/api/glob)
- ripgrep（`rg`）与其退出码约定（0=匹配/1=无匹配/2=错误）：[https://github.com/BurntSushi/ripgrep](https://github.com/BurntSushi/ripgrep)
- MDN `AbortSignal` 与 `addEventListener("abort")`（本节 signal→kill 的基础）：[https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal](https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal)
- Node.js `fs.rename` / `fs.mkdir` / `fs.stat`（C 组三工具底层）：[https://nodejs.org/api/fs.html](https://nodejs.org/api/fs.html)

---

## 6. 小结与下一节预告

本节我们把 Agent「探索陌生环境」的 7 件工具逐一拆开，按「解决什么问题」分成三组：

- **A 组 · 万能逃生舱 `bash`**：`Bun.spawn(["zsh","-c",cmd])` 跑任意命令，用 `signal → proc.kill()` + 结束后 `removeEventListener` 实现「可中断且不泄漏」；成功吐裸 stdout、失败用 `Error:` 前缀编码（被第 8 节识别）。能力最全、最危险、必过审批（1.2）。
- **B 组 · 搜索/浏览 `glob_search`/`grep_search`/`list_files`**：共享「校验（`ensureDirectoryPath`）→ 执行 → 截断（`truncateText`）→ 封装（`okToolResult`）」四步骨架；`grep_search` 额外处理 rg 子进程（signal、exit1 不算错、`RG_NOT_FOUND` 优雅降级）；`list_files` 有稳定排序、目录尾斜杠、深度受控递归三个体贴细节（1.3~1.5）。
- **C 组 · 元信息/系统 `file_info`/`mkdir`/`move_path`**：最轻量的「`ensureAbsolutePath` → 一次系统调用 → try/catch 兜底」；`mkdir` 默认递归、`move_path` 双路径校验用两个错误码（1.6）。
- **一条贯穿主线**：这 7 个工具生产的错误码（`INVALID_*`/`*_FAILED`/`RG_NOT_FOUND`）与第 8 节 `inferToolErrorKind` 精确对齐；六个工具靠第 8 节 `preferSummaryOnly` 只回摘要、data 留给 TUI——「机器可读」与「人可读」分离（1.7）。

至此，[第 12 节](./12-tool-foundation-file-io.md) 的「读/整写/局部替换」加上本节的「跑命令/搜索/浏览/元信息/建目录/移动」，Agent 已经能**在陌生项目里自由探索、并做粗粒度的改动**。但你一定注意到了：本节和第 12 节的**改文件**工具，粒度都偏「粗」——`write_file` 整体覆盖、`str_replace` 靠软约束的唯一匹配、`bash` 更是「你自己写命令」。

**承上启下（启下）**：可真实的代码修改，往往需要**外科手术式的精确**——在一个几百行的文件里，**同时**改第 12 行、删第 45-47 行、在第 88 行后插入一段，且**绝不能打错地方**。这种「多处、精确、带上下文校验」的改动，`str_replace` 的软约束和 `write_file` 的整体覆盖都力不从心。**这就需要一个更强、更严的工具——一个从零手写的 unified diff 解析器与应用器 `apply_patch`**：它解析 `@@ -a,b +c,d @@` 的 hunk 头，逐行比对上下文防止「漂移」，打错了宁可拒绝也不乱改。

**这正是 [第 14 节](./00-roadmap.md) 的主题**——回收第 12 节那个悬念：`str_replace` 的「唯一匹配」是软约束，真正做到「逐行硬校验、打错就拒绝」的，就是 `apply_patch`。

> 预告一个细节：你会在第 14 节看到，`apply_patch` 为什么**刻意不支持文件删除**（不接受 `/dev/null` 目标）？以及它如何用 `validateHunkCounts` 把「补丁声称改 3 行、实际给了 4 行」这类不一致挡在应用之前——这是「用严格换安全」的极致体现，和本节 `bash` 那种「给你最大自由」的逃生舱哲学，恰好形成鲜明对照。

👉 下一节 **第 14 节：apply_patch —— 手写 unified diff 解析器与应用器**。

准备好后，对我说「**生成第 14 节**」即可。
