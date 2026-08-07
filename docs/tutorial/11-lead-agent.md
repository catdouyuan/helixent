# 第 11 节：Lead Agent —— 系统提示词、工具装配与 AGENTS.md

> 本节属于 **第四部分 · Coding 层（面向编程的专用 Agent）**，是整个第四部分的**开篇与总装图**。前十节我们**自底向上**造好了所有零件：[第 2 节](./02-message.md) 的 `Message`、[第 3 节](./03-model.md) 的 `Model`、[第 4 节](./04-tool.md) 的 `defineTool`、[第 5～6 节](./05-react-loop.md) 的 ReAct 主循环、[第 7 节](./07-middleware.md) 的中间件插座、以及插在插座上的 [第 8](./08-tool-result-pipeline.md)/[9](./09-skills.md)/[10](./10-todos.md) 三大插件。本节要做的，是**把这些零件拼成一台"会写代码"的成品机器**。
>
> 对应 roadmap 为本节设定的**核心问题**：
>
>> 一个「会写代码的 Agent」是如何被组装出来的？系统提示词里藏了哪些引导？
>>
>
> **一句边界声明**：本节精讲**一个文件**——[lead-agent.ts](../../src/coding/agents/lead-agent.ts)（120 行，绝对主角，也是整个 `coding` 层的入口），外加两个各只有一两行的**桶文件（barrel）** [coding/agents/index.ts](../../src/coding/agents/index.ts) 和 [coding/index.ts](../../src/coding/index.ts)。本节是一张**「装配总图」**：它会**引用**十几个尚未细看的工具（`read_file`、`bash`、`apply_patch`……）和已经看过的三个中间件，但**不拆开它们**——工具的内部实现是 [第 12～15 节](./00-roadmap.md) 的主题，本节只负责讲清「**这些零件按什么规则、什么顺序、被谁注入，最终拼成一个 `Agent` 实例**」。换句话说：前十节讲"零件怎么造"，本节讲"整机怎么装"；下四节再回头讲"每个被装进来的零件内部长啥样"。

---

## 0. 承上启下

[第 10 节](./10-todos.md) 结尾，我们讲完了插在"中间件插座"上的**三个插件**，并在收尾时**明确埋下了本节的钩子**。原话是这样的：

> 一个**通用**的 Agent 大脑已经彻底完备了……但请注意"通用"二字——**它还不是一个"会写代码"的 Agent**。它不知道该配哪些工具（读文件？跑命令？打补丁？），也没有一份"我是一个编程助手、我该怎么在项目里干活"的人设。**把这台通用大脑"特化"成一个专门的 Coding Agent**……是第四部分的任务。而这一切的"总装线"，就是那个工厂函数 `createCodingAgent`。

第 10 节还**预告了一个具体悬念**：

> 第 11 节你会看到 `createCodingAgent` 里那段 XML 风格的系统提示词——里面藏着 `<tool_usage>` 行为约束、`<notes>` 边界声明，甚至会**自动加载项目根目录的 `AGENTS.md` 当作长期记忆**。通用大脑的"人格"，就是在那里被注入的。

本节就来兑现这个悬念。让我们先把"通用大脑"和"专用 Coding Agent"的差距摆清楚，你才会明白 `createCodingAgent` 到底在做什么。

**回忆 [第 5 节](./05-react-loop.md) 的 `Agent` 类。** 它的构造函数（[agent.ts](../../src/agent/agent.ts#L65-L91)）需要五样东西：

```ts
new Agent({
  model,        // 用哪个模型？        —— 第 3 节，但"具体哪个"没定
  prompt,       // 系统提示词是什么？   —— 第 5 节留空，纯占位
  messages,     // 初始对话历史？       —— 默认空数组
  tools,        // 能调哪些工具？       —— 第 4 节定义了"工具长啥样"，但没说"配哪几个"
  middlewares,  // 插哪些中间件？       —— 第 7~10 节造好了中间件，但没说"插哪几个、什么顺序"
});
```

看到了吗？`Agent` 类本身是**彻底通用**的——它是一副"空骨架"，五个槽位全是空的。**它不知道自己是干嘛的**：你给它配一组"查天气/订机票"的工具，它就是个旅行助手；给它配"读文件/改代码/跑命令"的工具 + 一段"你是编程助手"的提示词，它才成为一个 Coding Agent。

**`createCodingAgent` 就是那个"往五个槽位里填正确零件"的工厂。** 它做的全部事情，就是回答上面五个问号：

| 槽位            | `createCodingAgent` 填了什么                                          | 本节小节 |
| --------------- | ----------------------------------------------------------------------- | -------- |
| `model`       | **调用方注入**（不硬编码，见 1.2）                                | 1.2      |
| `prompt`      | 一段**XML 风格的系统提示词**（人设 + 工作目录 + 工具用法约束）    | 1.4      |
| `messages`    | 若项目根有`AGENTS.md`，**自动加载为一条 seed 消息**（长期记忆） | 1.3      |
| `tools`       | **12 个编程工具** + 1 个可选的提问工具                            | 1.5      |
| `middlewares` | **Skills + Todos + 可选的审批**三大中间件                         | 1.6      |

打开 [lead-agent.ts](../../src/coding/agents/lead-agent.ts)，我们开始拆这张总装图。

---

## 1. 主题内容

### 1.1 先想清楚问题：如果让你来"组装"一个 Coding Agent，你要做哪些决定？

老规矩，看代码前先自己当一次设计者。你手上已经有了一副空骨架 `Agent`，现在要把它组装成一个能在用户项目目录里干活的编程助手。你至少要拍板五个决定：

1. **模型从哪来？** 是在工厂里 `new OpenAIModelProvider(...)` 写死，还是让调用方传进来？——这决定了这个工厂**能不能被复用**（CLI 用、测试用、别的程序用）。
2. **系统提示词怎么写？** 用一段大白话散文，还是用结构化的标签？要塞进哪些"行为约束"（比如"改文件前先读文件"）？——这决定了 Agent 的**行为质量**。
3. **要不要给它"项目记忆"？** 同一个 Agent 面对不同项目，怎么让它快速知道"这个项目的约定"（用什么框架、跑什么命令）？——这就是 `AGENTS.md` 要解决的。
4. **配哪些工具？** 读文件、写文件、跑命令、搜索、打补丁……一个个列进 `tools` 数组。哪些是必备的？哪些是**看情况才给**的？
5. **插哪些中间件、什么顺序？** Skills、Todos、审批——它们的**顺序**会不会影响行为（回忆第 9、10 节的"接力叠加"）？哪些是**可选**的？

**关键洞察**：这五个决定里，有一条贯穿始终的分界线——**"哪些东西工厂自己决定，哪些东西让调用方注入"**。

- **工厂自己决定的**：系统提示词的内容、配哪 12 个工具、三大中间件的顺序——这些是"一个 Coding Agent 之所以是 Coding Agent"的**本质**，不该让调用方操心。
- **让调用方注入的**：用哪个模型、扫哪些技能目录、审批时怎么"问人"、白名单存哪——这些是**环境相关**的，CLI 有 CLI 的答案、测试有测试的答案、headless 脚本有另一套答案。

这条分界线，就是 `createCodingAgent` 参数设计的灵魂：**本质写死在函数体里，环境通过参数注入。** 想清楚这一点，下面每一段代码的取舍就都顺理成章了。我们**从外到内**看：先看工厂的"接口"（签名/参数），再看它依次填充的五个槽位（记忆 → 提示词 → 工具 → 中间件），最后看调用方（CLI）如何注入环境、拼成最终产品。

### 1.2 工厂签名：依赖注入式的参数设计（[lead-agent.ts](../../src/coding/agents/lead-agent.ts#L31-L47)）

先看这个 `async` 工厂函数的签名：

```ts
export async function createCodingAgent({
  model,                                             // 必填：用哪个模型
  cwd = process.cwd(),                               // 工作目录，默认当前目录
  skillsDirs = [join(process.cwd(), ".agents/skills")], // 技能目录，默认只扫一个
  askUser,                                           // 可选：审批时如何"问人"
  askUserQuestion,                                   // 可选：主动提问时如何"问人"
  approvalPersistence,                               // 可选：白名单读写契约
}: {
  model: Model;
  cwd?: string;
  skillsDirs?: string[];
  askUser?: (toolUse: ToolUseContent) => Promise<ApprovalDecision>;
  askUserQuestion?: (params: AskUserQuestionParameters) => Promise<AskUserQuestionResult>;
  approvalPersistence?: ApprovalPersistence;
}) {
```

这个签名把 1.1 的"分界线"落到了实处。逐个看参数：

- **`model: Model`（唯一必填）**：呼应 [第 3 节](./03-model.md)。工厂**不 `new` 任何 Provider**——用 OpenAI 还是 Anthropic、baseURL、API Key，全是调用方的事（[cli/index.tsx](../../src/cli/index.tsx#L44-L62) 里根据配置 `new` 好一个 `Model` 再传进来）。**这是最关键的一次依赖注入**：它让 `createCodingAgent` 与"具体哪家模型"彻底解耦，第 16/17 节的两个 Provider 都能无缝接入。
- **`cwd = process.cwd()`**：Agent 要在**哪个目录**里干活。默认当前进程目录。这个值会被**用两次**：拼 `AGENTS.md` 路径（1.3）、填进系统提示词的 `<working_directory>`（1.4）。
- **`skillsDirs`（默认只有一个 `.agents/skills`）**：呼应 [第 9 节](./09-skills.md)。注意**库的默认值很克制**——只扫项目下的 `.agents/skills`；而 CLI 会把它扩充成 5 个目录（1.7 详述）。这正是"库给最小默认、产品层按需扩充"的分层。
- **`askUser?` / `askUserQuestion?`（可选回调）**：这两个是 [第 15 节](./00-roadmap.md)（人机确认）的**注入点**。类型都是 `(...) => Promise<...>`——**工厂只要一个"能问人的函数"，完全不关心"人在哪、怎么问"**（是终端弹窗？是 Web 表单？还是自动应答的测试桩？）。`?` 意味着**可以不传**——不传就得到一个"不需要人盯着"的 headless Agent（Q5 详述）。
- **`approvalPersistence?`（可选契约）**：审批白名单的读写契约（"这个工具我永久允许"存哪、怎么读）。同样是接口注入，具体落盘留到 [第 18 节](./00-roadmap.md)。

**为什么整个函数是 `async` 的？** 因为它体内要 `await agentsFile.exists()` 和 `await agentsFile.text()`（1.3 读 `AGENTS.md`）——读磁盘是异步的。所以调用方必须 `const agent = await createCodingAgent(...)`（[cli/index.tsx](../../src/cli/index.tsx#L74)）。

> 📌 **一个 lint 细节**：源码里 `askUser`、`askUserQuestion` 的类型定义上方各有一行 `// eslint-disable-next-line no-unused-vars`。这不是"没用到"——而是 ESLint 对**函数类型里的形参名**（`toolUse`、`params`）会误报"未使用"，这里手动豁免。这类"给类型签名里的参数起个有意义的名字、但 lint 看不懂"的小豁免，在 TS 项目里很常见（第 21 节会讲这套 lint 规范）。

### 1.3 长期记忆：自动加载 `AGENTS.md` 为一条 seed 消息（[lead-agent.ts](../../src/coding/agents/lead-agent.ts#L48-L61)）

填充 `messages` 槽位的逻辑，是本节 roadmap 点名的三大亮点之一——**自动加载项目根 `AGENTS.md` 作为长期记忆**：

```ts
const agentsFile = Bun.file(`${cwd}/AGENTS.md`);
const messages: NonSystemMessage[] = [];
if (await agentsFile.exists()) {
  const agentsFileContent = await agentsFile.text();
  messages.push({
    role: "user",
    content: [
      {
        type: "text",
        text: "> The `AGENTS.md` file has been automatically loaded. Here is the content:\n\n" + agentsFileContent,
      },
    ],
  });
}
```

**先说"是什么"。** `AGENTS.md` 是放在项目根目录的一份 Markdown 文件，写着**这个项目的约定**——用什么技术栈、跑什么命令、有哪些代码规范、目录怎么组织。本仓库自己就有一份（[AGENTS.md](../../AGENTS.md)），开头就是"Helixent is a small library for building ReAct-style agent loops on the Bun stack..."，还列了四层架构、测试怎么跑、`bun run check` 是质量门禁等等。**它是给 Agent 看的"项目说明书 + 长期记忆"。**

**再看这段代码的三个关键决策：**

**决策一：`Bun.file(...).exists()` —— "有就加载，没有就算了"。** 用 [第 21 节](./00-roadmap.md) 会讲的 Bun 原生文件 API 检查 `AGENTS.md` 是否存在。**不存在？`if` 不进，`messages` 保持空数组，Agent 照常启动。** 这和第 9 节 Skills 的"宽容发现"是同一种容错哲学——**项目记忆是"锦上添花"，绝不能因为它缺失就让 Agent 起不来**。

**决策二（最精妙）：作为 `role: "user"` 消息注入，而不是拼进 `system` prompt。** 这是最容易被忽略、也最值得琢磨的一点。`AGENTS.md` 的内容明明是"系统级"的项目背景，为什么不直接拼进 1.4 那段系统提示词，而要**伪装成一条用户消息**塞进 `messages`？

答案藏在那句**前缀**里：`"> The \`AGENTS.md\` file has been automatically loaded. Here is the content:\n\n"`。这个 `>` 是 Markdown 引用块语法，整句话是**说给模型听的旁白**："这条消息不是用户真的打字发的，是系统帮你自动加载的项目文件。" 把它放进对话历史（`messages`）而非系统提示词，有几个好处（Q1 会详谈）：

- **它是"对话的一部分"**，模型能像对待任何上下文那样自然地引用它、在后续追问时回看它；
- **系统提示词保持"纯粹的人设"**（1.4 那段 XML），不被具体项目的内容"污染"——换个项目，system prompt 一字不变，变的只是这条 seed 消息；
- **它天然带"时间位置"**：作为**第一条**消息出现在用户真正的问题**之前**，模型读到的顺序就是"先了解项目背景，再看用户要干嘛"。

**决策三：`NonSystemMessage[]` 的类型约束。** `messages` 声明为 [第 2 节](./02-message.md) 的 `NonSystemMessage[]`（[message.ts](../../src/foundation/messages/types/message.ts#L54)，即 `UserMessage | AssistantMessage | ToolMessage`）。**系统消息是不允许出现在这里的**——因为 `system` prompt 由 `Model` 在 [第 3 节](./03-model.md) 统一拼装（`_buildModelProviderParams` 里 `context.prompt` → `{ role: "system", ... }`，见 [model.ts](../../src/foundation/models/model.ts#L50-L63)）。这条类型约束**从编译期就杜绝了"在对话历史里混入 system 消息"的错误**——这正是第 2、3 节"单一数据源 + system 由 Model 统管"设计在这里兑现的红利。

> ⚠️ **一个诚实的小坑（Q6 详述）**：`AGENTS.md` 是在**工厂运行时**（启动那一刻）注入 `messages` 的。而 TUI 的 `/clear` 命令会调 `agent.clearMessages()`（[agent.ts](../../src/agent/agent.ts#L131-L133)）把 `messages` 数组**整个清空**——**连这条 `AGENTS.md` seed 消息一起清掉**，且不会重新加载。这算不算 bug？放到 Q6 摊开讲。

### 1.4 系统提示词：XML 风格的"人设"注入（[lead-agent.ts](../../src/coding/agents/lead-agent.ts#L80-L101)）

填充 `prompt` 槽位的，是这段 **XML 风格的系统提示词**——它就是通用大脑被注入的"人格"。完整照抄：

```
<agent name="Helixent" role="leading_agent" description="A coding agent">
Use the given tools and skills to perform parallel/sequential operations and solve the user's problem in the given working directory.
</agent>

<working_directory dir="${cwd}/" />

<tool_usage>
- Inspect directories before assuming file paths.
- Prefer list_files or glob_search to discover files.
- Prefer grep_search to locate relevant content.
- Read a file before editing it.
- Prefer apply_patch for targeted edits.
- If apply_patch fails, re-read the file and choose a safer edit strategy.
- Do not repeat the same failing tool call with unchanged invalid input.
- Use tool result summaries and error codes to decide the next step.
</tool_usage>

<notes>
- Never try to start a local static server. Let the user do it.
- If the user's input is a simple task or a greeting, you should just respond with a simple answer and then stop.
</notes>
```

它由**三个 XML 块**组成，各司其职：

**① `<agent>` —— 身份与总纲。** 用属性声明"我是谁"（`name="Helixent"`、`role="leading_agent"`——注意 "leading agent" 这个词，暗示未来可能有"子 agent"），标签内容是一句话总纲："用给定的工具和技能，在给定的工作目录里，串行/并行地解决用户的问题。" 这句话把 [第 6 节](./06-parallel-tools.md) 的"并行工具调度"能力也点了出来（`parallel/sequential operations`）。

**② `<working_directory dir="${cwd}/" />` —— 空间锚点。** 一个自闭合标签，把 1.2 的 `cwd` 插值进去。**这是模型的"你在这里"**——它读文件、跑命令时的路径基准。注意这里用了模板字符串插值 `${cwd}`，所以**每个不同的工作目录，都会得到一段略微不同的系统提示词**。

**③ `<tool_usage>` —— 行为约束（本节重点）。** 这 8 条 bullet 是整段提示词的**灵魂**，它们不是泛泛的"好好干活"，而是**每一条都对应一个真实的工具或一个真实的坑**——本质上是一份"用工具的最佳实践清单"，而这些工具正是 [第 12～15 节](./00-roadmap.md) 要拆的。我们逐条对照：

| `<tool_usage>` 约束                                                   | 对应的工具 / 意图                                                       | 将在哪节详解 |
| ----------------------------------------------------------------------- | ----------------------------------------------------------------------- | ------------ |
| Inspect directories before assuming file paths                          | 别瞎猜路径，先看目录                                                    | §13         |
| Prefer`list_files` or `glob_search` to discover files               | 发现文件用这俩                                                          | §13         |
| Prefer`grep_search` to locate relevant content                        | 找内容用 grep                                                           | §13         |
| **Read a file before editing it**                                 | 改文件前先读——**防止盲改**                                      | §12         |
| Prefer`apply_patch` for targeted edits                                | 精确改动优先用补丁                                                      | §14         |
| If`apply_patch` fails, re-read and choose a safer strategy            | 补丁失败后的**退路**                                              | §14         |
| **Do not repeat the same failing tool call**                      | 别拿同样的错误输入死磕——**防止死循环**                          | 呼应 §8     |
| **Use tool result summaries and error codes** to decide next step | 用[第 8 节](./08-tool-result-pipeline.md) 的 `summary`/`code` 做决策 | §8          |

看清楚了吗？**这张表就是本节作为"总装图"的最好证明**——系统提示词里的每一条引导，都在为后面几节要装进来的工具"打预防针"。尤其最后两条，直接呼应了 [第 8 节](./08-tool-result-pipeline.md) 那套 `{ ok, summary, code }` 结构化结果契约：**提示词明确教模型"看 summary 和 error code 来决定下一步、别拿同样的烂输入死磕"**——第 8 节我们造好了这套结构化错误，这里就在提示词里"激活"了它的用途。

**④ `<notes>` —— 边界声明。** 两条"别做什么"：别自己起本地静态服务器（交给用户）、简单任务/打招呼就直接简短回答然后停（别小题大做、别为了用工具而用工具）。这两条是"降噪"——防止 Agent 在琐碎场景下过度行动。

**这段提示词最后怎么变成模型看到的 `system` 消息？** 回忆 [第 3 节](./03-model.md)：它作为 `prompt` 传给 `new Agent`，存进 `agentContext.prompt`；每步 `_think` 时被拷进 `modelContext.prompt`（[agent.ts](../../src/agent/agent.ts#L181-L186)，还会被 Skills/Todos 中间件追加内容——第 9/10 节讲过）；最终由 `Model._buildModelProviderParams` 包成 `{ role: "system", content: [...] }` 放在消息列表最前面（[model.ts](../../src/foundation/models/model.ts#L52-L54)）。**一条清晰的链路：`lead-agent` 写字符串 → `Agent` 持有 → 中间件每步追加 → `Model` 封装成 system 消息 → Provider 发给厂商。**

### 1.5 工具装配：12 个必备 + 1 个可选（[lead-agent.ts](../../src/coding/agents/lead-agent.ts#L103-L117)）

填充 `tools` 槽位的，是这个数组——**一次性把这个 Coding Agent"这双手"的所有手指都装上**：

```ts
tools: [
  bashTool,          // 跑命令
  fileInfoTool,      // 看文件元信息
  listFilesTool,     // 列目录
  globSearchTool,    // 按 glob 找文件
  grepSearchTool,    // 按内容搜
  mkdirTool,         // 建目录
  movePathTool,      // 移动/重命名
  readFileTool,      // 读文件
  writeFileTool,     // 写文件（整体覆盖）
  strReplaceTool,    // 字符串替换（唯一匹配）
  applyPatchTool,    // 打补丁（精确多处改动）
  todoTool,          // 待办清单（第 10 节的 todo_write）
  ...(askUserQuestionTool ? [askUserQuestionTool] : []),  // 可选：主动提问
],
```

**按 roadmap 后续章节的划分，这 12+1 个工具正好分成五组**（本节只报"装了什么、归哪节"，实现留给对应章节）：

| 组                  | 工具                                                                                                | 干什么                                                 | 详解章节                     |
| ------------------- | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------ | ---------------------------- |
| **文件读写**  | `read_file`、`write_file`、`str_replace`                                                      | 读、整体写、唯一匹配替换                               | [§12](./00-roadmap.md)       |
| **探索/系统** | `bash`、`glob_search`、`grep_search`、`list_files`、`file_info`、`mkdir`、`move_path` | 跑命令、找文件、搜内容、列目录、看元信息、建目录、移动 | [§13](./00-roadmap.md)       |
| **精确编辑**  | `apply_patch`                                                                                     | 手写 unified diff 打补丁                               | [§14](./00-roadmap.md)       |
| **计划**      | `todo_write`（= `todoTool`）                                                                    | 维护待办清单                                           | [§10](./10-todos.md)（已讲） |
| **人机提问**  | `ask_user_question`（可选）                                                                       | Agent 主动问用户                                       | [§15](./00-roadmap.md)       |

这里有两个装配细节值得说：

**细节一：`todoTool` 从哪来？** 它不是 import 的现成工具，而是 1.6 会讲的 `createTodoSystem()` **解构出来的**（[lead-agent.ts](../../src/coding/agents/lead-agent.ts#L62)）——回忆 [第 10 节](./10-todos.md)：`todoTool`（进 `tools`）和 `todoMiddleware`（进 `middlewares`）是**同一次工厂调用产出的孪生兄弟，共享闭包状态**。**它俩在这里被拆开、装进两个不同的数组**——你在本节亲眼看到了第 10 节所说的"两个不同槽位"。

**细节二：`ask_user_question` 的条件装配（[lead-agent.ts](../../src/coding/agents/lead-agent.ts#L64)、[L116](../../src/coding/agents/lead-agent.ts#L116)）。** 这是唯一一个**"看情况才装"**的工具：

```ts
const askUserQuestionTool = askUserQuestion ? createAskUserQuestionTool(askUserQuestion) : null;
// ...
...(askUserQuestionTool ? [askUserQuestionTool] : []),
```

**只有调用方传了 `askUserQuestion` 回调，才会创建并装入这个工具**；否则用 `...[]`（展开一个空数组）**不装任何东西**。这个 `...(cond ? [x] : [])` 是 JS/TS 里**条件性往数组里加元素**的惯用法——干净、无副作用。**为什么它要条件装配？** 因为"主动提问"这个能力的**前提是"有人能回答"**——如果没传 `askUserQuestion`（比如在 headless 脚本里没人盯着），给模型装一个"问了也没人答"的工具就是个陷阱。**没有回答者，就不给提问工具**——这是很干净的"能力与前提绑定"。

### 1.6 中间件装配：三大中间件的顺序与条件（[lead-agent.ts](../../src/coding/agents/lead-agent.ts#L62-L76)）

填充 `middlewares` 槽位的逻辑，把前面几节的三个中间件插件**按特定顺序**装进插座：

```ts
const { tool: todoTool, middleware: todoMiddleware } = createTodoSystem();       // 第 10 节
// ...
const middlewares = [createSkillsMiddleware(skillsDirs), todoMiddleware];         // ① Skills → ② Todos
if (askUser) {                                                                    // ③ 可选：审批
  middlewares.push(
    createCodingApprovalMiddleware({
      cwd,
      requiresApproval: CODING_TOOLS_REQUIRING_APPROVAL,
      askUser,
      approvalPersistence,
    }),
  );
}
```

**装了三个中间件，顺序是 `[Skills, Todos, (Approval)]`**。三个都值得说：

**① `createSkillsMiddleware(skillsDirs)`（[第 9 节](./09-skills.md)）**：把 1.2 注入的 `skillsDirs` 传进去，得到技能中间件。它管 `beforeAgentRun`（扫目录发现技能）+ `beforeModel`（把技能列表注入 prompt）。

**② `todoMiddleware`（[第 10 节](./10-todos.md)）**：待办中间件，管 `beforeModel`（智能提醒）+ `afterToolUse`（归零计数器）。

**③ `createCodingApprovalMiddleware(...)`（[第 15 节](./00-roadmap.md)，可选）**：审批中间件——**只有传了 `askUser` 才 `push`**（和 1.5 的提问工具同款"能力与前提绑定"：没有"问人"的手段，就没有"审批"这道关）。它管 `beforeToolUse`：拦下危险工具（`bash`/`write_file`/`str_replace`/`apply_patch`/`mkdir`/`move_path`——见 [CODING_TOOLS_REQUIRING_APPROVAL](../../src/coding/permissions/requires-approval.ts#L2-L9)），先查白名单、没命中就 `askUser` 弹给人确认，用户拒绝就返回 `{ __skip: true }` 短路掉这次工具调用（[coding-approval-middleware.ts](../../src/coding/permissions/coding-approval-middleware.ts#L20-L42)）——**这正是第 7 节 `beforeToolUse` 短路协议的实战**。

**为什么顺序是 Skills → Todos → Approval？这个顺序重要吗？** **重要，而且是精心安排的**（Q4 详证）。回忆 [第 7 节](./07-middleware.md)：中间件**按数组顺序**依次分发钩子。所以：

- **`beforeModel` 阶段**（拼系统提示词附加内容）：Skills 先跑（追加 `<skill_system>`），Todos 后跑（在其成果上追加 `<todo_reminder>`）——**这正是第 9/10 节反复讲的"在同一个 `modelContext.prompt` 上接力叠加"**。顺序决定了两段 XML 的先后。
- **`beforeToolUse` 阶段**（工具执行前）：只有审批中间件参与。它排在最后，语义上也最自然——**"技能注入、待办提醒"都是在准备提示词，而"审批"是在真正动手前的最后一道闸**。

**注意 `askUser`/`approvalPersistence` 又是"注入"进来的**——审批"怎么问人""白名单存哪"都不由工厂决定，交给调用方。工厂只负责**声明"哪些工具需要审批"**（`CODING_TOOLS_REQUIRING_APPROVAL`）这个**编程语义**的部分。这再次体现 1.1 的分界线：**"哪些工具危险"是本质（写死），"怎么问、存哪"是环境（注入）**。

### 1.7 拼装成品：`new Agent(...)` 与"库默认 vs CLI 扩充"（[lead-agent.ts](../../src/coding/agents/lead-agent.ts#L78-L119) & [cli/index.tsx](../../src/cli/index.tsx#L64-L83)）

五个槽位全部填好，最后一步就是"合上盖子"——把它们交给 `new Agent`：

```ts
return new Agent({
  model,          // 1.2 注入的模型
  prompt: `...`,  // 1.4 的 XML 提示词
  messages,       // 1.3 的 AGENTS.md seed（可能为空）
  tools: [...],   // 1.5 的 12+1 个工具
  middlewares,    // 1.6 的 [Skills, Todos, (Approval)]
});
```

**一个成品 Coding Agent 就此诞生。** 但要真正理解这张"总装图"，得看它的**调用方**——CLI 是怎么"注入环境"的。看 [cli/index.tsx](../../src/cli/index.tsx#L74-L83)：

```ts
const agent = await createCodingAgent({
  model,                                              // ← new Model(entry.name, provider, {...})，见 cli L57-62
  skillsDirs,                                         // ← 5 个目录，见下
  askUser: globalApprovalManager.askUser,             // ← 审批"问人"接到全局审批管理器（第 15/19 节）
  askUserQuestion: globalAskUserQuestionManager.askUserQuestion,  // ← 提问"问人"同理
  approvalPersistence: {                              // ← 白名单读写接到 settings（第 18 节）
    loadAllowList: (cwd) => settingsLoader.loadAllowList(cwd),
    persistAllowedTool: (cwd, toolName) => settingsWriter.appendAllowedTool(cwd, toolName),
  },
});
```

对照 1.2 讲的"库默认值"，你会看到一个清晰的**分层扩充**模式：

| 参数                    | 库默认（lead-agent.ts）     | CLI 注入的实参（cli/index.tsx）                                                                                                                                  |
| ----------------------- | --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `skillsDirs`          | 只有`.agents/skills` 一个 | **5 个**：项目 `skills`、项目 `.agents/skills`、安装目录、`~/.agents/skills`、`~/.helixent/skills`（[cli L64-70](../../src/cli/index.tsx#L64-L70)） |
| `askUser`             | 无（不装审批）              | `globalApprovalManager.askUser`（接 TUI 弹窗）                                                                                                                 |
| `askUserQuestion`     | 无（不装提问工具）          | `globalAskUserQuestionManager.askUserQuestion`（接 TUI 弹窗）                                                                                                  |
| `approvalPersistence` | 无（白名单为空）            | 接`SettingsLoader/Writer`（读写 `~/.helixent/...`）                                                                                                          |

**这张表就是"分层"最生动的体现**，呼应 [第 1 节](./01-overview.md) 的核心思想：**`coding` 层给一个"能独立跑、但功能最小"的默认 Agent（库）；`cli` 层负责"注入真实环境"，把它扩充成一个完整的产品。** `createCodingAgent` 本身不知道有 TUI、不知道有 settings 文件、不知道技能还能从 home 目录来——它只暴露一组"插孔"，让 CLI 去插。**同一个工厂，CLI 用它做出交互式产品，测试可以用它做出 headless 实例（全不传可选参数）**——这就是依赖注入换来的复用性。

**顺便交代两个桶文件（barrel）。** [coding/agents/index.ts](../../src/coding/agents/index.ts) 只有一行 `export * from "./lead-agent"`；[coding/index.ts](../../src/coding/index.ts) 再把 `agents`、`permissions`、`ask-user-question*` 等统一 re-export。于是外部只需 `import { createCodingAgent } from "@/coding"`（正如 [cli/index.tsx](../../src/cli/index.tsx#L10) 所做）——**桶文件是"包的公开门面"**，把内部文件结构对外隐藏，这是全项目一致的模块组织约定（第 21 节会讲）。

### 1.8 全景：一张"装配总图"

把前十节的零件和本节的装配串成一张图，你就能看清 `createCodingAgent` 到底在"总装"什么：

```
  【调用方注入的"环境"】                        【createCodingAgent 工厂：本质写死】
  ┌─────────────────────┐
  │ model (第3节)        │──────────────┐
  │ cwd                 │───┐          │
  │ skillsDirs (第9节)   │─┐ │          │
  │ askUser (第15节)     │ │ │          │
  │ askUserQuestion     │ │ │          │        ┌──────────────────────────────────┐
  │ approvalPersistence │ │ │          │        │  槽位①model  ← 注入                │
  └─────────────────────┘ │ │          ├───────►│  槽位②prompt ← XML 人设(第5节骨架)  │
                          │ │          │        │      <agent>/<working_directory>/  │
   磁盘 ./AGENTS.md ──────┼─┼──读取────►messages │      <tool_usage>(激活第8节错误码)/ │
        (存在才加载,       │ │  (第2节   │  seed  │      <notes>                       │
         作为 user 消息)   │ │  NonSystem)│        │  槽位③messages ← AGENTS.md(可能空) │
                          │ │          │        │  槽位④tools  ← 12个(第12~14节)+     │
   createTodoSystem() ────┼─┤          │        │      todoTool(第10) +可选ask(第15) │
   (第10节: 工具+中间件)   │ │          │        │  槽位⑤middlewares ←                │
        ├── todoTool ─────┼─┼──────────┼───────►│      [Skills(第9),Todos(第10),     │
        └── todoMiddleware┘ │          │        │       (Approval 第15,可选)]         │
                            │          │        └────────────────┬───────────────────┘
   createSkillsMiddleware(skillsDirs)──┘                         │
                                                                 ▼
                                                        new Agent({...})  ← 第5节的空骨架
                                                                 │
                                                                 ▼
                                                    一个"会写代码"的成品 Agent
```

**一句话总括**：**`createCodingAgent` 是一条"总装线"——它把"环境相关的零件"（模型、技能目录、问人回调、白名单）作为参数注入，把"编程本质的零件"（XML 人设、12 个工具、三大中间件顺序）写死在函数体里，再自动挂上项目的 `AGENTS.md` 长期记忆，最终合成一个第 5 节那副空骨架的"填满版"。前十节造零件，这一节装整机。**

---

## 2. 亮点与关键设计

明确标注哪些是「妙笔」、哪些是「关键决策」：

1. **【核心决策】"本质写死、环境注入"的分界线。** 系统提示词、12 个工具、三大中间件顺序——这些是"Coding Agent 之所以是 Coding Agent"的本质，写死在工厂里；模型、技能目录、问人回调、白名单落盘——这些是环境相关的，通过参数注入。这条分界线让**同一个工厂既能被 CLI 装成交互产品、又能被测试装成 headless 实例**（1.1、1.2、1.7）。
2. **【核心妙笔】`AGENTS.md` 作为 `role:"user"` seed 消息注入，而非拼进 system prompt。** 用一句 `>` 引用块旁白告诉模型"这是自动加载的项目文件"，让项目记忆成为**对话的一部分**（可回看、可引用），同时**保持系统提示词是"纯人设"**（换项目 system prompt 不变）。类型约束为 `NonSystemMessage[]` 还从编译期杜绝了"混入 system 消息"（1.3、Q1）。
3. **【关键决策】XML 风格的系统提示词。** 用 `<agent>`/`<working_directory>`/`<tool_usage>`/`<notes>` 把"身份/空间/行为约束/边界"结构化，比一段散文更利于模型解析与遵守，也利于人类维护（1.4、Q2）。
4. **【妙笔】`<tool_usage>` 的每一条都"预激活"后面章节的工具。** 8 条约束逐一对应真实工具/真实坑，尤其"用 summary 和 error code 决策、别拿烂输入死磕"直接激活了[第 8 节](./08-tool-result-pipeline.md)的结构化错误契约——本节作为"总装图"的最佳注脚（1.4 那张对照表）。
5. **【关键决策】依赖注入解耦模型厂商。** 工厂只收一个 `Model`、绝不 `new` 任何 Provider，让第 16/17 节的 OpenAI/Anthropic 都能无缝接入（1.2）。
6. **【关键决策】能力与前提绑定的"条件装配"。** `ask_user_question` 工具、审批中间件都**只在传了对应"问人"回调时才装**——没有回答者就不给提问/审批能力，避免"问了没人答"的陷阱。用 `...(cond ? [x] : [])` 干净实现（1.5、1.6）。
7. **【关键决策】中间件顺序 `[Skills, Todos, Approval]` 是精心排布的。** `beforeModel` 阶段 Skills 先注入、Todos 后接力（呼应第 9/10 节的"链式叠加"）；`beforeToolUse` 阶段审批作为"动手前最后一道闸"排在最后（1.6、Q4）。
8. **【关键决策】库给最小默认、CLI 分层扩充。** `skillsDirs` 库默认只 1 个、CLI 扩成 5 个；问人/白名单库默认无、CLI 接到全局管理器和 settings——教科书级的"库 vs 产品"分层（1.7，呼应第 1 节）。
9. **【妙笔】`async` 工厂 + `Bun.file().exists()` 的宽容加载。** 读 `AGENTS.md` 需要异步，故工厂是 `async`；文件不存在则 `messages` 保持空、Agent 照常启动——延续第 8/9 节"缺失绝不拖垮主流程"的容错基调（1.3）。

---

## 3. 工业对比

对比业界方案的做法与优缺点。

### 3.1 Claude Code / `CLAUDE.md`、`AGENTS.md` —— Helixent 的直接对标

Anthropic 的 Claude Code 有一个几乎一模一样的机制：**自动加载项目根的 `CLAUDE.md`**（社区也在推 `AGENTS.md` 作为跨工具的通用命名）作为项目记忆/约定说明。它同样把这份内容作为上下文喂给模型，用来告诉 Agent "这个项目怎么干活"。Helixent 直接采用了 `AGENTS.md` 这个更中立的命名（本仓库自己的 [AGENTS.md](../../AGENTS.md) 就是范例）。

**Claude Code 的系统提示词也是"重度结构化 + 大量行为约束"的**——它有超长的工具使用规范、"改前先读""优先用某工具"之类的引导，和 Helixent 的 `<tool_usage>` 如出一辙（只是 Claude Code 的规模大得多）。**差异**在于：Claude Code 支持**多层 `CLAUDE.md`**（用户级 `~/.claude/CLAUDE.md` + 项目级 + 子目录级，逐层合并），而 Helixent 只加载**项目根一份**——够教学、够小项目用，但没有 Claude Code 的分层记忆那么完整。**读懂本节，你就读懂了 Claude Code "项目记忆 + 系统提示词"这套骨架。**

### 3.2 Cursor / `.cursorrules`、`.cursor/rules` —— "规则"而非"对话记忆"

Cursor 也让你写项目约定（`.cursorrules` 或新的 `.cursor/rules/*.mdc`），但它更多是**作为"规则"注入系统提示词层面**（甚至按文件类型 glob 匹配注入——见第 9 节 3.2 的对比）。Helixent 的 `AGENTS.md` 则是**作为一条对话消息**注入。

**取舍**：Cursor 的规则更"系统级、可按场景条件触发"；Helixent 的 `AGENTS.md` 更"对话级、一次性全量加载、模型可自然回看"。对"项目全局约定"这种**整个会话都该知道**的信息，Helixent 的"开局塞一条 user 消息"简单直接；但如果约定很多、需要按场景加载，Cursor 的条件规则更省 token（这其实又回到了第 9 节 Skills 的"渐进式披露"思路——Helixent 把"按需加载"留给了 Skills，`AGENTS.md` 只管"全局小约定"）。

### 3.3 OpenAI Assistants API / `instructions` —— 有"系统指令"，无"项目记忆约定"

OpenAI 的 Assistants API 有一个 `instructions` 字段，等价于系统提示词，你可以往里写人设和行为约束。但**它没有"自动加载项目根某个文件当记忆"的约定**——那是"编程 Agent"这个垂直场景才有的需求，通用 Assistants API 不提供。你想要 `AGENTS.md` 的效果，得**自己**在应用层读文件、拼进 `instructions` 或作为首条 message——**正是 Helixent 的 `createCodingAgent` 替你做了的事**。

**这反向说明了 `createCodingAgent` 的定位**：它是一个**面向"编程"这个垂直领域的装配层**，把通用 Agent API 不管的那些"编程惯例"（读项目记忆、配一套编程工具、插审批）打包好。**通用 API 给你乐高零件，`createCodingAgent` 给你搭好的"编程主题套装"。**

### 3.4 Aider / 传统 CLI 编程助手 —— 提示词与工具耦合在主流程

Aider 这类较早的编程 CLI，提示词和工具选择往往**硬编码在主流程里**，没有清晰的"工厂 + 依赖注入"分层——换模型、改工具集要动核心代码。Helixent 用 `createCodingAgent` 把"装配"独立成一个纯工厂函数，**装配逻辑和运行逻辑（`Agent.stream`）彻底分离**：`Agent` 只管"怎么跑循环"，`createCodingAgent` 只管"跑之前配好什么"。这种分离让**测试可以只测装配、或只测循环**，也让"再造一个不同人设的 Agent"只需再写一个工厂函数，不碰 `Agent` 核心。

### 3.5 一览表

| 方案                                     | 项目记忆机制                               | 系统提示词风格            | 模型/工具装配方式 | 分层清晰度        |
| ---------------------------------------- | ------------------------------------------ | ------------------------- | ----------------- | ----------------- |
| **Helixent `createCodingAgent`** | 自动加载根`AGENTS.md` 为 user 消息       | XML 结构化 + 行为约束     | 工厂 + 依赖注入   | 高（库/CLI 分层） |
| Claude Code                              | 多层`CLAUDE.md`/`AGENTS.md` 合并       | 重度结构化 + 超长规范     | 内置              | 高                |
| Cursor                                   | `.cursorrules`/`.cursor/rules`（规则） | 规则注入 + glob 条件      | 内置              | 中                |
| OpenAI Assistants                        | 无（需自己实现）                           | `instructions` 自由文本 | API 参数          | 由使用者决定      |
| Aider 等早期 CLI                         | 有的支持 read 文件                         | 多为散文                  | 常硬编码在主流程  | 低                |

---

## 4. 深度解释：为什么这样设计？不这样会怎样？

用 Q&A 形式讲清几个"为什么"，以及"不这样会出什么问题"。

### Q1：为什么 `AGENTS.md` 作为 `role:"user"` 消息注入，而不是直接拼进 system prompt？

**核心理由：让"项目记忆"和"Agent 人设"各归其位、互不污染。**

先看**不这样（拼进 system prompt）会怎样**：`createCodingAgent` 的系统提示词本是一段**与具体项目无关的纯人设**（"我是 Helixent，我这样用工具"）。如果把 `AGENTS.md`（少则几十行、多则几百行的项目细节）拼进去，system prompt 就变成"人设 + 这个项目的具体内容"的混合体——**换个项目就得重拼一次 system prompt**，而且 system prompt 会随项目臃肿程度剧烈波动。人设与项目内容耦合在一起，难以分别演化、难以测试。

**再看这样（作为 user 消息）的好处**，有三层：

1. **职责分离**：system prompt 永远是那段干净的 XML 人设（换项目一字不变），项目记忆是 `messages` 里的**一条数据**。人设归 `prompt`、记忆归 `messages`——各归其位。
2. **模型能自然对待它**：作为对话历史的一部分，模型可以在第 20 步"回看"这条消息，像引用任何上下文一样引用项目约定；而 system prompt 在有些厂商的实现里是"特殊对待"的，未必适合放大段可回溯的内容。
3. **那句 `>` 旁白是点睛**：`"> The AGENTS.md file has been automatically loaded..."` 明确告诉模型"这条 user 消息不是真人打的，是系统自动加载的"——**避免模型误以为用户真的手动粘贴了一大段文档**，从而正确理解它的性质（背景资料，而非当前指令）。

**代价**：它占据了 `messages` 的第一条，且（见 Q6）会被 `/clear` 一起清掉。但相比"污染 system prompt"的耦合代价，这个取舍是划算的。

### Q2：系统提示词为什么用 XML 风格标签，而不是纯 Markdown 或散文？

**因为结构化标签对"模型解析"和"人类维护"都更友好。**

- **对模型**：`<tool_usage>...</tool_usage>` 这样的显式边界，让模型能清晰区分"这是身份""这是工作目录""这是工具用法""这是注意事项"。现代 LLM（尤其 Anthropic 系）在训练中见过大量 XML 风格的结构化提示，对标签边界的遵循度往往高于一段没有分节的散文。属性（`name=`、`role=`、`dir=`）还能承载结构化的键值信息。
- **对人类维护者**：想加一条工具约束？往 `<tool_usage>` 里加一个 bullet 即可，边界清晰、不易和别的部分串味。想改工作目录的表达？只动 `<working_directory>`。**结构化 = 可维护。**

**不这样（写成一大段散文）会怎样**：模型容易把"人设"和"约束"混着读、抓不住重点；人类改一处容易牵连一片。当然，XML 风格也不是唯一解（Markdown 分节标题也能达到类似效果），但**"给提示词加明确的结构边界"这个方向是明确有益的**——具体用 XML 还是 Markdown 是风格选择，Helixent 选了 XML（也和它对标的 Claude 系一致）。

### Q3：为什么模型、问人回调、白名单都用"依赖注入"，而不是在工厂里直接创建？

**因为这些都是"环境相关"的，硬编码会杀死工厂的可复用性。**

设想工厂里直接写死：`const model = new OpenAIModelProvider({ apiKey: process.env.OPENAI_KEY })`、`askUser = someTuiPopup()`。那么：

- **测试**没法用了——测试想用一个假模型（mock）、一个"自动同意"的假 `askUser`，但工厂写死了真实的 OpenAI 和真实的 TUI 弹窗。
- **换厂商**要改工厂源码——想用 Anthropic？得进 `createCodingAgent` 改 `new`。
- **headless 场景**没法用——没有 TUI 的脚本里，`someTuiPopup()` 根本跑不起来。

**依赖注入把"用什么模型、怎么问人、白名单存哪"的决定权交还给调用方**，于是：CLI 注入真实的 OpenAI/Anthropic + TUI 弹窗 + settings 落盘；测试注入 mock 模型 + 自动应答桩 + 内存白名单；未来的 Web 版注入 Web 表单……**工厂本身一行不改**。这就是 [第 3 节](./03-model.md) `Model`/`ModelProvider` 分离、[第 15 节](./00-roadmap.md) 把"问人"抽象成回调的价值，在装配层的集中兑现。**"环境从外面注入、本质留在里面"是这个工厂最重要的一课。**

### Q4：中间件顺序 `[Skills, Todos, Approval]` 换一下会怎样？顺序真的重要吗？

**重要。** 回忆 [第 7 节](./07-middleware.md)：中间件按数组顺序依次分发每个钩子。所以顺序至少在两处产生可见影响：

**① `beforeModel` 的"接力叠加"顺序（第 9/10 节详证）。** Skills 排在 Todos 前，于是每步拼 prompt 时：`原始 prompt` → Skills 追加 `<skill_system>` → Todos 在此基础上追加 `<todo_reminder>`。**若对调**，就变成 Todos 的提醒在前、技能列表在后。两段内容都还在，但**先后顺序变了**——这通常影响不大（都是追加），但"技能能力"先于"待办提醒"出现，逻辑上更顺（先让模型知道"我有哪些本事"，再提醒"你的清单进展如何"）。

**② `beforeToolUse` 的执行时机。** 目前只有审批中间件用了 `beforeToolUse`，所以**它排最后没有竞争问题**。但设想未来 Skills 或 Todos 也想在 `beforeToolUse` 做点事——那审批排在最后就意味着"**其他中间件都处理完、最后才由审批决定放不放行**"，这符合"审批是动手前最后一道闸"的直觉。如果把审批排到最前，它可能在其他中间件还没来得及调整上下文时就做了拦截决定。

**结论**：当前顺序**不是随意排的**——它让"能力/记忆的准备"（Skills、Todos）先行、"动手前的把关"（Approval）殿后。**这是一个符合语义直觉的排布，而中间件系统"按数组顺序分发"的设计，正是让这种"用顺序表达优先级"成为可能的基础。**

### Q5：`askUser`/`askUserQuestion` 是可选的——都不传会得到一个什么样的 Agent？

**会得到一个"headless（无人值守）"的 Coding Agent。** 具体表现：

- **不传 `askUser`**：`if (askUser)` 不成立，**审批中间件不装**（[lead-agent.ts](../../src/coding/agents/lead-agent.ts#L67)）。于是 `bash`、`write_file`、`apply_patch` 等危险工具**不再弹窗确认，直接执行**——因为没有"人"可问。
- **不传 `askUserQuestion`**：`ask_user_question` 工具**不装进 `tools`**（1.5）。模型**失去"主动问用户"的能力**——它只能靠已有信息自己决策。

**这正是"依赖注入 + 条件装配"的威力**：同一个 `createCodingAgent`，传齐回调 → 交互式、每步危险操作都过人眼的"谨慎助手"（CLI 就是这么用的）；全不传 → 全自动、不打断、适合脚本/CI 的"放手跑"模式。**"要不要人盯着"这个重大行为差异，仅由"传不传两个回调"决定，工厂逻辑零改动。**

**风险提示**：headless 模式下危险工具无人把关，只适合在**受控/沙箱环境**里对**可信任务**使用——这也是为什么 CLI（面向真人、在真实项目里跑）**一定**会接上审批。**"是否有人把关"的选择权，被干净地交给了调用方。**

### Q6：`/clear` 会把 `AGENTS.md` seed 消息也清掉——这是 bug 吗？

**这是一个真实存在的、值得警惕的行为缺口，我不粉饰它。**

事实链条：`AGENTS.md` 是在 `createCodingAgent` **运行那一刻**（启动时）被 push 进 `messages` 的（1.3）；而工厂**只运行一次**。TUI 的 `/clear` 命令会调 `agent.clearMessages()`（[use-agent-loop.ts](../../src/cli/tui/hooks/use-agent-loop.ts#L95-L100)），其实现是 `this._context.messages.length = 0`（[agent.ts](../../src/agent/agent.ts#L131-L133)）——**把整个 `messages` 数组清空，连那条 `AGENTS.md` seed 一起清掉**。清空后不会重新加载（工厂不会再跑）。**结果：用户 `/clear` 之后，Agent 就"忘了"项目约定。**

**这算 bug 吗？取决于 `/clear` 的语义预期**：

- 若 `/clear` 的语义是"清空**对话**、但保留**项目背景**"——那这就是个 **bug**：项目记忆本该像 system prompt 一样"常驻"，不该被清对话的操作误伤。
- 若 `/clear` 的语义是"彻底重置到一张白纸"——那清掉 `AGENTS.md` 也算"符合预期"，只是**用户可能没意识到**连项目记忆都没了。

**更稳妥的做法（当前代码没做，可作改进）**：要么把 `AGENTS.md` 内容改为拼进 system prompt（但那会引入 Q1 说的耦合代价）；要么给 `clearMessages` 一个"保留 seed 消息"的选项，`/clear` 时只清用户对话、保留开头的 `AGENTS.md`；要么 `/clear` 后重新注入一次 `AGENTS.md`。**这属于"把项目记忆存成一条普通消息"这个设计（Q1 的取舍）带来的副作用**——Q1 的好处（职责分离）是实打实的，但代价就是它和普通消息一样会被 `clearMessages` 波及。**识别出这种"设计取舍的连带影响"，比简单判'好/坏'更重要**——它提醒我们：任何"把 X 建模成 Y"的决定，都会让 X 继承 Y 的所有行为（包括不想要的那些）。

---

## 5. 参考资料

**本节精讲的源码（一个主角 + 两个桶文件）**：

- 装配总图（绝对主角）：[lead-agent.ts](../../src/coding/agents/lead-agent.ts)（工厂签名 [L31-L47](../../src/coding/agents/lead-agent.ts#L31-L47)、`AGENTS.md` 加载 [L48-L61](../../src/coding/agents/lead-agent.ts#L48-L61)、系统提示词 [L80-L101](../../src/coding/agents/lead-agent.ts#L80-L101)、工具数组 [L103-L117](../../src/coding/agents/lead-agent.ts#L103-L117)、中间件装配 [L62-L76](../../src/coding/agents/lead-agent.ts#L62-L76)、`new Agent` [L78-L119](../../src/coding/agents/lead-agent.ts#L78-L119)）
- 桶文件：[coding/agents/index.ts](../../src/coding/agents/index.ts)、[coding/index.ts](../../src/coding/index.ts)
- 项目记忆样例：[AGENTS.md](../../AGENTS.md)（本仓库自己的项目约定文件）

**装配所依赖的零件（各章精讲）**：

- 空骨架 `Agent` 与构造函数：[agent.ts](../../src/agent/agent.ts#L65-L91)（[第 5 节](./05-react-loop.md)）、`clearMessages` [L131-L133](../../src/agent/agent.ts#L131-L133)
- `prompt` → system 消息封装：[model.ts `_buildModelProviderParams`](../../src/foundation/models/model.ts#L50-L63)（[第 3 节](./03-model.md)）
- `NonSystemMessage` 类型：[message.ts](../../src/foundation/messages/types/message.ts#L54)（[第 2 节](./02-message.md)）
- 三大中间件：[skills-middleware.ts](../../src/agent/skills/skills-middleware.ts)（[第 9 节](./09-skills.md)）、[todos.ts](../../src/agent/todos/todos.ts)（[第 10 节](./10-todos.md)）、[coding-approval-middleware.ts](../../src/coding/permissions/coding-approval-middleware.ts)（[第 15 节](./00-roadmap.md)）
- 需审批的工具清单：[requires-approval.ts](../../src/coding/permissions/requires-approval.ts#L2-L9)

**调用方（CLI 如何注入环境）**：

- [cli/index.tsx](../../src/cli/index.tsx#L44-L83)：`new Model`（[L57-62](../../src/cli/index.tsx#L57-L62)）、5 个技能目录（[L64-70](../../src/cli/index.tsx#L64-L70)）、`createCodingAgent` 调用与回调注入（[L74-83](../../src/cli/index.tsx#L74-L83)）——具体机制留给 [第 18 节](./00-roadmap.md)

**上游依赖章节**：

- [第 1 节 · 项目全景与四层架构](./01-overview.md)（"库给最小默认、CLI 组装成产品"的分层思想）
- [第 3 节 · Model 与 ModelProvider](./03-model.md)（依赖注入模型、`prompt` 如何变 system 消息）
- [第 5 节 · ReAct 主循环](./05-react-loop.md)（`Agent` 空骨架的五个槽位）
- [第 7 节 · Middleware 中间件系统](./07-middleware.md)（中间件按数组顺序分发、`beforeToolUse` 短路）
- [第 8 节 · 工具结果处理管线](./08-tool-result-pipeline.md)（`<tool_usage>` 激活的 summary/error-code 决策）
- [第 9 节 · Skills](./09-skills.md)、[第 10 节 · Todos](./10-todos.md)（被装配进来的两个中间件）

**外部资料**：

- Anthropic · Claude Code 与 `CLAUDE.md`/项目记忆（本节 `AGENTS.md` 的直接对标）：[https://docs.anthropic.com/en/docs/claude-code](https://docs.anthropic.com/en/docs/claude-code)
- `AGENTS.md` 通用约定（跨工具的项目说明文件命名）：[https://agents.md/](https://agents.md/)
- Anthropic · Prompt engineering 中的 XML 标签实践（本节提示词风格的来源）：[https://docs.anthropic.com/en/docs/build-with-claude/prompt-engineering/use-xml-tags](https://docs.anthropic.com/en/docs/build-with-claude/prompt-engineering/use-xml-tags)
- 依赖注入（Dependency Injection）概念：[https://en.wikipedia.org/wiki/Dependency_injection](https://en.wikipedia.org/wiki/Dependency_injection)

---

## 6. 小结与下一节预告

本节我们拆开了 Helixent 的"总装线" `createCodingAgent`，看清了它**如何用 120 行代码，把前十节所有零件拼成一个"会写代码"的成品 Agent**：

- **一条分界线（核心）**：**本质写死、环境注入**。系统提示词、12 个工具、三大中间件顺序是"编程本质"（写死在工厂里）；模型、技能目录、问人回调、白名单落盘是"环境"（参数注入）。这让同一个工厂既能装成 CLI 交互产品、又能装成 headless 测试实例（1.1、1.2、1.7、Q3、Q5）。
- **五个槽位的填充**：`model`（注入）、`prompt`（XML 人设，激活第 8 节错误码约定）、`messages`（自动加载 `AGENTS.md` 为 user seed 消息）、`tools`（12 必备 + 1 可选，条件装配提问工具）、`middlewares`（`[Skills, Todos, (Approval)]`，顺序精心排布）。
- **`AGENTS.md` 的妙处与副作用**：作为 user 消息注入让"项目记忆"与"人设"各归其位（Q1），但也因此会被 `/clear` 误伤（Q6）——我们诚实地标注了这个设计取舍的连带影响。
- **分层扩充**：库给最小默认（`skillsDirs` 只 1 个、无审批），CLI 注入真实环境（5 个目录、接全局管理器与 settings）——第 1 节"库 vs 产品"分层的又一次兑现（1.7）。

至此，**第 5～10 节的"通用大脑"被正式特化成了一个"专用 Coding Agent"**。回头看这张总装图：它像一份"物料清单 + 装配说明"，把模型、消息、工具、中间件这些前面逐一造好的零件，按"编程"这个领域的需求组装了起来。

**承上启下（启下）**：但你一定注意到了——本节这张总装图上，`tools` 数组里那 12 个工具（`bashTool`、`readFileTool`、`applyPatchTool`……）**我们只是"点了名、归了类"，却没打开任何一个看它内部长啥样**。它们是怎么校验路径的？怎么防止改错文件？怎么把结果封装成第 8 节那套 `{ ok, summary, code }` 契约的？

接下来的 [第 12～15 节](./00-roadmap.md) 就逐个拆开这些被装配进来的零件。而拆解要**从地基开始**——因为这 12 个工具并非各写各的，它们**共享同一套"地基函数"**：路径校验（`ensureAbsolutePath`）、目录边界检查（`isWithinDirectory`）、文本截断（`truncateText`）、以及把结果封装成结构化契约的 `okToolResult`/`errorToolResult`。**先看懂这套地基，再看最基础的三个文件操作工具（`read_file`/`write_file`/`str_replace`）如何站在地基之上、被设计得"既好用又防错"**——这就是 [第 12 节](./00-roadmap.md) 的主题。

> 预告一个细节：你会在第 12 节看到，每个工具的参数 schema 里，**第一个参数永远是 `description`**（回看本节 [read-file.ts](../../src/coding/tools/read-file.ts#L14-L16) 那句"Always place `description` as the first parameter"）——这个看似奇怪的强约定背后，藏着一个关于"让模型先说清意图、再动手"的巧思。

👉 下一节 **第 12 节：工具地基与文件读写 —— tool-utils / tool-result 与 read / write / str_replace**。

准备好后，对我说「**生成第 12 节**」即可。
