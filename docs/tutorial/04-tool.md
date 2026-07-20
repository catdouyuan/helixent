# 第 4 节：Tool 工具系统 —— defineTool 与 Zod 类型推导

> 本节属于 **第二部分 · Foundation 层（一切的地基）**。它是三块地基里的**最后一块**——[第 2 节](./02-message.md) 立了「数据」（`Message`），[第 3 节](./03-model.md) 立了「模型」（`Model` / `ModelProvider`），本节立「工具」（`Tool`）。读完它，Foundation 就齐了，我们便能进入第三部分把三块砖砌成一台会转的机器。
>
> 对应 roadmap 为本节设定的三个**核心问题**：
>
> 1. 一个「工具」在代码里长什么样？
> 2. 模型怎么知道有哪些参数？
> 3. 类型安全如何贯穿？

***

## 0. 承上启下

[第 3 节](./03-model.md) 在结尾把话递到了这里。我们已经看清了 `Model` 如何「说话」——消费一段 `Message[]` 历史、产出一条 `AssistantMessage`。但那一节里，`ModelContext` 和 `ModelProviderInvokeParams` 这两个入参类型上，都躺着一个我们**特意跳过、没有拆开**的字段：

```ts
tools?: Tool[];
```

当时留下的钩子是：

> **一个「工具」在代码里到底长什么样？模型是怎么知道「我有哪些工具、每个工具要什么参数」的？从工具定义、到 JSON Schema、再到 TypeScript 类型，这条链路如何做到「一处定义、三处受益」且全程类型安全？**

模型光会「说话」还不够——它得能「动手」。所谓「动手」，就是模型在回复里吐出一段 `tool_use`（第 2 节讲过的那个内容段），说「我要调用名为 `read_file` 的工具，参数是 `{ path: "/x/y" }`」。可这里有一连串问题：这个 `read_file` 到底是什么？它的参数规格谁定义的？模型凭什么知道「有 `read_file` 这个工具、它需要一个叫 `path` 的字符串参数」？调用真正落地时，又是谁去执行文件读取？

本节就钻进 [tools](../../src/foundation/tools/) 这个**只有两个核心文件、加起来不到 60 行**的目录，看它如何用一个叫 `defineTool` 的工厂函数 + 一份 Zod schema，把上面所有问题一次性回答干净。

读本节时，请打开这几个文件对照：

- 工具定义：[function-tool.ts](../../src/foundation/tools/function-tool.ts)
- 结构化结果契约：[structured-tool-result.ts](../../src/foundation/tools/structured-tool-result.ts)
- 桶文件：[tools/index.ts](../../src/foundation/tools/index.ts)、[foundation/index.ts](../../src/foundation/index.ts)
- 三个「真实工具」（用来印证抽象怎么落地）：[read-file.ts](../../src/coding/tools/read-file.ts)、[str-replace.ts](../../src/coding/tools/str-replace.ts)、[mkdir.ts](../../src/coding/tools/mkdir.ts)
- 三个「消费现场」（用来印证「三处受益」）：[agent.ts `_act`](../../src/agent/agent.ts#L222-L272)、[community/openai/utils.ts `convertToOpenAITools`](../../src/community/openai/utils.ts#L102-L107)、[community/anthropic/utils.ts `convertToAnthropicTools`](../../src/community/anthropic/utils.ts#L152-L158)

***

## 1. 主题内容

### 1.1 先想清楚问题：一个「工具」至少要提供什么？

在看代码前，还是先自己当一次设计者。你要让模型能「调用一个工具」，那么每个工具至少得携带这几样东西：

1. **一个名字**（`name`）——模型在 `tool_use` 里靠它点名，执行器靠它查找。
2. **一段描述**（`description`）——用自然语言告诉模型「这个工具是干嘛的、什么时候该用」。
3. **一份参数规格**（parameters）——模型得知道「这个工具接受哪些参数、每个参数什么类型、哪些必填」，才能生成合法的调用。
4. **一段真正干活的代码**（`invoke`）——当模型决定调用它时，这段函数被执行，产出结果。

前两样是纯字符串，简单。真正的难点在第 3、4 样，而且它们之间藏着一个**天生的矛盾**：

> - **模型那边**需要的参数规格是 **JSON Schema**——因为 OpenAI / Anthropic 的 function calling 协议就吃这个格式（`{ "type": "object", "properties": { "path": { "type": "string" } }, "required": ["path"] }`）。这是**运行期、跨进程**的「wire 格式」。
> - **代码这边**需要的参数规格是 **TypeScript 类型**——因为 `invoke` 函数的入参得有类型，你写 `input.path` 时 IDE 要能补全、`tsc` 要能校验。这是**编译期、进程内**的「静态类型」。

如果你天真地把这两样**分别手写**，灾难立刻降临：

```ts
// ❌ 反面教材：同一份参数规格，写了两遍
const jsonSchema = { type: "object", properties: { path: { type: "string" } }, required: ["path"] };
type ReadFileInput = { path: string };   // ← 和上面那份 schema 是两份「真相」
```

这两份「真相」迟早会**漂移**：哪天你给 schema 加了个 `startLine` 参数，却忘了同步改 `type`，于是模型能传 `startLine`，你的 `invoke` 里却拿不到类型提示——bug 就此埋下。**一份规格、两处手写、注定不同步**，这是所有「工具/函数调用」框架都要面对的核心痛点。

Helixent 的解法优雅得近乎作弊：**只写一份 Zod schema，让它同时生成 JSON Schema（给模型）和 TypeScript 类型（给代码）**。一份真相，两处派生，永不漂移。这就是 roadmap 点名的头号亮点——**「一处定义，三处受益」**。下面逐层拆开。

### 1.2 全景：一份 Zod schema，喂饱三个消费者

先给一张总图，建立空间感：

```
              defineTool({ name, description, parameters, invoke })
                                    │
                    parameters: 一份 Zod schema（z.object({...}))
                                    │
        ┌───────────────────────────┼───────────────────────────┐
        ▼                           ▼                           ▼
   ① 编译期 TS 类型              ② 运行期 JSON Schema          ③ 人类可读描述
   z.infer<P>                   parameters.toJSONSchema()     每个字段的 .describe(...)
        │                           │                           │
        ▼                           ▼                           ▼
   invoke(input) 的 input        community 层翻译成             作为 JSON Schema 里的
   拥有完整静态类型               OpenAI / Anthropic 的         "description" 字段，
   （IDE 补全 + tsc 校验）        工具声明，喂给模型             模型据此理解每个参数
```

一句话：**你在 `parameters` 里写下的那一个 `z.object({...})`，是整条链路唯一的「真相源」。** 编译期的类型、运行期喂给模型的 JSON Schema、乃至给模型看的参数说明文字，全部从它派生。你永远不会写第二遍，也就永远不会不同步。

现在从定义这份契约的 `function-tool.ts` 开始。

### 1.3 工具的形状：`FunctionTool` 接口与 `defineTool` 工厂（[function-tool.ts](../../src/foundation/tools/function-tool.ts)）

整个文件只有 43 行，却是 Foundation 三块地基的最后一块基石。先看 `FunctionTool` 接口（[function-tool.ts](../../src/foundation/tools/function-tool.ts#L8-L21)）：

```ts
export interface FunctionTool<
  P extends z.ZodSchema<Record<string, unknown>> = z.ZodSchema<Record<string, unknown>>,
  R = unknown,
> {
  /** The name of the tool. */
  name: string;
  /** The description of the tool. */
  description: string;
  /** The parameters of the tool. */
  parameters: P;
  /** The function to invoke when the tool is called. */
  invoke: (input: z.infer<P>, signal?: AbortSignal) => Promise<R>;
}
```

这个接口带着**两个泛型参数**，它们是本节全部类型魔法的载体，务必吃透：

- **`P extends z.ZodSchema<Record<string, unknown>>`**——`P` 是「参数 schema 的类型」。约束 `extends z.ZodSchema<Record<string, unknown>>` 是在说：**参数 schema 解析出来必须是一个「对象」**（`Record<string, unknown>`），而不能是裸的 `string` / `number`。这正好匹配 JSON Schema function calling 的硬性要求——工具参数顶层永远是一个 object。默认值 `= z.ZodSchema<Record<string, unknown>>` 则让你在不关心具体形状时能写裸的 `FunctionTool`。
- **`R = unknown`**——`R` 是「`invoke` 返回值的类型」，默认 `unknown`。它让工具的产物类型也能被静态追踪（虽然大多数工具最终都返回下一节要讲的 `StructuredToolResult`）。

接口里最关键的一行是 `invoke`：

```ts
invoke: (input: z.infer<P>, signal?: AbortSignal) => Promise<R>;
```

请死死盯住 `input: z.infer<P>` 这半行——**这就是「类型受益」的技术核心**。`z.infer<P>` 是 Zod 提供的类型工具，作用是「**从一个 Zod schema 的类型，反推出它解析后的 TypeScript 类型**」。也就是说，`invoke` 的入参类型不是你手写的，而是**从 `parameters` 那份 schema 自动算出来的**。你在 `parameters` 里写什么，`invoke` 的 `input` 就自动是什么类型——两者由编译器绑死，不可能漂移。

第二个参数 `signal?: AbortSignal` 是**可选的取消信号**。它呼应第 3 节反复出现的 `AbortSignal`，也为第 5 节的 `AbortController` 贯穿式取消埋下接口——一个长时间运行的工具（比如 `bash` 跑一条慢命令）可以监听这个 signal，在用户按下 Ctrl-C 时中断自己。为什么是可选？因为大量工具（如纯计算、快速文件读写）根本不需要理会取消，可选参数让它们的实现可以干脆忽略它。

接着看 `defineTool` 工厂（[function-tool.ts](../../src/foundation/tools/function-tool.ts#L31-L43)）：

```ts
export function defineTool<P extends z.ZodSchema<Record<string, unknown>>, R>({
  name,
  description,
  parameters,
  invoke,
}: {
  name: string;
  description: string;
  parameters: P;
  invoke: (input: z.infer<P>, signal?: AbortSignal) => Promise<R>;
}): FunctionTool<P, R> {
  return { name, description, parameters, invoke } as FunctionTool<P, R>;
}
```

它的函数体简单到只有一行 `return`——**它运行时什么都没做，只是把四个字段原样打包**。它既不调用 `parameters.toJSONSchema()`，也不做任何校验。那它存在的意义是什么？

**答案是：它存在的全部价值在于「类型推导」，而非运行时行为。** 请看它的泛型签名 `<P extends ..., R>`：当你调用 `defineTool({ parameters: z.object({ path: z.string() }), invoke: ... })` 时，TypeScript 会**从你传入的 `parameters` 实参自动推断出 `P`**，进而算出 `z.infer<P>`，于是 `invoke` 里那个 `input` 参数就**自动获得了精确类型**。这是一种叫「[**泛型参数推断**](https://www.typescriptlang.org/docs/handbook/2/functions.html#inference)」的技巧——你不用手写任何类型标注，`defineTool` 就能让 `invoke` 的 `input` 拥有和 schema 一致的类型。

> 顺带解释末尾那个 `as FunctionTool<P, R>` 断言（[function-tool.ts](../../src/foundation/tools/function-tool.ts#L43)）：对象字面量的推断类型和 `FunctionTool<P, R>` 接口在结构上等价，但 TS 对「函数参数类型」的推断有时偏保守，这里用一次 `as` 把类型收敛到目标接口。它不影响运行时，只是让类型对齐得干净——是一个务实的小妥协。

### 1.4 「一处定义，三处受益」的现场：读一个真实工具

抽象讲完，来看它怎么落地。打开最简单的 `read_file`（[read-file.ts](../../src/coding/tools/read-file.ts#L10-L21)）：

```ts
export const readFileTool = defineTool({
  name: "read_file",
  description: "Read a file from an absolute path. Supports optional line-range reads for large files.",
  parameters: z.object({
    description: z
      .string()
      .describe("Explain why you want to read the file. Always place `description` as the first parameter."),
    path: z.string().describe("The absolute path to the file to read."),
    startLine: z.number().int().positive().describe("1-based starting line to read.").optional(),
    endLine: z.number().int().positive().describe("1-based ending line to read, inclusive.").optional(),
    maxChars: z.number().int().positive().describe("Maximum characters to return from the selected range.").optional(),
  }),
  invoke: async ({ path, startLine, endLine, maxChars }) => {
    // ...
  },
});
```

就这一处 `z.object({...})`，同时兑现了三份收益：

**① 编译期类型（受益于 `z.infer<P>`）。** 看 `invoke: async ({ path, startLine, endLine, maxChars }) => ...` 这行的解构——`path` 自动是 `string`，`startLine` / `endLine` / `maxChars` 自动是 `number | undefined`。你在函数体里写 `startLine - 1` 时 IDE 会补全、写 `path.toUpperCase()` 不会报错，但写 `path * 2` 会被 `tsc` 拦下。**这套类型你一个字都没手写，全是从 schema 推来的。** 更妙的是它「活」的：哪天你把 `path` 改成 `z.number()`，`invoke` 里所有把 `path` 当字符串用的地方会**立刻编译报错**，逼你同步——漂移在编译期就被扼杀。

**② 运行期 JSON Schema（受益于 `.toJSONSchema()`）。** 这份 schema 会在工具被喂给模型前，由 community 层调用 `parameters.toJSONSchema()` 转成标准 JSON Schema（1.6 详述）。`z.string()` 变成 `{ "type": "string" }`，`.optional()` 让字段从 `required` 数组里消失——**这套 JSON Schema 你也一个字没手写。**

**③ 人类（模型）可读的描述（受益于 `.describe(...)`）。** 注意每个字段后面都挂着 `.describe("...")`。Zod 的 `.describe()` 会把这段文字写进生成的 JSON Schema 的 `"description"` 字段。于是模型不仅知道「有个叫 `path` 的字符串参数」，还知道「它应该是一个绝对路径」。**参数的语义说明，同样从这一处 schema 派生。**

一处定义（那个 `z.object`），三处受益（类型 / 结构 / 语义），且三者永远同步。这就是把「工具定义」这件事做到极致简洁的秘诀。

> 观察一个反复出现的约定：每个工具的第一个参数都是 ``description: z.string().describe("...Always place `description` as the first parameter.")``。这不是笔误，是一个**刻意的行为引导**——1.7 会专门讲它为什么重要。

### 1.5 工具产物的契约：`StructuredToolResult`（[structured-tool-result.ts](../../src/foundation/tools/structured-tool-result.ts)）

`invoke` 跑完要返回点什么。返回一个裸字符串行不行？可以，但不够好——调用方（Agent、UI、截断策略）会很想知道「这次调用**成功还是失败**、有没有**结构化数据**可供程序进一步处理、失败的话是**哪一类错误**」。于是 Helixent 定义了一份统一的结果契约（[structured-tool-result.ts](../../src/foundation/tools/structured-tool-result.ts#L1-L15)），整个文件只有 15 行：

```ts
export type StructuredToolSuccess<T = unknown> = {
  ok: true;
  summary: string;
  data?: T;
};

export type StructuredToolError = {
  ok: false;
  summary: string;
  error: string;
  code?: string;
  details?: Record<string, unknown>;
};

export type StructuredToolResult<T = unknown> = StructuredToolSuccess<T> | StructuredToolError;
```

看到熟悉的形状了吗？——这**又是一个「可辨识联合」**，和第 2 节的 `Message`、内容段是同一个模式，只不过这次的判别式（discriminator）是布尔字段 **`ok`**：

- **`ok: true`（成功支 `StructuredToolSuccess`）**：必带一段 `summary`（人类可读的一句话小结），可选带一份泛型 `data`（结构化数据，供程序消费）。
- **`ok: false`（失败支 `StructuredToolError`）**：必带 `summary` 和 `error`（错误信息），可选带 `code`（**机器可读的错误码**，如 `"FILE_NOT_FOUND"` / `"INVALID_PATH"`）和 `details`（补充上下文）。

TypeScript 靠 `ok` 这个字面量类型，能在你 `if (result.ok)` 之后**自动收窄**：`true` 分支里能访问 `.data`，`false` 分支里能访问 `.error` / `.code`——访问错了会编译报错。这和第 2 节用 `role`/`type` 收窄消息是同一套「类型安全」哲学。

这份契约不是摆设，coding 层给它配了两个极简的工厂函数（[tool-result.ts](../../src/coding/tools/tool-result.ts#L5-L17)）：

```ts
export function okToolResult<T>(summary: string, data: T): ToolResult<T> {
  return { ok: true, summary, data };
}

export function errorToolResult(error: string, code?: string, details?: Record<string, unknown>): ToolResult<never> {
  return { ok: false, summary: error, error, ...(code ? { code } : {}), ...(details ? { details } : {}) };
}
```

回头看 `mkdir` 工具（[mkdir.ts](../../src/coding/tools/mkdir.ts#L20-L33)），它把这份契约用得淋漓尽致：

```ts
invoke: async ({ path, recursive }) => {
  const absolute = ensureAbsolutePath(path);
  if (!absolute.ok) {
    return errorToolResult(absolute.error, "INVALID_PATH", { path });      // ← 失败：带 code
  }
  try {
    await mkdir(path, { recursive: recursive ?? true });
    return okToolResult(`Created directory: ${path}`, { path, recursive: recursive ?? true });  // ← 成功：带 data
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return errorToolResult(`Failed to create directory: ${path}`, "MKDIR_FAILED", { path, message });
  }
},
```

**为什么** **`summary`** **是必填、且成功失败都要有？** 因为它是喂回给模型的「一句话小结」。roadmap 里第 8 节的截断策略会用到它——当工具返回一大坨 `data` 撑爆上下文时，可以退化成只回 `summary`。这里先埋个伏笔：`summary` 是「无论如何都得给模型一个交代」的那句话，`data` 是「有余力时再附上」的结构化细节。为什么 `code` 用**字符串常量**（`"FILE_NOT_FOUND"`）而非数字？因为它要让**模型**读懂并据此决策下一步（第 8 节会讲 `inferToolErrorKind` 如何从这些码前后缀推断错误类别），字符串比数字自解释得多。

> 注意 `read_file` 是个**例外**：它成功时**不**返回 `StructuredToolResult`，而是直接返回文件原文本（[read-file.ts](../../src/coding/tools/read-file.ts#L59-L62) 有注释 `Do NOT return a structured result here`）。这是刻意的——文件内容就是要「原样」喂给模型，包一层结构反而累赘。这说明结构化结果是**推荐契约而非强制**：`FunctionTool` 的返回类型是泛型 `R`，工具可以自由返回字符串、结构化对象或任意值。统一由第 8 节的 `normalizeToolResult` 在回喂前归一化。

### 1.6 消费现场其一：工具怎么「被声明给模型」

现在验证「三处受益」里的第二处——JSON Schema 究竟怎么到模型手里。第 3 节讲过，`Tool[]` 会随 `ModelProviderInvokeParams` 传给 provider。provider 在拼请求时，把每个工具翻译成厂商的工具声明格式。

**OpenAI**（[openai/utils.ts](../../src/community/openai/utils.ts#L102-L107)）：

```ts
export function convertToOpenAITools(tools: Tool[]): ChatCompletionTool[] {
  return tools.map((tool) => ({
    type: "function",
    function: { name: tool.name, description: tool.description, parameters: tool.parameters.toJSONSchema() },
  }));
}
```

**Anthropic**（[anthropic/utils.ts](../../src/community/anthropic/utils.ts#L152-L158)）：

```ts
export function convertToAnthropicTools(tools: Tool[]): Anthropic.Tool[] {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.parameters.toJSONSchema() as Anthropic.Tool["input_schema"],
  }));
}
```

两家的核心动作一模一样，都是 **`tool.parameters.toJSONSchema()`**——**这就是「受益点②」的字面兑现**。你在 `defineTool` 里写的那份 Zod schema，此刻被 Zod 自带的能力转成标准 JSON Schema，塞进 OpenAI 的 `function.parameters` 或 Anthropic 的 `input_schema`。字段结构、类型、`required`、乃至每个字段的 `description`（受益点③），全部随之进入模型的「工具菜单」。模型读到这份菜单，才知道「我有 `read_file`，它要一个叫 `path` 的字符串」——**这正是本节核心问题②「模型怎么知道有哪些参数」的完整答案**。

两家的差异也一目了然，正好复习第 3 节的结论：OpenAI 把工具包在 `{ type: "function", function: {...} }` 里，Anthropic 是扁平的 `{ name, description, input_schema }`——**同一份 `toJSONSchema()` 产物，两个适配器各自包装成自家格式**。核心契约（`FunctionTool`）保持通用，厂商差异下沉到 community 边界。

### 1.7 消费现场其二：工具怎么「被执行」

模型读了菜单，在回复里吐出一段 `tool_use`（第 2 节的内容段：`{ type: "tool_use", id, name, input }`）。接下来轮到执行。看 Agent 主循环的 `_act`（[agent.ts](../../src/agent/agent.ts#L223-L233)，第 5、6 节会完整精讲，这里只看和工具直接相关的三行）：

```ts
const tool = this.tools?.find((t) => t.name === toolUse.name);   // ① 按名字查找工具
if (!tool) throw new Error(`Tool ${toolUse.name} not found`);
// ...（省略审批中间件）
const result = await tool.invoke(toolUse.input, signal);          // ② 执行，把模型给的 input 传进去
```

链路闭环了：

1. **查找**：拿模型给的 `toolUse.name` 去 `this.tools` 里 `find` 出对应的 `FunctionTool`。这就是为什么工具**必须有唯一的 `name`**。
2. **执行**：调 `tool.invoke(toolUse.input, signal)`。`toolUse.input` 就是模型按 JSON Schema 生成的参数对象，`signal` 是第 5 节的取消信号，透传给工具。

把 1.3～1.7 串起来，一次完整的工具调用生命周期就清晰了：

```
defineTool 定义（1.3）
   │  parameters: Zod schema
   ▼
toJSONSchema() 翻译（1.6）──► 喂给模型 ──► 模型生成 tool_use{ name, input }
                                                        │
                                                        ▼
                              agent._act 按 name 查找工具（1.7）
                                                        │
                                                        ▼
                              tool.invoke(input, signal) 执行（1.4）
                                                        │
                                                        ▼
                              返回 StructuredToolResult（1.5）──► 归一化后回喂模型（第 8 节）
```

### 1.8 `description` 第一参数：一个刻意的行为约定

回到 1.4 埋的那个伏笔。你会发现**每一个** coding 工具的参数第一位都是 `description`（[read-file.ts](../../src/coding/tools/read-file.ts#L14-L16)、[str-replace.ts](../../src/coding/tools/str-replace.ts#L12-L14)、[mkdir.ts](../../src/coding/tools/mkdir.ts#L14-L16) 全都如此），且描述文字里都带一句 ``Always place `description` as the first parameter``：

```ts
description: z
  .string()
  .describe("Explain why you want to read the file. Always place `description` as the first parameter."),
```

这个 `description` 参数**对工具的功能毫无用处**——`read_file` 的 `invoke` 里根本没解构它、没用它。那为什么每个工具都强制要一个？

**因为它是给模型的「先解释再动手」的行为引导。** 让模型在调用工具前，先在 `description` 里写清「我为什么要读这个文件」，等于逼它**先想一步、把意图外显出来**。这有三重好处：(1) 模型自己会因此调用得更审慎（表达意图的过程本身促进推理）；(2) UI 渲染工具调用时（第 19/20 节）能直接把这句 `description` 展示给人类看，一眼知道 Agent 在干嘛、为什么干；(3) 放在**第一个**参数，是利用「模型倾向于按顺序生成参数」的特性——让它**先**生成意图、**再**生成具体参数，顺序上强化了「三思而后行」。

这是一个极轻量却极有效的 prompt engineering 技巧：**不靠系统提示词长篇大论,而是把「先说明意图」这条规则,直接编码进每个工具的参数结构里**——模型想调用工具，就绕不开先填这个字段。

### 1.9 桶文件与导出：`Tool` 也从 `@/foundation` 出来

和前两节收尾一样，看这些类型怎么被导出。[tools/index.ts](../../src/foundation/tools/index.ts) 又是一个极薄的桶文件：

```ts
import type { FunctionTool } from "./function-tool";

export * from "./function-tool";
export * from "./structured-tool-result";

export type Tool = FunctionTool;
```

这里多了一行值得注意：**`export type Tool = FunctionTool;`**。它给 `FunctionTool`（用默认泛型）起了个更短、更中性的别名 `Tool`。为什么？因为在**上层代码**（`agent.ts`、provider、`lead-agent.ts`）眼里，它们不关心一个工具的参数是什么具体形状，只把它当「一个可以调用的东西」——用 `Tool` 这个不带泛型的名字，比 `FunctionTool<...>` 清爽得多。而 `defineTool` 的作者需要完整的泛型推导，才用带泛型的 `FunctionTool<P, R>`。**一个类型，两个名字，各取所需。**

再往上被 [foundation/index.ts](../../src/foundation/index.ts) 汇总（`export * from "./tools"`），于是全项目任何地方都能写：

```ts
import { defineTool } from "@/foundation";                          // 定义工具
import type { Tool, FunctionTool, StructuredToolResult } from "@/foundation";  // 消费类型
```

你在每个 coding 工具文件顶部（`import { defineTool } from "@/foundation"`）、在两个 provider 的 `convertToXxxTools`（`import type { ... Tool } from "@/foundation"`）里看到的，都是这一个门。这第三次印证了第 1 节的「桶文件 + 全具名导出 + `@/*` 别名」——**地基的每一块（数据 / 模型 / 工具），都只从** **`@/foundation`** **这一个入口出来。**

***

## 2. 亮点与关键设计

1. **`defineTool` 工厂 + Zod schema：「一处定义，三处受益」——本节思想内核。**
   参数只写一份 `z.object({...})`，就同时派生出：① `invoke` 入参的**编译期 TS 类型**（`z.infer<P>`）、② 喂给模型的**运行期 JSON Schema**（`.toJSONSchema()`）、③ 每个参数的**语义描述**（`.describe()` 进 JSON Schema 的 `description`）。三者由同一真相源派生，**永不漂移**。`defineTool` 本身运行时零逻辑，全部价值在于泛型推断让你「不手写类型」。

2. **`StructuredToolResult` 的可辨识联合契约——`{ ok, summary, data | error, code }`。**
   用布尔 `ok` 作判别式，成功/失败两支各带专属字段，TS 自动收窄。`summary` 必填（第 8 节截断策略的落脚点），`code` 用**字符串常量**便于模型读懂并决策。这份契约推荐而非强制（`read_file` 就返回裸文本），保留了灵活性。

3. **`description` 强制第一参数——把行为引导编码进类型。**
   每个工具都要一个对功能无用、却逼模型「先解释意图再动手」的 `description` 参数。这是把 prompt engineering **下沉进参数结构**的巧思：既促进模型审慎推理，又让 UI 能展示「Agent 在干嘛」。

4. **泛型贯穿的类型安全——`FunctionTool<P, R>` 与 `Tool` 别名。**
   定义端用带泛型的 `FunctionTool<P, R>` 吃满推导；消费端用中性别名 `Tool` 保持清爽。`AbortSignal` 可选第二参数，为第 5 节的贯穿式取消预留接口。

***

## 3. 工业对比

把 Helixent 的工具系统与业界主流放一起看：

| 维度 | Helixent | OpenAI SDK（原生） | LangChain | Vercel AI SDK |
| --- | --- | --- | --- | --- |
| 参数规格来源 | **一份 Zod schema** | **手写 JSON Schema** | Zod / 手写 schema（`StructuredTool`） | 一份 Zod schema（`tool({ parameters })`） |
| TS 类型从哪来 | `z.infer` 自动推导 | **另外手写**（易漂移） | 从 schema 推导 | 从 schema 推导 |
| JSON Schema 从哪来 | `.toJSONSchema()` 自动生成 | 就是你手写的那份 | 从 schema 生成 | 从 schema 生成 |
| 定义方式 | `defineTool({...})` 工厂 | 裸对象 + 手写 handler | `tool()` / `class extends StructuredTool` | `tool({...})` |
| 结果契约 | `StructuredToolResult`（`ok/summary/data/code`） | 返回字符串，格式自定 | `ToolMessage`（字符串/结构） | 返回值序列化为字符串 |
| 抽象重量 | **极薄**（2 文件 <60 行） | 无抽象（贴着 API） | 较重（类继承、回调、多种基类） | 中（函数式，功能全） |

几点读法：

- **「一份 schema 派生一切」是现代工具系统的共识，Helixent / Vercel AI SDK / LangChain 殊途同归。** 它们都认识到「手写两份规格必然漂移」这个痛点，选择用 Zod（或类似 schema 库）当单一真相源。**对比之下，OpenAI 原生 SDK 是最痛的**——你得手写 JSON Schema 喂给 API，再**另外**手写 TS 类型给自己的 handler，两份全靠人肉同步。Helixent 用 `defineTool` + `z.infer` + `toJSONSchema()` 把这个痛点消灭得干干净净。
- **抽象的「薄」依然是刻意的。** LangChain 的工具体系功能全面（多种基类、回调、错误处理钩子），但概念也重；Helixent 只有一个 `defineTool` 工厂 + 一个 `FunctionTool` 接口 + 一份结果契约，**一眼能读完**。它和 Vercel AI SDK 的 `tool()` 在气质上最接近——都走「一个工厂函数 + Zod」的极简路线。
- **结果契约是 Helixent 的一个加分项。** OpenAI / Vercel 大多让工具返回字符串（或自动序列化），把「成功/失败/错误码」的语义留给你自己在字符串里塞。Helixent 用 `StructuredToolResult` 把这套语义**类型化**了（`ok` / `code` / `summary` / `data`），让上层（截断策略、错误分类、UI）能程序化地处理结果——这为第 8 节那套精细的结果处理管线打下了地基。

***

## 4. 深度解释：为什么这样设计？不这样会怎样？

**Q1：为什么用 Zod，而不是让工具作者直接手写 JSON Schema？**
因为要消灭「**两份真相**」。模型要 JSON Schema、代码要 TS 类型，本是同一份参数规格的两种投影。若手写 JSON Schema，你就**必须再手写一份 TS 类型**给 `invoke` 用，两者靠人肉同步，加个字段忘了改另一处就出 bug。Zod 是「**一份定义，双向投影**」的最佳载体：`z.infer` 投影出 TS 类型、`toJSONSchema()` 投影出 JSON Schema。写一次，两处自动同步，且**编译器会替你守护同步**——改了 schema，用错类型的地方立刻红。代价是引入一个 `zod` 依赖并绑定它的 API，但对一个「工具会越加越多」的框架，这笔账极其划算。

**Q2：`defineTool` 运行时什么都不做，就一行 `return`，为什么不直接写对象字面量？**
因为 `defineTool` 买的不是运行时行为，而是**类型推断的入口**。如果你直接写对象字面量 `const tool: FunctionTool = { ... }`，TS 无法从 `parameters` 反推 `invoke` 的 `input` 类型——你要么手动标注 `invoke` 的入参（又回到「手写类型」的老路），要么失去类型安全。`defineTool<P, R>(...)` 的泛型签名让 TS **从你传入的 `parameters` 实参自动捕获 `P`**，进而算出 `z.infer<P>` 喂给 `invoke`。这是「用一个泛型工厂函数换取自动类型推导」的经典手法（Vercel AI SDK 的 `tool()`、许多表单库的 `defineSchema` 都是同一招）。**它的函数体空得理直气壮——因为它的活儿全在编译期干完了。**

**Q3（一处诚实的精读发现）：`invoke` 的类型是 `z.infer<P>`，但执行时 `agent._act` 直接把模型给的 `toolUse.input` 传进去，中间并没有调用 `parameters.parse(...)` 做运行时校验——这不危险吗？**
是的，这是一个真实存在的「类型信任跳跃」。[agent.ts](../../src/agent/agent.ts#L231) 里是 `await tool.invoke(toolUse.input, signal)`，`toolUse.input` 的静态类型是 `Record<string, unknown>`，被当作 `z.infer<P>` 传入——**编译期假设它合法，运行期却没用 Zod 强制校验**。这背后是一个刻意的信任链：provider 的 `StreamAccumulator`（第 16/17 节）保证「工具参数的 JSON 没解析完整前，绝不吐出 `tool_use`」，所以到达 `_act` 的 `input` 至少是**合法的 JSON 对象**。至于「字段是否齐全、类型是否精确」，则由**工具的** **`invoke`** **内部自己防御**——你回看 `read_file` / `mkdir`，第一件事都是 `ensureAbsolutePath(path)` 之类的手动检查，用 `errorToolResult(..., "INVALID_PATH")` 兜住非法输入。**这是一种「乐观 + 就地兜底」的取舍**：省掉每次调用都跑一遍 Zod 校验的开销，把校验责任分散进各工具的业务逻辑里。代价是 `parameters` 那份 schema 在运行期只用于「生成 JSON Schema」，并不用于「校验输入」——它的运行期职责比你初看时以为的要窄。理解这一点，你才算真正读懂了这套工具系统的边界。

**Q4：为什么工具结果要设计成结构化的 `{ ok, summary, data }`，而不是干脆都返回字符串？**
因为**下游有多个消费者，且各自需要不同粒度的信息**。模型需要一段能读懂的文字（`summary` / `error`）；截断策略（第 8 节）需要知道「哪部分是可省略的 `data`、哪部分是无论如何要保留的 `summary`」；错误分类逻辑需要机器可读的 `code`；UI 可能想展示结构化的 `details`。如果全塞进一个字符串，这些消费者就得各自去**解析字符串**，脆弱且易错。用一个可辨识联合把语义**类型化**，等于给下游一份「结构化的契约」，各取所需、编译器护航。当然它不强制——`read_file` 返回裸文本正说明「原始内容就该原样传」时可以豁免，统一由第 8 节的归一化层兜底。**核心求稳（有契约），边界求活（可豁免）**，这与第 2、3 节 `ToolUseContent<T>` / `options` 口袋是同一种哲学。

**Q5：`invoke` 的 `signal?: AbortSignal` 为什么是可选的第二参数，而不是塞进 `input` 里？**
因为 `signal` 和业务参数是**两种正交的东西**：`input` 是「模型决定的、随每次调用变化的业务数据」，`signal` 是「运行时环境注入的、与业务无关的控制信号」。把它们混在一起，`input` 的类型就会被 `AbortSignal` 污染，`z.infer<P>` 也没法干净推导。作为**独立的第二参数**，它既不干扰参数类型推导，又能让**需要它的工具**（如 `bash` 监听中断）用、**不需要的工具**（如纯计算）直接忽略——可选性把「是否关心取消」的选择权交给了每个工具自己。这与第 3 节 `ModelContext.signal`、第 5 节 `AbortController` 一脉相承：**取消信号作为一条独立的「控制通道」贯穿全链路**，而非混进数据通道。

***

## 5. 参考资料

- 本项目源码：[function-tool.ts](../../src/foundation/tools/function-tool.ts)、[structured-tool-result.ts](../../src/foundation/tools/structured-tool-result.ts)、[tools/index.ts](../../src/foundation/tools/index.ts)、[foundation/index.ts](../../src/foundation/index.ts)
- 真实工具样本：[read-file.ts](../../src/coding/tools/read-file.ts)、[str-replace.ts](../../src/coding/tools/str-replace.ts)、[mkdir.ts](../../src/coding/tools/mkdir.ts)、[tool-result.ts](../../src/coding/tools/tool-result.ts)
- 单元测试（印证 `defineTool` 与结果契约）：[foundation/\_\_tests\_\_/tools.test.ts](../../src/foundation/__tests__/tools.test.ts)
- Zod · 类型推导 `z.infer`：<https://zod.dev/?id=type-inference>
- Zod · 转 JSON Schema：<https://zod.dev/json-schema>
- OpenAI · Function Calling（工具声明格式）：<https://platform.openai.com/docs/guides/function-calling>
- Anthropic · Tool Use（`input_schema` 格式）：<https://docs.anthropic.com/en/docs/build-with-claude/tool-use>
- Vercel AI SDK · `tool()`（同类极简工具工厂）：<https://sdk.vercel.ai/docs/ai-sdk-core/tools-and-tool-calling>
- JSON Schema 规范：<https://json-schema.org/>
- 上游依赖：[第 1 节 · 项目全景与四层架构](./01-overview.md)、[第 2 节 · Message 消息类型系统](./02-message.md)、[第 3 节 · Model 与 ModelProvider](./03-model.md)

***

## 6. 小结与下一节预告

本节你应该已经吃透了「地基的第三块砖」——**工具系统**：

- **工具的形状**：一个工具 = `name` + `description` + `parameters`（Zod schema）+ `invoke`（执行函数）。`defineTool` 是一个运行时零逻辑、纯为类型推导而生的工厂。
- **一处定义，三处受益**：你只写一份 `z.object({...})`，就自动派生出 ① `invoke` 入参的 TS 类型（`z.infer<P>`）、② 喂给模型的 JSON Schema（`.toJSONSchema()`）、③ 参数的语义描述（`.describe()`）。三者永不漂移——这是本节的思想内核。
- **结构化结果契约**：`StructuredToolResult` 用 `ok` 判别成功/失败，`summary` 必填、`code` 用字符串常量，为第 8 节的结果处理管线打好地基（推荐而非强制，`read_file` 可豁免返回裸文本）。
- **`description` 第一参数**：把「先解释意图再动手」的行为引导，直接编码进每个工具的参数结构。
- **完整链路**：`defineTool` 定义 → `toJSONSchema()` 喂模型 → 模型生成 `tool_use` → `agent._act` 按名查找 → `tool.invoke(input, signal)` 执行 → 返回结构化结果。也回收了第 3 节的钩子：`ModelContext.tools` 里躺的，正是这一节的 `FunctionTool`。
- 一处诚实的边界：运行期并不用 Zod 二次校验 `input`，schema 的运行期职责仅限「生成 JSON Schema」，输入合法性由 provider 的累积器 + 工具内部的防御性检查共同兜底。

至此，**Foundation 三块地基（数据 / 模型 / 工具）全部就位**。回望这三节：第 2 节的 `Message` 是「流动的数据」，第 3 节的 `Model` 是「会说话的嘴」，第 4 节的 `Tool` 是「能动手的手」。但它们此刻还是**三个静止、互不相干的零件**——`Model` 不会自己去调 `Tool`，`Tool` 的结果也不会自己回到 `Model` 面前。

**承上启下（启下）**：把这三个零件串成一台**会自主运转的机器**，需要一个「循环」——一个能反复「让模型思考 → 执行工具 → 把结果喂回模型 → 再思考」的引擎。这正是整个项目的**心脏**：

> **Agent 是怎么「一步步思考并行动」的？这个循环在什么时候开始、又在什么条件下停下来？模型的输出如何触发工具调用、工具的结果又如何回流成下一轮思考的输入？**

这就是第三部分 **Agent 层**的主题。下一节我们钻进 [agent.ts](../../src/agent/agent.ts) 的 `stream` 与 `_think`，看这台 ReAct 引擎的**控制流骨架**如何搭起来（并发执行多个工具的细节，会刻意留到第 6 节）。

👉 下一节 **第 5 节：ReAct 主循环 —— think / act / observe 的骨架**。这是全书最该吃透的一节——它把前三节的静止零件，第一次真正地转了起来。

准备好后，对我说「**生成第 5 节**」即可。
