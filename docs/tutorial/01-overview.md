# 第 1 节：项目全景与四层架构

> 本节属于 **第一部分 · 总览**。它是整套教程的「地图」——读完之后，你脑子里应该有一张清晰的结构图：Helixent 由哪几块组成、每块负责什么、它们谁依赖谁、以及一条用户消息是如何在这些块之间「流」过去、再「流」回来的。
>
> 对应 roadmap 里为本节设定的三个**核心问题**：
> 1. Helixent 由哪些层组成？
> 2. 为什么要这样分层？
> 3. 数据是怎么在层与层之间流动的？

---

## 0. 承上启下

这是第 1 节，前面没有内容需要承接。所以我们直接谈「启下」：

整套教程采用**自底向上**的顺序。本节先给你一张全局地图，让你知道每个后续章节讲的东西「长在地图的哪个位置」。而地图的**最底层地基**，是一个叫 `Message` 的数据结构——它几乎决定了上面所有层的形状。因此本节末尾会自然地把你交接给 **第 2 节：Message 消息类型系统**。

在读本节时，请打开这几个文件对照（后面会反复引用）：

- 依赖约定：[docs/code-convention.md](../code-convention.md)
- 项目说明：[AGENTS.md](../../AGENTS.md)、[README.md](../../README.md)
- 库总入口：[src/index.ts](../../src/index.ts)
- CLI 入口：[src/cli/index.tsx](../../src/cli/index.tsx)
- 四个层的桶文件（barrel）：[foundation/index.ts](../../src/foundation/index.ts)、[agent/index.ts](../../src/agent/index.ts)、[coding/index.ts](../../src/coding/index.ts)、以及 `src/cli/*`

---

## 1. 主题内容

### 1.1 一句话理解 Helixent 在做什么

用最朴素的话说：

> Helixent 给一个**大语言模型（LLM）**配了两样东西——**一双手**（工具：读文件、写文件、跑命令……）和**一个循环**（Agent Loop：思考 → 行动 → 观察 → 再思考……）。于是这个模型就能像一个初级工程师一样，在你的项目目录里干活。外面再套一层漂亮的**终端界面（TUI）**，让你能和它对话、审批它的危险操作。

它的同类产品是 Claude Code、Cursor Agent、OpenAI Codex CLI、Aider、Cline。Helixent 的独特价值不在功能多，而在**代码量小、分层干净、命名统一**——它是学习「一个现代 Coding Agent 到底由哪些零件构成」的绝佳标本。

它跑在 **Bun** 运行时上，用 **TypeScript** 编写，TUI 用 **Ink + React**。这些技术选型的原因会在后续章节（尤其第 21 节）展开，这里先记住：**全 TypeScript、单一语言、单个二进制可分发**。

### 1.2 先感性认识：一次对话里数据是怎么走的

在讲抽象的「层」之前，先跟着一条真实的用户消息走一遍。假设你在项目目录里敲下 `helixent`，然后输入「帮我在当前目录建一个 hello world 的 web 服务器」：

```
你在终端输入一句话
      │
      ▼
① CLI 层：把你的话包成一个 UserMessage，交给 Agent
      │
      ▼
② Agent 层：进入循环。把「历史消息 + 你的新消息」交给 Model
      │
      ▼
③ Foundation(Model) → Community(Provider)：翻译成 OpenAI/Anthropic 的
   网络格式，发请求，把流式返回拼成一条 AssistantMessage
      │
      ▼
④ Agent 层：检查这条 AssistantMessage 里有没有「工具调用」
      │
      ├── 没有工具调用 → 循环停止，把最终回答显示给你
      │
      └── 有工具调用（比如 write_file）→
              ⑤ Coding 层：真正去执行 write_file，把结果包成 ToolMessage
                    │
                    ▼
              把 ToolMessage 追加进历史，回到 ② 再想下一步
```

请特别注意贯穿这张图的三种东西：`UserMessage`、`AssistantMessage`、`ToolMessage`。它们都是 **`Message`** 这个类型的变体。**从头到尾，各层交换的都是同一种数据结构**。这就是我们后面要反复强调的「**单一数据源（single source of truth）**」思想——它是理解整个项目的钥匙。

### 1.3 Helixent 由哪些层组成？

Helixent 的核心分为 **4 层**，外加 1 个横切的 **community 适配区**。它们各自的职责如下：

| 层 | 目录 | 一句话职责 | 关键词 |
| --- | --- | --- | --- |
| **① Foundation** | [src/foundation](../../src/foundation) | 一切的**地基**：定义 `Message`（数据）、`Model`（模型抽象）、`Tool`（工具）三大原语 | 稳定、可复用、不依赖任何人 |
| **② Agent** | [src/agent](../../src/agent) | 一个**通用**的 ReAct 循环 + 中间件系统：让模型「思考→行动→观察」地转起来 | 通用、与业务无关 |
| **③ Coding** | [src/coding](../../src/coding) | 把通用 Agent **特化**成「会写代码的 Agent」：一组编程工具 + 一份系统提示词 + 人机审批 | 面向编程、领域专用 |
| **④ CLI** | [src/cli](../../src/cli) | **人机界面**：命令行参数解析、配置管理、以及用 Ink 写的终端 UI（TUI） | 交互、渲染、持久化 |
| **⋆ Community** | [src/community](../../src/community) | **可插拔适配器**：把内部数据翻译成各家模型厂商（OpenAI / Anthropic）的网络格式 | 隔离第三方 SDK |

> ⚠️ **一个容易困惑的点（先讲清楚）**：你会发现不同文档里「层数」说法不一致：
> - [README.md](../../README.md) 说是 **「三层 + community」**（它把 CLI 排除在「核心三层」之外）；
> - [AGENTS.md](../../AGENTS.md) 说是 **「四层 + community」**（它把 CLI 算作第 4 层）。
>
> 这不是矛盾，只是**视角不同**：站在「作为一个库（library）被别人引用」的角度，核心就是 `foundation / agent / coding` 三层（正是 [src/index.ts](../../src/index.ts) 导出的东西）；站在「作为一个完整的命令行产品」的角度，还得算上 `cli`。本教程采用 roadmap 的口径，统一称 **「四层」**，把 CLI 当作与前三层平级的一层来讲。记住这个区别即可，别被绕晕。

下面逐层展开。

#### ① Foundation —— 地基（三块原语）

见 [foundation/index.ts](../../src/foundation/index.ts)，它只干一件事：把三个子模块原样导出。

```ts
export * from "./messages";
export * from "./models";
export * from "./tools";
```

这三块就是整个项目的「三块地基」：

- **Messages（数据）**：对话历史用什么结构表示。核心是 [message.ts](../../src/foundation/messages/types/message.ts) 里的 `Message` 类型——它是 `SystemMessage | UserMessage | AssistantMessage | ToolMessage` 的联合。**这是全项目最重要的类型**，第 2 节专讲。
- **Models（模型抽象）**：如何「换一个大模型厂商，上层代码一行不改」。核心是 [model.ts](../../src/foundation/models/model.ts) 的 `Model` 类和 [model-provider.ts](../../src/foundation/models/model-provider.ts) 的 `ModelProvider` 接口。第 3 节专讲。
- **Tools（工具）**：一个「工具」在代码里长什么样。核心是 [function-tool.ts](../../src/foundation/tools/function-tool.ts) 的 `defineTool` 工厂。第 4 节专讲。

Foundation 的设计意图（引自 [AGENTS.md](../../AGENTS.md)）：**保持这些类型稳定、可复用；新增模型后端时通过扩展 `ModelProvider` 来做；让 `Message` 始终是对话记录的单一数据源。**

#### ② Agent —— 通用大脑（ReAct 循环）

见 [agent/index.ts](../../src/agent/index.ts)：

```ts
export * from "./agent";
export * from "./agent-event";
export * from "./agent-middleware";
export * from "./todos";
```

这一层提供一个**可复用、且与「编程」无关**的 ReAct 风格循环。它的心脏是 [agent.ts](../../src/agent/agent.ts) 里 `Agent` 类的 `stream()` 方法——一个 `async *stream()` 异步生成器，反复执行「让模型思考 → 执行模型要的工具 → 把结果喂回去」直到模型不再要求调用工具为止。

**关键约束**：这一层**只依赖 foundation**，并且**必须保持通用**——它不知道什么叫 `read_file`、`bash`，它只知道「有一批叫 `Tool` 的东西可以被调用」。正因如此，同一套 Agent 循环既能用来写代码，也能拿去做别的（客服、数据分析……）。第 5～10 节会把这一层彻底拆开。

#### ③ Coding —— 特化成「会写代码的 Agent」

见 [coding/index.ts](../../src/coding/index.ts)。这一层做的事，是把「② 那个通用大脑」装配成一个具体的、会编程的成品。装配总图就是 [lead-agent.ts](../../src/coding/agents/lead-agent.ts) 里的 `createCodingAgent()` 工厂函数。它把三样东西拼在一起：

1. 一个 `Model`（从上层传进来）；
2. 一组**编程工具**：`bash`、`read_file`、`write_file`、`str_replace`、`list_files`、`glob_search`、`grep_search`、`apply_patch`、`file_info`、`mkdir`、`move_path`（见 [src/coding/tools](../../src/coding/tools)）；
3. 一份精心调校的**系统提示词** + 几个**中间件**（技能、待办、人机审批）。

第 11～15 节专讲这一层。

#### ④ CLI —— 人机界面

见 [src/cli](../../src/cli)。它负责：

- **命令行**：用 Commander 解析 `helixent config model add` 这类子命令（[src/cli/commands](../../src/cli/commands)）；
- **配置**：用 Zod 校验 `~/.helixent/config.yaml`（[src/cli/config](../../src/cli/config)）；
- **TUI**：用 Ink + React 把 Agent 的流式事件渲染成终端界面、把审批弹窗画出来（[src/cli/tui](../../src/cli/tui)）。

[cli/index.tsx](../../src/cli/index.tsx) 是这一层（也是整个可执行程序）的入口。第 18～20 节专讲。

#### ⋆ Community —— 可插拔的厂商适配器

见 [src/community](../../src/community)。这里放的是**第三方模型厂商的适配器**：目前有 [openai](../../src/community/openai) 和 [anthropic](../../src/community/anthropic) 两家。每个适配器都实现了 foundation 定义的 `ModelProvider` 接口，把内部的 `Message` 翻译成对应厂商 API 要求的「网络格式（wire format）」。

它被单独拎出来、而不是塞进 foundation，是为了**隔离第三方 SDK 的依赖**——这样 foundation/agent/coding 的核心逻辑就完全不知道 `openai` 或 `@anthropic-ai/sdk` 这两个 npm 包的存在。第 16、17 节专讲。

### 1.4 目录结构总览

把上面的话落到目录上，就是这样（对照 [src](../../src) 目录）：

```
src/
├── foundation/      # ① 地基：数据 / 模型 / 工具 三大原语
│   ├── messages/    #    Message 类型系统（第 2 节）
│   ├── models/      #    Model + ModelProvider（第 3 节）
│   └── tools/       #    defineTool + 结构化结果（第 4 节）
│
├── agent/           # ② 通用 ReAct 循环
│   ├── agent.ts     #    心脏：stream() 主循环（第 5、6 节）
│   ├── agent-middleware.ts  # 8 个生命周期钩子（第 7 节）
│   ├── skills/      #    技能系统（第 9 节）
│   └── todos/       #    待办/计划模式（第 10 节）
│
├── coding/          # ③ 面向编程的专用 Agent
│   ├── agents/      #    lead-agent.ts 装配总图（第 11 节）
│   ├── tools/       #    read/write/bash/apply_patch...（第 12~14 节）
│   └── permissions/ #    人机审批（第 15 节）
│
├── community/       # ⋆ 第三方模型适配器（可插拔）
│   ├── openai/      #    OpenAI Provider（第 16 节）
│   └── anthropic/   #    Anthropic Provider（第 17 节）
│
├── cli/             # ④ 命令行 + 终端界面
│   ├── index.tsx    #    可执行入口
│   ├── config/      #    配置 schema 与读写（第 18 节）
│   ├── commands/    #    Commander 子命令（第 18 节）
│   ├── settings/    #    审批白名单等设置的持久化（第 18 节）
│   └── tui/         #    Ink/React 终端界面（第 19、20 节）
│
└── index.ts         # 库总入口：只导出 foundation/agent/coding
```

一个值得注意的**命名约定**（来自 [code-convention.md](../code-convention.md)）：

- **文件夹**：kebab-case；集合用复数（`tools/`、`messages/`、`hooks/`），层/概念用单数（`foundation`、`agent`、`coding`、`cli`）。
- **文件**：一律 kebab-case（`read-file.ts`、`model-provider.ts`），**即使是类/组件模块也不用 PascalCase 文件名**。
- **每个目录都有一个 `index.ts` 桶文件**做统一 re-export；**全项目没有任何 default export，只有具名导出**。

这些约定看似琐碎，但正是它们让这个项目「一眼看上去就很整齐」——你在后续任何一节里看到 `import { X } from "@/foundation"`，都能立刻知道 X 来自哪一层。

### 1.5 为什么这样分层？—— 严格的单向依赖

分层的价值，全在「**依赖方向**」这四个字上。[code-convention.md](../code-convention.md) 里用一行字定死了规矩：

> `foundation` → (nothing) • `agent` → `foundation` • `coding` → `foundation` • `community/*` → `foundation`（adapters）• `cli` → everything

翻译成人话，并结合实际源码里的 `import` 补全，依赖关系是这样一张**只有箭头、没有环**的图：

```
        ┌─────────────────────────────────────────┐
        │                  cli                     │   ← 依赖下面所有人
        └─────────────────────────────────────────┘
              │            │            │
              ▼            ▼            ▼
        ┌──────────┐  ┌──────────┐  ┌──────────────┐
        │  coding  │  │  agent   │  │  community/* │
        └──────────┘  └──────────┘  └──────────────┘
              │            │            │
              │      ┌─────┘            │
              ▼      ▼                  ▼
        ┌─────────────────────────────────────────┐
        │               foundation                 │   ← 谁也不依赖
        └─────────────────────────────────────────┘
```

几条关键读法：

- **foundation 在最底层，谁也不依赖**（它甚至不知道 openai 这个包存在）。这保证了地基的**稳定**——改上层永远不会波及地基。
- **agent 只依赖 foundation**，且刻意**不依赖 coding**。这保证了循环的**通用性**：你可以拿 agent 层去搭一个完全不写代码的 Agent。
- **coding 依赖 foundation + agent**：它在 [lead-agent.ts](../../src/coding/agents/lead-agent.ts) 里 `import { Agent } from "@/agent"`，把通用循环特化成编程 Agent。（注意：code-convention 里为了简洁只写了 `coding → foundation`，但实际代码中 coding 也 import 了 agent——这是合理且必要的，因为「特化」本就意味着依赖「通用」。以源码为准。）
- **community 只依赖 foundation**：每个 provider 只是去实现 foundation 定义的 `ModelProvider` 接口，**反过来 foundation 绝不依赖 community**。这就是「可插拔」——想加第三家厂商，只在 community 里新增一个文件夹，核心一行不改。
- **cli 依赖所有人**：它是最顶层的「组装者」，把模型、Agent、UI 全都拼起来。

**为什么单向依赖如此重要？** 因为它把「改动的影响范围」牢牢限制住了：

- 你想接入一个新模型厂商 → 只动 `community/`；
- 你想加一个新工具（比如 `git_commit`）→ 只动 `coding/tools/`；
- 你想换个 UI 主题 → 只动 `cli/tui/`；
- 而 `foundation` 里那几个核心类型，几乎永远不用动。

这正是「高内聚、低耦合」在一个真实项目里的样子。

### 1.6 数据是怎么在层间流动的？—— 一份 `Message` 贯穿始终

这是本节三个核心问题里最重要的一个。答案一句话：**所有层交换的都是同一种数据 —— `Message`。**

回到 [message.ts](../../src/foundation/messages/types/message.ts)，`Message` 是四种角色的联合：

```ts
export type Message = SystemMessage | NonSystemMessage;
export type NonSystemMessage = UserMessage | AssistantMessage | ToolMessage;
```

- `SystemMessage`：系统提示词 / 策略；
- `UserMessage`：用户说的话（可含图片）；
- `AssistantMessage`：模型的回复（可含文本、思考、工具调用）；
- `ToolMessage`：工具执行的结果。

现在我们把 1.2 那张流程图**落到具体代码**，端到端追踪一次运行，看这份 `Message` 是如何被各层接力传递的：

**第 ① 站 · CLI 层（组装 + 启动）** —— [cli/index.tsx](../../src/cli/index.tsx)

无参数运行 `helixent` 时，这里会：读配置 → 按 `entry.provider` 选择 `OpenAIModelProvider` 或 `AnthropicModelProvider`（community 层）→ `new Model(...)`（foundation 层）→ `createCodingAgent({ model, ... })`（coding 层）→ 最后 `render(<App/>)` 把舞台交给 TUI。

```tsx
const model = new Model(entry.name, provider, { max_tokens: 16 * 1024, thinking: { type: "enabled" } });
const agent = await createCodingAgent({ model, skillsDirs, askUser: ..., askUserQuestion: ... });
render(<AgentLoopProvider agent={agent} ...><App .../></AgentLoopProvider>, { patchConsole: false });
```

**第 ② 站 · Coding 层（装配成品）** —— [lead-agent.ts](../../src/coding/agents/lead-agent.ts)

`createCodingAgent` 组装出一个 `Agent`。注意一个巧思：如果项目根目录有 `AGENTS.md`，它会被当作**第一条 `UserMessage`** 塞进初始 `messages`——这就是「长期记忆」的实现方式。它还把一堆编程工具和中间件挂上去：

```ts
return new Agent({
  model,
  prompt: `<agent name="Helixent" ...>...</agent>...`,   // 系统提示词
  messages,                                              // 可能含 AGENTS.md
  tools: [bashTool, readFileTool, writeFileTool, /* ... */ todoTool],
  middlewares,                                           // skills / todos / approval
});
```

**第 ③ 站 · Agent 层（循环）** —— [agent.ts `stream()`](../../src/agent/agent.ts#L140-L171)

用户在 TUI 里输入的话被包成 `UserMessage` 传给 `agent.stream(message)`。循环的骨架非常清爽：

```ts
async *stream(message: UserMessage): AsyncGenerator<AgentEvent> {
  this._appendMessage(message);            // 把用户消息追加进历史
  await this._beforeAgentRun();
  for (let step = 1; step <= this.options.maxSteps; step++) {
    const assistantMessage = yield* this._think();   // 想：调模型
    yield { type: "message", message: assistantMessage };
    const toolUses = this._extractToolUses(assistantMessage);
    if (toolUses.length === 0) {           // 没有工具调用 → 停机
      await this._afterAgentRun();
      return;
    }
    yield* this._act(toolUses);            // 做：执行工具，产出 ToolMessage
  }
}
```

**第 ④ 站 · Foundation(Model) → Community(Provider)（翻译 + 请求）**

`_think()` 内部调用 `this.model.stream(modelContext)`。在 [model.ts](../../src/foundation/models/model.ts#L50-L63) 里，`Model` 做了一件很聪明的事——它自己负责把系统提示词拼成 `SystemMessage` 放到最前面，再拼上历史消息：

```ts
private _buildModelProviderParams(context: ModelContext): ModelProviderInvokeParams {
  const messages: Message[] = [];
  if (context.prompt) {
    messages.push({ role: "system", content: [{ type: "text", text: context.prompt }] });
  }
  messages.push(...context.messages);
  return { model: this.name, options: this.options, messages, tools: context.tools, signal: context.signal };
}
```

随后 `provider.stream(params)`（community 层）把这批内部 `Message[]` 翻译成 OpenAI/Anthropic 的网络格式，发出请求，并把**流式返回的碎片累积成一条完整的 `AssistantMessage`** 交回来。

**第 ⑤ 站 · 回到 Agent 层（执行工具）** —— [agent.ts `_act()`](../../src/agent/agent.ts#L222-L272)

如果 `AssistantMessage` 里带了 `tool_use`，`_act()` 就会找到对应的工具（coding 层的 `bashTool` / `writeFileTool` 等）去执行，把返回值包成一条 `ToolMessage`（`tool_result`）追加进历史，然后循环回到第 ③ 站——把「历史 + 新的工具结果」再喂给模型，让它决定下一步。

**闭环就此形成。** 请回看这一路：从 CLI 到 Coding 到 Agent 到 Foundation 到 Community，再折返回来——**每一层读写的都是同一族 `Message`**。没有哪一层发明了自己的私有对话格式、也没有反复的格式转换（唯一一次「格式翻译」发生在 community 层的最边缘，把内部 `Message` 转成厂商 wire 格式）。这就是「单一数据源」带来的最大好处：**心智负担极低**——你只要吃透一个 `Message` 类型，就看得懂任意两层之间在传什么。

### 1.7 两个入口：库入口 vs CLI 入口

最后厘清一个新手常问的问题：「程序到底从哪开始跑？」Helixent 有**两个不同的入口**，服务两类不同的使用者：

- **库入口** [src/index.ts](../../src/index.ts)：给「把 Helixent 当依赖库来用」的开发者。它只导出核心三层，**不含 cli、也不直接导出 community**：

  ```ts
  export * from "./foundation";
  export * from "./agent";
  export * from "./coding";
  ```

- **CLI 入口**：根目录的 [index.ts](../../index.ts) 只有一行 `import "./src/cli";`，它触发 [cli/index.tsx](../../src/cli/index.tsx) 执行——这才是你敲 `helixent` 时真正运行的东西。`package.json` 里 `bin.helixent` 指向的、以及 `build:bin` 用 `bun build --compile` 打出来的单文件二进制，跑的都是这条线。

一句话记忆：**想「引用」Helixent，从 `src/index.ts` 进；想「运行」Helixent，从 `src/cli/index.tsx` 进。**

---

## 2. 亮点与关键设计

本节对应的三个「妙笔」，现在可以明确标注了：

1. **严格单向依赖（`foundation ← agent/coding/community ← cli`）**
   —— 这是**关键决策**。用一条不可违反的依赖规则，换来「改动影响范围可控」和「各层可独立演进/测试」。它是整个项目「干净」的根源。

2. **community 作为可插拔适配器，隔离第三方 SDK**
   —— 这是**妙笔**。foundation 只定义 `ModelProvider` 接口这份「契约」，具体的 `openai` / `@anthropic-ai/sdk` 依赖被关进 community 的小黑屋。想支持新厂商 = 新增一个实现了契约的文件夹，核心零改动。

3. **一份 `Message` 贯穿始终的「单一数据源」**
   —— 这是**思想内核**。全项目只有一种对话数据结构，各层之间不做多余的格式转换，唯一的「翻译」被推到最边缘的 community 层。这让代码的可读性和可维护性都大幅提升。

一个额外的、贯穿全项目的工程亮点：**桶文件（`index.ts`）+ 全具名导出 + kebab-case 文件名 + `@/*` 路径别名**。它们合起来让「跨层引用」永远是一句清清爽爽的 `import { X } from "@/foundation"`。

---

## 3. 工业对比

把 Helixent 的分层思路，和业界常见方案对照一下，你会更理解它「为什么这么设计」：

| 维度 | Helixent | LangChain / LangGraph | OpenAI 官方 SDK | Claude Code（闭源，公开信息） |
| --- | --- | --- | --- | --- |
| 对话数据模型 | **单一 `Message` 类型**贯穿所有层 | 有 `BaseMessage` 体系，但抽象层级多、概念（Chain/Runnable/Graph）较重 | 直接用厂商 wire 格式（`role`+`content`），无跨厂商统一层 | 内部有统一 transcript，思路与 Helixent 类似 |
| 厂商适配 | community 层可插拔 `ModelProvider`，核心零依赖 SDK | 有大量 integration 包，但核心与 integration 耦合度较高 | 只服务 OpenAI 自家 | 主要面向 Anthropic 自家模型 |
| Agent 循环 | 自研极简 `async *stream()` + 中间件，代码可一眼读完 | 用 Graph/StateMachine 抽象，功能强但学习曲线陡 | 无内置 Agent 循环（需自己写或用 Assistants API） | 自研，未开源 |
| 定位 | **教学友好**：小、清晰、命名统一 | **生产全能**：组件丰富、生态大、也更重 | **官方基座**：稳定但需自行编排上层 | **产品级**：体验好但看不到源码 |

要点：**Helixent 不追求「功能最全」，而追求「结构最清晰」**。LangChain 那套 Chain/Runnable/Graph 抽象在大型生产系统里很有价值，但对「想搞懂一个 Agent 到底怎么转」的学习者反而是噪音。Helixent 用几百行就把核心讲明白，这正是它作为「教学标本」的价值所在。

---

## 4. 深度解释：为什么非要这么分？不这么做会怎样？

**Q1：为什么不把所有代码堆在一起、非要分四层？**
如果不分层，最典型的后果是「涟漪式改动」：你想换个模型厂商，结果发现 openai SDK 的类型渗透进了 Agent 循环甚至 UI 渲染里，改一处牵动全身。分层 + 单向依赖，本质是给「改动」修了**防火墙**——每层只能看见自己下方的层，看不见上方，也看不见平级兄弟层的内部。

**Q2：为什么把 community 单独拎出来，而不放进 foundation？**
因为 foundation 是「地基」，它必须**零第三方运行时依赖**（除了 zod 这种纯类型/校验工具）。一旦让 foundation 直接 `import "openai"`，地基就和某个特定厂商绑死了。把厂商适配隔离到 community、只让它去实现 foundation 定义的接口，就实现了「依赖倒置」：**是适配器依赖抽象，而非抽象依赖适配器**。

**Q3：为什么 agent 层要刻意「不认识」编程工具？**
如果 agent 循环里写死了 `if (toolName === "read_file")` 这类逻辑，它就再也没法复用到非编程场景了。让 agent 只认识抽象的 `Tool`、把「有哪些具体工具」的决定权交给 coding 层，循环就保持了通用性。这也是为什么「工具装配」发生在 coding 的 [lead-agent.ts](../../src/coding/agents/lead-agent.ts)，而不是 agent 的 [agent.ts](../../src/agent/agent.ts)。

**Q4：「单一数据源」如果不坚持，会出什么问题？**
最常见的坑是「格式转换地狱」：UI 有一套消息格式、Agent 有一套、每个厂商又各有一套，中间要写 N×M 个转换函数，还容易在转换时丢字段（比如 `tool_use_id` 对不上）。Helixent 让 `Message` 从头贯到尾，把转换收敛到 community 层唯一的边界上，从根本上避免了这类 bug。第 2 节你会看到这个 `Message` 类型是如何用「可辨识联合（discriminated union）」精心设计的。

---

## 5. 参考资料

- 本项目文档：[README.md](../../README.md)（Architecture 一节）、[AGENTS.md](../../AGENTS.md)、[code-convention.md](../code-convention.md)
- ReAct 论文：*ReAct: Synergizing Reasoning and Acting in Language Models*（Yao et al., 2022）— https://arxiv.org/abs/2210.03629
- 依赖倒置原则（DIP）/ 整洁架构：Robert C. Martin, *Clean Architecture* — 分层与依赖方向的经典论述
- Bun 运行时：https://bun.com
- Ink（用 React 渲染终端 UI）：https://github.com/vadimdemedes/ink
- Agent Skills 标准格式：https://agentskills.io/
- 对照产品：Claude Code、Cursor Agent、OpenAI Codex CLI、Aider、Cline（了解同类形态，建立坐标系）

---

## 6. 小结与下一节预告

本节你应该已经建立起这张地图：

- Helixent = **4 层**（foundation / agent / coding / cli）+ **1 个 community 适配区**；
- 它们靠**严格单向依赖**组织，foundation 在最底、cli 在最顶；
- 一份 **`Message`** 从 CLI 一路流到 community 再折返，是贯穿全局的**单一数据源**；
- 想「引用」从 [src/index.ts](../../src/index.ts) 进，想「运行」从 [cli/index.tsx](../../src/cli/index.tsx) 进。

**承上启下（启下）**：我们反复提到，这张地图的**最底层地基是 `Message`**——`Model` 消费和产出它、`Agent` 循环搬运它、`community` 在边界翻译它、`cli` 渲染它。可以说，**`Message` 的形状决定了它上面所有层的形状**。所以，要真正读懂 Helixent，就必须从这块地基的第一块砖开始。

👉 下一节 **第 2 节：Message 消息类型系统 —— 端到端的单一数据源**，我们就钻进 [message.ts](../../src/foundation/messages/types/message.ts) 与 [content.ts](../../src/foundation/messages/types/content.ts)，看它是如何用「双层可辨识联合」把一段对话建模得既严谨又灵活的，并解答一个你现在或许已经好奇的问题：**为什么消息内容是「分段数组」而不是「一个字符串」？**

准备好后，对我说「**生成第 2 节**」即可。
