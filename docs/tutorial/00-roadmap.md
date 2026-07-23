# Helixent 源码精读 · 学习路线图（Roadmap）

> 这是一份为**零基础读者**准备的、系统化拆解 Helixent 项目的学习路线图。
> 目标：读完整套教程后，你不仅能看懂 Helixent 每一行关键代码，还能理解「为什么这么设计」，并能把这些设计思想迁移到自己的 Agent / CLI / 框架项目中。

***

## 一、这个项目是什么？

Helixent 是一个用 **Bun + TypeScript** 编写的 **ReAct 风格 Coding Agent 框架 + 命令行工具**。
一句话概括它做的事：

> 给一个大语言模型（LLM）配上「一双手」（工具）和「一个循环」（Agent Loop），让它能读文件、改代码、跑命令，像一个初级工程师一样在你的项目目录里干活；同时提供一个漂亮的终端界面（TUI）让你和它对话。

它的同类产品是 **Claude Code、Cursor Agent、OpenAI Codex CLI、Aider、Cline** 等。Helixent 的价值在于：**代码量小、分层极其干净、命名规范统一**，是学习「一个现代 Coding Agent 到底由哪些零件组成」的绝佳样本。

***

## 二、学习前的注意事项（请先读这一节）

### 1. 前置知识要求

- **必须**：了解 TypeScript 基本语法（`interface` / `type` / 泛型 / 联合类型）、`async/await`。
- **最好**：听说过 LLM 的「function calling / tool use」概念、知道什么是「流式输出（streaming）」。
- **不需要**：会 React / Ink / Bun —— 这些会在对应章节从零讲解。
- 如果你完全没接触过「Agent」这个词，**不要跳过第 1 节和第 5 节**，它们解释了整套东西的思想内核。

### 2. 本教程的教学约定

每一节都会严格包含以下**六个部分**（这是你和我约定的固定格式）：

1. **承上启下**：先用一段话回顾上一节留下的「钩子」，并说明本节要在整体拼图里补上哪一块 —— 保证你始终知道「现在学到哪、为什么学这个」。
2. **主题内容**：该主题的设计思路 + 具体代码位置 + 实现细节逐行讲解。
3. **亮点与关键设计**：明确标注哪些是「妙笔」、哪些是「关键决策」。
4. **工业对比**：对比 Claude Code / LangChain / OpenAI SDK 等业界方案的做法与优缺点。
5. **深度解释**：复杂设计会讲清「为什么这样做」以及「不这样做会出什么问题」。
6. **参考资料**：文档、博客、论文、规范链接。

### 3. 如何使用本教程

- **按顺序学**：章节之间有严格的依赖关系（见第四节的依赖图），且**后一节总是建立在前一节的结论之上**。强烈建议从第 1 节顺序读到最后。
- **对照源码学**：每节都会给出可点击的源码链接。请**一边读教程一边打开对应源文件**，不要只读教程。
- **动手验证**：建议 `bun install` 后跑 `bun run dev`，边学边观察 Agent 的实际行为。跑测试用 `bun test`。
- **一次一节**：当你准备好学某一节时，对我说「**生成第 N 节**」，我才会输出该节的完整内容并写入独立文件。

### 4. 阅读源码的推荐入口

如果你想在学习前先自己"摸"一遍，推荐这个顺序打开文件感受一下：
[message.ts](../../src/foundation/messages/types/message.ts) → [model.ts](../../src/foundation/models/model.ts) → [agent.ts](../../src/agent/agent.ts) → [lead-agent.ts](../../src/coding/agents/lead-agent.ts) → [cli/index.tsx](../../src/cli/index.tsx)。

***

## 三、完整章节路线图

> 共 **21 节**，分为 **7 个部分**。整体沿「**自底向上**」推进：从最底层的核心原语（数据、模型、工具）→ 通用 Agent 循环 → 面向编程的专用能力 → 模型厂商适配 → 人机界面 → 工程收尾。
> 设计原则：**不重不漏**——每个源文件只在一节里被「精讲」，其余章节只做引用；**渐进衔接**——每节都从上一节的产物出发，并为下一节埋好伏笔。
> 每节标注了：**核心问题**（这节要回答什么）、**主要代码位置**、**亮点预告**、**承上启下**（与前后章节的接口）。

### 第一部分 · 总览（先建立全局观）

#### 第 1 节：项目全景与四层架构

- **核心问题**：Helixent 由哪些层组成？为什么要这样分层？数据是怎么在层与层之间流动的？
- **主要代码**：`AGENTS.md`、`README.md`、`src/*` 目录结构、[code-convention.md](../code-convention.md)、[src/index.ts](../../src/index.ts)
- **亮点预告**：严格单向依赖（`foundation ← agent/coding/community ← cli`）；`community` 作为可插拔适配器隔离第三方 SDK；一份 `Message` 贯穿始终的「单一数据源」思想。
- **承上启下**：这是全书的「地图」。本节末尾会指出：整张地图的最底层地基是 `Message` 数据结构——它决定了上面所有层的形状，因此**下一节就从它开始**。

***

### 第二部分 · Foundation 层（一切的地基）

#### 第 2 节：Message 消息类型系统 —— 端到端的单一数据源

- **核心问题**：对话历史用什么数据结构表示？为什么内容是「分段数组」而不是「一个字符串」？
- **主要代码**：[message.ts](../../src/foundation/messages/types/message.ts)、[content.ts](../../src/foundation/messages/types/content.ts)、[role.ts](../../src/foundation/messages/types/role.ts)、[messages/index.ts](../../src/foundation/messages/index.ts)
- **亮点预告**：用 `role` 和 `type` 双层「可辨识联合（discriminated union）」建模；`snake_case` 与 `camelCase` 的「wire vs internal」分界；`ToolUseContent<T>` 的泛型输入设计。
- **承上启下**：承接第 1 节点出的「单一数据源」。本节确立了 `Message` 的形状后，一个自然的问题浮现：**谁来生产这些** **`AssistantMessage`？**——那就是模型，交给第 3 节。

#### 第 3 节：Model 与 ModelProvider —— 模型抽象与适配契约

- **核心问题**：如何做到「换一个大模型厂商，Agent 代码一行不改」？`invoke` 和 `stream` 为何是一对？
- **主要代码**：[model.ts](../../src/foundation/models/model.ts)、[model-provider.ts](../../src/foundation/models/model-provider.ts)、[model-context.ts](../../src/foundation/models/model-context.ts)、[models/index.ts](../../src/foundation/models/index.ts)
- **亮点预告**：`Model`（编排壳）与 `ModelProvider`（厂商契约）的职责分离；`ModelContext` 只带第 2 节的 `NonSystemMessage`、由 `Model` 负责拼装 `system` prompt 的巧思；流式约定「每次 yield 都是完整快照」。
- **承上启下**：本节消费第 2 节的 `Message`、产出新的 `AssistantMessage`。但模型光会「说话」还不够——它还得能「动手」。模型如何声明「我能调用哪些工具」？这把钥匙交给第 4 节。

#### 第 4 节：Tool 工具系统 —— defineTool 与 Zod 类型推导

- **核心问题**：一个「工具」在代码里长什么样？模型怎么知道有哪些参数？类型安全如何贯穿？
- **主要代码**：[function-tool.ts](../../src/foundation/tools/function-tool.ts)、[structured-tool-result.ts](../../src/foundation/tools/structured-tool-result.ts)、[tools/index.ts](../../src/foundation/tools/index.ts)、[foundation/index.ts](../../src/foundation/index.ts)
- **亮点预告**：`defineTool` 工厂 + Zod schema → 自动 JSON Schema → 自动 TS 类型推导的「一处定义，三处受益」；结构化结果 `{ ok, summary, data | error, code }` 的契约设计。
- **承上启下**：至此 Foundation 三块地基（数据 / 模型 / 工具）齐备。它们是**静止的零件**；把它们串成一台运转的机器，需要一个「循环」——这正是第三部分 Agent 层的主题，从第 5 节的心脏开始。

***

### 第三部分 · Agent 层（可复用的通用大脑）

#### 第 5 节：ReAct 主循环 —— think / act / observe 的骨架

- **核心问题**：Agent 是怎么「一步步思考并行动」的？循环在什么时候停下来？（本节只讲**控制流骨架**，并发细节留给第 6 节）
- **主要代码**：[agent.ts](../../src/agent/agent.ts#L140-L205) [`stream`](../../src/agent/agent.ts#L140-L205) [/](../../src/agent/agent.ts#L140-L205) [`_think`](../../src/agent/agent.ts#L140-L205)、[agent-event.ts](../../src/agent/agent-event.ts)、[agent/index.ts](../../src/agent/index.ts)
- **亮点预告**：`async *stream()` 生成器驱动的主循环；`_think` 拉取模型流式快照；「无工具调用即停机」的终止条件；`maxSteps` 熔断；`AbortController` 贯穿式取消。
- **承上启下**：本节把第 3 节的模型和第 4 节的工具接进了一个循环，但特意在 `_act`（执行工具）处留了一个「占位」。**当一步里模型同时要调多个工具时，怎么并发？** 这个被刻意跳过的问题，就是第 6 节。

#### 第 6 节：并行工具调度 —— Promise.race 循环 vs Promise.all

- **核心问题**：一次要调多个工具时怎么并发执行？为什么不用 `Promise.all`？
- **主要代码**：[agent.ts](../../src/agent/agent.ts#L222-L272) [`_act`](../../src/agent/agent.ts#L222-L272)
- **亮点预告**：用「`Promise.race` + pending 集合」实现**谁先完成谁先产出结果消息**；把 abort 也塞进 race 的技巧；工具错误「就地捕获成 `Error:` 文本」而非抛出的容错哲学。
- **承上启下**：填平第 5 节的 `_act` 占位后，主循环已能完整跑通。但循环目前是「封闭」的——想插入审批、技能、待办等行为就得改核心代码。**如何不改核心而扩展？** 答案是第 7 节的中间件。

#### 第 7 节：Middleware 中间件系统 —— 8 个生命周期钩子

- **核心问题**：如何在不改 Agent 核心代码的前提下，插入审批、技能注入、待办提醒等行为？
- **主要代码**：[agent-middleware.ts](../../src/agent/agent-middleware.ts)、[agent.ts 钩子分发](../../src/agent/agent.ts#L278-L360)
- **亮点预告**：`beforeX/afterX` 成对钩子；「返回 `Partial<Context>` 则 `Object.assign` 合并，返回空则无操作」的极简协议；`beforeToolUse` 返回 `{ __skip: true }` 的「短路跳过」信号设计。
- **承上启下**：中间件是后续**一切扩展的插座**。接下来的第 8/9/10 节，都是往这个插座上插的三个具体「插件」——它们互不相关、可任意组合，因此可以并列学习。先从最基础、被所有工具依赖的「结果处理」讲起。

#### 第 8 节：工具结果处理管线 —— normalize / policy / summary

- **核心问题**：第 6 节工具返回的五花八门的结果，如何统一成喂给模型的字符串？如何防止上下文被撑爆？
- **主要代码**：[tool-result-runtime.ts](../../src/agent/tool-result-runtime.ts)、[tool-result-policy.ts](../../src/agent/tool-result-policy.ts)、[tool-result-summary.ts](../../src/agent/tool-result-summary.ts)
- **亮点预告**：`normalizeToolResult` 把「结构化对象 / `Error:` 字符串 / 裸值」归一化；按工具名分级的**截断策略**（`preferSummaryOnly` / `maxStringLength`）；`inferToolErrorKind` 从错误码前后缀推断错误类别。
- **承上启下**：本节解决了「结果怎么回喂」。下一节转向另一个正交问题：**能力怎么按需注入**——即在不撑爆 prompt 的前提下，让 Agent 临时学会一套专门技能。

#### 第 9 节：Skills 技能系统 —— 渐进式加载（Progressive Disclosure）

- **核心问题**：如何让 Agent「按需」学会一套专门技能，而不是把所有说明书一次性塞进 prompt？
- **主要代码**：[skills-middleware.ts](../../src/agent/skills/skills-middleware.ts)、[skill-reader.ts](../../src/agent/skills/skill-reader.ts)、[list-skills.ts](../../src/agent/skills/list-skills.ts)、[skills/types](../../src/agent/skills/types/index.ts)、`skills/*/SKILL.md`
- **亮点预告**：只把技能的 frontmatter（名字+描述+路径）注入 prompt，正文让模型自己用 `read_file` 按需读取的「渐进式披露」；多目录发现 + 按路径去重的策略；对标 [agentskills.io](https://agentskills.io/) 标准格式。
- **承上启下**：技能让 Agent「会得更多」，但长任务里模型容易「跑偏 / 忘事」。最后一个中间件插件——待办系统，专治「注意力涣散」，见第 10 节。

#### 第 10 节：Todos 计划模式 —— 工具 + 中间件的组合拳

- **核心问题**：如何让 Agent 在长任务中维护一个「待办清单」并保持专注？
- **主要代码**：[todos.ts](../../src/agent/todos/todos.ts)、[todos/types.ts](../../src/agent/todos/types.ts)、[todos/index.ts](../../src/agent/todos/index.ts)
- **亮点预告**：`createTodoSystem` 同时返回「一个工具 + 一个中间件」共享同一份闭包状态；基于「距上次写入步数」的**智能提醒**机制（防止模型忘记更新待办）；`merge` 增量更新 vs 全量替换。
- **承上启下**：到这里，一个**通用**的 Agent 大脑（循环 + 中间件 + 三大插件）已经完备。但它还不是「会写代码」的——它缺一套编程专用工具和一份精心调校的人设。把通用大脑「特化」成 Coding Agent，是第四部分的任务，从第 11 节的装配总图开始。

***

### 第四部分 · Coding 层（面向编程的专用 Agent）

#### 第 11 节：Lead Agent —— 系统提示词、工具装配与 AGENTS.md

- **核心问题**：一个「会写代码的 Agent」是如何被组装出来的？系统提示词里藏了哪些引导？
- **主要代码**：[lead-agent.ts](../../src/coding/agents/lead-agent.ts)、[coding/agents/index.ts](../../src/coding/agents/index.ts)、[coding/index.ts](../../src/coding/index.ts)
- **亮点预告**：`createCodingAgent` 工厂如何把「第 3 节的模型 + 一组工具 + 第 7 节的三大中间件」拼成成品；XML 风格的系统提示词与 `<tool_usage>` 行为约束；自动加载项目根 `AGENTS.md` 作为长期记忆。
- **承上启下**：本节是一张「**装配总图**」，它引用了一堆还没细看的工具。接下来第 12～15 节就逐个拆解这些被装配进来的零件。先从最基础、且共享同一套路径/结果工具函数的「文件读写」讲起。

#### 第 12 节：工具地基与文件读写 —— tool-utils / tool-result 与 read / write / str\_replace

- **核心问题**：所有 coding 工具共享哪些「地基函数」（路径校验、结果封装、文本截断）？Agent 读改文件的工具如何设计得「既好用又防错」？
- **主要代码**：[tool-utils.ts](../../src/coding/tools/tool-utils.ts)、[tool-result.ts](../../src/coding/tools/tool-result.ts)、[read-file.ts](../../src/coding/tools/read-file.ts)、[write-file.ts](../../src/coding/tools/write-file.ts)、[str-replace.ts](../../src/coding/tools/str-replace.ts)
- **亮点预告**：`ensureAbsolutePath` / `isWithinDirectory` / `truncateText` 三件套如何被所有工具复用；`okToolResult` / `errorToolResult` 落地第 4 节的结构化契约；`read_file` 的行号范围读取与截断；`str_replace` 强制「唯一匹配」以防误改；`description` 作为第一参数的强约定。
- **承上启下**：本节铺好了工具「地基函数」，后续所有工具都站在它们之上。第 13 节讲的一批「探索环境」工具，正是这些地基函数的最大用户。

#### 第 13 节：搜索与系统工具 —— bash / glob / grep / list\_files / file\_info / mkdir / move\_path

- **核心问题**：这些「探索环境」的工具分别解决什么问题？为什么 `bash` 要这样处理输出和中断？
- **主要代码**：[bash.ts](../../src/coding/tools/bash.ts)、[glob-search.ts](../../src/coding/tools/glob-search.ts)、[grep-search.ts](../../src/coding/tools/grep-search.ts)、[list-files.ts](../../src/coding/tools/list-files.ts)、[file-info.ts](../../src/coding/tools/file-info.ts)、[mkdir.ts](../../src/coding/tools/mkdir.ts)、[move-path.ts](../../src/coding/tools/move-path.ts)
- **亮点预告**：`bash` 用 `Bun.spawn` + `signal` 实现可中断子进程（呼应第 5 节的 `AbortController`）；`grep_search` 依赖 `rg` 并优雅降级报 `RG_NOT_FOUND`；搜索类工具「只回摘要不回数据」的上下文节流（呼应第 8 节的 policy）。
- **承上启下**：第 12/13 节的工具都靠「整体覆盖 / 唯一匹配」改文件，粒度粗。要做外科手术式的多处精确改动，需要一个更强的工具——自研 diff 引擎 `apply_patch`，见第 14 节。

#### 第 14 节：apply\_patch —— 手写 unified diff 解析器与应用器

- **核心问题**：为什么要自己实现一个 diff 解析器？它如何保证「打补丁不打错地方」？
- **主要代码**：[apply-patch.ts](../../src/coding/tools/apply-patch.ts)
- **亮点预告**：从零解析 `@@ -a,b +c,d @@` hunk 头；`validateHunkCounts` 校验行数、上下文/删除行**逐行比对**防漂移；为何刻意不支持文件删除（`/dev/null`）。
- **承上启下**：第 12～14 节的工具都能「改动世界」——跑命令、写文件、打补丁，都是危险操作。**执行前如何拦下来让人类过目？** 这就引出第 15 节的人机确认基础设施。

#### 第 15 节：Human-in-the-Loop —— 审批与提问共享的「队列 + 单活跃 + 订阅」模式

- **核心问题**：危险操作（跑命令、改文件）如何在执行前弹给人类确认？Agent 主动向人提问又是怎么实现的？两者为什么能共用一套基础设施？
- **主要代码**：审批——[coding-approval-middleware.ts](../../src/coding/permissions/coding-approval-middleware.ts)、[approval-manager.ts](../../src/coding/permissions/approval-manager.ts)、[requires-approval.ts](../../src/coding/permissions/requires-approval.ts)、[approval-persistence.ts](../../src/coding/permissions/approval-persistence.ts)、[approval-types.ts](../../src/coding/permissions/approval-types.ts)；提问——[ask-user-question.ts](../../src/coding/tools/ask-user-question.ts)、[ask-user-question-manager.ts](../../src/coding/tools/ask-user-question-manager.ts)
- **亮点预告**：审批以「中间件 + 第 7 节的 `beforeToolUse` 短路」实现，与核心解耦；`ask_user_question` 则以「阻塞式工具」实现；两个 `Manager` 共享同一套**队列 + 单活跃请求 + 订阅**模型来桥接异步 Promise 与（尚未登场的）React UI；`approval-persistence` 只定义「白名单读写契约」，具体落盘留到第 18 节。
- **承上启下**：这两个 Manager 都在「等一个 UI 来响应」。但整个 Coding Agent 目前还跑在内存里、连不上真实模型厂商。先补齐「连接真实模型」这一环——第五部分的 Provider 适配。

***

### 第五部分 · Community 层（第三方模型适配）

#### 第 16 节：OpenAI Provider —— 消息转换与流式累积器

- **核心问题**：第 2 节的内部 `Message` 如何翻译成 OpenAI 的 wire 格式？第 3 节约定的「完整快照」流式碎片如何拼回？
- **主要代码**：[model-provider.ts](../../src/community/openai/model-provider.ts)、[utils.ts](../../src/community/openai/utils.ts)、[stream-utils.ts](../../src/community/openai/stream-utils.ts)、[types.ts](../../src/community/openai/types.ts)、[openai/index.ts](../../src/community/openai/index.ts)
- **亮点预告**：`convertToOpenAIMessages` 的双向翻译；`StreamAccumulator` 增量拼接**未完成的 tool-call JSON**，并「参数没解析成功前不吐出 tool\_use」的严谨；`temperature: 0` 默认值决策。
- **承上启下**：本节是 `ModelProvider` 契约的**第一个实现**。有了范本，第 17 节接入第二家厂商时，就能清晰对照出「哪些是契约共性、哪些是厂商差异」。

#### 第 17 节：Anthropic Provider —— 多 Provider 的共性与差异

- **核心问题**：接入第二个厂商时，哪些能复用、哪些必须定制？两家 API 的差异体现在哪？
- **主要代码**：[model-provider.ts](../../src/community/anthropic/model-provider.ts)、[utils.ts](../../src/community/anthropic/utils.ts)、[stream-utils.ts](../../src/community/anthropic/stream-utils.ts)、[anthropic/index.ts](../../src/community/anthropic/index.ts)
- **亮点预告**：`system` prompt 单独抽取（Anthropic 不放在 messages 里）；`thinking.budget_tokens` 的自动推导；`baseURL` 默认值的谨慎处理；同名不同实现的 `StreamAccumulator` 对比第 16 节。
- **承上启下**：至此「大脑 + 工具 + 模型」全部就位，一个完整的 Agent 已能在代码里跑起来。剩下的是**把它交到用户手里**——一个能配置、能对话、能审批的命令行程序，这是第六部分。

***

### 第六部分 · CLI / TUI 层（人机交互界面）

#### 第 18 节：CLI 入口、配置、命令与设置持久化

- **核心问题**：敲下 `helixent` 之后到底发生了什么？模型配置和第 15 节的审批白名单，究竟存在哪、怎么读写？
- **主要代码**：[cli/index.tsx](../../src/cli/index.tsx)、[config/schema.ts](../../src/cli/config/schema.ts)、[config/index.ts](../../src/cli/config/index.ts)、[commands/\*](../../src/cli/commands/index.ts)、[model-providers.ts](../../src/cli/model-providers.ts)、[bootstrap/\*](../../src/cli/bootstrap/index.ts)、[settings/settings.ts](../../src/cli/settings/settings.ts)、[settings-loader.ts](../../src/cli/settings/settings-loader.ts)、[settings-writer.ts](../../src/cli/settings/settings-writer.ts)
- **亮点预告**：Commander 子命令（`config model add/list/remove/set-default`）vs 无参进入 TUI 的分流；用 Zod 校验 `~/.helixent/config.yaml`；首次运行向导（first-run wizard）；`SettingsLoader/Writer` + `appendToolToAllowList` 如何**落地**第 15 节 `approval-persistence` 定义的白名单契约。
- **承上启下**：本节是「命令行外壳 + 落盘」，它在 `cli/index.tsx` 里 `render(<App/>)` 后就把舞台交给了 TUI。**Agent 的流式事件如何驱动一个 React 界面刷新？** 第 19 节揭晓。

#### 第 19 节：TUI 架构与状态编排 —— Ink + React 的 Agent Loop Hook

- **核心问题**：终端界面为什么能用 React 写？第 5 节的流式事件、第 15 节两个 Manager 的「等待响应」，如何被接进 React 的状态与渲染？
- **主要代码**：[use-agent-loop.ts](../../src/cli/tui/hooks/use-agent-loop.ts)、[app.tsx](../../src/cli/tui/app.tsx)、[use-approval-manager.ts](../../src/cli/tui/hooks/use-approval-manager.ts)、[use-ask-user-question-manager.ts](../../src/cli/tui/hooks/use-ask-user-question-manager.ts)、[approval-prompt.tsx](../../src/cli/tui/components/approval-prompt.tsx)、[ask-user-question-prompt.tsx](../../src/cli/tui/components/ask-user-question-prompt.tsx)
- **亮点预告**：Ink = 「用 React 渲染到终端」；`AgentLoopProvider` 用 Context 分发状态；`enqueueMessage` + 50ms 批量刷新的**节流渲染**；两个 `use*Manager` Hook 如何 `subscribe` 第 15 节的 Manager、把「单活跃请求」变成一个弹出的 React 表单。
- **承上启下**：本节打通了「Agent → 状态 → 弹窗」的**输出与交互回路**。还差最后一环：用户**怎么把话打进去**（输入框、斜杠命令、历史），以及消息**怎么好看地显示出来**（渲染器、主题）——第 20 节收尾人机界面。

#### 第 20 节：TUI 输入、命令面板与消息渲染

- **核心问题**：输入框的光标/历史/斜杠命令补全是怎么实现的？为什么同一套工具调用要写两个渲染器？消息如何「滚出」到终端历史？
- **主要代码**：输入——[input-editor.ts](../../src/cli/tui/input-editor.ts)、[command-registry.ts](../../src/cli/tui/command-registry.ts)、[use-command-input.ts](../../src/cli/tui/hooks/use-command-input.ts)、[use-input-history.ts](../../src/cli/tui/hooks/use-input-history.ts)、[input-box.tsx](../../src/cli/tui/components/input-box.tsx)、[command-list.tsx](../../src/cli/tui/components/command-list.tsx)；渲染——[message-text.ts](../../src/cli/tui/message-text.ts)、[message-history.tsx](../../src/cli/tui/components/message-history.tsx)、[markdown.tsx](../../src/cli/tui/components/markdown.tsx)、[token-usage.ts](../../src/cli/tui/token-usage.ts)、[themes/index.ts](../../src/cli/tui/themes/index.ts)
- **亮点预告**：纯函数 `input-editor` 光标操作 + `command-registry` 的斜杠命令解析/补全/`/help`；ANSI 纯文本渲染器 vs Ink 组件渲染器「刻意不复用」的取舍；`useFlushToScrollback` 把定稿消息写入终端 scrollback 的技巧；Token 用量统计与主题系统。
- **承上启下**：到此，从数据结构到用户按键的**完整链路**已全部走通。最后一部分跳出「读代码」，站在「作品」视角，看这个项目如何用工程手段保证质量、并打包成一个能分发的二进制。

***

### 第七部分 · 工程实践（把它当一个「作品」来欣赏）

#### 第 21 节：测试、代码规范、构建与发布

- **核心问题**：这个项目如何保证质量？如何被打包成一个单文件可执行程序？
- **主要代码**：`src/**/__tests__/*`、[code-convention.md](../code-convention.md)、[bun.md](../bun.md)、`package.json`、`.githooks/`、`.github/workflows/check.yml`
- **亮点预告**：Bun 内置测试运行器与「co-located 测试」；`bun build --compile` 产出单文件二进制；pre-commit hook + CI 双保险的 `bun run check`；为什么选 Bun 而不是 Node/Deno。
- **承上启下**：这是全书终点，也是回到起点的闭环——它检验的正是第 1 节那张架构图里每一层的质量约束。读完本节，建议回到第 1 节重读全景图，你会有全新的理解。

***

## 四、章节依赖关系（建议学习顺序）

```
第1节 总览
   │
   ▼
第2节 Message ──► 第3节 Model ──► 第4节 Tool        (Foundation：三块地基，严格按序)
                                     │
                                     ▼
                        第5节 ReAct 主循环（骨架）  ◄── 整个项目的「心脏」，务必吃透
                                     │
                                     ▼
                        第6节 并行调度（填 _act 占位）
                                     │
                                     ▼
                        第7节 Middleware  ◄── 后续一切扩展的「插座」
                                     │
             ┌───────────────────────┼───────────────────────┐
             ▼                       ▼                       ▼
      第8节 结果管线            第9节 Skills             第10节 Todos      (三个可并列的插件)
             │                       │                       │
             └───────────────────────┴───────────────────────┘
                                     ▼
                        第11节 Lead Agent（把上面零件装配成 Coding Agent）
                                     │
             ┌──────────────┬────────┴────────┬──────────────┐
             ▼              ▼                 ▼              ▼
      第12节 工具地基    第13节 探索工具     第14节 apply_patch  第15节 人机确认(审批+提问)
      +文件读写         (依赖第12节地基)                        │
                                                              ▼
                        第16节 OpenAI ──► 第17节 Anthropic   (Provider 适配：先范本后对照)
                                     │
                                     ▼
      第18节 CLI入口/配置/持久化 ──► 第19节 TUI架构/状态编排 ──► 第20节 输入/命令/渲染
                                     │
                                     ▼
                        第21节 工程实践（收尾，回扣第1节）
```

**最短核心路径**（如果时间紧，只想抓主干）：`1 → 2 → 3 → 4 → 5 → 7 → 11`。这 7 节读完，你就理解了「一个 Agent 从定义到跑起来」的完整骨架。

***

## 五、覆盖对照（不重不漏自查表）

> 用于确认「每个源码目录都被恰好一节精讲」，避免遗漏或重复。

| 部分           | 章节            | 精讲的源码范围                                                                                                                     |
| ------------ | ------------- | --------------------------------------------------------------------------------------------------------------------------- |
| 一 总览         | §1            | `src/index.ts`、目录结构与依赖约束                                                                                                    |
| 二 Foundation | §2 / §3 / §4  | `messages/*` / `models/*` / `tools/*`                                                                                       |
| 三 Agent      | §5 / §6       | `agent.ts`（`stream`+`_think`）/（`_act`）、`agent-event.ts`                                                                     |
| 三 Agent      | §7            | `agent-middleware.ts` + 钩子分发                                                                                                |
| 三 Agent      | §8 / §9 / §10 | `tool-result-*.ts` / `skills/*` / `todos/*`                                                                                 |
| 四 Coding     | §11           | `coding/agents/*`、`coding/index.ts`                                                                                         |
| 四 Coding     | §12           | `tool-utils.ts`、`tool-result.ts`、`read/write/str-replace`                                                                   |
| 四 Coding     | §13           | `bash`、`glob/grep`、`list-files`、`file-info`、`mkdir`、`move-path`                                                             |
| 四 Coding     | §14           | `apply-patch.ts`                                                                                                            |
| 四 Coding     | §15           | `permissions/*`、`ask-user-question*.ts`                                                                                     |
| 五 Community  | §16 / §17     | `community/openai/*` / `community/anthropic/*`                                                                              |
| 六 CLI/TUI    | §18           | `cli/index.tsx`、`config/*`、`commands/*`、`bootstrap/*`、`model-providers.ts`、`settings/*`                                     |
| 六 CLI/TUI    | §19           | `use-agent-loop`、`app.tsx`、`use-*-manager` Hook、审批/提问 prompt 组件                                                             |
| 六 CLI/TUI    | §20           | 输入子系统（`input-editor`、`command-registry`、输入 Hook/组件）+ 渲染（`message-text`、`message-history`、`markdown`、`token-usage`、`themes`） |
| 七 工程         | §21           | `__tests__/*`、构建脚本、CI、`.githooks/`                                                                                          |

***

## 六、文件组织说明

- 本文件（`00-roadmap.md`）：路线图 + 学习注意事项，作为**全局索引**，随时回来查阅。
- 后续每一节生成独立文件，命名规则：`docs/tutorial/NN-<topic-slug>.md`（例如 `01-overview.md`、`05-react-loop.md`）。
- 每个文件自包含，可单独阅读，但仍建议按依赖顺序学习——每节开头的「承上启下」会明确它依赖哪几节。

***

## 七、下一步

路线图已就绪。请审阅上面的章节划分：

- 如果 **认可**，对我说「**生成第 1 节**」，我就开始输出第 1 节《项目全景与四层架构》的完整内容。
- 如果想 **调整**（增删章节、改变粒度、调整顺序、指定先学某节），直接告诉我。

