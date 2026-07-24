# 第 14 节：apply_patch —— 手写 unified diff 解析器与应用器

> 本节属于 **第四部分 · Coding 层（面向编程的专用 Agent）**。[第 12 节](./12-tool-foundation-file-io.md) 给了三个「改文件」工具（`read_file`/`write_file`/`str_replace`），[第 13 节](./13-search-system-tools.md) 又补上了七个「探索环境」的工具（`bash`/`glob`/`grep`/`list`/`info`/`mkdir`/`move`）。但这两节结尾都指向同一个尖锐的缺口：**它们改文件的粒度都太粗**——`write_file` 是整体覆盖、`str_replace` 靠软约束的「唯一匹配」、`bash` 更是「你自己写命令」。要在一个几百行的文件里**同时**改第 12 行、删第 45–47 行、在第 88 行后插一段，且**一个字都不能打错地方**，前面的工具都力不从心。
>
> 对应 roadmap 为本节设定的**核心问题**：
>
> > 为什么要自己实现一个 diff 解析器？它如何保证「打补丁不打错地方」？
>
> **一句边界声明**：本节只精讲**一个文件**——[apply-patch.ts](../../src/coding/tools/apply-patch.ts)（232 行）。它是全项目**最「算法密集」**的工具：没有 spawn 子进程、没有花哨的 API，只有一个**从零手写的 unified diff 解析器 + 应用器**。我们会把它拆成三个纯函数（`parsePatch` 解析 / `validateHunkCounts` 校验 / `applyHunks` 应用）逐行讲透，然后看外层 `invoke` 如何把它们编排成一个「解析 → 逐文件校验路径 → 逐 hunk 逐行比对 → 写盘」的安全管线。它**站在 [第 12 节](./12-tool-foundation-file-io.md) 的 `okToolResult`/`errorToolResult` 地基上**（所以本节必须在第 12 节之后读），错误码 `INVALID_PATCH_PATH`/`DELETE_NOT_SUPPORTED`/`PATCH_APPLY_FAILED` 又精确对齐 [第 8 节](./08-tool-result-pipeline.md) 的分类器——尤其 `DELETE_NOT_SUPPORTED` 是全项目**唯一**触发 `unsupported` 错误类别的码，和 [第 13 节](./13-search-system-tools.md) 的 `RG_NOT_FOUND`（唯一的 `environment_missing`）恰成一对镜像。

***

## 0. 承上启下

[第 12 节](./12-tool-foundation-file-io.md) 在拆完 `str_replace` 时，特意留了一个「诚实标注」的钩子。原话是这样的：

> `str_replace` 的「唯一匹配」是**软约束**而非硬校验（硬校验在第 14 节）——读源码要区分「设计意图」和「当前实现」。

[第 13 节](./13-search-system-tools.md) 结尾则把这根线收得更紧：

> 可真实的代码修改，往往需要**外科手术式的精确**——在一个几百行的文件里，**同时**改第 12 行、删第 45-47 行、在第 88 行后插入一段，且**绝不能打错地方**。这种「多处、精确、带上下文校验」的改动，`str_replace` 的软约束和 `write_file` 的整体覆盖都力不从心。**这就需要一个更强、更严的工具——一个从零手写的 unified diff 解析器与应用器 `apply_patch`**。

它还预告了本节会回答的两个具体细节：

> 你会在第 14 节看到，`apply_patch` 为什么**刻意不支持文件删除**（不接受 `/dev/null` 目标）？以及它如何用 `validateHunkCounts` 把「补丁声称改 3 行、实际给了 4 行」这类不一致挡在应用之前——这是「用严格换安全」的极致体现。

本节就来兑现这两个悬念，并把 `str_replace` 那句「硬校验在第 14 节」落到实处。

**先回忆三个上游结论，它们是本节的直接前提：**

1. **[第 12 节](./12-tool-foundation-file-io.md) 的结果地基。** `okToolResult(summary, data)` / `errorToolResult(error, code, details)`——本节所有的成功/失败返回都走这两个函数（[tool-result.ts](../../src/coding/tools/tool-result.ts)）。你会看到 `apply_patch` 是**唯一一个既用结构化结果、又几乎不做前置路径校验**的工具（校验被内嵌进解析流程），这背后的取舍是本节的看点之一。
2. **[第 12 节](./12-tool-foundation-file-io.md) 的 `str_replace` 软约束。** `str_replace` 靠「让模型自己保证 old 唯一」来防误改——但它**不校验上下文**，万一 old 在文件里出现两次、或模型记错了周围的代码，它照样替换。`apply_patch` 是这条软约束的「硬化版」：它带上下文行（context line），并**逐行硬比对**，对不上就拒绝。
3. **[第 8 节](./08-tool-result-pipeline.md) 的错误码分类器 `inferToolErrorKind`。** 它按错误码的前后缀把错误分成 `invalid_input`/`unsupported`/`not_found`/`environment_missing`/`execution_failed`/`unknown` 六类（[tool-result-runtime.ts](../../src/agent/tool-result-runtime.ts#L24-L32)）。本节三个错误码分别命中三条不同的分支——尤其 `DELETE_NOT_SUPPORTED` 是全项目**唯一**命中 `_NOT_SUPPORTED` → `unsupported` 的码。

准备好了。`apply_patch` 的核心是「**看懂一段 diff 文本，再把它安全地贴回文件**」——我们先从「为什么要自己手写这个解析器、而不用现成的库」这个最根本的问题开始。

***

## 1. 主题内容

### 1.1 先建立地图：unified diff 长什么样，`apply_patch` 由哪几块组成？

在读代码前，先补齐一个背景知识：**什么是 unified diff？** 它就是你天天在 `git diff` 里看到的那种格式。举个最小的例子——把文件里的 `beta` 改成 `gamma`：

```diff
--- /abs/path/demo.txt
+++ /abs/path/demo.txt
@@ -1,2 +1,2 @@
 alpha
-beta
+gamma
```

拆开看，它由**两种结构**组成：

| 结构 | 样子 | 含义 |
| --- | --- | --- |
| **文件头（file header）** | `--- 旧路径` + `+++ 新路径` | 「接下来的改动作用在哪个文件上」 |
| **hunk（变更块）** | `@@ -oldStart,oldCount +newStart,newCount @@` + 若干行 | 「在旧文件第 `oldStart` 行起、涉及 `oldCount` 行，对应新文件第 `newStart` 行起、`newCount` 行」 |

hunk 里的每一行都带一个**前缀字符**，这是 unified diff 的灵魂：

- `' '`（空格）= **context line**（上下文行）：这行**没变**，同时出现在旧文件和新文件里，作用是「定位锚点」。
- `'-'` = **delete line**（删除行）：这行只在**旧**文件里，要删掉。
- `'+'` = **add line**（新增行）：这行只在**新**文件里，要加上。

所以上面那段 diff 读作：「在 `demo.txt` 第 1 行起，`alpha` 保持不动，把 `beta` 删掉、换成 `gamma`」。

**理解了格式，`apply_patch` 要做的事就清晰了——它是一台「三段式流水线」**：

```
patch 字符串
   │
   ▼  ① parsePatch：文本 → 结构化的 PatchFile[]（解析器）
PatchFile[] { oldPath, newPath, hunks[] }
   │
   ▼  ② validateHunkCounts：校验「声称的行数」与「实际给的行数」一致（守门员）
   │
   ▼  ③ applyHunks：逐行比对上下文/删除行，边走边产出新文件内容（应用器）
新文件内容字符串
   │
   ▼  ④ invoke：编排上面三步 + 路径校验 + 写盘 + 结构化结果
```

本节就**按这个顺序**拆：先 `parsePatch`（1.3），再 `validateHunkCounts`（1.4），再 `applyHunks`（1.5），最后看 `invoke` 怎么把它们串起来（1.6）。但在动手读代码前，必须先回答那个最根本的问题——

### 1.2 关键决策：为什么要「从零手写」，而不用现成的 diff 库？

这是本节最该想清楚的一件事。npm 上现成的 diff 库一大把（`diff`、`diff-match-patch`、`parse-diff`…），Helixent 为什么偏要自己写一个 232 行的解析器？roadmap 的核心问题就是冲着它来的。**四个理由，层层递进：**

**① 依赖最小化——呼应 [第 1 节](./01-overview.md) 的分层哲学。** Helixent 通篇的气质是「能不引依赖就不引」（`grep` 靠系统 `rg`、shell 靠 `Bun.spawn`、glob 靠 `Bun.Glob`）。一个 diff 应用器的核心算法其实很小（就是「按行游标走、比对、拼接」），引一个第三方库反而要承担它的 API 变更、体积、潜在 bug。**自己写 232 行，比引一个几千行的库更符合「小而清晰」的项目气质。**

**② 要的是「应用（apply）」而非「生成（diff）」——需求本就窄。** 大多数 diff 库的重头戏是**生成** diff（比较两个字符串算出差异，这是个 O(ND) 的经典算法，很复杂）。但 `apply_patch` **不需要生成**——diff 是**模型给的**（模型自己写出 `@@ ... @@`）。它只需要**应用**，而「应用」比「生成」简单得多：**不用跑 diff 算法，只需按行游标顺序走一遍、比对、拼接**。需求这么窄，手写反而更聚焦。

**③ 要的是「严格」而非「宽容」——这与主流库的目标相反。** 这是最关键的一点。GNU `patch`、`git apply` 这类工具的设计目标是**尽量把补丁打上去**：它们有「模糊匹配（fuzz）」，上下文对不上会尝试上下几行找、行号偏了会自动纠偏。**这对人类很友好，但对 Agent 很危险**——模型可能记错了文件内容、或文件已被改动，一个「宽容」的应用器会「猜」一个位置把补丁打上去，**结果打错地方却不报错**。Helixent 要的恰恰相反：**上下文对不上就立刻失败**，宁可让模型重来，也绝不「猜」。这种「零模糊、逐行硬比对」的语义，现成库大多不提供（或要额外配置），**手写才能把「严格」焊死进逻辑**。

**④ 要能内联项目自己的安全策略。** `apply_patch` 有两条 Helixent 独有的规矩：**路径必须是绝对路径**、**拒绝 `/dev/null` 删除文件**（1.6 详解）。这些是项目级的安全约束，塞进一个通用库里很别扭；手写就能自然地把它们编织进应用流程。

> 📌 **一句话总结这个决策**：`apply_patch` 手写 diff 应用器，是因为它的需求「窄」（只 apply 不 diff）、要求「严」（零模糊、逐行硬比对）、且要内联「项目安全策略」（绝对路径 + 禁删）。这三点合起来，让「引库」的收益远小于「手写 232 行」的可控性。**这是「不要为了 DRY 而引入不匹配的抽象」的又一个案例**（对比 [第 13 节 Q3](./13-search-system-tools.md) 「该不该抽公共函数」的取舍——同一种务实的工程判断）。

想清楚「为什么手写」，我们就带着「它到底严在哪」的问题，进入第一段代码——解析器。

### 1.3 `parsePatch` —— 把 diff 文本解析成结构化的 `PatchFile[]`（一台手写状态机）

`parsePatch`（[apply-patch.ts L32-L105](../../src/coding/tools/apply-patch.ts#L32-L105)）是本节第一个核心函数：**输入一坨 diff 字符串，输出一个结构化的 `PatchFile[]` 数组**。在读它之前，先看它要产出的三个类型定义（[L12-L26](../../src/coding/tools/apply-patch.ts#L12-L26)）——**类型先行**能让我们一眼看清解析的目标形状：

```ts
type HunkLine = { type: "context" | "delete" | "add"; text: string };

type PatchHunk = {
  oldStart: number;   // 旧文件里从第几行开始（1-based）
  oldCount: number;   // 旧文件里涉及几行
  newStart: number;   // 新文件里从第几行开始
  newCount: number;   // 新文件里涉及几行
  lines: HunkLine[];  // 这个 hunk 的所有行（带类型）
};

type PatchFile = {
  oldPath: string;    // --- 后面的路径
  newPath: string;    // +++ 后面的路径
  hunks: PatchHunk[]; // 这个文件的所有 hunk
};
```

**看到没？1.1 那张「文件头 + hunk + 带前缀的行」的手绘图，被一比一翻译成了三个嵌套类型。** 解析器的全部工作，就是把扁平的字符串「立体化」成这三层结构。它是一台**手写的行级状态机**——逐行扫描，根据行首特征切换状态。头部先有个关键常量：

```ts
const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@$/;
```

**这个正则是整个解析器的「大脑」，值得逐段拆解它匹配的 `@@ -1,2 +1,2 @@`：**

- `^@@ -` —— hunk 头固定以 `@@ -` 开头。
- `(\d+)` —— 捕获组 1：`oldStart`（必填）。
- `(?:,(\d+))?` —— 捕获组 2：`oldCount`。注意外层 `(?:...)?` 是**可选非捕获组**——意味着 `,count` 整体可以省略。这对应 unified diff 的一条约定：**当 count 为 1 时可以省略**（`@@ -5 +5 @@` 等价于 `@@ -5,1 +5,1 @@`）。
- ` \+` —— 中间一个空格 + 转义的 `+`。
- `(\d+)` / `(?:,(\d+))?` —— 捕获组 3、4：`newStart`（必填）、`newCount`（可选）。
- `@@$` —— 固定以 `@@` 结尾。`$` 锚定行尾，意味着 hunk 头**后面不能跟别的东西**（有些 diff 会在 `@@` 后附函数名，这里刻意不支持——又一处「从严」）。

**主循环用 `index` 游标逐行走，分三种情况处理**（这就是状态机的三个状态转移）：

**状态 A · 遇到文件头 `--- `（[L40-L53](../../src/coding/tools/apply-patch.ts#L40-L53)）：**

```ts
if (line.startsWith("--- ")) {
  const next = lines[index + 1] ?? "";
  if (!next.startsWith("+++ ")) {
    throw new Error("Patch is missing +++ header after --- header.");   // ← 强制成对
  }
  current = {
    oldPath: normalizePatchPath(line.slice(4).trim()),   // 去掉 "--- " 4 个字符
    newPath: normalizePatchPath(next.slice(4).trim()),
    hunks: [],
  };
  files.push(current);
  index += 2;   // ← 一次吃掉两行（--- 和 +++）
  continue;
}
```

三个细节：**（a）强制成对**——看到 `---` 就**必须**紧跟 `+++`，否则直接 throw。这是「结构完整性」的第一道校验。**（b）一次吃两行**（`index += 2`）——因为 `---`/`+++` 是绑定出现的。**（c）`current` 指针**——它指向「当前正在收集 hunk 的文件」，后面遇到的 hunk 都往这个 `current.hunks` 里塞。这是状态机「记住我在哪个文件里」的关键。

路径还经过一个 `normalizePatchPath`（[L28-L30](../../src/coding/tools/apply-patch.ts#L28-L30)）：

```ts
function normalizePatchPath(rawPath: string) {
  return rawPath.replace(/^b\//, "").replace(/^a\//, "");
}
```

**这是对 `git diff` 习惯的贴心兼容。** `git diff` 生成的补丁路径长这样：`--- a/src/foo.ts` / `+++ b/src/foo.ts`——它给旧文件加 `a/` 前缀、新文件加 `b/` 前缀。这个函数把这两个前缀剥掉，让 `a/src/foo.ts` 还原成 `src/foo.ts`。**这样模型无论用不用 `git` 风格前缀，路径都能被正确识别。** （注意：剥完前缀后路径仍需是绝对路径，否则会被 1.6 的 `INVALID_PATCH_PATH` 拦下。）

**状态 B · 遇到 hunk 头 `@@ ... @@`（[L55-L96](../../src/coding/tools/apply-patch.ts#L55-L96)）——这是解析器的核心：**

```ts
const header = line.match(HUNK_HEADER);
if (header) {
  if (!current) {
    throw new Error("Encountered hunk before file header.");   // ← hunk 必须先有文件头
  }
  const hunk: PatchHunk = {
    oldStart: Number(header[1]),
    oldCount: Number(header[2] ?? 1),   // ← 省略时默认 1（呼应正则的可选组）
    newStart: Number(header[3]),
    newCount: Number(header[4] ?? 1),
    lines: [],
  };
  index += 1;
  // 内层循环：贪婪吃掉后续的 hunk 正文行，直到遇到下一个 @@ 或 ---
  while (index < lines.length) {
    const hunkLine = lines[index] ?? "";
    if (hunkLine.startsWith("@@ ") || hunkLine.startsWith("--- ")) {
      break;   // ← 边界：下一个 hunk 或下一个文件，交还给主循环
    }
    if (hunkLine === "\\ No newline at end of file") {
      index += 1;
      continue;   // ← 忽略这行元信息
    }
    if (hunkLine === "") {
      index += 1;
      continue;   // ← 忽略空行
    }
    const prefix = hunkLine[0];
    const text = hunkLine.slice(1);   // ← 去掉前缀字符，留正文
    if (prefix === " ") {
      hunk.lines.push({ type: "context", text });
    } else if (prefix === "-") {
      hunk.lines.push({ type: "delete", text });
    } else if (prefix === "+") {
      hunk.lines.push({ type: "add", text });
    } else {
      throw new Error(`Unsupported hunk line: ${hunkLine}`);   // ← 未知前缀直接拒绝
    }
    index += 1;
  }
  current.hunks.push(hunk);
  continue;
}
```

**这段「内层 while 循环」是本节最需要吃透的一段，五个要点：**

1. **hunk 必须先有文件头**：`if (!current) throw`——如果补丁一上来就是 `@@`、前面没有 `---`，直接拒绝。又一道结构完整性校验。
2. **`Number(header[2] ?? 1)` 的默认值**：正则里 `oldCount`/`newCount` 是可选组，没捕获到时是 `undefined`，`?? 1` 兜底成 1——**精确对应 unified diff「count 省略即为 1」的约定**。正则的「可选」和这里的「默认 1」是一套配合。
3. **贪婪吃行 + 双边界**：内层循环一直吃，直到遇到 `@@ `（下一个 hunk）或 `--- `（下一个文件）才 `break`。**注意 `break` 时不动 `index`**——把这一行「退还」给主循环去重新判断（主循环的 `continue` 会重新走一遍分支）。这是状态机「交接」的关键手法。
4. **忽略两种噪声行**：`\ No newline at end of file`（这是 diff 工具标记「文件末尾无换行」的元信息行）和**空行**都被 `continue` 跳过。**为什么忽略空行？** 因为真正的「空的上下文行」在 unified diff 里应该是**一个空格 + 空内容**（即 `" "`），而**完全空的行**（`""`）通常是补丁文本里无意义的分隔。跳过它们让解析更鲁棒。（这个宽容点值得记住——1.5 会讲它和「严格比对」如何并存。）
5. **未知前缀直接 throw**：如果某行既不是 ` `/`-`/`+` 开头，也不是上面两种噪声，就抛 `Unsupported hunk line`。**这又是「从严」**——不认识的东西绝不「猜」，直接失败。

**状态 C · 其它行**：主循环末尾 `index += 1`（[L98](../../src/coding/tools/apply-patch.ts#L98)）——不匹配文件头也不匹配 hunk 头的行（比如 `diff --git ...`、`index abc..def` 这类 git 补丁的元信息），**直接跳过**。这让解析器能吞下完整的 `git diff` 输出而不被那些「花边」噪声干扰。

**最后一道校验**（[L101-L104](../../src/coding/tools/apply-patch.ts#L101-L104)）：

```ts
if (files.length === 0) {
  throw new Error("Patch does not contain any file changes.");
}
return files;
```

如果扫完一遍**一个文件头都没找到**（比如模型给了一坨根本不是 diff 的文本），就抛错。**至此，`parsePatch` 把一坨字符串安全地立体化成了 `PatchFile[]`——每个文件、每个 hunk、每一行的类型都清清楚楚。**

> 💡 **小结这台状态机的「严」与「宽」**：它对**结构**极严（`---` 必配 `+++`、hunk 必先有文件头、未知前缀直接拒、空补丁报错），但对**噪声**适度宽容（跳过 git 元信息行、`\ No newline`、纯空行）。**「结构从严、噪声从宽」——既能吃下真实的 `git diff` 输出，又不会把错误结构蒙混过关。** 这个分寸感是手写解析器的价值所在。

### 1.4 `validateHunkCounts` —— 应用前的「守门员」：声称的行数 vs 实际的行数

解析出结构后，**先别急着应用**。`validateHunkCounts`（[L107-L128](../../src/coding/tools/apply-patch.ts#L107-L128)）是应用前的一道独立校验，也是 roadmap 亮点预告里点名的「`validateHunkCounts` 校验行数」。它回答一个问题：**hunk 头声称的 `oldCount`/`newCount`，和 hunk 正文里实际给的行数，对得上吗？**

```ts
function validateHunkCounts(hunk: PatchHunk, filePath: string) {
  let oldSeen = 0;
  let newSeen = 0;

  for (const line of hunk.lines) {
    if (line.type === "context") {
      oldSeen += 1;   // 上下文行：旧、新文件里都算一行
      newSeen += 1;
    } else if (line.type === "delete") {
      oldSeen += 1;   // 删除行：只在旧文件里
    } else {
      newSeen += 1;   // 新增行：只在新文件里
    }
  }

  if (oldSeen !== hunk.oldCount || newSeen !== hunk.newCount) {
    throw new Error(
      `Hunk count mismatch for ${filePath} at @@ -${hunk.oldStart},${hunk.oldCount} +${hunk.newStart},${hunk.newCount} @@. ` +
        `Observed old=${oldSeen}, new=${newSeen}.`,
    );
  }
}
```

**逻辑非常干净，关键在那个「三分类计数」：**

- **context 行**同时属于旧文件和新文件（它没变，两边都有），所以 `oldSeen` 和 `newSeen` **都 +1**。
- **delete 行**只在旧文件里（要删掉），只 `oldSeen += 1`。
- **add 行**只在新文件里（新加的），只 `newSeen += 1`。

数完后，**`oldSeen` 必须等于 hunk 头声称的 `oldCount`，`newSeen` 必须等于 `newCount`**——对不上就 throw。

**为什么这道校验如此重要？看 [apply-patch.test.ts](../../src/coding/tools/__tests__/apply-patch.test.ts#L63-L85) 那个专门的测试用例：**

```ts
const patch = [
  `--- ${filePath}`,
  `+++ ${filePath}`,
  "@@ -1,1 +1,1 @@",   // ← 声称：旧 1 行、新 1 行
  " alpha",            // context → oldSeen=1, newSeen=1
  "-beta",             // delete  → oldSeen=2
  "+gamma",            // add     → newSeen=2
  "",
].join("\n");
// 实际：oldSeen=2, newSeen=2，但头声称 oldCount=1, newCount=1 → 不匹配！
```

hunk 头写着 `@@ -1,1 +1,1 @@`（声称旧、新各 1 行），但正文实际给了 2 个旧行（`alpha`+`beta`）和 2 个新行（`alpha`+`gamma`）。`validateHunkCounts` 会抓出 `oldSeen=2 !== oldCount=1`，抛出 `Hunk count mismatch`——**这个补丁在真正碰文件之前就被拒绝了**。测试断言了 `result.error` 里含 `"Hunk count mismatch"`。

**这道校验挡住的是哪一类错误？** 是「模型自己写的补丁内部就自相矛盾」——它可能算错了行数、或漏抄/多抄了一行。**这类错误如果不拦，会导致后面的 `applyHunks` 按错误的边界去比对，产生更诡异的结果。** 在「碰文件之前」用一个纯算术的校验把它挡下，是最廉价、最早期的防线。**它和 hunk 头形成了一种「自校验」——补丁自己带着「我应该有几行」的声明，应用器就拿它来对账。**

### 1.5 `applyHunks` —— 应用器核心：按游标走、逐行硬比对、边走边拼

现在到了最核心的 `applyHunks`（[L130-L174](../../src/coding/tools/apply-patch.ts#L130-L174)）——它回答 roadmap 的核心问题「如何保证打补丁不打错地方」。**它的策略是：维护一个「源文件行游标 `sourceIndex`」，按 hunk 指定的位置走过去，逐行硬比对，边走边把结果推进 `output`。**

先看开头的「切行」：

```ts
function applyHunks(original: string, file: PatchFile) {
  const sourceLines = original === "" ? [] : original.replace(/\r\n/g, "\n").split("\n");
  const output: string[] = [];
  let sourceIndex = 0;
  // ...
}
```

**两个细节**：（a）`original === "" ? [] : ...`——空文件切出**空数组**而非 `[""]`（`"".split("\n")` 会得到 `[""]`，那会多出一个幽灵空行）。这是「新建文件」场景（原文件不存在时 `original` 是 `""`）的正确处理。（b）`.replace(/\r\n/g, "\n")`——先把 Windows 换行 `\r\n` 归一成 `\n`，**跨平台一致性**（`parsePatch` 开头 [L33](../../src/coding/tools/apply-patch.ts#L33) 也做了同样的归一，两处呼应）。

**核心是遍历每个 hunk（[L135-L166](../../src/coding/tools/apply-patch.ts#L135-L166)），分三步：**

**第①步 · 校验 + 快进到 hunk 起点：**

```ts
for (const hunk of file.hunks) {
  validateHunkCounts(hunk, file.newPath);   // ← 应用前先过 1.4 的守门员
  const expectedIndex = hunk.oldStart - 1;   // 1-based → 0-based

  while (sourceIndex < expectedIndex) {
    output.push(sourceLines[sourceIndex] ?? "");   // ← 把 hunk 之前的行原样搬过去
    sourceIndex += 1;
  }
  // ...
```

先对每个 hunk 调 `validateHunkCounts`（把 1.4 的校验嵌进应用流程）。然后 `expectedIndex = oldStart - 1`（diff 的行号是 1-based，数组是 0-based）。**接着的 while 循环把「上一个 hunk 结束到这个 hunk 开始之间」的行原样搬进 `output`**——这些行不在任何 hunk 里，是「没动的部分」，照抄即可。这就是「按游标走到 hunk 该出现的位置」。

**第②步 · 逐行处理 hunk 内容——三种行三种命运（[L144-L165](../../src/coding/tools/apply-patch.ts#L144-L165)）：**

```ts
for (const line of hunk.lines) {
  if (line.type === "context") {
    const actual = sourceLines[sourceIndex] ?? "";
    if (actual !== line.text) {
      throw new Error(
        `Context mismatch in ${file.newPath} at line ${sourceIndex + 1}: ` +
          `expected ${JSON.stringify(line.text)}, got ${JSON.stringify(actual)}`,
      );
    }
    output.push(actual);   // ← 上下文行：校验通过后原样保留
    sourceIndex += 1;
  } else if (line.type === "delete") {
    const actual = sourceLines[sourceIndex] ?? "";
    if (actual !== line.text) {
      throw new Error(
        `Delete mismatch in ${file.newPath} at line ${sourceIndex + 1}: ` +
          `expected ${JSON.stringify(line.text)}, got ${JSON.stringify(actual)}`,
      );
    }
    sourceIndex += 1;   // ← 删除行：校验通过后跳过（不推进 output = 删掉）
  } else {
    output.push(line.text);   // ← 新增行：直接推进 output（不动 sourceIndex）
  }
}
```

**这 20 行是整个工具的心脏，是「打补丁不打错地方」的保证所在。逐行看三种行的命运：**

| 行类型 | 是否比对源文件 | 是否推进 `output` | 是否推进 `sourceIndex` | 直觉 |
| --- | --- | --- | --- | --- |
| **context** | ✅ **硬比对** | ✅ 推 `actual` | ✅ +1 | 「这行该没变，我核对一下确实没变，原样保留」 |
| **delete** | ✅ **硬比对** | ❌ 不推（=删掉） | ✅ +1 | 「这行该被删，我核对一下确实是它，然后跳过它」 |
| **add** | ❌ 不比对 | ✅ 推 `line.text` | ❌ 不动 | 「这是新行，源文件里没有，直接加进去」 |

**关键中的关键，是 context 和 delete 那两个 `if (actual !== line.text) throw`：**

- **context 行**：diff 说「第 N 行是 `alpha`（没变）」，应用器就去源文件第 `sourceIndex` 行看**实际**是不是 `alpha`。**不是就立刻 throw `Context mismatch`。**
- **delete 行**：diff 说「删掉第 N 行的 `beta`」，应用器去看源文件第 `sourceIndex` 行**实际**是不是 `beta`。**不是就立刻 throw `Delete mismatch`。**

**这就是「不打错地方」的机制——它不『相信』行号，它『核对』内容。** 想象模型给的补丁行号偏了（比如文件被别人改过、或模型记错了），或者上下文内容记错了：一个「宽容」的工具（GNU patch）会去附近找、去猜；`apply_patch` **直接拒绝**——`actual !== line.text` 就抛错，整个补丁作废，一个字都不写。**「宁可不改，绝不改错」**——这就是 1.2 说的「用严格换安全」，也是 `str_replace` 那条软约束的「硬化版」：`str_replace` 只保证 old 存在，`apply_patch` 则**逐行核对上下文**，把「打在对的位置」变成了硬约束。

**再品那个错误信息**：`Context mismatch in ... at line N: expected "alpha", got "alphaX"`——它用 `JSON.stringify` 把期望值和实际值都**带引号打印**（这样空格、不可见字符的差异也看得出来），还给出**具体行号**。模型收到这个错误，能精确知道「第 N 行我以为是 alpha，其实是 alphaX」，从而在下一步（在 [第 11 节](./11-lead-agent.md) `<tool_usage>` 「apply_patch 失败就重读文件再选更安全的策略」的引导下）重读文件、修正补丁。**错误信息的精确度，直接决定了模型自我纠错的能力。**

**第③步 · 收尾——搬运 hunk 之后的剩余行（[L168-L173](../../src/coding/tools/apply-patch.ts#L168-L173)）：**

```ts
  while (sourceIndex < sourceLines.length) {
    output.push(sourceLines[sourceIndex] ?? "");
    sourceIndex += 1;
  }

  return output.join("\n");
```

所有 hunk 处理完后，源文件**剩下的行**（最后一个 hunk 之后的部分）原样搬进 `output`，最后 `join("\n")` 成新文件内容。**至此，一个「按游标走、逐行硬比对、边走边拼」的应用器就完整了。**

> 💡 **回收 1.3 的「跳过空行」伏笔**：还记得 `parsePatch` 会跳过纯空行 `""` 吗？这里就能看出它为什么不影响「严格性」——被跳过的是**完全空的行**（补丁文本里的无意义分隔），而真正的「空上下文行」在 diff 里是 `" "`（一个空格），它 `slice(1)` 后得到 `""` 并被记为 `{ type: "context", text: "" }`，照样会参与逐行硬比对。**「跳过无意义空行」和「严格比对有意义的空上下文」并不矛盾——因为它们在 diff 里长得不一样（`""` vs `" "`）。**

### 1.6 `invoke` —— 编排层：路径校验、禁删、写盘与结构化结果

三个纯函数备齐后，外层 `invoke`（[L186-L231](../../src/coding/tools/apply-patch.ts#L186-L231)）把它们编排成一个完整的工具。先看工具定义头：

```ts
export const applyPatchTool = defineTool({
  name: "apply_patch",
  description:
    "Apply a unified diff patch to one or more files using absolute paths in the patch headers. " +
    "Note: File deletion is not supported (will fail if +++ /dev/null is used).",
  parameters: z.object({
    description: z.string().describe("Explain why you want to apply the patch. Always place `description` as the first parameter."),
    patch: z.string().describe("Unified diff patch content with --- and +++ headers. Must use absolute paths."),
  }),
  invoke: async ({ patch }) => { /* ... */ },
});
```

**注意 `description` 里把两条硬规矩直接写进了工具说明**：「用绝对路径」和「不支持删文件」。这是「让模型在调用前就知道边界」——比等它踩坑再报错更省一个来回。参数只有两个：老规矩的 `description`（第一参数，[第 12 节](./12-tool-foundation-file-io.md) 的强约定）和 `patch`（补丁正文）。

**`invoke` 的编排流程（整个包在一个大 try/catch 里）：**

```ts
invoke: async ({ patch }) => {
  try {
    const files = parsePatch(patch);          // ① 解析（可能 throw）
    const changedFiles: string[] = [];

    for (const file of files) {               // ② 逐文件处理
      // ②a 路径必须绝对
      if (!file.newPath.startsWith("/")) {
        return errorToolResult(`Patch paths must be absolute. Received: ${file.newPath}`, "INVALID_PATCH_PATH", {
          oldPath: file.oldPath, newPath: file.newPath,
        });
      }

      // ②b 拒绝删除文件
      if (file.newPath === "/dev/null") {
        return errorToolResult(
          "File deletion (+++ /dev/null) is currently not supported by apply_patch.",
          "DELETE_NOT_SUPPORTED",
          { oldPath: file.oldPath, newPath: file.newPath },
        );
      }

      // ②c 读原文（不存在 = 新建，读空串）
      const target = Bun.file(file.newPath);
      const original = (await target.exists()) ? await target.text() : "";

      // ②d 应用补丁（可能 throw：count/context/delete mismatch）
      const updated = applyHunks(original, file);

      // ②e 自动建父目录
      const parent = dirname(file.newPath);
      if (!(await exists(parent))) {
        await mkdir(parent, { recursive: true });
      }

      // ②f 写盘
      await target.write(updated);
      changedFiles.push(file.newPath);
    }

    // ③ 成功：结构化结果
    return okToolResult(`Applied patch to ${changedFiles.length} file(s).`, {
      fileCount: changedFiles.length, changedFiles,
    });
  } catch (error) {
    // ④ 兜底：所有 throw 都收敛成一个错误码
    const message = error instanceof Error ? error.message : String(error);
    return errorToolResult(message, "PATCH_APPLY_FAILED");
  }
},
```

**六个编排细节，逐个看：**

**①②a 路径必须绝对（`INVALID_PATCH_PATH`）**：`parsePatch` 已经 `normalizePatchPath` 剥掉了 `a/`、`b/` 前缀，这里再检查剥完之后**是不是以 `/` 开头**。为什么强制绝对路径？因为工具没有「当前工作目录」的上下文（它不像 `bash` 有 cwd），**相对路径会有歧义**——`src/foo.ts` 相对谁？强制绝对路径消除一切歧义。错误码 `INVALID_PATCH_PATH`（`INVALID_` 前缀 → [第 8 节](./08-tool-result-pipeline.md) 归为 `invalid_input`，语义：「输入错了，改对了再来」）。

**②b 拒绝 `/dev/null`（`DELETE_NOT_SUPPORTED`）——本节的招牌决策**：unified diff 用 `+++ /dev/null` 表示「这个文件被删除了」。`apply_patch` **刻意不支持它**，看到就返 `DELETE_NOT_SUPPORTED`。[apply-patch.test.ts](../../src/coding/tools/__tests__/apply-patch.test.ts#L46-L61) 专门测了这个。**为什么禁删？** 3.x 和 Q2 会详谈，一句话预告：删文件是**极高危、且不可逆**的操作，而删除**有别的、更受控的路径**（模型可以用 `bash("rm ...")`，那会走 [第 15 节](./00-roadmap.md) 的审批弹窗），没必要让 `apply_patch` 也具备「一声不响删文件」的能力。错误码 `DELETE_NOT_SUPPORTED`（`_NOT_SUPPORTED` 后缀 → 第 8 节归为 `unsupported`）——**这是全项目唯一一个 `unsupported` 类别的错误码**（我们在源码里全局搜过，`_NOT_SUPPORTED` 只有这一处）。

**②c 读原文——顺带支持「新建文件」**：`(await target.exists()) ? await target.text() : ""`——文件存在就读它，**不存在就读成空串 `""`**。结合 1.5 里 `applyHunks` 对空串的处理（切成 `[]`），这让 `apply_patch` **能用一个「全是 add 行、从第 0 行开始」的补丁来新建文件**。一个工具同时覆盖「改文件」和「建文件」。

**②d 应用**：调 `applyHunks`——这里可能抛出 1.4/1.5 的三种错误（count mismatch / context mismatch / delete mismatch），都会被最外层 catch 接住。

**②e 自动建父目录**：`if (!(await exists(parent))) await mkdir(parent, { recursive: true })`——**和 [第 12 节](./12-tool-foundation-file-io.md) `write_file` 一模一样的贴心**。要往 `/a/b/c.ts` 写但 `/a/b` 不存在时，自动递归建好，不让模型因「父目录不存在」而卡壳。

**②f + ③ 写盘与成功结果**：`Bun.file(...).write(updated)` 写入，把路径记进 `changedFiles`。全部文件处理完，返回 `okToolResult`，data 里带 `fileCount` 和 `changedFiles`——**因为 `apply_patch` 在 [第 8 节 policy](../../src/agent/tool-result-policy.ts#L34-L41) 里是 `includeData: true`（不同于第 13 节搜索工具的 summary-only），这份 data 会真的回喂给模型**，让它知道「哪些文件被改了」。

**④ 统一兜底（`PATCH_APPLY_FAILED`）**：最外层一个 `try/catch` 把 `parsePatch` 和 `applyHunks` 里所有的 `throw`（缺 `+++` 头、hunk 在文件头前、未知前缀、空补丁、count/context/delete mismatch……）**全部收敛成一个错误码 `PATCH_APPLY_FAILED`**（`_FAILED` 后缀 → 第 8 节归为 `execution_failed`），并把 `error.message` 原样作为错误文本回给模型。[apply-patch.test.ts](../../src/coding/tools/__tests__/apply-patch.test.ts#L77-L84) 断言了 count mismatch 会返回 `PATCH_APPLY_FAILED` 且 error 含 `Hunk count mismatch`。

> ⚠️ **一个诚实标注：`invoke` 不是「事务性」的。** 注意 ②b/②a 的检查是在 `for` 循环里逐文件做的、②d/②f 也是逐文件应用并**立即写盘**。这意味着：如果一个补丁包含**多个文件**，第一个文件写成功了、第二个文件的 hunk 却校验失败抛错，**第一个文件的改动已经落盘、不会回滚**（catch 只负责返回错误码，不撤销已写的文件）。这是一个**已知的非原子性**——对「一个补丁通常只改一个文件」的常见场景无害，但读源码时要意识到「多文件补丁 + 中途失败」会留下部分改动。这与 [第 12 节](./12-tool-foundation-file-io.md) `str_replace` 「空转不写盘」的谨慎形成对比——`apply_patch` 在多文件事务性上没有做保证（Q5 会讨论「为什么可以接受」）。

### 1.7 错误码全景：三个码，三条通往第 8 节分类器的线

把 `apply_patch` 的三个错误码和 [第 8 节](./08-tool-result-pipeline.md) 的 `inferToolErrorKind`（[tool-result-runtime.ts L24-L32](../../src/agent/tool-result-runtime.ts#L24-L32)）连起来看，是本节「生产错误码 → 消费错误码分类」链路的收束：

```ts
export function inferToolErrorKind(code?: string): ToolErrorKind {
  if (!code) return "unknown";
  if (code.startsWith("INVALID_")) return "invalid_input";        // ← INVALID_PATCH_PATH 命中这里
  if (code.endsWith("_NOT_SUPPORTED")) return "unsupported";      // ← DELETE_NOT_SUPPORTED 命中这里（全项目唯一）
  if (code === "RG_NOT_FOUND") return "environment_missing";      // ← 第 13 节 grep 的专属分支
  if (code === "FILE_NOT_FOUND" || code.endsWith("_NOT_FOUND")) return "not_found";
  if (code.endsWith("_FAILED")) return "execution_failed";        // ← PATCH_APPLY_FAILED 命中这里
  return "unknown";
}
```

| `apply_patch` 错误码 | 触发场景 | 第 8 节归类 | 对模型的语义 |
| --- | --- | --- | --- |
| `INVALID_PATCH_PATH` | 路径非绝对 | `invalid_input` | 「输入错了，把路径改成绝对路径再来」 |
| `DELETE_NOT_SUPPORTED` | `+++ /dev/null` | **`unsupported`**（全项目唯一） | 「这个操作我不支持，换个工具（如 `bash rm`）」 |
| `PATCH_APPLY_FAILED` | 解析/校验/比对的一切 throw | `execution_failed` | 「执行失败了，看 error 详情决定怎么改」 |

**三个码精确命中三条不同的分支——这不是巧合，是命名约定的产物**：`INVALID_` 前缀、`_NOT_SUPPORTED`/`_FAILED` 后缀都是 [code-convention.md](../code-convention.md) 规定的 SCREAMING_SNAKE 错误码风格，`inferToolErrorKind` 就靠这些前后缀「望文生义」地分类。**尤其值得玩味的是 `DELETE_NOT_SUPPORTED` 和第 13 节 `RG_NOT_FOUND` 的镜像关系**：

- `RG_NOT_FOUND` → `environment_missing`：**唯一**用「精确值匹配」的分支，语义是「环境缺东西，模型重试无用，去装 rg」。
- `DELETE_NOT_SUPPORTED` → `unsupported`：**唯一**触发 `_NOT_SUPPORTED` 后缀分支的码，语义是「这个能力我故意不提供，模型别硬试，换条路」。

**两者都是「模型不该重试、该改变策略」的错误类别**，也都是各自类别在全项目里的**独苗**——它们标记出 Helixent 错误分类体系里两个最「特殊」的角落：一个是「环境不满足」，一个是「能力被刻意阉割」。

### 1.8 全景：一张 `apply_patch` 的数据流与防线图

把本节的三个纯函数、`invoke` 编排、和上下游连起来：

```
   模型给出 patch 字符串（自己写的 unified diff）
                    │
                    ▼
   ┌──────────────【apply_patch invoke】───────────────────────────────┐
   │                                                                    │
   │  ① parsePatch(patch)  ── 手写状态机 ──────────────────────────┐    │
   │     · --- 必配 +++          · @@ 头正则解析 oldStart/count…    │    │
   │     · normalizePatchPath 剥 a//b/   · 未知前缀→throw          │    │
   │     · 跳过 git 元信息/空行/\No newline    · 空补丁→throw       │    │
   │     └───────────► PatchFile[] { oldPath,newPath,hunks[] }      │    │
   │                    │                                           │    │
   │  ② 逐文件校验：                                                │    │
   │     · newPath 非 "/" 开头 → INVALID_PATCH_PATH（invalid_input）│    │
   │     · newPath === "/dev/null" → DELETE_NOT_SUPPORTED（唯一 unsupported）
   │                    │                                           │    │
   │  ③ applyHunks(original, file)  ── 应用器核心 ─────────────────┤    │
   │     · validateHunkCounts：声称行数 vs 实际行数（守门员）        │    │
   │     · 游标 sourceIndex 快进到 hunk 起点                        │    │
   │     · context/delete 行【逐行硬比对】actual!==text → throw     │    │
   │     · add 行直接推 output                                      │    │
   │     └───────────► 新文件内容字符串                             │    │
   │                    │                                           │    │
   │  ④ 不存在则读空串（=新建）→ 自动建父目录 → Bun.file.write       │    │
   │                    │                                           │    │
   │  catch(所有 throw) ─┴──► PATCH_APPLY_FAILED（execution_failed）│    │
   └────────────────────┬───────────────────────────────────────────────┘
                        │ okToolResult / errorToolResult（第 12 节地基）
                        ▼
        【第 8 节 formatToolResultForMessage】
          · apply_patch policy: includeData=true（data 回喂模型：changedFiles）
          · 错误码 INVALID_*/*_NOT_SUPPORTED/*_FAILED → inferToolErrorKind 三分类
                        │
                        ▼
   拼成 tool_result 回喂模型（并驱动第 19/20 节 TUI；执行前先过第 11/15 节审批）
```

**一句话总括**：**`apply_patch` 是全项目最「算法密集」的工具——它手写一台状态机把 diff 文本解析成结构（`parsePatch`），用一道算术校验挡住内部矛盾的补丁（`validateHunkCounts`），再用「按游标走、逐行硬比对 context/delete、对不上就 throw」的应用器保证「打补丁不打错地方」（`applyHunks`）。外层 `invoke` 给它加上「绝对路径、禁删 /dev/null、自动建父目录、统一兜底成 PATCH_APPLY_FAILED」的编排，产出的三个错误码精确命中第 8 节分类器的三条分支。它把第 12 节 `str_replace` 那条『唯一匹配』软约束，硬化成了『逐行核对上下文』的强约束——这就是「用严格换安全」的极致。**

***

## 2. 亮点与关键设计

明确标注哪些是「妙笔」、哪些是「关键决策」：

1. **【核心妙笔】`applyHunks` 用「逐行硬比对 context/delete，对不上就 throw」实现『不打错地方』。** 它**不相信行号、只核对内容**——context 行核对「这行确实没变」、delete 行核对「删的确实是它」，任一对不上就抛 `Context mismatch`/`Delete mismatch`，整个补丁作废、一字不写。这是 roadmap 核心问题「如何保证打补丁不打错地方」的直接答案，也是「宁可不改、绝不改错」哲学的落地（1.5）。

2. **【关键决策】从零手写而非引 diff 库——因为需求「窄」、要求「严」、要内联「安全策略」。** 只需 apply 不需 diff（需求窄）、要零模糊逐行硬比对（要求严，与 GNU patch 的「模糊匹配」目标相反）、要内联「绝对路径 + 禁删」（项目安全策略）。三点合起来，引库的收益远小于手写 232 行的可控性（1.2）。

3. **【核心妙笔】`validateHunkCounts` 用一道纯算术校验，在「碰文件之前」挡住内部矛盾的补丁。** 靠「context 行 old/new 都 +1、delete 只 +old、add 只 +new」的三分类计数，对账 hunk 头声称的 `oldCount`/`newCount`。这让「模型自己算错行数」这类错误在最早期、最廉价的阶段就被拦下，是补丁的「自校验」（1.4）。

4. **【妙笔】`DELETE_NOT_SUPPORTED` 是全项目唯一的 `unsupported` 错误码，与第 13 节 `RG_NOT_FOUND` 构成镜像。** 刻意拒绝 `+++ /dev/null` 删除，返回一个 `_NOT_SUPPORTED` 后缀的码——它是 `inferToolErrorKind` 里 `unsupported` 分支的唯一触发者，语义「这能力我故意不给，别硬试」。和 `RG_NOT_FOUND`（唯一的 `environment_missing`）分别标记出错误分类体系里「能力被阉割」与「环境不满足」两个最特殊的角落（1.6②b、1.7）。

5. **【关键决策】统一 try/catch 把「解析 + 校验 + 应用」的一切 throw 收敛成 `PATCH_APPLY_FAILED`。** 三个纯函数内部大胆用 `throw` 表达各种「结构/内容不对」（缺 `+++`、hunk 在文件头前、未知前缀、空补丁、三种 mismatch……），最外层一个 catch 统一兜底成结构化错误码——**「内部用异常、边界转结构化」的清晰分层**，让纯函数保持简洁、边界保持契约（1.6④）。

6. **【妙笔】`normalizePatchPath` 剥 `a/`/`b/` 前缀 + 状态 C 跳过 git 元信息行 = 直接吞下 `git diff` 输出。** 模型可以把 `git diff` 的原始输出（带 `diff --git`、`index abc..def`、`a/`/`b/` 前缀）几乎原样丢进来，解析器自动消化这些「花边」。「结构从严、噪声从宽」的分寸感（1.3）。

7. **【关键决策】`includeData: true`——`apply_patch` 的结果 data 回喂模型，不同于第 13 节搜索工具的 summary-only。** 因为 `changedFiles`（改了哪些文件）是模型下一步推理的**刚需信息**（对比搜索工具那种「太大或太废话」的 data）。这印证第 13 节 1.7 的判据：「回不回 data，看 data 里有没有模型下一步真正需要的新信息」（1.6）。

8. **【妙笔】读空串支持「新建文件」——一个工具覆盖「改」与「建」。** 文件不存在时 `original = ""`，`applyHunks` 把空串切成空数组 `[]`，于是一个「全 add 行、从第 0 行起」的补丁就能建出新文件。配合「自动建父目录」，`apply_patch` 既能外科手术式改文件，也能整建新文件（1.5、1.6②c/②e）。

9. **【一致性红利】三个错误码靠 SCREAMING_SNAKE 前后缀「望文生义」地命中第 8 节分类器。** `INVALID_` → `invalid_input`、`_NOT_SUPPORTED` → `unsupported`、`_FAILED` → `execution_failed`。工具只管按 [code-convention](../code-convention.md) 起对名字，分类器就自动归好类——这是「命名即契约」的一致性红利（1.7）。

***

## 3. 工业对比

对比业界方案的做法与优缺点。

### 3.1 GNU `patch` / `git apply` —— 「宽容」的应用器，与 `apply_patch` 的目标相反

Unix 世界的 `patch` 命令和 `git apply` 是最经典的 diff 应用器。它们和 `apply_patch` 做的是**同一件事**（把 unified diff 贴回文件），但**设计目标截然相反**：

- **它们追求「尽量打上去」**：GNU `patch` 有著名的 **fuzz factor**（模糊因子）——上下文对不上时，它会**忽略若干行上下文**再试；行号偏了，它会**在附近上下搜索**匹配位置。`git apply` 也有 `-C`（context 数）、`--recount`（自动重算行号）、`--3way`（三方合并回退）等一堆「尽量成功」的开关。
- **`apply_patch` 追求「对不上就失败」**：零 fuzz、不搜索、不重算。context/delete 行 `actual !== line.text` 立刻 throw。

**为什么 Helixent 反其道而行？** 因为**使用者不同**。GNU `patch` 服务**人类**——人打补丁时，源文件可能已经有轻微改动，「模糊匹配」能省去手动解决冲突的麻烦，且**人会检查结果**。而 `apply_patch` 服务**LLM**——模型可能**幻觉**出错误的上下文、或记错文件内容，一个「宽容」的应用器会「猜」一个位置把补丁打上去，**结果错了模型还以为成功了**（因为没报错）。**对 Agent 来说，「静默打错」比「明确失败」危险得多**——失败了模型还能重读文件纠错（第 11 节 `<tool_usage>` 就是这么引导的），打错了却会污染代码库且难以察觉。所以 `apply_patch` 选择「严格失败」，把「模糊匹配」的智能让位给「重读—重试」的循环。

### 3.2 OpenAI Codex CLI 的 `apply_patch` —— 自定义格式 vs 标准 unified diff

OpenAI 的 Codex CLI 也有一个同名的 `apply_patch` 工具，但它用的是**自定义的补丁格式**（`*** Begin Patch` / `*** Update File:` / `@@` 上下文块等），而**不是**标准 unified diff。它的设计动机是「让模型更容易正确生成补丁」——自定义格式弱化了对精确行号的依赖，更多靠上下文块定位。

**两种路线的取舍**：

- **Codex 自定义格式**：优点是**对模型更友好**（不用精确数行号，减少幻觉出错的概率）；缺点是**模型要专门学这套格式**（它不是模型预训练里见过的 `git diff`），且工具要写一个专门的解析器。
- **Helixent 标准 unified diff**：优点是**复用模型的先验**——`git diff` 格式是模型在海量代码/教程里见过无数次的，几乎不用教；缺点是**要求模型算对行号**（`@@ -a,b +c,d @@`），一旦算错就触发 count/context mismatch。Helixent 用 `validateHunkCounts` + 逐行比对**把「算错」变成「明确失败」**，再靠模型重试兜底。

**结论**：Codex 用「自定义格式降低出错率」，Helixent 用「标准格式 + 严格校验 + 重试循环」。前者赌「格式友好能减少错误」，后者赌「模型熟悉 git diff + 严格失败能纠错」。两者都是合理的工程选择，反映了「是让工具迁就模型，还是让模型用标准格式」的不同哲学。

### 3.3 Aider 的多重编辑格式 —— `diff` / `whole` / `udiff` 的对比

Aider（一个流行的开源 AI 结对编程工具）在这个问题上做了大量实证工作，它支持多种「编辑格式」：`whole`（整文件重写，类似 `write_file`）、`diff`（搜索-替换块，类似 `str_replace`）、`udiff`（unified diff，类似本节 `apply_patch`）。Aider 的作者通过 benchmark 发现：**不同模型、不同格式的成功率差异很大**——强模型用 `udiff` 效果好（精确、省 token），弱模型用 `whole` 更稳（不容易搞错格式）。

**这对理解 Helixent 的工具矩阵很有启发**：Helixent 其实**同时提供了这三档**——`write_file`（whole）、`str_replace`（diff 的搜索-替换变体）、`apply_patch`（udiff）。[第 11 节](./11-lead-agent.md) 的 `<tool_usage>` 明确引导「**Prefer apply_patch for targeted edits**」（优先用 apply_patch 做精确改动），但也保留了 `write_file`/`str_replace` 作为退路。**这不是冗余，而是「给模型多档精度的编辑工具、让它按场景选」**——和 Aider 的实证结论不谋而合：**没有一种编辑格式在所有场景都最优，提供一个梯度、让模型（或引导）择优，才是稳健的设计。**

### 3.4 npm `diff` / `diff-match-patch` 等库 —— 为什么不直接用？

回到 1.2 的决策，这里做个横向对比。npm 上的成熟 diff 库：

- **`diff`（jsdiff）**：功能全面，能 diff 也能 apply（`Diff.applyPatch`）。但它的 `applyPatch` **默认带 fuzz**（`fuzzFactor` 参数），语义偏「宽容」；要它「严格」得额外配置，且它的重点在「生成 diff」，apply 只是附带。
- **`diff-match-patch`（Google）**：主打「模糊补丁」（专为协同编辑设计，能在文本已大幅改动时仍尽量应用），**与 `apply_patch` 的「严格」目标完全南辕北辙**。
- **`parse-diff`**：只解析不应用，用它还得自己写应用器——那和手写也没差多少。

**所以「引库」在这里并不省事**：要么库的语义（宽容）与需求（严格）相悖，要么库只解决了一半（只解析）。**手写 232 行反而得到了：精确匹配需求的严格语义、内联的项目安全策略（绝对路径 + 禁删）、零外部依赖、完全可控的错误信息。** 这是「不为 DRY 而 DRY」的典范——**当现成抽象与你的需求不匹配时，手写一个刚好合身的，往往比削足适履地套用库更好。**

### 3.5 一览表

| 维度 | Helixent `apply_patch` | GNU patch / git apply | OpenAI Codex | Aider | npm diff 库 |
| --- | --- | --- | --- | --- | --- |
| 补丁格式 | 标准 unified diff | 标准 unified diff | 自定义格式 | 多档（whole/diff/udiff） | unified diff |
| 匹配策略 | **零模糊·逐行硬比对** | 模糊匹配（fuzz） | 上下文块定位 | 视格式 | 多带 fuzz |
| 对不上时 | **立刻失败** | 尽量猜着打上 | 视实现 | 失败/重试 | 默认宽容 |
| 服务对象 | LLM（要能纠错） | 人类（会检查） | LLM | LLM | 通用 |
| 删文件 | **刻意禁止** | 支持 | 支持 | 支持 | 支持 |
| 依赖 | **零**（手写 232 行） | 系统命令 | 内置 | 内置 | 第三方库 |
| 错误可读性 | 结构化码 + 精确行号 | 文本 reject 文件 | 视实现 | 视实现 | 异常/布尔 |

***

## 4. 深度解释：为什么这样设计？不这样会怎样？

用 Q&A 形式讲清几个「为什么」，以及「不这样会出什么问题」。

### Q1：`applyHunks` 为什么要「逐行硬比对」context 和 delete 行？删掉这两个 `throw`、只按行号照打不行吗？

**不行——删掉它们，`apply_patch` 就退化成一个「危险的 `str_replace`」，会静默地打错地方。**

假设去掉那两个 `if (actual !== line.text) throw`，`applyHunks` 就变成「纯按行号操作」：hunk 说 `@@ -45 ... @@`，它就无脑去操作源文件第 45 行，**根本不看那行到底是不是补丁以为的内容**。

**这会出什么问题？** 想象这个真实场景：

1. 模型在第 1 步 `read_file` 读了 `foo.ts`，记住了内容。
2. 中间它跑了别的操作（甚至用户手动改了文件），`foo.ts` 的内容**变了**——原来第 45 行是 `const x = 1;`，现在因为上面插了几行，第 45 行变成了 `function bar() {`。
3. 模型基于**旧记忆**生成补丁：「删除第 45 行的 `const x = 1;`」。

**没有硬比对**：应用器无脑删掉第 45 行——但那行现在是 `function bar() {`！**它删错了行，还报告「成功」。** 代码库被悄悄破坏，模型和用户都不知道。这正是 3.1 说的「静默打错」——**对 Agent 是灾难性的**。

**有硬比对**：应用器发现「补丁说第 45 行该是 `const x = 1;`，但实际是 `function bar() {`」，`actual !== line.text`，立刻 throw `Delete mismatch`。补丁作废、文件一字不改，模型收到明确错误、重读文件、发现内容变了、重新生成正确补丁。**「明确失败 + 重试」远胜「静默打错」。**

**这就是 context/delete 硬比对的全部意义**：它让 `apply_patch` **不信任行号，只信任内容**——行号只用来「快进到大概位置」，真正决定「打不打、打哪」的是**逐行内容核对**。这也是它比 `str_replace` 更强的地方：`str_replace` 只保证「old 在文件里存在」，`apply_patch` 保证「改动周围的上下文和我以为的**完全一致**」——精度高了一个量级。

### Q2：为什么刻意「不支持删除文件」（拒绝 `/dev/null`）？这不是把功能阉割了吗？

**这是一个『安全 > 功能完整性』的深思熟虑的取舍，而非偷懒。**

先明确 unified diff 里删文件的表示：`+++ /dev/null` 意味着「新文件是空/不存在」，即**整个文件被删掉**。`apply_patch` 看到它直接返 `DELETE_NOT_SUPPORTED`。**三个理由支撑这个决策：**

1. **删文件是「不可逆的高危操作」，且危害面大。** 改文件错了还能改回来（内容还在版本控制里、或能重新生成），但「删文件」如果删错了、或删了不该删的，恢复成本高得多（尤其没提交 git 时）。让一个「打补丁」的工具**顺带**具备「删文件」能力，是在扩大它的「爆炸半径」。

2. **删除有更受控的替代路径。** 模型真要删文件，可以用 `bash("rm /path/to/file")`——而 `bash` 在 [第 11 节](./11-lead-agent.md) 的 `CODING_TOOLS_REQUIRING_APPROVAL` 名单里，**每次执行都会弹 [第 15 节](./00-roadmap.md) 的审批框让人类确认**。**这就把「删文件」这个高危操作，从 `apply_patch` 的「一声不响执行」，挪到了 `bash` 的「必经人类审批」。** 换句话说，禁删不是「不能删」，而是「删的时候必须走审批那条更醒目的路」。

3. **保持工具语义单一。** `apply_patch` 的名字和心智模型是「**修改**文件内容」。让它能删文件会**模糊这个语义**——一个「改内容」的工具突然能让整个文件消失，是违反直觉的。**「一个工具只干一件在名字里说清楚的事」** 是好的接口设计。

**「不这样会怎样」**：如果支持删除，模型可能因为一个措辞含糊的任务（「清理一下这个模块」）就生成一个删文件的补丁，`apply_patch` 静默执行、文件没了——而它**不在**「必审批」逻辑的重点保护范围（虽然 `apply_patch` 本身也在审批名单，但审批框展示「一个补丁」时，人类未必注意到里头藏着 `/dev/null` 删除）。**明确拒绝 `/dev/null`、逼模型改用会醒目弹窗的 `bash rm`，是一道额外的安全护栏。** 这与本节通篇「用严格换安全」的哲学一脉相承。

### Q3：三个纯函数（`parsePatch`/`validateHunkCounts`/`applyHunks`）大量用 `throw`，为什么不像别的工具那样直接返回 `errorToolResult`？

**因为「纯函数内部用异常表达错误、在工具边界统一转成结构化结果」是一种清晰的分层，能让核心算法保持简洁。**

对比一下两种写法。如果让 `applyHunks` 直接返回结构化错误，它每一处校验都得写成：

```ts
// 假想的「到处返回结构化错误」写法——啰嗦且污染算法
if (actual !== line.text) {
  return { ok: false, error: "...", code: "CONTEXT_MISMATCH" };  // 每层都要把这个错误往上传
}
```

那么 `applyHunks` 的返回类型就变成 `string | ErrorResult`，调用它的 `invoke` 每次都要判断「是不是错误」再决定往下走还是返回——**错误处理的代码会像藤蔓一样缠绕进算法主干，可读性大幅下降**。而且 `parsePatch` 嵌套在 while 循环里，深层的错误要一层层 return 出来，非常笨拙。

**用 `throw` + 顶层 catch 的写法**（实际采用的）则干净得多：

- 三个纯函数**只关心「正确路径」**，遇到任何不对就 `throw`，不用操心「怎么把错误传出去」——异常会自动冒泡到最外层。
- **边界处（`invoke` 的 try/catch）统一收口**：一个 catch 接住所有异常，转成 `PATCH_APPLY_FAILED`。错误信息（`error.message`）也自动带上了——`throw new Error("Context mismatch at line 5: ...")` 的消息直接成为返回给模型的 error 文本。

**这是「让每层做它最擅长的事」**：纯算法函数用异常保持线性、简洁；工具边界用结构化结果履行对 Agent 的契约（第 4 节的 `StructuredToolResult`）。**注意这个分工是有意的**——`INVALID_PATCH_PATH`/`DELETE_NOT_SUPPORTED` 这两个是在 `invoke` 里**直接 `return errorToolResult`**（因为它们是「边界策略检查」，不属于算法内部），而算法内部的错误全靠 `throw` + catch 收敛成 `PATCH_APPLY_FAILED`。**「边界策略用 return、算法内部用 throw」——两种错误来源，两种表达方式，各得其所。**

### Q4：`parsePatch` 为什么要跳过 `git diff` 的元信息行（`diff --git`、`index ...`）和 `a/`/`b/` 前缀？直接要求「干净的 unified diff」不更简单吗？

**因为『迁就模型最可能产出的格式』比『要求模型产出理想格式』更务实——这是面向 LLM 设计工具的一条重要原则。**

模型生成补丁时，**最自然的产物是 `git diff` 的完整输出**——因为它在训练数据里见过海量的 `git diff`，包括那些「花边」：

```diff
diff --git a/src/foo.ts b/src/foo.ts
index 3a2f1b..8c4d2e 100644
--- a/src/foo.ts
+++ b/src/foo.ts
@@ -1,2 +1,2 @@
 alpha
-beta
+gamma
```

如果 `parsePatch` **只接受「干净」的 unified diff**（没有 `diff --git`/`index` 行、路径不带 `a/`/`b/`），那模型每次都得**记得手动删掉**那些行、剥掉前缀——**这是额外的认知负担，模型很容易忘、忘了就报错**，白白多一轮重试。

**Helixent 的选择是「宽容地吃下模型最可能给的东西」**：状态 C 的 `index += 1` 默默跳过 `diff --git`/`index` 这类不认识的行，`normalizePatchPath` 自动剥掉 `a/`/`b/` 前缀。**于是模型无论是给「干净 diff」还是「原始 git diff 输出」，都能被正确解析。** 这大幅降低了「格式不对」这类低级失败的概率。

**但要注意这个『宽容』是有边界的**（呼应 1.3 的「结构从严、噪声从宽」）：它只对**不影响语义的噪声**宽容（元信息行、路径前缀、空行），对**结构性错误**依然极严（`---` 没配 `+++`、hunk 在文件头前、未知行前缀）。**「对噪声宽容，对结构严格」——既降低了模型的格式负担，又不放过真正的错误。** 这个分寸感，正是面向 LLM 设计工具时最需要拿捏的。

### Q5：1.6 提到 `invoke` 处理多文件补丁「不是事务性的」（中途失败会留下部分改动），这是个 bug 吗？为什么可以接受？

**它是一个『已知的、经过权衡的局限』，而非 bug——因为常见场景不触发它，而做到真正的事务性成本很高。**

先复述问题：一个补丁若含多个文件（`--- fileA` ... `--- fileB` ...），`invoke` 在 `for` 循环里**逐个应用并立即写盘**。如果 fileA 写成功了、fileB 的 hunk 校验失败抛错，catch 只返回 `PATCH_APPLY_FAILED`，**fileA 的改动已经落盘、不回滚**。理论上这留下了「一半应用」的中间状态。

**为什么这可以接受？三层考量：**

1. **常见场景是「单文件补丁」，根本不触发。** Agent 做「精确编辑」时，绝大多数补丁只改**一个**文件（改一个函数、修一个 bug）。单文件补丁要么整体成功、要么整体失败（在写盘前就抛错），**天然是原子的**。多文件补丁 + 中途失败是个**边缘场景**。

2. **真做到事务性，成本高、复杂度大。** 要保证多文件原子性，得先「全部应用到内存、全部校验通过、再一次性全部写盘」（两阶段提交），或者「记录已写文件、失败时逐个回滚」。这两种都要引入额外的状态管理和错误处理逻辑，**与本工具「小而清晰」的气质相悖**。对一个边缘场景付出这么大的复杂度，性价比低。

3. **有外部安全网兜底。** 即使真的留下了部分改动，Agent 通常在 **git 仓库**里工作——用户能 `git diff` 看到所有改动、`git checkout` 回滚任何一个文件。而且模型收到 `PATCH_APPLY_FAILED` 后会重读文件、发现 fileA 已改 fileB 没改，从而修正。**「部分应用」是可观测、可恢复的，不是不可挽回的数据损坏。**

**所以这是一个典型的「工程权衡」**：在「常见场景无害 + 完整事务性成本高 + 有外部安全网」的综合判断下，作者选择了**不实现事务性**，换取代码的简洁。**读源码时能识别出这类「经过权衡的局限」（而非把它误判成 bug），是理解设计意图的关键。** 当然，如果未来「多文件补丁」变成高频场景，这里就值得升级成两阶段提交了——**这也是 1.6 那个 ⚠️ 标注存在的意义：把局限诚实地写出来，而不是假装它不存在。**

### Q6：`apply_patch` 明明自己做了那么多校验（严格得几乎不可能打错），为什么还要被放进「必须审批」的名单？

**因为『校验正确性』和『校验意图』是两码事——`apply_patch` 只能保证「打得对」，不能保证「该不该打」。**

回顾一下：`apply_patch` 在 [CODING_TOOLS_REQUIRING_APPROVAL](../../src/coding/permissions/requires-approval.ts) 名单里（和 `bash`/`write_file`/`str_replace`/`mkdir`/`move_path` 一起）。乍看有点多余——它校验这么严，打错的概率极低，还要人审批干嘛？

**关键区分两种「错」：**

- **`apply_patch` 的校验防的是「技术性打错」**：打到错误的行、上下文对不上、补丁自相矛盾。这些它能自己拦（Q1、1.4、1.5）。
- **审批防的是「意图性错误」**：补丁**技术上完全正确**，但**改的内容本身是错的/有害的**——比如把一段安全校验逻辑删掉、把生产配置改坏、往代码里注入后门。**这些 `apply_patch` 一点都拦不住**——从它的角度看，这是一个「完美应用」的补丁。

**只有人类（或审批策略）能判断「这个改动该不该发生」。** `apply_patch` 会改动**真实的源代码文件**——这是有实际后果的写操作，和 `write_file`/`str_replace` 同属「危险的改动世界」类工具。所以它理应过审批这一关，让人类在改动落盘前**过目内容、确认意图**。

**这揭示了一个分层的安全模型**（也正是 [第 15 节](./00-roadmap.md) 的主题）：

- **第一层·工具自校验**（本节）：保证操作「技术上正确」——不打错地方、不接受矛盾补丁。
- **第二层·人机审批**（第 15 节）：保证操作「意图上正确」——人类确认「这个改动我认可」。

**两层缺一不可**：光有自校验，模型可能「正确地做错事」；光有审批，人类要审的东西里混着大量「技术性错误」会很累。**`apply_patch` 把「技术正确性」这层扛下来（让审批时人类只需关注『内容意图』而非『格式对不对』），审批则专注「意图正确性」——这正是下一节要展开的人机协作基础设施。**

***

## 5. 参考资料

**本节精讲的源码（唯一文件）**：
- [apply-patch.ts](../../src/coding/tools/apply-patch.ts)（232 行）
  - 类型定义 `HunkLine`/`PatchHunk`/`PatchFile`：[L12-L26](../../src/coding/tools/apply-patch.ts#L12-L26)
  - hunk 头正则 `HUNK_HEADER`：[L10](../../src/coding/tools/apply-patch.ts#L10)
  - `normalizePatchPath`（剥 `a/`/`b/`）：[L28-L30](../../src/coding/tools/apply-patch.ts#L28-L30)
  - `parsePatch`（手写状态机）：[L32-L105](../../src/coding/tools/apply-patch.ts#L32-L105)
  - `validateHunkCounts`（行数守门员）：[L107-L128](../../src/coding/tools/apply-patch.ts#L107-L128)
  - `applyHunks`（逐行硬比对应用器）：[L130-L174](../../src/coding/tools/apply-patch.ts#L130-L174)
  - `invoke` 编排（路径校验/禁删/写盘/兜底）：[L186-L231](../../src/coding/tools/apply-patch.ts#L186-L231)

**co-located 测试（[第 21 节](./00-roadmap.md) 会讲这套约定）**：
- [apply-patch.test.ts](../../src/coding/tools/__tests__/apply-patch.test.ts)
  - 简单补丁应用成功（`beta`→`gamma`）：[L20-L44](../../src/coding/tools/__tests__/apply-patch.test.ts#L20-L44)
  - 拒绝 `/dev/null` 删除 → `DELETE_NOT_SUPPORTED`：[L46-L61](../../src/coding/tools/__tests__/apply-patch.test.ts#L46-L61)
  - 行数不匹配 → `PATCH_APPLY_FAILED` + `Hunk count mismatch`：[L63-L85](../../src/coding/tools/__tests__/apply-patch.test.ts#L63-L85)

**上游依赖章节**：
- [第 12 节 · 工具地基与文件读写](./12-tool-foundation-file-io.md)：`okToolResult`/`errorToolResult`（本节所有返回的地基）、`str_replace` 的「唯一匹配」软约束（`apply_patch` 是它的硬化版）、`write_file` 的「自动建父目录」（本节 ②e 同款）
- [第 8 节 · 工具结果处理管线](./08-tool-result-pipeline.md)：`inferToolErrorKind`（三个错误码的分类）、`getToolResultPolicy`（`apply_patch` 的 `includeData: true`）
- [第 13 节 · 搜索与系统工具](./13-search-system-tools.md)：`RG_NOT_FOUND`（与 `DELETE_NOT_SUPPORTED` 构成「唯一类别」的镜像）、Q3「重复 vs 抽象」的务实取舍（与本节「不引 diff 库」同源）
- [第 11 节 · Lead Agent](./11-lead-agent.md)：`apply_patch` 被装配进 `tools` 数组、`<tool_usage>` 的「Prefer apply_patch for targeted edits / 失败就重读文件」引导、`CODING_TOOLS_REQUIRING_APPROVAL`（`apply_patch` 需审批）
- [第 4 节 · Tool 工具系统](./04-tool.md)：`defineTool` 工厂与 `StructuredToolResult` 契约（本节结果形状的源头）

**关联源码（本节引用但不精讲）**：
- 审批名单：[requires-approval.ts](../../src/coding/permissions/requires-approval.ts)、装配处：[lead-agent.ts](../../src/coding/agents/lead-agent.ts#L103-L117)
- 结果 policy 与分类：[tool-result-policy.ts](../../src/agent/tool-result-policy.ts#L34-L41)、[tool-result-runtime.ts](../../src/agent/tool-result-runtime.ts#L24-L32)
- 工具编写规范：[code-convention.md](../code-convention.md)（`description` 第一参数、SCREAMING_SNAKE 错误码、`Bun.file` 优先）

**外部资料**：
- unified diff 格式规范（GNU diffutils）：<https://www.gnu.org/software/diffutils/manual/html_node/Unified-Format.html>
- GNU `patch` 与 fuzz factor（「模糊匹配」的经典实现，与本节「严格」对照）：<https://www.gnu.org/software/diffutils/manual/html_node/Inexact.html>
- `git apply` 文档（`--recount`/`--3way` 等「尽量成功」的开关）：<https://git-scm.com/docs/git-apply>
- OpenAI Codex CLI 的 `apply_patch` 自定义格式（3.2 对比）：<https://github.com/openai/codex>
- Aider 的编辑格式 benchmark（whole/diff/udiff 的实证对比，3.3）：<https://aider.chat/docs/leaderboards/>
- Bun `Bun.file` 读写 API（`exists`/`text`/`write`）：<https://bun.sh/docs/api/file-io>

***

## 6. 小结与下一节预告

本节我们把全项目最「算法密集」的工具 `apply_patch` 从零拆到底：

- **为什么手写**：需求「窄」（只 apply 不 diff）、要求「严」（零模糊、逐行硬比对，与 GNU patch 的宽容目标相反）、要内联「安全策略」（绝对路径 + 禁删）——三点让「引库」的收益远小于「手写 232 行」的可控性（1.2）。
- **`parsePatch`**：一台手写状态机，用 `HUNK_HEADER` 正则解析 `@@ -a,b +c,d @@`，把 diff 文本立体化成 `PatchFile[]`；「结构从严（`---` 必配 `+++`、未知前缀直接拒）、噪声从宽（跳过 git 元信息/空行、剥 `a/`/`b/` 前缀）」，能直接吞下 `git diff` 输出（1.3）。
- **`validateHunkCounts`**：一道纯算术校验，用「context 计双、delete 计旧、add 计新」的三分类计数，在碰文件前挡住「声称改 N 行、实际给 M 行」的自相矛盾补丁（1.4）。
- **`applyHunks`**：应用器核心，维护源文件游标，对 context/delete 行**逐行硬比对**——`actual !== line.text` 立刻 throw，「不相信行号、只核对内容」，这就是「打补丁不打错地方」的保证（1.5）。
- **`invoke` 编排**：绝对路径校验（`INVALID_PATCH_PATH`）、禁删 `/dev/null`（`DELETE_NOT_SUPPORTED`，全项目唯一的 `unsupported`）、读空串支持新建、自动建父目录、统一 try/catch 兜底成 `PATCH_APPLY_FAILED`；三个错误码精确命中第 8 节分类器（1.6、1.7）。
- **一条主线**：它把第 12 节 `str_replace` 的「唯一匹配」软约束，硬化成了「逐行核对上下文」的强约束——**「用严格换安全」**贯穿始终，和第 13 节 `bash`「给你最大自由」的逃生舱哲学恰成对照。

至此，[第 12～14 节](./12-tool-foundation-file-io.md) 把 Coding Agent 的**改动能力**讲完了——`write_file` 整写、`str_replace` 局部替换、`bash` 跑命令、`apply_patch` 外科手术式打补丁。**这四件工具都能「改动真实世界」——写文件、跑命令、打补丁，全是有实际后果、可能造成破坏的危险操作。**

**承上启下（启下）**：可你一定注意到了一个反复出现却始终没展开的词——**审批**。本节 Q2/Q6 反复提到「`bash rm` 会弹审批框」「`apply_patch` 在必审批名单里」「工具自校验保证『打得对』，审批保证『该不该打』」，第 13 节也说过 `bash` 是「能力核弹、必过审批」。**这些危险操作在真正执行前，到底是怎么被『拦下来、弹给人类过目』的？** 而且不只是「拦截确认」——Agent 有时还需要**主动向人提问**（「这个模糊的需求你到底想要哪种？」）。**这两件事（审批拦截、主动提问）看起来不同，为什么能共用同一套基础设施？**

**这正是 [第 15 节](./00-roadmap.md) 的主题**——它会揭晓 Helixent 如何用「**中间件 + `beforeToolUse` 短路**」（呼应 [第 7 节](./07-middleware.md)）实现审批拦截、用「**阻塞式工具**」实现主动提问，以及两个 `Manager` 如何共享同一套「**队列 + 单活跃请求 + 订阅**」模型，把异步的 Promise 桥接到（尚未登场的）React UI。

> 预告一个细节：你会在第 15 节看到，审批和提问这两个功能，为什么都要设计成「**单活跃请求 + 队列**」——因为终端 UI 一次只能弹一个框问一件事，而 Agent 可能同时（第 6 节的并行工具！）触发多个需要人类响应的请求。如何把「并发的请求」排成「一个接一个的弹窗」，正是那套共享基础设施要解决的核心问题。

👉 下一节 **第 15 节：Human-in-the-Loop —— 审批与提问共享的「队列 + 单活跃 + 订阅」模式**。

准备好后，对我说「**生成第 15 节**」即可。
