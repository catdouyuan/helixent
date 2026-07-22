# 第 8 节：工具结果处理管线 —— normalize / policy / summary

> 本节属于 **第三部分 · Agent 层（可复用的通用大脑）**，是 [第 7 节](./07-middleware.md) 分岔出的**三个并列插件**中的第一个。第 7 节我们把「插座」（中间件系统）本身看透了，并预告了插在这个插座上的三个具体插件——结果处理、Skills、Todos。按 roadmap 的安排，我们**先从最基础、被所有工具依赖的「结果处理」讲起**。
>
> 对应 roadmap 为本节设定的**核心问题**：
>
> > 第 6 节工具返回的五花八门的结果，如何统一成喂给模型的字符串？如何防止上下文被撑爆？
>
> **一句边界声明**：本节精讲**三个文件**——归一化与格式化的 [tool-result-runtime.ts](../../src/agent/tool-result-runtime.ts)（187 行）、按工具分级的截断策略 [tool-result-policy.ts](../../src/agent/tool-result-policy.ts)（45 行）、给 UI 用的轻量摘要器 [tool-result-summary.ts](../../src/agent/tool-result-summary.ts)（28 行）。这三个文件加起来不到 260 行，却是「让 Agent 循环在真实世界里不崩」的关键一环。至于结果**从哪来**（工具的 `invoke` 返回值）是 [第 4 节](./04-tool.md) 和 [第 12～14 节](./00-roadmap.md) 的主题，结果**到哪去后怎么渲染**（TUI 消费 `summarizeToolResultText`）是 [第 20 节](./00-roadmap.md) 的主题，本节只负责中间那段「归一化 → 按策略截断 → 序列化」的**管线**本身。

***

## 0. 承上启下

[第 6 节](./06-parallel-tools.md) 结尾，我们把 `_act` 的并发调度逐行看透了，但在「收割」阶段撞见一个**一直被当黑盒**的函数。回看那段收割循环（[agent.ts](../../src/agent/agent.ts#L259-L270)）：

```ts
const toolMessage: ToolMessage = {
  role: "tool",
  content: [
    {
      type: "tool_result",
      tool_use_id: resolved.toolUseId,
      content: formatToolResultForMessage({ toolName: resolved.toolName, result: resolved.result }),
      //        ^^^^^^^^^^^^^^^^^^^^^^^^^^ 第 6 节反复出现、却始终没拆的黑盒
    },
  ],
};
```

第 6 节我们特意跳过了它，只说了一句「它把五花八门的结果统一成字符串，第 8 节再讲」。现在到了拆黑盒的时候。而且第 6 节还给它留了一个**必须兑现的承诺**——当时讲「容错哲学」时我们说：每个工具的错误会被就地 `catch` 压成一段 `` `Error: ${message}` `` 文本当作正常结果返回（[agent.ts](../../src/agent/agent.ts#L235-L237)），并且强调「这段 `Error:` 前缀的文本，会和第 8 节的解析约定**对暗号**」。本节就要揭晓这个暗号是怎么对上的。

先把问题的**真实尺度**摆出来，你才会明白为什么需要一整条管线，而不是一句 `String(result)`：

`_act` 收割到的那个 `resolved.result`，它的类型是 `unknown`——因为它可能是下面**任意一种**东西：

1. **结构化成功对象**：`read_file` 之外的绝大多数工具返回 `{ ok: true, summary: "...", data: {...} }`（第 4 节定义的 `StructuredToolResult`，由第 12 节的 `okToolResult` 生产）。
2. **结构化错误对象**：`{ ok: false, summary, error, code }`，比如 `grep_search` 找不到 `rg` 时返回 `code: "RG_NOT_FOUND"`。
3. **裸字符串 `Error: xxx`**：两种来源——① 第 6 节 `_act` 的 `catch` 把抛出的异常压成的文本；② `bash` 命令失败时**主动**返回的 `` `Error: Command ... failed` ``（[bash.ts](../../src/coding/tools/bash.ts#L30-L33)）。
4. **裸字符串（正常）**：`bash` 成功时直接返回 stdout（[bash.ts](../../src/coding/tools/bash.ts#L34)）；`read_file` 成功时直接返回带行号的文件正文（[read-file.ts](../../src/coding/tools/read-file.ts#L59-L62)）——**它们压根不走结构化契约**。
5. **任意裸值**：理论上工具可以返回数字、对象、`null`、`undefined`……`unknown` 意味着「什么都可能」。

这五类东西，最终都要变成 `ToolResultContent.content` 那个**字符串**字段（第 2 节定义，[content.ts](../../src/foundation/messages/types/content.ts#L59-L65)），喂回给模型。于是两个尖锐的问题浮现，正是 roadmap 为本节设定的核心问题：

> **① 归一化**：这五类形态各异的东西，怎么统一成一个「模型读得懂、格式稳定」的字符串？尤其是那个 `Error:` 裸字符串，怎么和结构化错误「殊途同归」？
>
> **② 防撑爆**：一个 `bash("find / -type f")` 可能吐出**几十万行**、一个 `read_file` 可能读进一整个大文件——如果原样塞进 `content`，模型的上下文窗口瞬间被撑爆，轻则烧钱、重则直接超限报错。怎么按工具的不同性质，做**分级**的截断？

第 7 节的中间件是「往循环里**插**行为」；本节的管线则是「把循环**产出的数据**收拾干净」。它不走 `beforeToolUse` 那条中间件路径，而是在 `_act` 收割结果时被**直接调用**——但它同样是「让 Agent 稳健运转」不可或缺的一环。打开这三个文件，我们开始。

***

## 1. 主题内容

### 1.1 先想清楚问题：如果让你来写 `formatToolResultForMessage`，会踩哪些坑？

老规矩，看代码前先自己当一次设计者。你的任务：写一个函数，输入 `(toolName, result: unknown)`，输出一个要喂给模型的字符串。

**最朴素的第一版**：

```ts
function formatToolResultForMessage({ result }): string {
  return typeof result === "string" ? result : JSON.stringify(result);
}
```

跑起来你会**立刻**踩四个坑：

1. **结构化对象的 `data` 太大**。`read_file` 读一个 5000 行的文件，`JSON.stringify` 出来几万字符，直接喂给模型——上下文爆了。而且很多工具（`list_files`、`glob_search`）的 `data` 对模型其实**没用**：模型只需要知道「找到了 12 个文件」这个 `summary`，那一大坨文件路径数组塞给它纯属浪费 token。
2. **`Error:` 裸字符串和结构化错误「长得不一样」**。第 6 节 catch 出来的是 `"Error: xxx"` 纯文本，而 `grep_search` 返回的是 `{ ok: false, error: "...", code: "RG_NOT_FOUND" }` 对象。如果不做归一化，模型这一轮看到纯文本、下一轮看到 JSON，**同样是「失败」却有两种面孔**，它很难稳定地学会「哦这是个错误」。
3. **`JSON.stringify` 可能抛异常**。如果 `result` 里有循环引用，`JSON.stringify` 直接 throw——而这个函数是在 `_act` 收割阶段调的，它一 throw，整条 `ToolMessage` 组装失败，主循环崩溃。**一个「格式化结果」的辅助函数，绝不该有能力搞崩主循环。**
4. **截断后可能产出「坏 JSON」**。假设你想到了要截断，写成 `JSON.stringify(obj).slice(0, 4000)`——这会把一个合法 JSON 从中间**切断**，变成 `{"ok":true,"data":"xxxx`（缺了结尾的引号和括号）。模型拿到一段**语法非法**的 JSON，比拿到一段被明确标注「[truncated]」的合法 JSON 糟糕得多。

这四个坑，恰好对应本节三个文件要解决的问题：

- 坑 1（该不该带 data、截到多长）→ **policy**（[tool-result-policy.ts](../../src/agent/tool-result-policy.ts)）：按工具名给出分级策略。
- 坑 2（多种形态归一）→ **normalize**（[tool-result-runtime.ts](../../src/agent/tool-result-runtime.ts#L58-L98) 的 `normalizeToolResult`）。
- 坑 3、坑 4（安全序列化、截断不产出坏 JSON）→ **format**（[tool-result-runtime.ts](../../src/agent/tool-result-runtime.ts#L100-L143) 的 `formatToolResultForMessage` + `stringifyWithinLimit`）。

我们按「数据流的顺序」来讲：先 normalize（把万物归一），再 policy（决定怎么裁），最后 format（安全落地成字符串）。第四个文件 summary 是一条**给 UI 的旁路**，最后单独讲。

### 1.2 normalize：把「五类形态」归一成一个可辨识联合（[tool-result-runtime.ts](../../src/agent/tool-result-runtime.ts#L58-L98)）

先看这条管线的**第一道工序**。`normalizeToolResult` 的职责：吃进一个 `unknown`，吐出一个**规整的** `NormalizedToolResult`。先看它的输出类型（[tool-result-runtime.ts](../../src/agent/tool-result-runtime.ts#L13-L22)）：

```ts
export type NormalizedToolSuccess = StructuredToolSuccess & {
  raw: unknown;   // ← 额外挂一个「原始值」
};

export type NormalizedToolError = StructuredToolError & {
  errorKind: ToolErrorKind;   // ← 额外挂一个「错误类别」
  raw: unknown;
};

export type NormalizedToolResult = NormalizedToolSuccess | NormalizedToolError;
```

注意它**复用了第 4 节的 `StructuredToolSuccess` / `StructuredToolError`**（[structured-tool-result.ts](../../src/foundation/tools/structured-tool-result.ts)），只是各自**多挂了两样东西**：`raw`（永远保留原始值，方便下游万一还想看原貌）和——仅错误分支才有的——`errorKind`（一个把杂乱错误码归纳成的「大类」，1.3 专讲）。这是一个漂亮的「**扩展而非替换**」：归一化的结果**依然是**第 4 节那个契约的形状，只是更饱满。

再看函数体，它是一串 `if` 瀑布，**按优先级**逐一匹配那五类形态（[tool-result-runtime.ts](../../src/agent/tool-result-runtime.ts#L58-L98)）：

```ts
export function normalizeToolResult(result: unknown): NormalizedToolResult {
  if (isStructuredToolSuccess(result)) {          // ① 已经是结构化成功
    return { ok: true, summary: result.summary,
             ...(result.data !== undefined ? { data: result.data } : {}), raw: result };
  }
  if (isStructuredToolError(result)) {            // ② 已经是结构化错误
    return { ok: false, summary: result.summary, error: result.error,
             ...(result.code ? { code: result.code } : {}),
             ...(result.details ? { details: result.details } : {}),
             errorKind: inferToolErrorKind(result.code), raw: result };
  }
  if (typeof result === "string" && result.startsWith("Error:")) {   // ③ 裸 Error: 字符串
    const error = result.slice("Error:".length).trim() || "Tool execution failed.";
    return { ok: false, summary: error, error, errorKind: "unknown", raw: result };
  }
  const summary = stringifyValue(result);         // ④⑤ 其余一切：当成功的裸值
  return { ok: true, summary,
           ...(result !== undefined ? { data: result } : {}), raw: result };
}
```

**这就是 roadmap 说的「把结构化对象 / `Error:` 字符串 / 裸值归一化」。** 逐条看这四个分支的匠心：

**分支 ①②：用「运行时类型守卫」认出结构化对象。** 注意它不是 `if (result.ok === true)`——因为 `result` 是 `unknown`，直接点 `.ok` TS 不让过，运行时也可能 `result` 是 `null` 而炸。它用了两个**手写的类型守卫**（[tool-result-runtime.ts](../../src/agent/tool-result-runtime.ts#L34-L56)）：

```ts
function isStructuredToolSuccess(value: unknown): value is StructuredToolSuccess {
  return (
    typeof value === "object" && value !== null &&
    "ok" in value && value.ok === true &&
    "summary" in value && typeof value.summary === "string"
  );
}
```

**它检查的不只是 `ok`，还要求 `summary` 存在且是字符串**——因为一个「结构化结果」的最低契约就是「有 `ok` 布尔 + 有 `summary` 字符串」。这种「逐字段验形」的守卫，是处理 `unknown` 外部数据的正确姿势：**不轻信形状，逐个字段确认**。错误守卫（`isStructuredToolError`）更严一层，还要求 `error` 也是字符串——因为错误契约多一个必填的 `error` 字段。

**分支 ③：`Error:` 前缀识别——第 6 节承诺的「对暗号」现场。** 这就是第 6 节反复预告的那句话的兑现。当 `result` 是个字符串、且以 `"Error:"` 开头，它被判定为**错误**，剥掉前缀、取出真正的错误消息。

> 这里有个**极其重要、极易被忽略**的顺序细节：分支 ③ 排在分支 ①② **之后**。为什么？因为万一有个结构化对象，它的 `summary` 恰好是 `"Error: ..."` 开头呢？由于 ①② 先匹配，它会被正确地当成结构化结果处理，**不会**被 ③ 误伤。顺序即优先级——**先认「结构化」，认不出来才退化到「靠字符串前缀猜」**。这个「猜」是给那些不遵守结构化契约的老式工具（`bash`）兜底的，属于**兼容层**，所以放最后。

**分支 ④⑤：万物皆可「成功裸值」。** 走到这里，说明 `result` 既不是结构化对象、也不是 `Error:` 字符串——那就当它是「一个成功的裸值」：把它 `stringifyValue` 成 `summary`，同时原样塞进 `data`。这里的兜底函数 `stringifyValue`（[tool-result-runtime.ts](../../src/agent/tool-result-runtime.ts#L145-L157)）是坑 3（`JSON.stringify` 会抛）的**第一道防线**：

```ts
function stringifyValue(value: unknown) {
  if (value === undefined) return "undefined";
  if (value === null) return "null";
  if (typeof value === "string") return value;
  if (typeof value === "object") {
    try { return JSON.stringify(value); }
    catch { return "[unserializable object]"; }   // ← 循环引用等，绝不 throw
  }
  return String(value);
}
```

它把 `undefined`/`null` 显式处理（否则 `String(undefined)` 虽也行，但显式更清晰），字符串直接返回，对象用 `try/catch` 包住 `JSON.stringify`——**循环引用也只会得到 `"[unserializable object]"`，绝不抛异常**。这是「格式化函数不许搞崩主循环」原则的第一处落地。

**归一化的产物长什么样？** 无论进来的是哪一类，出来的都是一个 `{ ok: boolean, summary: string, ... }` 的规整对象。**万物归一。** 从此下游只需面对「成功 or 失败」两种形状，不用再关心「原始到底是对象还是字符串」。

### 1.3 妙笔：`inferToolErrorKind` —— 从错误码的「前后缀」推断错误大类（[tool-result-runtime.ts](../../src/agent/tool-result-runtime.ts#L24-L32)）

归一化错误分支里调了一个 `inferToolErrorKind(result.code)`，这是 roadmap 特意点名的**妙笔**，值得单独拆。先看它（[tool-result-runtime.ts](../../src/agent/tool-result-runtime.ts#L24-L32)）：

```ts
export function inferToolErrorKind(code?: string): ToolErrorKind {
  if (!code) return "unknown";
  if (code.startsWith("INVALID_")) return "invalid_input";
  if (code.endsWith("_NOT_SUPPORTED")) return "unsupported";
  if (code === "RG_NOT_FOUND") return "environment_missing";
  if (code === "FILE_NOT_FOUND" || code.endsWith("_NOT_FOUND")) return "not_found";
  if (code.endsWith("_FAILED")) return "execution_failed";
  return "unknown";
}
```

它把散落在各个工具里的、**几十种**具体错误码（`INVALID_PATH`、`INVALID_RANGE`、`DELETE_NOT_SUPPORTED`、`FILE_NOT_FOUND`、`START_LINE_OUT_OF_RANGE`、`PATCH_APPLY_FAILED`、`RG_NOT_FOUND`……）归纳成**6 个大类**（[tool-result-runtime.ts](../../src/agent/tool-result-runtime.ts#L5-L11)）：

```ts
export type ToolErrorKind =
  | "invalid_input"       // 参数错了（用户/模型可以改）
  | "unsupported"         // 不支持的操作（换个思路）
  | "not_found"           // 找不到目标（路径/文件不存在）
  | "environment_missing" // 环境缺失（比如没装 rg）
  | "execution_failed"    // 执行到一半失败了
  | "unknown";            // 没归到类的
```

**它的精髓：不靠「穷举一张巨大的映射表」，而靠「错误码的命名规约」来推断。** 各个工具在起错误码名字时，遵守了一套**隐式的命名约定**：「参数非法」类都以 `INVALID_` **开头**、「不支持」类都以 `_NOT_SUPPORTED` **结尾**、「找不到」类都以 `_NOT_FOUND` 结尾、「执行失败」类都以 `_FAILED` 结尾。于是这个函数只需匹配**前缀/后缀**，就能把无穷多个具体错误码归到有限的几类里——**新增一个叫 `INVALID_ENCODING` 的错误码？不用改这个函数，它天然被 `startsWith("INVALID_")` 接住，自动归入 `invalid_input`。**

这是一个「**约定优于配置（Convention over Configuration）**」的漂亮示范：与其维护一张「错误码 → 类别」的巨表（每加一个码就得改表，还容易漏），不如**让错误码的名字自己携带分类信息**，用前后缀模式一网打尽。

> **两个值得玩味的细节**：
> - `RG_NOT_FOUND` 被**单独**用 `===` 精确匹配成 `environment_missing`，而**没有**让它落进后面的 `_NOT_FOUND`（那会错归成 `not_found`）。这是因为 `RG_NOT_FOUND` 的语义是「**ripgrep 这个程序没装**」（环境缺失），而不是「**要找的文件不存在**」（not_found）——名字撞了 `_NOT_FOUND` 后缀，但语义完全不同。**所以精确匹配必须排在后缀匹配之前**——顺序又一次成了正确性的关键。`FILE_NOT_FOUND` 也被显式 `===` 列出（虽然它其实也满足 `endsWith("_NOT_FOUND")`），是为了**可读性**：把最常见的那个错误码摆在明面上。
> - `errorKind` 目前**只在归一化结果里挂着**，`formatToolResultForMessage` 并没有把它拼进给模型的字符串（1.5 会看到，喂给模型的只有 `summary`/`error`/`code`）。那它有什么用？它是一个**面向未来的分类维度**——留给「按错误类别做重试策略」（比如 `environment_missing` 不该重试，`execution_failed` 可以重试一次）、「按类别统计打点」、「UI 按类别显示不同图标」等场景。**先把分类能力做进数据模型，具体消费留给未来**——这是一种有远见的「留钩子」。

### 1.4 policy：按工具名分级的「截断策略表」（[tool-result-policy.ts](../../src/agent/tool-result-policy.ts)）

归一化解决了「形态统一」，但没解决「防撑爆」。第二道工序 `policy` 登场，它回答两个问题：**这个工具的结果，① 要不要带 `data`？② 最长能有多少字符？** 整个文件就是一张 `switch` 表（[tool-result-policy.ts](../../src/agent/tool-result-policy.ts#L14-L45)）：

```ts
export function getToolResultPolicy(toolName: string): ToolResultPolicy {
  switch (toolName) {
    case "list_files":
    case "glob_search":
    case "grep_search":
    case "file_info":
    case "mkdir":
    case "move_path":
      return { preferSummaryOnly: true, includeData: false, maxStringLength: 1000, uiSummaryOnly: true };
    case "read_file":
      return { preferSummaryOnly: false, includeData: true, maxStringLength: 12000 };
    case "apply_patch":
    case "write_file":
    case "str_replace":
      return { preferSummaryOnly: false, includeData: true, maxStringLength: 4000 };
    default:
      return DEFAULT_POLICY;   // { preferSummaryOnly: false, includeData: true, maxStringLength: 4000 }
  }
}
```

`ToolResultPolicy` 的四个字段（[tool-result-policy.ts](../../src/agent/tool-result-policy.ts#L1-L6)）含义：

| 字段 | 含义 | 谁在读它 |
| --- | --- | --- |
| `preferSummaryOnly` | 只回 `summary`、**丢掉 `data`** | `formatToolResultForMessage`（喂模型） |
| `includeData` | 是否允许带 `data` | `formatToolResultForMessage`（喂模型） |
| `maxStringLength` | 序列化后的字符上限 | `stringifyWithinLimit`（截断） |
| `uiSummaryOnly` | **给 UI 用**：终端里也只显示摘要 | 第 20 节的 TUI 渲染器 |

把这张表**按「工具的性质」分组**来读，设计意图就浮现了——**这是按「结果对模型的价值密度」分级**：

**第一组（`preferSummaryOnly: true`，上限 1000）：探索类工具。** `list_files`/`glob_search`/`grep_search`/`file_info`/`mkdir`/`move_path` 这些工具，它们的 `data`（一大坨文件路径、匹配行）对模型的**决策价值极低**——模型通常只需要知道「找到了/没找到、大概几个」这个 `summary`，就能决定下一步。真要看具体内容，它会再调 `read_file`。所以这组**直接丢掉 data、上限压到 1000**——这正呼应了 roadmap 第 13 节预告的「搜索类工具『只回摘要不回数据』的上下文节流」。**这组是「防撑爆」的主力**：一个 `grep` 匹配上万行，压到 1000 字符的摘要，省下的是海量 token。

**第二组（`includeData: true`，上限 12000）：`read_file` 独一档。** 读文件的**全部价值就在 `data`（文件内容）里**，丢了 data 等于没读。所以它必须带 data，且上限给到**最高的 12000**——这个数字**不是拍脑袋**的，它和 `read-file.ts` 里的 `DEFAULT_MAX_CHARS = 12000`（[read-file.ts](../../src/coding/tools/read-file.ts#L8)）**完全一致**。也就是说，工具**自己**在读的时候已经按 12000 截过一次，policy 这里的 12000 是**同一条红线的呼应**，保证「工具截到多长、管线就放行多长」，不会二次误伤。（不过 `read_file` 有个更特殊的待遇，见 1.5 开头。）

**第三组（`includeData: true`，上限 4000）：写入类工具。** `apply_patch`/`write_file`/`str_replace` 的 `data`（比如 diff、写入字节数）对模型有中等价值——它需要确认「改动是否符合预期」，但不需要完整文件。上限给中等的 4000。

**第四组（`DEFAULT_POLICY`，上限 4000）：其余一切（含 `bash`）。** 注意 `bash` **没有**在 switch 里列出，它走 `default`。这是个有意思的选择：`bash` 的输出千变万化（可能是 stdout、可能是 `Error:`），给它一个中庸的默认策略（带 data、4000 上限）最稳妥。

> **一个「近处的关联」**：`maxStringLength` 的默认值 `DEFAULT_POLICY` 定成 4000（[tool-result-policy.ts](../../src/agent/tool-result-policy.ts#L8-L12)），和第三组写入类工具一致。这不是巧合——**4000 是这个项目对「一条工具结果喂给模型」的『默认合理上限』的判断**。探索类往下压（1000），读文件往上放（12000），其余都锚在 4000。

### 1.5 format：把 normalize + policy 拼起来，安全落地成字符串（[tool-result-runtime.ts](../../src/agent/tool-result-runtime.ts#L100-L143)）

现在看**管线的总装配**——`formatToolResultForMessage`，也就是第 6 节那个黑盒的真面目。它把 1.2 的 normalize 和 1.4 的 policy 串起来，产出最终字符串（[tool-result-runtime.ts](../../src/agent/tool-result-runtime.ts#L100-L143)）：

```ts
export function formatToolResultForMessage({ toolName, result }): string {
  if (toolName === "read_file" && typeof result === "string") {   // ★ 特事特办：read_file 走直通车
    return result;
  }

  const normalized = normalizeToolResult(result);        // ← 工序一：归一化
  const policy = getToolResultPolicy(toolName);          // ← 工序二：查策略

  if (!normalized.ok) {                                   // 分支 A：错误
    return stringifyWithinLimit(
      { ok: false, summary: normalized.summary, error: normalized.error,
        ...(normalized.code ? { code: normalized.code } : {}),
        ...(normalized.details ? { details: normalized.details } : {}) },
      policy.maxStringLength,
      { ok: false, summary: truncateSummary(normalized.summary),   // ← 兜底版（更短）
        error: truncateSummary(normalized.error),
        ...(normalized.code ? { code: normalized.code } : {}) },
    );
  }

  if (policy.preferSummaryOnly || !policy.includeData) {  // 分支 B：只要摘要
    return JSON.stringify({ ok: true, summary: truncateSummary(normalized.summary) });
  }

  return stringifyWithinLimit(                            // 分支 C：带 data
    { ok: true, summary: normalized.summary,
      ...(normalized.data !== undefined ? { data: normalized.data } : {}) },
    policy.maxStringLength,
    { ok: true, summary: truncateSummary(normalized.summary) },   // ← 兜底版（丢掉 data）
  );
}
```

从上到下四个决策点：

**★ 开头的 `read_file` 直通车——一个「刻意破例」。** 第一件事就是特判：如果是 `read_file` 且结果是字符串，**原样返回，完全不进管线**。为什么？回看 1.1 提到的第 4 类：`read_file` 成功时返回的是**带行号的纯文件正文**（[read-file.ts](../../src/coding/tools/read-file.ts#L59-L62)），它**不是**结构化对象，也不该被 `JSON.stringify` 包一层（那会把文件内容变成一个 JSON 字符串值，加一堆转义反斜杠，既浪费 token 又难读）。而且工具**自己已经用 `truncateText(numbered, 12000)` 截过**了（[read-file.ts](../../src/coding/tools/read-file.ts#L56)），管线无需再管。**所以最有价值的「文件内容」享受一条零加工的直通车。** 这个破例，和第 6 节测试里那条 `"passes through raw read_file text results"` 对得上（[tool-result-runtime.test.ts](../../src/agent/__tests__/tool-result-runtime.test.ts#L100-L118)）——甚至连「文件内容本身以 `Error:` 开头」的刁钻情况都被这条直通车正确放行（否则会被 1.2 的分支 ③ 误判成错误！）。

**分支 A（错误）：稳定的错误形状。** 归一化后 `ok: false`，就拼一个 `{ ok: false, summary, error, code?, details? }` 喂给模型。**注意：无论错误原来是「结构化对象」还是「`Error:` 裸字符串」，走到这里都被拼成同一个 JSON 形状。** 这就 1.1 坑 2 的解法——**模型永远只看到一种「失败的样子」**，稳定可学。

**分支 B（只要摘要）：探索类的极致节流。** 若 policy 说 `preferSummaryOnly` 或 `!includeData`（就是 1.4 第一组那些探索工具），**直接扔掉 data，只回一个截短到 500 字符的 summary**。这一步是「防撑爆」最狠的一刀：一个 `grep` 的上万行 data，到这儿被砍成一句「找到 N 处匹配」。

**分支 C（带 data）：`read_file`（非字符串结果）和写入类走这里。** 拼上 data 一起序列化，但交给 `stringifyWithinLimit` 把关长度。

**贯穿分支 A/C 的主角：`stringifyWithinLimit` —— 「截断绝不产出坏 JSON」的守门人（坑 4 的解法）。** 这是整个 format 里最精巧的函数（[tool-result-runtime.ts](../../src/agent/tool-result-runtime.ts#L159-L180)）：

```ts
function stringifyWithinLimit(payload, maxLength, fallback): string {
  const serialized = JSON.stringify(payload);
  if (!maxLength || serialized.length <= maxLength) {
    return serialized;                    // ① 没超限：原样
  }
  const fallbackSerialized = JSON.stringify(fallback);
  if (!maxLength || fallbackSerialized.length <= maxLength) {
    return fallbackSerialized;            // ② 超限：换「兜底版」（更短，通常已丢 data）
  }
  // ③ 连兜底版都超限：对 summary/error 本身再做「按字符切」，但仍拼成合法 JSON
  if (fallback.ok) {
    return JSON.stringify({ ok: true, summary: fallback.summary.slice(0, Math.max(0, maxLength - 32)) });
  }
  return JSON.stringify({
    ok: false,
    summary: fallback.summary.slice(0, Math.max(0, maxLength - 64)),
    error: fallback.error.slice(0, Math.max(0, maxLength - 64)),
    ...(fallback.code ? { code: fallback.code } : {}),
  });
}
```

**它的核心思想：截断不是「切字符串」，而是「换一个更小的合法结构，再序列化」——三级降级，每一级的产物都是合法 JSON。**

- **第①级**：完整版没超限 → 直接用。
- **第②级**：完整版超了 → 换 `fallback`（调用方传进来的「兜底版」，通常是**丢掉 data、只留截短 summary** 的精简结构）再序列化。**关键：它是先构造一个小对象，再 `JSON.stringify`——所以产物必然是合法 JSON**，绝不会像 `slice` 那样切出半个 JSON。
- **第③级**：连兜底版都还超（比如 summary 本身就是个超长字符串）→ 这才动手 `slice`，但**只 slice `summary`/`error` 这两个纯字符串字段的值**，然后**重新用 `JSON.stringify` 包一遍**。所以哪怕内容被砍了，外层 JSON 结构依然完整合法。那个 `maxLength - 32` / `maxLength - 64` 是**给 JSON 的结构字符（`{"ok":true,"summary":"..."}` 那些括号引号）预留的余量**，保证 slice 完再包上外壳后总长仍不超限。

**这就是坑 4 的彻底解法**：从头到尾没有一次「切一个已经序列化好的 JSON 字符串」，全是「先构造更小的对象，再序列化」。测试 `"always returns valid json when payload exceeds limits"` 精确验证了这点——一个 10000 字符的 patch，最终产出的是 `{ ok: true, summary: "Applied patch" }`（data 被降级丢掉），且 `JSON.parse` 不抛（[tool-result-runtime.test.ts](../../src/agent/__tests__/tool-result-runtime.test.ts#L139-L154)）。

配套的 `truncateSummary`（[tool-result-runtime.ts](../../src/agent/tool-result-runtime.ts#L182-L187)）则是给 summary 单独用的「带尾注截断」——超过 500 字符就切，并**明确标注** `... [truncated N chars]`，让模型**知道**「这里被截了」，而不是以为原文就这么短：

```ts
function truncateSummary(value: string, maxLength = 500): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength)}... [truncated ${value.length - maxLength} chars]`;
}
```

**「让模型知道内容被截断」本身就是一种诚实**——被截断的信息如果不加标注，模型会误以为看到了全部，从而做出错误判断。

### 1.6 summary：一条「给 UI 的旁路」（[tool-result-summary.ts](../../src/agent/tool-result-summary.ts)）

前面 1.2～1.5 是**主管线**：结果 → 归一化 → 按策略截断 → 序列化成字符串 → 喂给**模型**。本节最后一个文件 `tool-result-summary.ts` 走的是**另一条路**：它把「已经序列化好、存在消息历史里的那个字符串」**反向解析**出一句人话，给**终端 UI** 显示。

先明确它和主管线的**方向相反**：

- 主管线（`formatToolResultForMessage`）：**对象 → 字符串**（写进 `ToolMessage.content`，给模型）。
- 这条旁路（`summarizeToolResultText`）：**字符串 → 一句人话**（从 `ToolMessage.content` 里反解，给 UI 显示）。

看它（[tool-result-summary.ts](../../src/agent/tool-result-summary.ts)）：

```ts
export function summarizeToolResultText(content: string): string | null {
  if (content.startsWith("Error:")) {
    return content;                         // ① Error: 裸文本 → 原样显示
  }
  try {
    const parsed = JSON.parse(content) as { ok?: boolean; summary?: unknown; error?: unknown; code?: unknown };
    if (parsed.ok === true && typeof parsed.summary === "string") {
      return parsed.summary;                // ② 成功 → 只显示 summary
    }
    if (parsed.ok === false) {              // ③ 失败 → 拼一句「Error [CODE]: msg」
      const message = typeof parsed.summary === "string" ? parsed.summary
                    : typeof parsed.error === "string" ? parsed.error : content;
      const code = typeof parsed.code === "string" ? parsed.code : null;
      return code ? `Error [${code}]: ${message}` : `Error: ${message}`;
    }
  } catch {
    return null;                            // ④ 不是 JSON → 返回 null（交给调用方兜底）
  }
  return null;
}
```

它的逻辑很直白：把主管线产出的那个 JSON 字符串**拆开，只挑对人类有意义的那句话**——成功挑 `summary`，失败拼成 `Error [CODE]: message`。三个设计点：

**① 返回 `string | null` 而不是「总返回个字符串」。** 当 `content` 不是它认识的格式（既非 `Error:` 前缀、又非合法 JSON、又非结构化对象），它**返回 `null`**，明确表示「我没法给出摘要，你自己看着办」。这把「兜底显示」的决定权交还给调用方（第 20 节的 TUI）——比如 TUI 可以在拿到 `null` 时选择「显示原文前 N 字」或「显示『(无摘要)』」。**返回 `null` 是一种诚实的「我不知道」，比硬编一个可能误导的默认值好。**

**② 失败时优先用 `summary`、退而用 `error`。** 看分支 ③：`message` 先取 `summary`（更适合人读的那句），没有再取 `error`（更原始），都没有才用 `content` 兜底。这个「优先级取值」保证 UI 上显示的永远是**最适合人读**的那个版本。测试 `"prefers summary over error for the message"` 精确锁定了这个偏好（[tool-result-summary.test.ts](../../src/agent/__tests__/tool-result-summary.test.ts#L37-L41)）。

**③ 为什么给模型和给 UI 是两套函数、两种「详略」？** 因为**受众不同，需求不同**：
- **模型**需要**结构化、可解析、够全**的信息——所以主管线给它一个带 `ok`/`error`/`code`/`data` 的 JSON，让它能精确判断成败、读取数据。
- **人**需要**一眼看懂、越短越好**的信息——所以这条旁路只给一句「找到 3 个文件」或「Error [RG_NOT_FOUND]: ...」，那些 `ok`、`data` 对着屏幕的人类是噪音。

这呼应了 1.4 policy 表里那个一直没解释的 `uiSummaryOnly` 字段：探索类工具设了 `uiSummaryOnly: true`，配合 `summarizeToolResultText`，让终端里这类工具**只闪过一句摘要**，不刷屏。**「喂给模型的」和「显示给人的」是两条独立管线**——这个分离，是第 20 节 TUI 渲染的重要伏笔。

### 1.7 全景：一条数据流串起三个文件

把本节三个文件放进第 6 节的收割循环里，完整数据流就清晰了：

```
工具 invoke 返回 result: unknown
   │  (结构化对象 / Error:字符串 / bash stdout / read_file正文 / 任意裸值)
   ▼
_act 收割 (第 6 节) ──► formatToolResultForMessage({ toolName, result })   ← 本节主入口
   │
   ├─ read_file 且是字符串? ──► 直通车，原样返回（零加工）
   │
   ├─ normalizeToolResult(result)        ← ①归一化：万物 → { ok, summary, ... }
   │     └─ 错误分支还会 inferToolErrorKind(code)  ← 妙笔：前后缀推断错误大类
   │
   ├─ getToolResultPolicy(toolName)      ← ②查策略：要不要 data、截多长
   │
   └─ stringifyWithinLimit(...)          ← ③安全序列化：三级降级，绝不产出坏 JSON
         │
         ▼
   一个「稳定、可解析、不超限」的字符串
         │
         ├────────────────────► 写进 ToolMessage.content，喂回【模型】（主路）
         │
         └─ summarizeToolResultText(content) ──► 一句人话，显示给【终端用户】（旁路，第 20 节）
```

**三个文件各司其职**：normalize 管「形态统一」、policy 管「分级裁剪」、format（含 `stringifyWithinLimit`）管「安全落地」，summary 管「给人看的旁路」。它们合起来回答了 roadmap 的核心问题：**五花八门的结果，先归一成统一形状，再按工具性质分级截断，最后安全序列化成一个既喂得了模型、又撑不爆上下文的字符串。**

***

## 2. 亮点与关键设计

1. **normalize 用「运行时类型守卫 + 有序 if 瀑布」把五类形态归一。**
   `isStructuredToolSuccess`/`isStructuredToolError` 逐字段验形（不轻信 `unknown` 的形状）；四个分支**按优先级排序**——先认结构化对象，认不出才退化到「靠 `Error:` 前缀猜」，最后一切兜底为「成功裸值」。**顺序即正确性**：结构化优先于字符串猜测，避免 `summary` 恰好以 `Error:` 开头的对象被误判。

2. **`inferToolErrorKind` 靠「命名规约」而非「巨型映射表」分类错误。**
   `INVALID_` 前缀、`_NOT_SUPPORTED`/`_NOT_FOUND`/`_FAILED` 后缀 → 6 个错误大类。新增错误码只要遵守命名约定就自动归类，无需改这个函数——「约定优于配置」的典范。`RG_NOT_FOUND` 用 `===` 精确匹配抢在 `_NOT_FOUND` 后缀之前，是「语义 > 字面」的细节。

3. **policy 把「结果对模型的价值密度」编码成一张分级表。**
   探索类（`list_files`/`grep` 等）`preferSummaryOnly + 上限1000`——只回摘要、丢 data，防撑爆主力；`read_file` `带data + 上限12000`（与工具自身的 `DEFAULT_MAX_CHARS` 对齐）；写入类与默认 4000。**按工具性质分级，而非一刀切。**

4. **`formatToolResultForMessage` 给 `read_file` 开「直通车」。**
   文件正文原样返回、完全不进管线——避免被 `JSON.stringify` 转义污染、避免以 `Error:` 开头的文件内容被误判为错误、且工具自己已截断过。最有价值的数据享受零加工。

5. **`stringifyWithinLimit` 用「三级降级 + 先构造小对象再序列化」保证截断永不产出坏 JSON。**
   从不 `slice` 一个已序列化的 JSON；而是「完整版 → 兜底版（丢 data） → slice 纯字符串字段后重新包壳」逐级降级，每级产物都合法。`maxLength - 32/64` 为 JSON 结构字符预留余量。配套 `truncateSummary` 用 `... [truncated N chars]` 明示截断，对模型诚实。

6. **`stringifyValue` 用 `try/catch` 包住 `JSON.stringify`，确保格式化函数永不抛异常。**
   循环引用只得到 `"[unserializable object]"`，绝不搞崩正在收割结果的主循环——「辅助函数不该有能力让核心崩溃」。

7. **给模型（`formatToolResultForMessage`）与给人（`summarizeToolResultText`）是两条独立管线。**
   模型要「结构化、可解析、够全」的 JSON；人要「一眼看懂、越短越好」的一句话。`summarizeToolResultText` 返回 `string | null`，把「无法摘要」的兜底权交还 UI。配合 policy 的 `uiSummaryOnly` 字段，实现终端「探索类工具只闪一句摘要」。

***

## 3. 工业对比

把 Helixent 的工具结果处理，与业界几种主流 Agent 框架的做法放一起看：

| 维度 | Helixent | LangChain (Tool `ToolMessage`) | OpenAI Agents SDK | Vercel AI SDK |
| --- | --- | --- | --- | --- |
| 结果的统一形态 | **归一成 `{ok,summary,error,code,data}`** 结构化契约 | `ToolMessage.content`（字符串/内容块），无强制结构 | 工具返回值经 `str()` 或结构化输出 | `tool result` 对象，交由模型格式化 |
| 上下文防撑爆 | **按工具名分级截断**（policy 表 + 三级降级） | 多靠开发者在工具内自己截断 | 开发者自理 / 靠模型 max_tokens | 开发者自理 |
| 错误处理 | **归一 + `errorKind` 分类**，错误变「可读观察」喂回模型 | 异常可配置为返回给模型或抛出 | 工具异常可返回给模型 | `experimental_toToolResultContent` 定制 |
| 给模型 vs 给 UI | **两条独立管线**（详略不同） | 通常同一份 content | 通常同一份 | 通常同一份 |
| 截断安全性 | **保证产出合法 JSON**（先构小对象再序列化） | 无框架级保证 | 无框架级保证 | 无框架级保证 |

几点读法：

- **「按工具分级截断」是 Helixent 相对少见的深耕点。** 多数框架把「结果太大怎么办」丢给开发者（在工具里自己截）或丢给模型（靠 `max_tokens` 硬砍）。Helixent 在**框架层**用一张 policy 表统一处理，且区分了「探索类只回摘要」和「读文件类保留内容」——这种「按结果的价值密度分级」的细腻度，是它作为「教学样本」特别值得学的地方。代价是这张表是**硬编码**的（深度解释 Q3 会讨论）。

- **「结果归一 + 错误分类」体现了「把工具结果当一等数据」的态度。** 很多框架里，工具结果就是一坨塞进消息的字符串。Helixent 把它建模成 `NormalizedToolResult`（带 `ok`/`errorKind`/`raw`），让「成败」「错误类别」「原始值」都成为可编程的维度。这和 LangChain 后来引入的 `ToolMessage.status`（success/error）是同一方向，但 Helixent 的 `errorKind` 分得更细。

- **「给模型」与「给 UI」分离，是 CLI/TUI 类产品特有的讲究。** 纯 API 场景（没有终端 UI）的框架通常不需要这条旁路。Helixent 因为要在终端里「好看地」展示工具调用（第 20 节），才需要 `summarizeToolResultText` 这条给人看的旁路——这是「它同时是框架**和** CLI 工具」这一双重身份的自然产物。

- **共同趋势**：无论哪个框架，「工具结果要经过一层加工才喂回模型」已是共识——区别只在加工的**深度**。Helixent 处在「较深」的一端：归一化 + 分类 + 分级截断 + 安全序列化，四道工序俱全，且都做在不到 260 行里。

***

## 4. 深度解释：为什么这样设计？不这样会怎样？

**Q1：为什么要把「归一化」和「按策略格式化」拆成 `normalizeToolResult` 和 `formatToolResultForMessage` 两个函数？合成一个不是更省事？**
拆开是为了**让「万物归一」这一步可以被独立复用和独立测试**。`normalizeToolResult` 的产物 `NormalizedToolResult` 是一个「干净、规整、带 `errorKind`」的数据结构，它的价值**不止**服务于「格式化成给模型的字符串」这一个下游。设想未来要做「按 `errorKind` 决定是否重试」——那段重试逻辑需要的是**归一化后的结构**（尤其是 `errorKind`），而**不是**最终那个字符串。如果把归一化和格式化揉成一个函数，重试逻辑就得把字符串再 `JSON.parse` 回来，绕一大圈。拆开后，`normalizeToolResult` 成了一个纯粹的「`unknown → 规整结构`」转换器，谁需要「规整结构」都能直接调它（测试就是一个现成的独立消费者，[tool-result-runtime.test.ts](../../src/agent/__tests__/tool-result-runtime.test.ts#L15-L64) 单独测了它）。**这是「单一职责」的经典收益：归一化只管归一化，截断只管截断，各自可测、可复用、可独立演化。**

**Q2：`stringifyWithinLimit` 为什么要搞「三级降级」这么复杂？直接 `JSON.stringify(payload).slice(0, maxLength)` 会怎样？**
会产出**语法非法的 JSON**，这是灾难。`slice` 一个序列化好的 JSON 字符串，几乎必然从某个键值中间、或某个括号引号之前切断，得到类似 `{"ok":true,"summary":"Applied pa` 这种残缺串。模型（或任何下游 `JSON.parse`）拿到它会**解析失败**——而工具结果解析失败，意味着模型这一轮「看不懂上一步干了啥」，可能重复调用、可能困惑、可能报错。三级降级的本质是**「宁可丢内容，不可坏结构」**：第①级尽量给全，第②级丢掉 data 这个「大户」（大多数超限都是 data 撑的，丢了它通常就够了），第③级才对 summary/error 的**值**动刀，但**动完刀立刻重新 `JSON.stringify` 包壳**，保证外层结构永远完整。**代价是几行额外代码，收益是「工具结果永远可被模型解析」这条硬保证**——对一个每一步都依赖「读懂上一步结果」的 ReAct 循环来说，这条保证是地基级的。测试 `"always returns valid json when payload exceeds limits"` 就是专门钉死这条保证的。

**Q3：policy 表是硬编码的 `switch (toolName)`，加一个新工具就得回来改这个文件——这不违反「开闭原则」吗？为什么不让每个工具自带自己的 policy？**
确实违反了严格意义的开闭原则，但这是一个**深思熟虑的权衡**，理由有三。① **policy 是「跨工具的横向策略」，集中放反而更好审视。** 「哪些工具该只回摘要、各自截多长」是一个需要**统一权衡**的决策——你想一眼看到「所有探索类都是 1000、read_file 是 12000」这种**横向对比**，才能判断分级是否合理。如果把 policy 散到每个工具文件里，就再也没法「一屏看全所有工具的截断策略」了，反而难维护。② **它有合理的 `default` 兜底。** 没在 switch 里列出的工具（比如 `bash`、或任何新加的工具）自动走 `DEFAULT_POLICY`（带 data、4000），**能正常工作**——不是「不改这个文件新工具就崩」，而是「不改也能跑，只是用默认策略」。真正需要特殊待遇（比如新的探索类工具想只回摘要）时才回来加一个 `case`。③ **`agent` 层不该 import `coding` 层的工具。** 注意 policy 在 `src/agent/`（通用层），而工具在 `src/coding/`（下游层）——第 1 节的**单向依赖**约束下，`agent` 层**不能**反向依赖 `coding` 层的具体工具。如果让「每个工具自带 policy」，`agent` 层的 `formatToolResultForMessage` 就得去读 `coding` 工具身上的属性，形成反向依赖，破坏分层。**用一张 `toolName → policy` 的字符串表，恰好在不引入反向依赖的前提下，让通用层能对具体工具「按名字」做差异化处理**——字符串是「无依赖的弱引用」。这是分层架构下的务实选择。

**Q4：为什么 `read_file` 要在 `formatToolResultForMessage` 开头特判「直通车」，而不是也让它走结构化契约（返回 `{ok, summary, data}`）？统一走契约不是更一致吗？**
因为 `read_file` 的结果有一个**独特性质**：它的「data」就是**要给模型直接阅读的大段文本**，而不是「给模型做程序化判断的结构化数据」。对比一下：`list_files` 的 data 是 `["a.ts","b.ts"]`（模型拿去判断），`apply_patch` 的 data 是 `{ added: 3 }`（模型拿去确认）——这些**适合**包在 JSON 里。但 `read_file` 的 data 是几百行代码正文，如果包成 `{"ok":true,"data":"line1\nline2\n..."}`，会有三重损耗：① **转义爆炸**——正文里的每个 `"`、`\`、换行都要转义成 `\"`、`\\`、`\n`，token 平白多出一大截；② **可读性下降**——模型要「脑内反转义」才能还原代码；③ **多此一举**——工具自己已经用 `truncateText(12000)` 截断并加好行号了，管线再包一层纯属浪费。所以让文件正文走「直通车」原样返回，是**尊重「文本内容」和「结构化数据」的本质区别**。至于「一致性」——真正的一致性不是「所有工具长一个样」，而是「**相似的东西一致对待，不同的东西区别对待**」。`read_file` 的正文和别的工具的结构化 data 本质不同，给它不同待遇恰恰是**更深层的一致**。这也是为什么 read-file.ts 里那句注释特意写着 `Do NOT return a structured result here`（[read-file.ts](../../src/coding/tools/read-file.ts#L59-L61)）——它是工具作者和管线作者之间的一个**明确约定**。

**Q5：`errorKind` 算出来却几乎没被用（`formatToolResultForMessage` 没把它拼进给模型的字符串），这不是「过度设计」吗？**
这是「**为可扩展性预留、但不过度实现**」的分寸拿捏，不算过度设计，理由有二。① **它的成本极低**：`inferToolErrorKind` 就是几行前后缀匹配，算一次几乎零开销，且它让 `NormalizedToolError` 这个**数据模型**更完整——「一个错误，除了消息和码，还应该有『类别』」是一个合理的建模直觉，先把维度补齐是有价值的。② **它预留的扩展是「高概率会发生」的**：一个 Agent 框架，几乎必然会走到「按错误类型做差异化处理」这一步——`environment_missing`（没装 rg）不该重试、`invalid_input`（参数错）该让模型改参数重试、`execution_failed`（跑挂了）可以原样重试一次……这些策略一旦要做，`errorKind` 就是现成的分类依据，不用再回来给每个错误码补分类。**过度设计的定义是「为『很可能永远不会发生』的需求增加『显著』的复杂度」**；而 `errorKind` 是「为『很可能会发生』的需求增加『微小』的复杂度」——两个条件都不满足「过度」。它是一个**低成本、高命中率的钩子**，恰如第 1.3 节末尾说的「先把分类能力做进数据模型，具体消费留给未来」。当然，如果直到项目终结它都没被消费，那它就成了「YAGNI 的反面教材」——但以 Agent 框架的演化规律看，这个赌注是划算的。

**Q6：`summarizeToolResultText` 遇到不认识的格式返回 `null`，为什么不干脆返回原始 `content`（至少 UI 有东西显示）？**
返回 `null` 是**把「兜底策略」的决定权交还给更了解显示语境的调用方**，这比在这个底层函数里硬编一个兜底更灵活。想清楚：`summarizeToolResultText` 是一个**纯粹的「提炼」函数**，它的契约是「我尽力从这段文本里**提炼**出一句适合人看的摘要；提炼不出来，我诚实地告诉你 `null`」。而「提炼不出来时该显示什么」，是一个**UI 层的决策**——第 20 节的 TUI 可能想「显示原文前 80 字」、可能想「显示灰色的『(结果无摘要)』」、可能想「干脆折叠不显示」。这些选择依赖于**终端宽度、主题、上下文**等只有 UI 层才知道的信息。如果 `summarizeToolResultText` 直接返回原始 `content` 兜底，就等于**替 UI 做了「显示全部原文」这个决定**——而原始 content 可能是一大坨 JSON 或几千字符的输出，直接刷屏，未必是 UI 想要的。**返回 `null`（一个明确的「我不知道」信号）比返回一个「可能不合适的默认值」更负责任**——这和 1.6 说的「诚实的『我不知道』」以及第 15 节 Manager「把决定权交给上层」是同一种「底层只提供能力、决策留给更懂语境的上层」的分层哲学。

***

## 5. 参考资料

- 本节主角（归一化 + 格式化）：[tool-result-runtime.ts](../../src/agent/tool-result-runtime.ts)（`normalizeToolResult` [L58-98](../../src/agent/tool-result-runtime.ts#L58-L98)、`inferToolErrorKind` [L24-32](../../src/agent/tool-result-runtime.ts#L24-L32)、类型守卫 [L34-56](../../src/agent/tool-result-runtime.ts#L34-L56)、`formatToolResultForMessage` [L100-143](../../src/agent/tool-result-runtime.ts#L100-L143)、`stringifyWithinLimit` [L159-180](../../src/agent/tool-result-runtime.ts#L159-L180)、`stringifyValue` [L145-157](../../src/agent/tool-result-runtime.ts#L145-L157)、`truncateSummary` [L182-187](../../src/agent/tool-result-runtime.ts#L182-L187)）
- 本节主角（分级策略）：[tool-result-policy.ts](../../src/agent/tool-result-policy.ts)（`ToolResultPolicy` 类型 [L1-6](../../src/agent/tool-result-policy.ts#L1-L6)、`getToolResultPolicy` [L14-45](../../src/agent/tool-result-policy.ts#L14-L45)、`DEFAULT_POLICY` [L8-12](../../src/agent/tool-result-policy.ts#L8-L12)）
- 本节主角（UI 旁路摘要）：[tool-result-summary.ts](../../src/agent/tool-result-summary.ts)
- 唯一的生产消费点（第 6 节）：[agent.ts `_act` 收割循环](../../src/agent/agent.ts#L259-L270)（调用 `formatToolResultForMessage`）、[agent.ts catch 压成 `Error:` 文本](../../src/agent/agent.ts#L235-L237)
- 上游契约（第 4 节）：[structured-tool-result.ts](../../src/foundation/tools/structured-tool-result.ts)（`StructuredToolSuccess` / `StructuredToolError`）
- 结果的几种来源（第 12～14 节预习）：[read-file.ts 返回裸文本](../../src/coding/tools/read-file.ts#L59-L62)、[read-file.ts `DEFAULT_MAX_CHARS=12000`](../../src/coding/tools/read-file.ts#L8)、[bash.ts 成功返回 stdout / 失败返回 `Error:`](../../src/coding/tools/bash.ts#L30-L34)、[tool-utils.ts `truncateText`](../../src/coding/tools/tool-utils.ts#L37-L45)
- 结果的落点类型（第 2 节）：[content.ts `ToolResultContent`](../../src/foundation/messages/types/content.ts#L59-L65)
- 三个文件的测试（可作为「可执行的规格说明」对照阅读）：[tool-result-runtime.test.ts](../../src/agent/__tests__/tool-result-runtime.test.ts)、[tool-result-policy.test.ts](../../src/agent/__tests__/tool-result-policy.test.ts)、[tool-result-summary.test.ts](../../src/agent/__tests__/tool-result-summary.test.ts)
- MDN · `JSON.stringify()`（及其在循环引用时抛错的行为）：<https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/JSON/stringify>
- MDN · `String.prototype.startsWith` / `endsWith`（`inferToolErrorKind` 的前后缀匹配）：<https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/String/startsWith>
- TypeScript 手册 · 用户自定义类型守卫（`value is T`）：<https://www.typescriptlang.org/docs/handbook/2/narrowing.html#using-type-predicates>
- 「约定优于配置」（Convention over Configuration）：<https://en.wikipedia.org/wiki/Convention_over_configuration>
- 上游依赖：[第 4 节 · Tool 工具系统](./04-tool.md)、[第 6 节 · 并行工具调度](./06-parallel-tools.md)、[第 7 节 · Middleware 中间件系统](./07-middleware.md)

***

## 6. 小结与下一节预告

本节我们拆开了从第 6 节就一直当黑盒的 `formatToolResultForMessage`，看清了 Helixent **如何用三个小文件（不到 260 行）把「五花八门的工具结果」收拾成「既喂得了模型、又撑不爆上下文」的字符串**：

- **normalize（[tool-result-runtime.ts](../../src/agent/tool-result-runtime.ts#L58-L98)）**：用「运行时类型守卫 + 有序 if 瀑布」把结构化对象 / `Error:` 字符串 / 裸值**归一**成统一的 `{ ok, summary, ... }`。顺序即正确性——先认结构化，认不出才靠 `Error:` 前缀猜。这兑现了第 6 节「`Error:` 文本与解析约定对暗号」的承诺。
- **`inferToolErrorKind`（妙笔）**：靠 `INVALID_`/`_NOT_FOUND`/`_FAILED` 等**命名规约**（而非巨型映射表）把几十种错误码归成 6 大类，`RG_NOT_FOUND` 精确匹配抢在后缀之前——「约定优于配置」。
- **policy（[tool-result-policy.ts](../../src/agent/tool-result-policy.ts)）**：一张 `toolName → 策略` 表，按「结果对模型的价值密度」分级——探索类只回摘要（防撑爆主力）、`read_file` 保留内容（12000，与工具自身对齐）、其余 4000。用字符串键在不破坏分层的前提下让通用层差异化对待具体工具。
- **format + `stringifyWithinLimit`**：给 `read_file` 正文开「直通车」（零加工）；错误归一成稳定形状；截断用「三级降级 + 先构小对象再序列化」**保证永不产出坏 JSON**；`truncateSummary` 用 `[truncated N chars]` 对模型诚实。
- **summary（[tool-result-summary.ts](../../src/agent/tool-result-summary.ts)）**：一条**给 UI 的反向旁路**，把已序列化的字符串反解成一句人话，返回 `string | null` 把兜底权交给 UI——「喂给模型的」和「显示给人的」是两条独立管线。

至此，第 6 节留下的最后一个黑盒被彻底填平：**ReAct 循环里「工具结果如何安全回喂」这一环，已经首尾闭合。** 一台会思考（第 5 节）、会并发行动（第 6 节）、可扩展（第 7 节）、且能稳健处理任意结果（本节）的通用 Agent，主干已经完整。

**承上启下（启下）**：本节解决的是「结果怎么**回喂**」——这是一个「数据往回流」的问题。下一节转向一个**正交**的问题：「能力怎么**注入**」——即在不把所有说明书一次性塞进 prompt 的前提下，让 Agent **按需**临时学会一套专门技能。它和本节一样是插在第 7 节「中间件插座」上的一个插件，但走的是 `beforeAgentRun` + `beforeModel` 那条路径（回想第 7 节 1.7 的预告）：

> **如何让 Agent「按需」学会一套专门技能，而不是把所有技能说明书一次性塞进 prompt 把它撑爆？只把技能的『名字 + 描述』注入，正文让模型自己用 `read_file` 去读——这种「渐进式披露」是怎么实现的？**

这个「能力按需注入、且同样注意『不撑爆 prompt』」的问题，就是 [第 9 节](./00-roadmap.md) 的主题。你会发现它和本节共享同一个底层焦虑——**上下文窗口是稀缺资源**——只是本节从「结果」这一侧节流，第 9 节从「能力注入」那一侧节流。

👉 下一节 **第 9 节：Skills 技能系统 —— 渐进式加载（Progressive Disclosure）**。

准备好后，对我说「**生成第 9 节**」即可。
