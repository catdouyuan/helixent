# 第 12 节：工具地基与文件读写 —— tool-utils / tool-result 与 read / write / str_replace

> 本节属于 **第四部分 · Coding 层（面向编程的专用 Agent）**。[第 11 节](./11-lead-agent.md) 画了一张「装配总图」`createCodingAgent`，把 12 个工具的名字一字排开装进了 `Agent`，但**没打开任何一个看内部**。从本节起，第 12～15 节就逐个拆开这些被装配进来的零件。
>
> 对应 roadmap 为本节设定的**核心问题**：
>
>> 所有 coding 工具共享哪些「地基函数」（路径校验、结果封装、文本截断）？Agent 读改文件的工具如何设计得「既好用又防错」？
>>
>
> **一句边界声明**：本节精讲**五个文件**——两个「地基」文件 [tool-utils.ts](../../src/coding/tools/tool-utils.ts)（45 行）、[tool-result.ts](../../src/coding/tools/tool-result.ts)（17 行），以及三个最基础的文件操作工具 [read-file.ts](../../src/coding/tools/read-file.ts)、[write-file.ts](../../src/coding/tools/write-file.ts)、[str-replace.ts](../../src/coding/tools/str-replace.ts)。这五个文件加起来不到 160 行，却是**整个 `coding/tools` 目录 15 个工具共同站立的地面**。[第 13 节](./00-roadmap.md)（探索工具）、[第 14 节](./00-roadmap.md)（apply_patch）都要复用本节的地基函数，所以**本节必须先于它们**。

---

## 0. 承上启下

[第 11 节](./11-lead-agent.md) 结尾，我们在拆完 `createCodingAgent` 这张总装图后，明确埋下了本节的钩子。原话是这样的：

> 本节这张总装图上，`tools` 数组里那 12 个工具（`bashTool`、`readFileTool`、`applyPatchTool`……）**我们只是"点了名、归了类"，却没打开任何一个看它内部长啥样**。它们是怎么校验路径的？怎么防止改错文件？怎么把结果封装成第 8 节那套 `{ ok, summary, code }` 契约的？

第 11 节还给出了本节的**拆解顺序**：

> 拆解要**从地基开始**——因为这 12 个工具并非各写各的，它们**共享同一套"地基函数"**：路径校验（`ensureAbsolutePath`）、目录边界检查（`isWithinDirectory`）、文本截断（`truncateText`）、以及把结果封装成结构化契约的 `okToolResult`/`errorToolResult`。**先看懂这套地基，再看最基础的三个文件操作工具（`read_file`/`write_file`/`str_replace`）如何站在地基之上、被设计得"既好用又防错"**。

并且预告了一个细节：

> 每个工具的参数 schema 里，**第一个参数永远是 `description`**……这个看似奇怪的强约定背后，藏着一个关于"让模型先说清意图、再动手"的巧思。

本节就来兑现这两个悬念。

**先回忆两个上游结论，它们是本节的直接前提：**

1. **[第 4 节](./04-tool.md) 的 `defineTool` 与 `StructuredToolResult`。** 我们知道了一个工具长这样：`defineTool({ name, description, parameters: z.object({...}), invoke })`；也知道了工具产物**推荐**返回一份结构化契约 `{ ok, summary, data | error, code }`（[structured-tool-result.ts](../../src/foundation/tools/structured-tool-result.ts)）。**本节要看的，就是这份契约在 `coding` 层如何被一对 `okToolResult`/`errorToolResult` 工厂函数"落地"，以及三个文件工具如何用它。**
2. **[第 8 节](./08-tool-result-pipeline.md) 的结果处理管线。** 工具返回的五花八门结果，会被 `normalizeToolResult` 归一化、按工具名分级截断、最后拼成喂给模型的字符串。**本节的工具是这条管线的"上游生产者"**——它们生产什么形状的结果，直接决定了第 8 节能怎么处理。尤其 `read_file` 有一个"不返回结构化结果、直接吐原文"的特例，正是第 8 节 `formatToolResultForMessage` 里那行 `if (toolName === "read_file")` 的存在理由——本节会把这条线接上。

准备好了，打开 [tool-utils.ts](../../src/coding/tools/tool-utils.ts)，我们从地面开始往上盖。

---

## 1. 主题内容

### 1.1 先想清楚问题：如果让你来写「一堆文件工具」，你会先抽出什么？

老规矩，写代码前先自己当一次设计者。假设你要给 Agent 写 15 个工具——读文件、写文件、列目录、搜内容、打补丁……你**第一版**可能会一个文件一个文件地闷头写。但写到第三个你就会发现，每个工具的开头几乎都在干**同样三件事**：

1. **校验路径**：模型给的 `path` 是不是绝对路径？（相对路径在不同 `cwd` 下含义会漂移，极其危险）
2. **封装结果**：成功要返回 `{ ok: true, summary, data }`，失败要返回 `{ ok: false, summary, error, code }`——每个工具都手写一遍这个对象字面量，又啰嗦又容易写歪（漏个字段、拼错 key）。
3. **截断长文本**：搜索/读取的结果可能有几万行，直接回喂会撑爆模型上下文，得在某个长度砍一刀并留个提示。

**这三件事，就是"地基"。** 如果不抽出来，会有两个后果：一是**重复**（15 个工具重复 15 遍路径校验逻辑），二是**不一致**（张三写 `Path must be absolute`、李四写 `path should be absolute`、王五的错误对象少了 `code` 字段——下游第 8 节的归一化就没法统一处理）。

所以 Helixent 的做法是：**把这三件事抽成两个"地基文件"**，让所有工具"复用同一套地面"：

| 地基文件                                               | 提供什么                                                                                    | 解决上面哪件事      |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------- | ------------------- |
| [tool-utils.ts](../../src/coding/tools/tool-utils.ts)   | `ensureAbsolutePath` / `ensureDirectoryPath` / `isWithinDirectory` / `truncateText` | 路径校验 + 文本截断 |
| [tool-result.ts](../../src/coding/tools/tool-result.ts) | `okToolResult` / `errorToolResult`                                                      | 结果封装            |

**关键洞察**：这两个文件加起来只有 62 行，但它们是**「一致性」的物理保证**。只要所有工具都调 `ensureAbsolutePath`，那么"相对路径"这个错误在**全项目**就长同一个样（同样的文案、同样的 `INVALID_PATH` 错误码）；只要都调 `errorToolResult`，那么失败结果的**形状**在全项目就完全一致。**地基的价值不在于它写了多少代码，而在于它消灭了多少"本可以各写各的"分歧。**

想清楚这一点，我们**从下往上**看：先看两个地基文件（1.2、1.3），再看三个站在地基上的文件工具（1.4 读、1.5 写、1.6 替换），最后回收 `description` 强约定这个贯穿所有工具的细节（1.7）。

### 1.2 地基一：`tool-utils.ts` —— 路径校验与文本截断四件套（[tool-utils.ts](../../src/coding/tools/tool-utils.ts)）

这个文件导出 4 个纯函数。我们逐个看，注意它们**返回值的统一形状**。

**① `ensureAbsolutePath` —— 最常被调用的一个（[L4-L9](../../src/coding/tools/tool-utils.ts#L4-L9)）：**

```ts
export function ensureAbsolutePath(path: string) {
  if (!path.startsWith("/")) {
    return { ok: false as const, error: `Path must be absolute: ${path}` };
  }
  return { ok: true as const, path };
}
```

只有 5 行，逻辑朴素到极点：**路径不以 `/` 开头，就判定为"非绝对路径"，返回失败**。但请注意三个设计点：

- **返回"可辨识联合"而非抛异常**：它返回 `{ ok: false, error } | { ok: true, path }`，而不是 `throw`。这和 [第 4 节](./04-tool.md) 说的"工具里别抛异常"是同一种哲学——**用返回值表达失败**，让调用方用 `if (!absolute.ok)` 显式处理。`as const` 让 `ok` 的类型收窄成字面量 `true`/`false`，于是 TS 能在 `if (absolute.ok)` 之后**自动收窄**出 `path` 字段一定存在（这正是第 2、4 节反复用到的可辨识联合红利）。
- **为什么用 `path.startsWith("/")` 而不是 `path.isAbsolute()`？** 这是一个**刻意从简**的判断：在 macOS/Linux 上绝对路径就是以 `/` 开头。它没用 `node:path` 的 `isAbsolute`（那会把 Windows 的 `C:\` 也算绝对路径）——因为 Helixent 是 Bun 项目、目标平台是类 Unix，这个简化是合理的（Q3 会讨论它的边界）。
- **它只做"格式校验"，不碰磁盘**：注意它**不检查文件是否存在**——那是各工具自己的事（`read_file` 里用 `Bun.file(path).exists()`）。**职责单一**：这个函数只回答"这个字符串是不是一个绝对路径"，仅此而已。

**② `ensureDirectoryPath` —— 建立在 ① 之上的"目录版"（[L11-L30](../../src/coding/tools/tool-utils.ts#L11-L30)）：**

```ts
export async function ensureDirectoryPath(path: string) {
  const absolute = ensureAbsolutePath(path);
  if (!absolute.ok) {
    return absolute;
  }

  try {
    const dirStat = await stat(path);
    if (!dirStat.isDirectory()) {
      return { ok: false as const, error: `Path exists but is not a directory: ${path}` };
    }
    return { ok: true as const, path };
  } catch (error: unknown) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return { ok: false as const, error: `Directory does not exist: ${path}` };
    }
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false as const, error: `Directory is inaccessible: ${path} (${message})` };
  }
}
```

它是 `ensureAbsolutePath` 的"加强版"，多了**真实访问磁盘**这一步。看它如何**复用 ①**：第一行就 `ensureAbsolutePath(path)`，失败直接把 `absolute` 原样返回（`return absolute`——形状一致，无需重新包装）。通过绝对路径校验后，才 `await stat(path)` 去问操作系统。它把三种失败**分门别类**：

- 路径存在但**不是目录**（比如指向了一个文件）→ `Path exists but is not a directory`；
- `stat` 抛 `ENOENT`（**目录不存在**）→ `Directory does not exist`；
- 其他错误（比如**权限不足**）→ `Directory is inaccessible: ... (原始错误信息)`。

**这是"地基函数也能分层"的范例**：`ensureDirectoryPath` 站在 `ensureAbsolutePath` 之上，就像 `read_file` 会站在 `ensureAbsolutePath` 之上一样。谁用它？[第 13 节](./00-roadmap.md) 的 `list_files`、`glob_search`、`grep_search`——这三个都要求"传进来的必须是一个真实存在的目录"，所以它们在开头调 `ensureDirectoryPath`（见 [list-files.ts](../../src/coding/tools/list-files.ts#L44)、[glob-search.ts](../../src/coding/tools/glob-search.ts#L24)、[grep-search.ts](../../src/coding/tools/grep-search.ts#L26)）。而本节的三个文件工具只需 `ensureAbsolutePath`（它们操作的是文件，存不存在各自用 `exists()` 判断）。

**③ `isWithinDirectory` —— "沙箱边界检查"（[L32-L35](../../src/coding/tools/tool-utils.ts#L32-L35)）：**

```ts
export function isWithinDirectory(root: string, target: string) {
  const relativePath = relative(resolve(root), resolve(target));
  return relativePath === "" || (!relativePath.startsWith("..") && !relativePath.includes(`..${sep}`));
}
```

它回答一个安全问题：**`target` 是不是在 `root` 目录"之内"？** 手法很经典：用 `node:path` 的 `resolve` 把两个路径都规整成绝对形式，再用 `relative(root, target)` 算出"从 root 走到 target 的相对路径"。如果这个相对路径**以 `..` 开头**（或中间含 `../`），说明 target 得先"跳出" root 才能到达——也就**不在 root 之内**。`relativePath === ""` 表示两者是同一目录（也算"在内"）。

**这是防"路径穿越攻击（path traversal）"的标准套路**——防止模型用 `../../etc/passwd` 之类的路径逃出工作目录。

> ⚠️ **一个诚实的观察**：`isWithinDirectory` 目前**在 `src` 里没有任何调用点**（我全仓搜索确认过——它只被定义、被导出，还没被任何工具用上）。也就是说，本节的三个文件工具**并没有真正把写操作限制在 `cwd` 内**——`write_file` 只要求路径是绝对路径，你给它 `/etc/hosts` 它也会尝试写。**这说明 `isWithinDirectory` 是一个"已备好、待接入"的地基函数**：作者把"沙箱边界检查"这块地基先浇好了，但还没在工具里启用它（真正的"危险操作拦截"目前靠 [第 15 节](./00-roadmap.md) 的**审批中间件**在工具执行前把关，而不是靠工具内部的路径边界检查）。roadmap 把它列进"三件套"是**着眼于它的设计意图**，但读源码时你要知道它此刻的真实状态——这种"地基先行、逐步接入"的痕迹，恰恰是阅读真实项目代码时该有的敏感度。

**④ `truncateText` —— 上下文节流的物理执行者（[L37-L45](../../src/coding/tools/tool-utils.ts#L37-L45)）：**

```ts
export function truncateText(text: string, maxChars: number) {
  if (text.length <= maxChars) {
    return { text, truncated: false };
  }
  return {
    text: `${text.slice(0, maxChars)}\n... [truncated ${text.length - maxChars} chars]`,
    truncated: true,
  };
}
```

逻辑一目了然：文本不超长就原样返回、`truncated: false`；超长就砍到 `maxChars`、追加一行 `... [truncated N chars]` 提示、`truncated: true`。**这个"截断了多少字符"的提示是点睛之笔**——它告诉模型"这里被截断了、还有 N 个字符没给你"，模型就知道"如果需要更多，我可以用 `startLine`/`endLine` 再读一段"，而不会误以为"文件就这么长"。

**它和 [第 8 节](./08-tool-result-pipeline.md) 的截断是什么关系？** 这里要讲清一个**两级截断**的层次，别混淆：

- **`truncateText` 是"工具内部的第一级截断"**：由**工具自己**在生产结果时调用，针对的是"这次读/搜的原始文本"。谁用它？`read_file`（[L56](../../src/coding/tools/read-file.ts#L56)）、以及第 13 节的 `glob_search`/`grep_search`/`list_files`。默认上限见各工具的 `DEFAULT_MAX_CHARS`（`read_file` 是 12000）。
- **第 8 节的 `getToolResultPolicy` + `stringifyWithinLimit` 是"回喂前的第二级截断"**：由 **Agent 的结果管线**在把结果拼成消息时，按工具名再卡一次上限（[tool-result-policy.ts](../../src/agent/tool-result-policy.ts)）。

两级各管一段：工具自己先把"原始产物"截到一个合理长度（并给模型留提示），管线再在回喂前兜底卡一道。**`truncateText` 是这套"上下文节流"哲学在工具层的物理执行者。**

**小结 1.2**：`tool-utils.ts` 这 4 个函数，是所有 coding 工具的"公共地面"。它们的共同气质是：**纯函数、返回值表达成败（`{ ok, ... }`）、职责单一、可组合**（`ensureDirectoryPath` 复用 `ensureAbsolutePath` 就是证明）。

### 1.3 地基二：`tool-result.ts` —— 把第 4 节的契约落成两个工厂（[tool-result.ts](../../src/coding/tools/tool-result.ts)）

整个文件只有 17 行，却是**每个工具的返回语句都要用到的**：

```ts
import type { StructuredToolResult } from "@/foundation";

export type ToolResult<T> = StructuredToolResult<T>;

export function okToolResult<T>(summary: string, data: T): ToolResult<T> {
  return { ok: true, summary, data };
}

export function errorToolResult(error: string, code?: string, details?: Record<string, unknown>): ToolResult<never> {
  return {
    ok: false,
    summary: error,
    error,
    ...(code ? { code } : {}),
    ...(details ? { details } : {}),
  };
}
```

**先接上上游。** `ToolResult<T>` 只是 [第 4 节](./04-tool.md) 那个 `StructuredToolResult<T>`（[structured-tool-result.ts](../../src/foundation/tools/structured-tool-result.ts)）的一个**本地别名**——`coding` 层不重新定义契约，而是从 `@/foundation` 引入、起个短名字用。**契约在 foundation 定义（第 4 节），在 coding 层封装成好用的工厂函数（本节），是"依赖单向向下"的又一次体现。**

**再看两个工厂各自的巧思：**

**`okToolResult(summary, data)` —— 强制"成功也要有摘要"。** 它把成功结果固定成 `{ ok: true, summary, data }`。注意 `summary` 是**必填第一参数**——这逼着每个工具在成功时也写一句人话摘要（`"Successfully wrote 128 chars to /x"`），而不是只甩一个 data 对象。**为什么 summary 这么重要？** 因为第 11 节那段系统提示词明确教模型"**用 tool result summaries 和 error codes 决定下一步**"——summary 就是给模型看的"这次干了啥"的一句话总结，也是第 8 节 `preferSummaryOnly` 策略下**唯一**会回喂的内容。

**`errorToolResult(error, code?, details?)` —— 三个精心的设计：**

1. **`summary` 和 `error` 是同一个值**（`summary: error, error`）。为什么冗余？因为契约里 `summary` 是"给人/模型看的一句话"、`error` 是"错误信息主体"——失败时这两者本就该一致，所以直接复用同一个字符串，既满足契约形状、又不啰嗦。
2. **`code` 和 `details` 用条件展开 `...(code ? { code } : {})`**。这是个惯用法：**只在传了值时才把这个 key 加进对象**。好处是——不传 `code` 时，结果对象里**根本没有 `code` 这个 key**，而不是 `code: undefined`。这让 `JSON.stringify` 输出更干净，也让第 8 节 `normalizeToolResult` 里 `if (result.code)` 的判断更可靠。
3. **返回类型是 `ToolResult<never>`**。`never` 是"不可能有值"的类型——因为**失败结果不带 `data`**（`data` 字段在错误分支里压根不存在）。用 `never` 作泛型参数，是在类型层面宣告"这个结果没有成功数据"。

**这两个工厂函数怎么用？** 看后面三个工具你会发现一个**铁律般的模式**：

```ts
// 校验失败 / 业务失败 → errorToolResult(人话, 错误码, {上下文})
return errorToolResult(absolute.error, "INVALID_PATH", { path });
// 成功 → okToolResult(人话摘要, {结构化数据})
return okToolResult(`Successfully wrote ${content.length} chars to ${path}`, { path, bytes: content.length });
```

**错误码（第二参数）是本节要特别强调的一环**——它直接喂给了 [第 8 节](./08-tool-result-pipeline.md) 的 `inferToolErrorKind`。回忆那个函数：它靠**错误码的前后缀**推断错误类别（`INVALID_*` → `invalid_input`、`*_NOT_FOUND` → `not_found`、`*_FAILED` → `execution_failed`……）。所以本节工具里那些 `INVALID_PATH`、`FILE_NOT_FOUND`、`WRITE_FAILED` **不是随手起的名字**——它们的前后缀是**和第 8 节的分类器对齐的暗号**。你在本节看到工具"生产"这些错误码，第 8 节就"消费"它们做分类。**这是一条清晰的生产—消费链路。**

### 1.4 `read_file` —— 行号范围读取、截断、以及那个"不返回结构化结果"的特例（[read-file.ts](../../src/coding/tools/read-file.ts)）

三个文件工具里，`read_file` 最有看头，因为它藏着一个**违背"统一契约"的刻意例外**。先看它的定义骨架：

```ts
export const readFileTool = defineTool({
  name: "read_file",
  description: "Read a file from an absolute path. Supports optional line-range reads for large files.",
  parameters: z.object({
    description: z.string().describe("Explain why you want to read the file. Always place `description` as the first parameter."),
    path: z.string().describe("The absolute path to the file to read."),
    startLine: z.number().int().positive().describe("1-based starting line to read.").optional(),
    endLine: z.number().int().positive().describe("1-based ending line to read, inclusive.").optional(),
    maxChars: z.number().int().positive().describe("Maximum characters to return from the selected range.").optional(),
  }),
  invoke: async ({ path, startLine, endLine, maxChars }) => { /* ... */ },
});
```

**参数设计**：除了必填的 `description`（1.7 详述）和 `path`，还有三个可选参数 `startLine`/`endLine`/`maxChars`——它们让模型可以**只读大文件的一段**，而不必一次拉全文。`z.number().int().positive()` 是层层收窄的 Zod 校验：必须是整数、必须为正——**在参数进入 `invoke` 之前，Zod 就把"传了 0 或负数或小数"的非法输入挡掉了**（这是第 4 节讲的"Zod 校验前置"的红利）。

**`invoke` 的执行流程**，我们跟着代码走一遍，注意它**层层设防**：

```ts
invoke: async ({ path, startLine, endLine, maxChars }) => {
  const absolute = ensureAbsolutePath(path);
  if (!absolute.ok) {
    return errorToolResult(absolute.error, "INVALID_PATH", { path });   // 关卡①：绝对路径
  }

  if (startLine !== undefined && endLine !== undefined && startLine > endLine) {
    return errorToolResult("startLine must be less than or equal to endLine.", "INVALID_RANGE", { path, startLine, endLine });  // 关卡②：范围合法
  }

  const file = Bun.file(path);
  if (!(await file.exists())) {
    return errorToolResult(`File ${path} does not exist.`, "FILE_NOT_FOUND", { path });   // 关卡③：文件存在
  }

  const text = await file.text();
  const lines = text.split("\n");
  const start = startLine ? startLine - 1 : 0;               // 1-based → 0-based
  const end = endLine ? Math.min(endLine, lines.length) : lines.length;   // 越界收口

  if (start < 0 || start >= lines.length) {
    return errorToolResult(`startLine ${startLine} is out of range for file ${path}.`, "START_LINE_OUT_OF_RANGE", { path, startLine, totalLines: lines.length });  // 关卡④：起始行在范围内
  }

  const selected = lines.slice(start, end);
  const numbered = selected.map((line, index) => `${start + index + 1}: ${line}`).join("\n");
  const limited = truncateText(numbered, maxChars ?? DEFAULT_MAX_CHARS);
  const isWholeFileRead = !startLine && !endLine;

  return isWholeFileRead && !limited.truncated ? text : limited.text;
},
```

**四道关卡，前三道都用 `errorToolResult` 返回结构化错误**（错误码 `INVALID_PATH`/`INVALID_RANGE`/`FILE_NOT_FOUND`/`START_LINE_OUT_OF_RANGE` 全部对齐第 8 节的分类器）。这是"防错"的体现——**在真正读文件之前，把所有"输入不合理"的情况都拦下并给出带错误码的解释**，而不是让底层 API 抛一个模型看不懂的异常。

**三个实现细节值得琢磨：**

**① `1-based` 对外、`0-based` 对内。** 参数 `startLine` 对模型是"从第 1 行开始"（符合人类/编辑器直觉），但数组是 0-based，所以 `const start = startLine ? startLine - 1 : 0` 做了转换。`end` 用 `Math.min(endLine, lines.length)` **收口越界**——你传 `endLine: 9999` 但文件只有 10 行，它不会报错，而是老老实实给你到第 10 行。这是"**对模型宽容**"的体现：能合理处理的边界，就别用错误去惩罚它。

**② 带行号输出。** `numbered` 把每行加上 `行号: ` 前缀（`${start + index + 1}: ${line}`）。**为什么要加行号？** 因为模型读完文件后，下一步往往要"改第 42 行"或"在第 10-15 行之间插入"——**有行号，模型才能精确定位**，[第 14 节](./00-roadmap.md) 的 `apply_patch` 也才好对齐。（源码里有个 `TODO: add line numbers ... with padding`，说明作者还想让行号右对齐、更美观，但当前版本是简单拼接。）

**③ 最精妙的一行：那个"不返回结构化结果"的特例。** 看最后：

```ts
// Do NOT return a structured result here.
// Instead, return the raw text.
return isWholeFileRead && !limited.truncated ? text : limited.text;
```

`read_file` 成功时**不**返回 `okToolResult(...)`，而是**直接返回字符串**！而且分两种情况：

- **整文件读 + 没截断**（`isWholeFileRead && !limited.truncated`）：返回**最原始的 `text`**（连行号都不加）——因为你想要文件"原样"的内容（用来整体理解、或喂给别的工具）。
- **其他情况**（读了某个范围、或触发了截断）：返回**带行号、可能带截断提示的 `limited.text`**。

**为什么 `read_file` 要打破"统一返回结构化契约"的规矩？** 这是本节最值得停下来想的设计。答案是：**文件内容就是要"原样"喂给模型，包一层 `{ ok, summary, data }` 反而是累赘。** 如果 `read_file` 也返回 `okToolResult("读了 100 行", { content: "..." })`，那模型看到的就是一个 JSON 字符串、文件内容被 `JSON.stringify` 转义（换行变成 `\n`、引号被转义）——**可读性大幅下降**。直接吐原文，模型看到的就是文件本来的样子。

**这个特例是怎么被下游正确处理的？** 回收第 8 节的钩子——还记得 [tool-result-runtime.ts](../../src/agent/tool-result-runtime.ts#L100-L103) 里那行特判吗？

```ts
export function formatToolResultForMessage({ toolName, result }: { toolName: string; result: unknown }): string {
  if (toolName === "read_file" && typeof result === "string") {
    return result;   // ← 就是为 read_file 这个特例开的后门
  }
  const normalized = normalizeToolResult(result);
  // ...
}
```

**看到闭环了吗？** `read_file` 在本节"违规"返回裸字符串，第 8 节的管线就用一行 `if (toolName === "read_file")` 专门放行、原样回喂。**上游的特例设计和下游的特判处理是配对出现的**——你在第 8 节可能觉得"为什么单独给 read_file 开后门"，现在从本节看，就明白那个后门服务的正是这里"直接吐原文"的决策。而且注意：**万一 `read_file` 返回的是结构化错误对象**（前面四道关卡之一），`typeof result === "string"` 就为 `false`，于是走下面正常的 `normalizeToolResult` 分支——**成功吐原文、失败走结构化**，两条路各得其所。

### 1.5 `write_file` —— 整体覆盖、自动建父目录、异常兜底（[write-file.ts](../../src/coding/tools/write-file.ts)）

`write_file` 比 `read_file` 简单，是"整体覆盖写"。看 `invoke`：

```ts
invoke: async ({ path, content }) => {
  const absolute = ensureAbsolutePath(path);
  if (!absolute.ok) {
    return errorToolResult(absolute.error, "INVALID_PATH", { path });   // 关卡①：绝对路径
  }

  try {
    const parentDir = parse(path).dir;
    if (!(await exists(parentDir))) {
      await mkdir(parentDir, { recursive: true });                      // 贴心：自动建父目录
    }

    const file = Bun.file(path);
    await file.write(content);
    return okToolResult(`Successfully wrote ${content.length} chars to ${path}`, { path, bytes: content.length });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return errorToolResult(`Failed to write file: ${path}`, "WRITE_FAILED", { path, message });   // 兜底
  }
},
```

三个设计点：

**① 自动创建父目录（"贴心"）。** 写文件前先 `parse(path).dir` 取出父目录，若不存在就 `mkdir(..., { recursive: true })` 递归创建。**为什么贴心？** 因为模型想写 `/project/src/new/deep/file.ts` 时，往往并不知道 `new/deep/` 这两级目录还不存在——如果 `write_file` 因为"父目录不存在"就报错，模型还得先调 `mkdir` 再重试，来回两步。这里**一步到位**，符合"让常见意图顺畅完成"的好用原则。（[write-file.test.ts](../../src/coding/tools/__tests__/write-file.test.ts#L62-L73) 专门测了"深层嵌套目录不存在时能自动创建"。）

**② 整个写操作包在 `try/catch` 里（"防错"）。** 磁盘写入可能因各种原因失败（权限、磁盘满、路径是只读的……），全都 `catch` 住、转成 `errorToolResult(..., "WRITE_FAILED", ...)`。**注意它把原始异常信息塞进了 `details.message`**——这样模型/用户既看到了"人话摘要"（`Failed to write file: /x`），又能在 details 里拿到底层真实原因。这再次印证了 [code-convention](../code-convention.md) 里那条铁律：**工具的 `invoke` 绝不把异常抛出去，一律 `catch` 成 `errorToolResult`**（否则会一路冒泡到 Agent 循环，破坏第 6 节"就地捕获成 Error 文本"的容错）。

**③ 成功摘要报"写了多少字符"。** `okToolResult` 的 summary 写 `Successfully wrote ${content.length} chars to ${path}`，data 里带 `{ path, bytes }`。这一句摘要让模型确认"写成功了、写了多少"——比只返回 `{ ok: true }` 信息量大得多。

> 📌 **注意 `write_file` 的"危险性"。** 它是**整体覆盖**——一次 `file.write(content)` 会把整个文件替换成 `content`。这意味着模型必须把**完整的新内容**都生成出来。对小文件没问题，但对大文件，这既费 token（要重新生成全文）又危险（漏抄一段就丢了）。**这正是为什么后面需要 `str_replace`（1.6）和 `apply_patch`（第 14 节）**——它们是"局部修改"，不用重写全文。也正因为 `write_file` 危险，它被列进了 [第 11 节](./11-lead-agent.md) 的 `CODING_TOOLS_REQUIRING_APPROVAL`，执行前要过第 15 节的审批。

### 1.6 `str_replace` —— 字符串替换与"计数—校验—写入"三段式（[str-replace.ts](../../src/coding/tools/str-replace.ts)）

`str_replace` 是"局部修改"的第一件武器：把文件里的 `old` 子串替换成 `new`。它的 `invoke` 是本节**逻辑最丰富**的一个，我们分段看。

**参数与前置校验**（和前两个工具同款套路，不赘述）：`description`（必填）、`path`、`old`（要替换的子串）、`new`（替换成什么）、`count`（可选，最多替换几处）。前置关卡：绝对路径（`INVALID_PATH`）→ 文件存在（`FILE_NOT_FOUND`）→ `old` 非空（`INVALID_ARGUMENT`）。

**第一段：先"数"出实际能替换几处（不改文件）：**

```ts
const maxReplacements = count ?? Number.POSITIVE_INFINITY;
if (maxReplacements === 0) {
  return okToolResult(`No replacements requested (count=0) in ${path}`, { path, replacements: 0, changed: false });
}

let replacements = 0;
let idx = 0;
while (replacements < maxReplacements) {
  const next = text.indexOf(old, idx);
  if (next === -1) break;
  replacements++;
  idx = next + old.length;
}

if (replacements === 0) {
  return errorToolResult(`No occurrences of 'old' found in ${path}.`, "NOT_FOUND", { path });
}
```

它先用 `indexOf` 循环**数一遍** `old` 出现了几次（最多数到 `maxReplacements`）。`idx = next + old.length` 保证**不重叠计数**。数完若 `replacements === 0`（一次都没找到），返回 `NOT_FOUND` 错误。**为什么要先数、后改？** 因为"没找到要替换的内容"本身就是一个模型该知道的**失败信号**——模型可能 `old` 抄错了，得知道"你要替换的东西根本不在文件里"，而不是默默什么都没改。

**第二段：真正执行替换（区分"全部替换"和"限量替换"）：**

```ts
let updated: string;
if (count === undefined) {
  updated = text.split(old).join(replacement);          // 全部替换：split/join 最简洁
} else {
  let remaining = count;
  updated = text.replaceAll(old, (match) => {            // 限量替换：用计数器控制
    if (remaining <= 0) return match;                    // 超额就原样返回（不替换）
    remaining--;
    return replacement;
  });
}
```

- **不传 `count`（全部替换）**：用 `text.split(old).join(replacement)`——这是 JS 里"替换所有出现"最干净的写法（比带正则的 `replaceAll` 更省心，因为 `old` 里若含正则特殊字符不会出岔）。
- **传了 `count`（限量替换）**：用 `replaceAll` + 一个 `remaining` 计数器，替换够 `count` 次后，后续匹配 `return match`（原样返回=不替换）。

**第三段：写入前再确认"真的变了"，然后写盘：**

```ts
if (updated === text) {
  return okToolResult(`No effective changes in ${path}`, { path, replacements: 0, changed: false });
}

try {
  await file.write(updated);
  return okToolResult(`Replaced ${replacements} occurrence(s) in ${path}`, { path, replacements, changed: true });
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  return errorToolResult(`Failed to write replacement to ${path}`, "WRITE_FAILED", { path, message });
}
```

- **`updated === text` 的空转检查**：如果替换后内容和原文**一模一样**（比如 `old` 和 `new` 相同），就**不写盘**，返回 `changed: false`。这避免了"无意义的磁盘写入"和"假装改了其实没改"的误导。
- **写盘同样包 `try/catch`**，失败转 `WRITE_FAILED`（和 `write_file` 一致）。
- **成功摘要报"替换了几处"**（`Replaced N occurrence(s)`），data 带 `{ path, replacements, changed }`。

**关键设计：`description` 里那句 "Make sure the `old` is unique in the file"。** 看工具的顶层 `description`：`"Replace occurrences of a substring in a file. Make sure the \`old\` is unique in the file."`这句话是**给模型的强引导**——它在教模型："**你给的`old`最好在文件里是唯一的**"。为什么？因为如果`old`是个很短、很常见的串（比如`data`），文件里出现几十次，不传 `count`就会**全被替换**，造成"误伤"。所以最佳实践是：**让`old` 带上足够的上下文（前后几行），使它在文件里唯一**，这样才能精确命中你想改的那一处。

> ⚠️ **一个要说清的落差**：roadmap 的亮点预告里写 `str_replace` "**强制**唯一匹配以防误改"。但读源码你会发现——**代码并没有在"`old` 出现多次时报错"**。它只是：不传 `count` 就全替换、传了 `count` 就替换前 N 个，并**在 `description` 里"劝"模型保证唯一**。也就是说，"唯一匹配"是通过**提示词引导（软约束）**而非**代码强制（硬约束）**实现的。这是个值得记住的区分：Helixent 这里选择了"相信模型 + 用 `count` 兜底"的轻量方案，而不是"代码里数到 >1 就拒绝"的强硬方案。真正做到"逐行硬校验、打错就拒绝"的，是 [第 14 节](./00-roadmap.md) 的 `apply_patch`——这也正是为什么还需要那个更重的工具。**读教程要以源码为准**：我在这里把预告和实现的差异摊开讲，就是这个意思。

### 1.7 回收强约定：为什么每个工具的第一个参数永远是 `description`？

现在回收第 11 节埋的那个悬念。你一定注意到了，本节三个工具（以及第 13 节所有工具）的 Zod schema，**第一个字段永远是**：

```ts
description: z.string().describe("Explain why you want to <action>. Always place `description` as the first parameter."),
```

这是 [code-convention](../code-convention.md#L54) 明文规定的**全项目强约定**。关键要分清**两个 description**，别搞混：

- **工具的 `description`**（`defineTool({ description: "Read a file from..." })`）：描述**这个工具是干什么的**，给模型看"我该在什么时候用这个工具"。
- **参数里的 `description` 字段**（schema 的第一个字段）：这不是工具的说明，而是**要模型在每次调用时填写"我为什么要这么做"的理由**（rationale）。

**为什么要强制模型先填一句"我为什么要读这个文件"？** 有三层好处：

1. **让模型"先想后做"**。要求模型在调用工具前先用一句话说清意图，本质上是一种轻量的"**思维链（chain-of-thought）诱导**"——模型在生成 `description` 的过程中，被迫先明确"我这一步到底想干嘛"，从而减少"瞎调工具"。这就是第 11 节说的"让模型先说清意图、再动手"的巧思。
2. **可读性 / 可审计**。这句 `description` 会显示在 TUI 里（[第 19/20 节](./00-roadmap.md) 的渲染），**用户能一眼看懂 Agent 每一步"想干嘛"**——"读 read-file.ts 是为了理解截断逻辑"，比光看到一个 `read_file(path=...)` 调用友好得多。审批（第 15 节）时，这句理由也是人类判断"要不要放行"的重要依据。
3. **"第一个参数"的位置约定**。为什么强调**放第一个**？因为工具调用的参数是**流式生成**的（第 3 节的流式、第 16 节的 `StreamAccumulator`）——把 `description` 放第一个，意味着模型**最先生成的就是意图说明**，然后才生成 `path`、`content` 等。这符合"先声明意图、再给出参数"的自然顺序，也让流式 UI 能第一时间显示"Agent 正打算做什么"。

**这个约定的代价与边界**：它让每次工具调用都多产出一句话（多花一点 token），且这句 `description` 在 `invoke` 里其实**没被用到**（你看三个工具的 `invoke` 参数解构，都没解构 `description`——它纯粹是"给人和给模型思考用的"，不参与实际逻辑）。但这点开销换来的"可读性 + 诱导思考 + 可审计"是划算的——这是一个典型的"**为了可观测性，主动增加一点冗余**"的工程取舍。

### 1.8 全景：一张"地基与文件工具"的依赖图

把本节五个文件的关系画出来，你就看清了"地基"到底托举着什么：

```
        【foundation 层（第 4 节）】
        structured-tool-result.ts : StructuredToolResult<T> = { ok, summary, data|error, code, details }
                        │ import
                        ▼
   ┌──────────────────────────────【coding/tools 地基】──────────────────────────────┐
   │  tool-result.ts                          tool-utils.ts                          │
   │  ├─ okToolResult(summary, data)          ├─ ensureAbsolutePath  ← 最常用        │
   │  └─ errorToolResult(error, code, det.)   ├─ ensureDirectoryPath ← 第13节目录工具用│
   │       └ code 前后缀对齐第8节分类器        ├─ isWithinDirectory   ← 已备好·未接入 │
   │                                          └─ truncateText        ← 第一级截断     │
   └───────────────────────┬──────────────────────────┬────────────────────────────┘
                           │ 复用                       │ 复用
        ┌──────────────────┼──────────────────┬────────┴─────────┐
        ▼                  ▼                  ▼                  ▼
   read_file           write_file         str_replace       (第13节 list/glob/grep …)
   ├ 4道关卡→errorTR    ├ 绝对路径校验      ├ 计数→校验→写入
   ├ 行号/范围/截断     ├ 自动建父目录      ├ split/join 或 count 限量
   └ 成功吐【原文】特例  └ try/catch兜底     └ description劝"old唯一"(软约束)
        │                  │                  │
        │ 成功=裸字符串     │ okToolResult      │ okToolResult / errorToolResult
        └──────────────────┴──────────────────┴──────────► 【第 8 节结果管线】
                                                            normalizeToolResult + policy 截断
                                                            (read_file 走 if 特判原样回喂)
                                                                    │
                                                                    ▼
                                                            拼成 tool_result 消息回喂模型
```

**一句话总括**：**`tool-utils` 和 `tool-result` 是两块"地面"——前者管"路径对不对、文本长不长"，后者管"结果长什么形状"；`read_file`/`write_file`/`str_replace` 站在这两块地面上，各自处理"读/整写/局部替换"，并通过统一的错误码与摘要，把产物交给第 8 节的管线回喂模型。唯一的例外是 `read_file` 成功时直接吐原文——一个被第 8 节特判配对处理的、为可读性而生的刻意破例。**

---

## 2. 亮点与关键设计

明确标注哪些是「妙笔」、哪些是「关键决策」：

1. **【核心决策】把"路径校验 / 结果封装 / 文本截断"抽成两个地基文件。** 62 行代码换来的是**全项目的一致性**——同一个"相对路径"错误在任何工具里都长同一个样、带同一个 `INVALID_PATH` 码；同一个成功/失败结果在任何工具里都是同一个形状。地基的价值不在代码量，而在消灭分歧（1.1、1.2、1.3）。
2. **【关键决策】地基函数一律"返回值表达成败"（`{ ok, ... }`）而非抛异常。** `ensureAbsolutePath`/`ensureDirectoryPath` 返回可辨识联合，配合 `as const` 让 TS 自动收窄。这与 [第 4 节](./04-tool.md)"工具里别抛异常"一脉相承，也让调用方用 `if (!x.ok)` 显式处理每一种失败（1.2）。
3. **【妙笔】`read_file` 成功时"不返回结构化结果、直接吐原文"的刻意破例。** 文件内容原样喂给模型可读性最好，包一层 JSON 反而累赘。这个破例与 [第 8 节](./08-tool-result-pipeline.md) `formatToolResultForMessage` 里那行 `if (toolName === "read_file")` 特判**配对出现**——上游破例、下游放行，是一处教科书级的"跨层协同"（1.4、Q1）。
4. **【关键决策】错误码的前后缀是"和第 8 节分类器对齐的暗号"。** `INVALID_PATH`/`FILE_NOT_FOUND`/`WRITE_FAILED` 等不是随手起名——它们的前后缀被 [第 8 节](./08-tool-result-pipeline.md) 的 `inferToolErrorKind` 用来推断错误类别。本节"生产"错误码、第 8 节"消费"错误码，构成清晰的生产—消费链路（1.3、Q4）。
5. **【妙笔】`errorToolResult` 用条件展开 `...(code ? { code } : {})` 保持结果形状干净。** 不传的字段"根本不出现"而非 `undefined`，让 JSON 输出干净、让下游 `if (result.code)` 判断可靠（1.3）。
6. **【关键决策】"好用"与"防错"两手抓。** 好用：`read_file` 越界行号自动收口、`write_file` 自动建父目录、`str_replace` 空转不写盘；防错：层层前置校验 + 全程 `try/catch` 兜底 + 带错误码的结构化失败。每个工具都在"让常见意图顺畅完成"和"把异常输入拦在门外"之间取平衡（1.4、1.5、1.6）。
7. **【核心妙笔】`description` 作为强制第一参数——诱导思考 + 可审计。** 强制模型每次调用先写一句"我为什么这么做"，本质是轻量的思维链诱导，也让 TUI/审批能显示 Agent 意图。放"第一个"是为了配合流式生成——意图最先吐出来（1.7）。
8. **【诚实标注】两处"预告 vs 实现"的落差**：`isWithinDirectory` 已备好但**尚未在任何工具接入**（沙箱边界目前靠第 15 节审批而非工具内校验）；`str_replace` 的"唯一匹配"是**提示词软约束**而非**代码硬校验**（真正硬校验的是第 14 节 `apply_patch`）。识别这类落差，是读真实项目源码的必备敏感度（1.2、1.6）。

---

## 3. 工业对比

对比业界方案的做法与优缺点。

### 3.1 Claude Code 的 `View` / `Edit` / `Replace` —— 强制"改前先读"与唯一匹配

Anthropic 的 Claude Code 有一组几乎对应的文件工具：`View`（读）、`Edit`/`Replace`（改）。它的 `Edit` 工具**在代码层面强制"唯一匹配"**——如果你给的 `old_string` 在文件里出现多次或一次都不出现，工具会**直接报错**，要求你提供更多上下文让匹配唯一。这比 Helixent 的 `str_replace`（靠 `description` 软性"劝"模型保证唯一、靠 `count` 兜底）**更硬**。

**取舍**：Claude Code 的硬校验更安全（绝不会误伤多处），但也更"挑剔"（模型经常要重试、补上下文）；Helixent 的软约束更宽松、实现更简单，把"唯一性"的责任更多交给模型自觉——代价是"`old` 太短导致误替换"的风险实打实存在。**Helixent 的补偿是**：真正需要"外科手术级精确"时，用 [第 14 节](./00-roadmap.md) 的 `apply_patch`（那才是它的硬校验工具）。所以两者的差异更多是"把硬校验放在哪个工具里"的分工选择，而非能力缺失。

### 3.2 OpenAI Codex CLI / `apply_patch` 风格 —— 没有独立的 str_replace

OpenAI 的 Codex CLI 更倾向于**用一个统一的 `apply_patch` 工具**承担所有编辑（读靠单独的读工具），不太设"字符串替换"这种中间粒度的工具。Helixent 则提供了**三档粒度**：`write_file`（整体覆盖，最粗）→ `str_replace`（子串替换，中）→ `apply_patch`（unified diff，最细）。

**取舍**：多档粒度让模型能"按需选择最合适的工具"——小改用 `str_replace` 省事、大范围重写用 `write_file`、多处精确改用 `apply_patch`。代价是模型要在三者间"选对"（选错会低效，比如用 `write_file` 改一个大文件的一行）。第 11 节那段 `<tool_usage>` 提示词（"Prefer apply_patch for targeted edits"）正是在**引导模型选对粒度**——这也说明"多工具"方案需要配套的提示词引导才好用。

### 3.3 LangChain / 通用 Agent 框架 —— 工具是"松散集合"，缺少共享地基

LangChain 等通用框架里，工具（Tool）往往是**各自独立**的类/函数，框架不强制它们共享一套"路径校验/结果封装/截断"的地基。开发者要么每个工具重复写这些逻辑，要么自己抽公共函数——**框架不替你做这件事**。

Helixent 因为是**面向"编程"这个垂直领域**的，才敢也才值得抽出 `tool-utils`/`tool-result` 这样的领域地基（所有工具都要校验路径、都要返回结构化结果）。**这印证了 [第 1 节](./01-overview.md) 的分层思想**：`coding` 层不是"一堆散装工具"，而是"一组共享地基、风格统一的工具家族"。通用框架给你造工具的**自由**，Helixent 的 coding 层给你造编程工具的**规范**。

### 3.4 传统 CLI（`sed`/`cat`/`grep`）—— 无结构化结果、无上下文节流

如果不用 Agent 专用工具，直接让模型生成 `sed`/`cat` 命令（Helixent 的 `bash` 工具也支持，见第 13 节），会有两个问题：一是**结果非结构化**（`sed` 成功失败都只有 stdout/exit code，没有 `{ ok, summary, code }` 供程序判断错误类别）；二是**无上下文节流**（`cat` 一个一万行的文件会把上下文撑爆，没有 `truncateText` 那样的"截断并提示"）。

**这正是"为什么要包一层专用工具、而不是全用 bash"的理由**：专用工具用 `okToolResult`/`errorToolResult` 提供了**机器可判读的成败与错误类别**，用 `truncateText` + 第 8 节 policy 提供了**上下文安全**。`bash` 是"逃生舱"（能力最全但最原始），`read_file`/`write_file`/`str_replace` 是"安全带齐全的专用通道"。

### 3.5 一览表

| 维度                       | Helixent（本节三工具）           | Claude Code    | OpenAI Codex | LangChain 通用 | 裸 bash/sed |
| -------------------------- | -------------------------------- | -------------- | ------------ | -------------- | ----------- |
| 共享地基（路径/结果/截断） | ✅`tool-utils`+`tool-result` | ✅（内置）     | ✅（内置）   | ❌ 各写各的    | ❌ 无       |
| 编辑粒度档位               | 3 档（write/replace/patch）      | 2~3 档         | 主打 patch   | 由使用者定     | 由命令定    |
| 唯一匹配                   | 软约束（提示词+count）           | 硬校验（报错） | patch 硬校验 | 无             | 无          |
| 结构化结果+错误码          | ✅                               | ✅             | ✅           | 视实现         | ❌          |
| 上下文节流（截断）         | ✅ 两级截断                      | ✅             | ✅           | 需自己做       | ❌          |
| 读文件是否原样吐           | ✅（刻意破例）                   | ✅             | ✅           | 视实现         | ✅（cat）   |

---

## 4. 深度解释：为什么这样设计？不这样会怎样？

用 Q&A 形式讲清几个"为什么"，以及"不这样会出什么问题"。

### Q1：`read_file` 为什么要打破"统一返回 `StructuredToolResult`"的规矩、直接返回裸字符串？

**核心理由：文件内容要"原样"喂给模型，包一层结构化外壳反而损害可读性。**

先看**不这样（也返回 `okToolResult`）会怎样**。假设 `read_file` 返回 `okToolResult("Read 100 lines", { content: fileText })`。那么第 8 节的管线会把它 `JSON.stringify` 成一个字符串喂给模型——文件里的每个换行变成 `\n`、每个引号变成 `\"`、整个内容被塞进一个 JSON 的 `data.content` 字段里。模型看到的不再是"文件本来的样子"，而是一坨转义过的 JSON。**对于"读代码来理解/修改"这个最高频的用途，这种转义是纯粹的干扰。**

**再看这样（返回裸字符串）的好处**：模型看到的就是文件原文（整读且不截断时甚至连行号都不加），和它在编辑器里看到的一模一样。这对后续"改第几行"的推理最友好。

**代价是什么？** `read_file` 成了整个工具体系里的"**异类**"——它的成功返回类型不是 `StructuredToolResult` 而是 `string`。这个异类**必须**被下游特殊照顾，于是就有了 [第 8 节](./08-tool-result-pipeline.md) `formatToolResultForMessage` 开头那行 `if (toolName === "read_file" && typeof result === "string") return result;`。**这是一个"用一处特判换取一处可读性"的取舍**：破例本身有代价（下游要记得特判、`read_file` 不能享受统一的结果处理），但对"读文件"这个超高频操作，可读性的收益远大于"多写一行特判"的成本。而且设计得很稳：失败时 `read_file` 仍返回结构化错误对象（`typeof` 不是 string），自动走回正常管线——**只在成功路径破例，失败路径归队**。

### Q2：为什么 `write_file` 要"自动创建父目录"，而不是让父目录不存在时直接报错？

**因为它符合"让模型的常见意图顺畅完成"的好用原则，且这个自动行为是安全的。**

设想模型在重构时想新建 `/project/src/features/auth/login.ts`，但 `features/auth/` 这两级目录还不存在。**如果 `write_file` 因"父目录不存在"报错**，模型就得：读到错误 → 意识到要先建目录 → 调 `mkdir` → 再调 `write_file`。**三步、两次工具往返**，还容易在"该建到哪一级"上犹豫。而自动建父目录**一步到位**。

**这个自动行为会不会"危险"（比如误建一堆目录）？** 基本不会——`mkdir(parentDir, { recursive: true })` 只创建"写这个文件所必需"的父目录，不会多建。而且写文件本身已经是"要改动世界"的操作、要过第 15 节审批，顺带建的父目录也在这次审批的语义覆盖内。**"必要的副作用、且在用户已授权的操作范围内"——这类自动化是划算的。** 反例是：如果 `write_file` 连"目标是个已存在的目录"都自动处理（比如自动改名），那就越界了——所以它没这么做，只做了"建父目录"这一件确定安全的贴心事。

### Q3：`ensureAbsolutePath` 只判断 `path.startsWith("/")`，会不会太简陋？

**在 Helixent 的目标环境里，这个简化是合理的；但要知道它的边界。**

`startsWith("/")` 的**优点**是简单、零依赖、意图清晰。它的**边界**在于：

- **平台假设**：它假设了类 Unix 路径（`/` 开头）。在 Windows 上，`C:\Users\...` 不以 `/` 开头，会被判为"非绝对路径"。但 Helixent 是 **Bun 项目、面向类 Unix 环境**（macOS/Linux），这个假设成立。若真要跨平台，应换成 `node:path` 的 `isAbsolute`。
- **不规整化**：它不处理 `//foo`、`/foo/../bar`、`/foo/./bar` 这类"是绝对路径但不规整"的情况——它只看"开头是不是 `/`"，不做 `resolve`。真正的规整化留给了各工具（或 Bun 底层 API）。
- **不校验存在/权限**：如前所述，它只管"格式"，存在性各工具用 `exists()`/`stat` 自己判断。

**为什么不做得更严？** 因为 `ensureAbsolutePath` 的**职责被刻意限定为"格式的第一道闸"**——它要足够轻、能被每个工具无脑调用。更复杂的检查（规整化、边界、存在性）要么交给专门的函数（`ensureDirectoryPath` 管存在性、`isWithinDirectory` 管边界），要么交给底层 API。**这是"每个地基函数只做一件事"的单一职责在起作用**——把"绝对路径格式校验"做到极简，反而让它成为最通用、最常被复用的那一个（本节 6 个工具全在用它）。

### Q4：错误码（`INVALID_PATH`、`FILE_NOT_FOUND`…）为什么要按前后缀命名？谁在乎？

**因为 [第 8 节](./08-tool-result-pipeline.md) 的 `inferToolErrorKind` 靠前后缀把错误码归类，命名就是"约定协议"。**

回忆第 8 节那个分类器（[tool-result-runtime.ts](../../src/agent/tool-result-runtime.ts#L24-L32)）：

```ts
export function inferToolErrorKind(code?: string): ToolErrorKind {
  if (code.startsWith("INVALID_")) return "invalid_input";
  if (code.endsWith("_NOT_SUPPORTED")) return "unsupported";
  if (code === "RG_NOT_FOUND") return "environment_missing";
  if (code === "FILE_NOT_FOUND" || code.endsWith("_NOT_FOUND")) return "not_found";
  if (code.endsWith("_FAILED")) return "execution_failed";
  return "unknown";
}
```

看懂了吗？本节工具用的 `INVALID_PATH`/`INVALID_RANGE`/`INVALID_ARGUMENT` 都被归为 `invalid_input`；`FILE_NOT_FOUND`/`NOT_FOUND`/`START_LINE_OUT_OF_RANGE`……里 `*_NOT_FOUND` 归为 `not_found`；`WRITE_FAILED`/`MKDIR_FAILED`/`MOVE_FAILED` 归为 `execution_failed`。**这些前后缀不是给人看的"好看"，而是给 `inferToolErrorKind` 这台机器读的"暗号"。**

**如果不遵守这个命名约定会怎样？** 假设某个工具的错误码起名叫 `PathIsBad`——它既不 `INVALID_` 开头、也不 `_FAILED` 结尾，于是被 `inferToolErrorKind` 归为 `unknown`。归为 `unknown` 就意味着**下游（UI、可能的重试策略、模型的错误理解）失去了"这是一类输入错误"的信息**，只能当"未知错误"处理。**所以命名约定本质是一份"隐式的协议"**：生产端（本节工具）和消费端（第 8 节分类器）通过"前后缀"这个约定通信，谁破坏命名，谁就悄悄退化成 `unknown`。这也提醒我们：**加新工具、起新错误码时，务必让它的前后缀落在已有的分类规则里**（这也是 [code-convention](../code-convention.md) 该约束的东西）。

### Q5：`str_replace` 里"先数一遍出现次数、再执行替换"是不是多余？直接 replace 不行吗？


如果**直接 replace**（`text.split(old).join(new)`）而不先数：当 `old` 在文件里**一次都不出现**时，`split` 会返回 `[整个文件]`、`join` 拼回原文——**结果和原文一模一样，替换悄无声息地"什么都没干"**。工具会返回"成功"，但模型**根本不知道它的 `old` 抄错了**、以为改成功了，继续往下走——这是很隐蔽的 bug 温床。

**先数一遍，就能区分三种情况并给出不同信号**：

- `replacements === 0`（一次没找到）→ 返回 `NOT_FOUND` **错误**，明确告诉模型"你要替换的东西不在文件里"；
- 替换后 `updated === text`（找到了但替换前后一样，比如 `old===new`）→ 返回 `changed: false` 的**成功但无变化**；
- 正常替换 → 返回 `changed: true` 和 `replacements` 计数。

**这三档反馈，正是"防错"设计的精髓**——不是等出了问题再补救，而是**在结果里如实告诉模型"到底发生了什么"**，让模型能基于准确信号决定下一步（对应第 11 节 `<tool_usage>`："用 summary 和 error code 决定下一步、别拿同样的烂输入死磕"）。多花一次 `indexOf` 循环的成本，换来的是"绝不悄悄失败"——这个取舍在"给模型用的工具"里尤其值得。

### Q6：既然抽了 `isWithinDirectory` 防路径穿越，为什么工具里不用它？现在安全吗？

**这是本节最该讲清的"设计意图 vs 当前实现"的落差。**

事实链条（我全仓搜索确认过）：`isWithinDirectory` 被定义、被导出，但**在 `src` 的任何工具里都没有调用点**。也就是说，本节的 `write_file`/`str_replace`（以及第 13 节的 `bash` 等）**并没有在工具内部把操作限制在 `cwd` 之内**——`write_file` 只要路径是绝对路径，理论上给它 `/etc/hosts` 它就会尝试写。

**那现在的安全靠什么？** 靠 [第 15 节](./00-roadmap.md) 的**审批中间件**。回忆第 11 节：`write_file`/`str_replace`/`bash`/`apply_patch`/`mkdir`/`move_path` 都在 `CODING_TOOLS_REQUIRING_APPROVAL` 里——它们执行前会被 `beforeToolUse` 拦下、弹给人类确认。**所以"防止乱写系统文件"这道防线，当前是"人类审批"而非"工具内路径边界检查"。**

**`isWithinDirectory` 是什么状态？** 是一块**"已浇好、待接入"的地基**。作者预备了这个函数（连防穿越的 `../` 判断都写好了），显然是**打算**将来在工具里加一道"必须在工作目录内"的硬约束（比如作为 headless 模式下没有人审批时的兜底），但当前版本还没接上。

**这对读者的启示有两点**：其一，**别把"函数存在"等同于"功能启用"**——读源码要追到"谁调用了它"，否则会高估系统的能力。其二，这是真实项目**渐进演进**的正常痕迹：地基常常先于使用者落地。我在正文 1.2 明确标注了它"未接入"，就是不想让你误以为本节的写工具有沙箱保护。**诚实地区分"设计意图"（roadmap 说的三件套）和"当前实现"（isWithinDirectory 尚未启用），比囫囵背下"有三件套"更有价值。**

---

## 5. 参考资料

**本节精讲的源码（两块地基 + 三个文件工具）**：

- 地基一 · 路径与截断：[tool-utils.ts](../../src/coding/tools/tool-utils.ts)（`ensureAbsolutePath` [L4-L9](../../src/coding/tools/tool-utils.ts#L4-L9)、`ensureDirectoryPath` [L11-L30](../../src/coding/tools/tool-utils.ts#L11-L30)、`isWithinDirectory` [L32-L35](../../src/coding/tools/tool-utils.ts#L32-L35)、`truncateText` [L37-L45](../../src/coding/tools/tool-utils.ts#L37-L45)）
- 地基二 · 结果封装：[tool-result.ts](../../src/coding/tools/tool-result.ts)（`okToolResult` [L5-L7](../../src/coding/tools/tool-result.ts#L5-L7)、`errorToolResult` [L9-L16](../../src/coding/tools/tool-result.ts#L9-L16)）
- 读：[read-file.ts](../../src/coding/tools/read-file.ts)（四道关卡 [L22-L52](../../src/coding/tools/read-file.ts#L22-L52)、行号/截断 [L54-L56](../../src/coding/tools/read-file.ts#L54-L56)、原文特例 [L57-L62](../../src/coding/tools/read-file.ts#L57-L62)）
- 写：[write-file.ts](../../src/coding/tools/write-file.ts)（自动建父目录 [L28-L32](../../src/coding/tools/write-file.ts#L28-L32)、try/catch 兜底 [L40-L43](../../src/coding/tools/write-file.ts#L40-L43)）
- 替换：[str-replace.ts](../../src/coding/tools/str-replace.ts)（计数 [L51-L63](../../src/coding/tools/str-replace.ts#L51-L63)、执行 [L65-L75](../../src/coding/tools/str-replace.ts#L65-L75)、空转与写盘 [L77-L95](../../src/coding/tools/str-replace.ts#L77-L95)）

**co-located 测试（第 21 节会讲这套约定）**：

- [tool-utils.test.ts](../../src/coding/tools/__tests__/tool-utils.test.ts)（含 `okToolResult`/`errorToolResult`/`truncateText` 的形状断言）
- [read-file.test.ts](../../src/coding/tools/__tests__/read-file.test.ts)（原文读 vs 范围读 vs 结构化错误）
- [write-file.test.ts](../../src/coding/tools/__tests__/write-file.test.ts)（覆盖写、深层建目录、相对路径报错）
- [str-replace.test.ts](../../src/coding/tools/__tests__/str-replace.test.ts)（全替/限量/count=0/未找到/空 old/相对路径六种情形）

**上游依赖章节**：

- [第 4 节 · Tool 工具系统](./04-tool.md)：`defineTool` 与 `StructuredToolResult` 契约（本节的 `okToolResult`/`errorToolResult` 是它的落地）
- [第 8 节 · 工具结果处理管线](./08-tool-result-pipeline.md)：`normalizeToolResult`、`inferToolErrorKind`、`formatToolResultForMessage`（本节工具是它的上游生产者，`read_file` 特判是它俩的配对点）
- [第 11 节 · Lead Agent](./11-lead-agent.md)：这些工具被装配进 `tools` 数组、`<tool_usage>` 对它们的行为约束、`CODING_TOOLS_REQUIRING_APPROVAL` 名单

**关联源码（本节引用但不精讲）**：

- 契约源头：[structured-tool-result.ts](../../src/foundation/tools/structured-tool-result.ts)
- 截断策略：[tool-result-policy.ts](../../src/agent/tool-result-policy.ts)、结果格式化：[tool-result-runtime.ts](../../src/agent/tool-result-runtime.ts)
- 复用 `ensureDirectoryPath` 的第 13 节工具：[list-files.ts](../../src/coding/tools/list-files.ts#L44)、[glob-search.ts](../../src/coding/tools/glob-search.ts#L24)、[grep-search.ts](../../src/coding/tools/grep-search.ts#L26)
- 工具编写规范：[code-convention.md](../code-convention.md)（`description` 第一参数、错误码约定、`ensureAbsolutePath` 强制用等）

**外部资料**：

- Bun 文件 I/O（`Bun.file` / `file.text()` / `file.write()`）：[https://bun.sh/docs/api/file-io](https://bun.sh/docs/api/file-io)
- Node.js `path` 模块（`relative`/`resolve`/`parse`/`sep`，本节 `isWithinDirectory`/`write_file` 用到）：[https://nodejs.org/api/path.html](https://nodejs.org/api/path.html)
- Zod schema 校验（`z.number().int().positive()` 等链式约束）：[https://zod.dev/](https://zod.dev/)
- 路径穿越攻击（Path Traversal）与防御（`isWithinDirectory` 的设计动机）：[https://owasp.org/www-community/attacks/Path_Traversal](https://owasp.org/www-community/attacks/Path_Traversal)

---

## 6. 小结与下一节预告

本节我们从"地面"往上，拆开了 Helixent 所有 coding 工具**共享的两块地基**和**最基础的三个文件工具**：

- **两块地基**：[tool-utils.ts](../../src/coding/tools/tool-utils.ts) 管"路径对不对、文本长不长"（`ensureAbsolutePath`/`ensureDirectoryPath`/`isWithinDirectory`/`truncateText`），[tool-result.ts](../../src/coding/tools/tool-result.ts) 管"结果长什么形状"（`okToolResult`/`errorToolResult`）。62 行代码，换来的是**全项目的一致性**——同一个错误长同一个样、同一个结果是同一个形状（1.1~1.3）。
- **三个文件工具**：`read_file`（四道关卡防错 + 行号范围读取 + 成功吐原文的刻意破例）、`write_file`（整体覆盖 + 自动建父目录 + try/catch 兜底）、`str_replace`（计数—校验—写入三段式 + 空转不写盘 + 软约束"old 唯一"）（1.4~1.6）。
- **一个贯穿约定**：每个工具的第一个参数永远是 `description`——诱导模型"先想后做"、让每一步可读可审计（1.7）。
- **两处诚实标注**：`isWithinDirectory` 已备好但**尚未接入**（沙箱靠第 15 节审批）、`str_replace` 的"唯一匹配"是**软约束**而非硬校验（硬校验在第 14 节）——读源码要区分"设计意图"和"当前实现"（Q6、1.6）。

至此，最基础的"读、整写、局部替换"已经就位。回头看它们，都有一个共同气质：**站在地基上、层层前置校验、失败给结构化错误码、成功给人话摘要**——这套"防错又好用"的模式，会在接下来的每一个工具里反复出现。

**承上启下（启下）**：但你一定发现了，本节的工具都在"**操作一个已知路径的文件**"——前提是模型**已经知道**该读/写哪个文件。可现实里，Agent 刚进入一个陌生项目时，**它对文件系统一无所知**：有哪些目录？某个函数定义在哪个文件？符合 `*.test.ts` 的文件有几个？**它需要一批"探索环境"的工具**——列目录、按通配符找文件、按内容搜索、看文件元信息、以及那把"什么都能干"的万能钥匙 `bash`。

而这些探索工具，正是本节地基函数的**最大用户**——`list_files`/`glob_search`/`grep_search` 都要调 `ensureDirectoryPath`、都要用 `truncateText` 做上下文节流，`bash` 还要呼应 [第 5 节](./05-react-loop.md) 的 `AbortController` 实现"可中断"。**先有地基（本节），才有站在地基上的探索工具（下节）**——这就是 [第 13 节](./00-roadmap.md) 的主题。

> 预告一个细节：你会在第 13 节看到，搜索类工具（`list_files`/`glob_search`/`grep_search`）在 [第 8 节](./08-tool-result-pipeline.md) 的 policy 里被设成 `preferSummaryOnly: true`——**它们"只回摘要、不回数据"**。为什么探索工具要这么"抠门"？因为搜索结果动辄成百上千行，全塞给模型会瞬间撑爆上下文——这正是本节 `truncateText` 那套"上下文节流"哲学的延续与升级。

👉 下一节 **第 13 节：搜索与系统工具 —— bash / glob / grep / list_files / file_info / mkdir / move_path**。

准备好后，对我说「**生成第 13 节**」即可。
