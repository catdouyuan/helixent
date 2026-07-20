# 第 5 节：ReAct 主循环 —— think / act / observe 的骨架

> 本节属于 **第三部分 · Agent 层（可复用的通用大脑）**，也是**全书最该吃透的一节**。前四节我们打磨出三块静止的地基零件——[第 2 节](./02-message.md) 的 `Message`（流动的数据）、[第 3 节](./03-model.md) 的 `Model`（会说话的嘴）、[第 4 节](./04-tool.md) 的 `Tool`（能动手的手）。本节第一次把它们**串成一台会自主运转的机器**：一个反复「思考 → 行动 → 观察」的循环。
>
> 对应 roadmap 为本节设定的两个**核心问题**：
>
> 1. Agent 是怎么「一步步思考并行动」的？
> 2. 这个循环在什么时候开始、又在什么条件下停下来？
>
> **一句重要的边界声明**：本节只讲**控制流骨架**——循环怎么转、何时停、怎么被取消。至于「一步里模型同时要调多个工具时怎么并发执行」，那是 `_act` 的内部细节，**刻意留到 [第 6 节](./00-roadmap.md)**；中间件那些 `beforeX/afterX` 钩子，是 [第 7 节](./00-roadmap.md) 的主角，本节只把它们当「已经插好的插座」一带而过。

***

## 0. 承上启下

[第 4 节](./04-tool.md) 在结尾把话递到了这里。我们已经清点完 Foundation 的三块地基，并且明确指出它们此刻还是**三个互不相干的零件**：

> `Model` 不会自己去调 `Tool`，`Tool` 的结果也不会自己回到 `Model` 面前。

第 4 节留下的钩子是：

> **Agent 是怎么「一步步思考并行动」的？这个循环在什么时候开始、又在什么条件下停下来？模型的输出如何触发工具调用、工具的结果又如何回流成下一轮思考的输入？**

要回答它，我们需要一个「引擎」——一段能反复执行「**让模型思考 → 执行工具 → 把结果喂回模型 → 再思考**」的代码。这段代码就是整个项目的**心脏**，它只藏在一个文件里：[agent.ts](../../src/agent/agent.ts)。

本节的目标，是把这颗心脏的**控制流**看得一清二楚：数据从 `stream()` 的入口进来，如何在 `_think`（思考）和 `_act`（行动）之间循环流转，又在什么条件下流出（正常停机 / 熔断 / 被取消）。

读本节时，请打开这几个文件对照：

- 主循环本体：[agent.ts](../../src/agent/agent.ts)（本节精讲 `stream` / `_think` 及其辅助方法，`_act` 内部留给第 6 节）
- 事件类型：[agent-event.ts](../../src/agent/agent-event.ts)
- 桶文件：[agent/index.ts](../../src/agent/index.ts)
- 一个真实消费者（印证「循环怎么被驱动」）：[use-agent-loop.ts](../../src/cli/tui/hooks/use-agent-loop.ts#L126-L134)（第 19 节精讲，这里只看那一圈 `for await`）

***

## 1. 主题内容

### 1.1 先想清楚问题：为什么是「循环」，而不是「一问一答」？

老规矩，看代码前先自己当一次设计者。

你手里有了 `Model`（能根据对话历史吐出一条 `AssistantMessage`）和一堆 `Tool`（能执行动作）。现在你想让模型「完成一个任务」，比如「把 `src/foo.ts` 里的一个 bug 修好」。这件事**一次模型调用做不完**——模型得先**读文件**（调 `read_file`）、看到内容后**思考**、再**改文件**（调 `str_replace`）、可能还要**跑测试**（调 `bash`）确认。

于是「一问一答」的模式立刻破产。你需要的是一个**循环**：

```
让模型看当前的对话历史 → 模型说「我要调 read_file」 → 你执行它、把结果塞回历史
   → 再让模型看（更长的）历史 → 模型说「我要调 str_replace」 → 执行、塞回
   → 再让模型看 → 模型说「改好了，测试也过了」（不再要求调工具）→ 停机
```

这个「思考一步、行动一步、把观察结果喂回去、再思考下一步」的范式，就是 2022 年那篇著名论文提出的 **ReAct（Reasoning + Acting）**。它的三个动作是：

| ReAct 动作 | 含义 | 在 Helixent 里由谁承担 |
| --- | --- | --- |
| **Think（思考）** | 模型基于当前历史推理，并决定「下一步做什么」 | `_think()`：调模型，拿到一条 `AssistantMessage`（可能含推理文本 + `tool_use`） |
| **Act（行动）** | 执行模型点名的工具 | `_act()`：并发跑工具，把结果封成 `ToolMessage`（第 6 节详解） |
| **Observe（观察）** | 把行动的结果作为「观察」反馈给模型 | **隐式**：`_act` 把 `ToolMessage` 追加进 `messages`，**下一轮** `_think` 读到它，就完成了「观察」 |

请特别记住最后一行：**Helixent 里没有一个叫 `_observe` 的方法**。「观察」这一步是**循环本身**帮你完成的——工具结果被追加进 `messages` 后，下一次迭代的 `_think` 自然会把它读进去。这个「结果回流」正是循环的闭环所在，也是 1.4 那张图里最关键的一条「回箭头」。

还有一个现代化的细节值得先点破：原始 ReAct 论文里，「Thought」和「Action」是模型**用纯文本**写出来的（靠 prompt 约定格式解析）。而 Helixent 走的是**结构化 tool calling** 路线——模型的一条 `AssistantMessage` 里可以**同时**包含推理文本（`text` / `thinking` 段）和 `tool_use` 段。也就是说，「思考」和「决定调哪个工具」被**融进了同一次模型调用**。这是 [第 2 节](./02-message.md) 那套「分段数组」内容模型带来的红利。

心智模型建立好了，来看代码怎么把它实现成一个精确、可停、可取消的循环。

### 1.2 全景：一张主循环的控制流图

先给一张总图，建立空间感。整个 `stream()` 的骨架长这样：

```
stream(userMessage)   ← 它是一个 async generator，调用方用 for-await 拉取事件
   │
   ├─ 守卫：已经在流式了？→ 抛错（不可重入）
   ├─ new AbortController()          ← 每次运行一个全新的取消令牌
   ├─ 把 userMessage 追加进 messages
   ├─ beforeAgentRun()               ← 中间件插座（第 7 节）
   ▼
 ┌─ for step = 1 .. maxSteps ─────────────────────────────────┐
 │    throwIfAborted()                ← 每轮开头先查「是否已被取消」  │
 │    beforeAgentStep(step)           ← 中间件插座（第 7 节）        │
 │                                                             │
 │    ①  THINK：assistantMessage = yield* _think()              │
 │           └─ 消费 model.stream() 的快照流，边流边 yield progress │
 │    afterModel(assistantMessage)    ← 中间件插座（第 7 节）        │
 │    yield { type:"message", message: assistantMessage }       │
 │                                                             │
 │    toolUses = 从 assistantMessage 里抽出所有 tool_use 段        │
 │    ┌── toolUses 为空？                                        │
 │    │      afterAgentRun() → return  ← ★正常停机：模型不再要工具   │
 │    └───────────────────────────                              │
 │                                                             │
 │    ②  ACT：yield* _act(toolUses)   ← 并发执行工具（第 6 节详解）  │
 │           └─ 每个工具结果被封成 ToolMessage，append 进 messages   │
 │    afterAgentStep(step)            ← 中间件插座（第 7 节）        │
 │                                                             │
 │    ③  OBSERVE（隐式）：回到循环顶部，下一轮 _think 读到刚 append   │
 │        的 ToolMessage —— 这就是「把观察喂回去」                   │
 └─────────────────────────────────────────────────────────────┘
        │ 循环跑满 maxSteps 仍没停？
        ▼
   throw new Error("Maximum number of steps reached")   ← ★熔断
   ── finally ──► 复位 _streaming / _abortController（无论正常/异常/取消）
```

三个用 ①②③ 标出的位置，就是 ReAct 的 think / act / observe。**整节剩下的内容，都是在把这张图逐块讲清楚。** 我们从循环赖以运转的「状态」讲起。

### 1.3 Agent 的三个私有状态字段（[agent.ts](../../src/agent/agent.ts#L49-L56)）

一台会转的机器需要记住「我现在处于什么状态」。`Agent` 类用三个私有字段和几个只读字段来承载（[agent.ts](../../src/agent/agent.ts#L49-L56)）：

```ts
export class Agent {
  private readonly _context: AgentContext;      // 对话上下文（prompt + messages + tools + skills）
  private _streaming = false;                    // 「我是否正在流式运行」的闸门
  private _abortController: AbortController | null = null;  // 本次运行的取消令牌

  readonly name?: string;
  readonly model: Model;                         // 第 3 节的 Model
  readonly options: Required<AgentOptions>;      // { maxSteps }
  readonly middlewares: AgentMiddleware[];        // 第 7 节的插座
  // ...
}
```

三个私有字段，正好对应循环要操心的三件事：

- **`_context`**——**唯一的可变状态**。它是一个 `AgentContext`（[agent.ts](../../src/agent/agent.ts#L20-L31)），装着 `prompt`（系统提示词）、`messages`（对话历史）、`tools`、`skills`。整个循环的「记忆」全在这里；`get messages()` / `get prompt()` / `get tools()` 都是它的只读视图。注意 `messages` 这个数组会被循环**原地 push**（1.5 会看到），所以它是「活」的对话历史。
- **`_streaming`**——一个**布尔闸门**，防止同一个 `Agent` 被并发地跑两次。为什么要防？因为 `_context.messages` 是共享可变状态，两个循环同时往里 push 消息会把历史搅乱。1.4 开头那道守卫就靠它。
- **`_abortController`**——本次运行的**取消令牌**。它是 [第 3 节](./03-model.md) `ModelContext.signal`、[第 4 节](./04-tool.md) `tool.invoke(input, signal)` 里那个 `AbortSignal` 的**源头**。1.9 会专门讲它如何贯穿全链路。

把状态看清了，现在进入本节的绝对核心——`stream()`。

### 1.4 `stream()`：主循环骨架逐行精讲（[agent.ts](../../src/agent/agent.ts#L140-L171)）

这 30 行是**整个项目最重要的 30 行**。请对照源码，我们逐段读（[agent.ts](../../src/agent/agent.ts#L140-L171)）：

```ts
async *stream(message: UserMessage): AsyncGenerator<AgentEvent> {
  if (this._streaming) {
    throw new Error("Agent is already streaming");
  }

  this._abortController = new AbortController();
  this._appendMessage(message);
  await this._beforeAgentRun();
  this._streaming = true;
  try {
    for (let step = 1; step <= this.options.maxSteps; step++) {
      this._abortController.signal.throwIfAborted();
      await this._beforeAgentStep(step);
      const assistantMessage = yield* this._think();
      await this._afterModel(assistantMessage);
      yield { type: "message", message: assistantMessage };

      const toolUses = this._extractToolUses(assistantMessage);
      if (toolUses.length === 0) {
        await this._afterAgentRun();
        return;
      }

      yield* this._act(toolUses);
      await this._afterAgentStep(step);
    }
    throw new Error("Maximum number of steps reached");
  } finally {
    this._streaming = false;
    this._abortController = null;
  }
}
```

**第一眼看签名**：`async *stream(...)`。那个 `*` 是关键——它把 `stream` 声明成一个 **async generator（异步生成器）**。它不「返回一个结果」，而是**一路 `yield` 出一连串 `AgentEvent`**，让调用方用 `for await (const event of agent.stream(msg))` 一个一个地拉。为什么用生成器？这是本节第一个重大设计决策，留到 [1.6](#16-生成器委托-yield本节最精妙的一处控制流) 和深度解释 Q1 细讲，先记住「它是一个可以被 `for await` 拉取的事件流」。

**入口三连（循环开始前的准备）**：

```ts
if (this._streaming) { throw new Error("Agent is already streaming"); }  // ① 不可重入守卫
this._abortController = new AbortController();                           // ② 造一个全新的取消令牌
this._appendMessage(message);                                           // ③ 把用户这句话追加进历史
await this._beforeAgentRun();                                           // ④ 中间件：运行开始钩子（第 7 节）
this._streaming = true;                                                 // ⑤ 落闸：宣告「我开始跑了」
```

注意 ⑤ `this._streaming = true` **故意放在 `_beforeAgentRun()` 之后、`try` 之前**。这样即使 `_beforeAgentRun` 抛错，`_streaming` 也还没被置真，`finally` 的复位逻辑与它无关——是个很克制的顺序安排。

**主循环（`for step = 1 .. maxSteps`）**：这是心脏的跳动。每一轮 `step` 就是 ReAct 的「一步」。逐行看循环体：

```ts
this._abortController.signal.throwIfAborted();   // 每轮开头：若已被取消，立即抛出中断
await this._beforeAgentStep(step);               // 中间件：步骤开始钩子（第 7 节）
```

`throwIfAborted()` 放在**循环最顶端**是个讲究：它保证「用户在上一步执行工具期间按了 Ctrl-C」这种情况，能在**进入下一次昂贵的模型调用之前**就被拦下。这是取消机制的「站岗哨兵」（1.9 详述）。

```ts
const assistantMessage = yield* this._think();   // ① THINK：调模型，拿回一条完整的 AssistantMessage
await this._afterModel(assistantMessage);        // 中间件：模型返回后钩子（第 7 节）
yield { type: "message", message: assistantMessage };  // 把这条定稿消息作为一个 message 事件吐给调用方
```

`yield* this._think()` 是整段最精妙的一行——它既把 `_think` 内部产生的 progress 事件**转发**给调用方，又把 `_think` 的**返回值**（那条 `AssistantMessage`）赋给 `assistantMessage`。这个「一箭双雕」靠的是生成器委托 `yield*`，[1.5](#15-_thinktoolusesyield) 和 [1.6](#16-生成器委托-yield本节最精妙的一处控制流) 会拆开讲。拿到消息后，先过 `_afterModel` 中间件，再 `yield` 一个 `message` 事件——**这是循环对外吐出的第一类事件：一条定稿的助手消息**。

```ts
const toolUses = this._extractToolUses(assistantMessage);
if (toolUses.length === 0) {
  await this._afterAgentRun();
  return;              // ★ 正常停机
}
```

**这就是 ReAct 的终止条件，也是本节核心问题之二的答案**：从刚拿到的 `assistantMessage` 里抽出所有 `tool_use` 段，**如果一个都没有**，说明模型这一轮没有要求调用任何工具——它认为任务完成了、给出了最终回答。于是跑一遍 `_afterAgentRun` 收尾钩子，`return` 结束生成器。1.8 会专门剖析这个「无工具调用即停机」的哲学。

```ts
yield* this._act(toolUses);          // ② ACT：并发执行这些工具（第 6 节详解内部）
await this._afterAgentStep(step);    // 中间件：步骤结束钩子（第 7 节）
```

如果有工具要调，就 `yield* this._act(toolUses)`。`_act` 会并发跑完所有工具、把每个结果封成 `ToolMessage` **追加进 `this.messages`**、并把每条结果作为 `message` 事件 `yield` 出来（**它的内部并发逻辑是第 6 节的主题，本节把它当黑盒**）。这里只需记住一个关键后果：**`_act` 结束后，`this.messages` 尾部多了若干条工具结果消息**。

然后循环回到顶部，`step + 1`，下一轮 `_think` 再次把 `this.messages`（现在含刚追加的工具结果）喂给模型——**这就是「观察」：上一步的行动结果，变成了这一步思考的输入。** 图 1.2 里那条从底部绕回顶部的箭头，就发生在这里。

**熔断与善后**：

```ts
    throw new Error("Maximum number of steps reached");   // 循环跑满 maxSteps 还没 return → 熔断
  } finally {
    this._streaming = false;      // 无论正常返回、抛错、还是被取消
    this._abortController = null; // 都复位状态，让 Agent 能被再次 stream
  }
```

`for` 循环最多转 `maxSteps` 次（默认 100，见构造函数 [agent.ts](../../src/agent/agent.ts#L72)）。**如果转满了还没 `return`**（即模型 100 步都还在要工具、迟迟不给最终答案），就 `throw` 一个「Maximum number of steps reached」——这是防止死循环烧钱的**熔断器**（1.8 详述）。而 `finally` 块保证：**无论循环是正常 `return`、还是抛错、还是被取消中断**，`_streaming` 和 `_abortController` 都会被复位——这样同一个 `Agent` 实例才能被安全地再次 `stream()`（对话的下一轮）。

一句话总结这 30 行：**一个受 `maxSteps` 保护、可被 `AbortController` 取消、每步「思考→判停→行动」的异步生成器循环，对外吐出 `message` 与 `progress` 两类事件。**

### 1.5 `_think()`：把「消费模型流」封装成一个「会返回消息的生成器」（[agent.ts](../../src/agent/agent.ts#L180-L205)）

`stream` 里那句 `const assistantMessage = yield* this._think()` 藏着不少东西。展开 `_think`（[agent.ts](../../src/agent/agent.ts#L180-L205)）：

```ts
private async *_think(): AsyncGenerator<AgentEvent, AssistantMessage> {
  const modelContext: ModelContext = {
    prompt: this.prompt,
    messages: this.messages,
    tools: this.tools,
    signal: this._abortController?.signal,
  };
  await this._beforeModel(modelContext);

  let latest: AssistantMessage | null = null;
  for await (const snapshot of this.model.stream(modelContext)) {
    latest = snapshot;
    if (snapshot.streaming) {
      yield this._deriveProgress(snapshot);
    }
  }
  if (!latest) {
    throw new Error("Model stream ended without producing a message");
  }
  // Defensive: ensure the final message is not flagged as streaming.
  if (latest.streaming) {
    delete latest.streaming;
  }
  this._appendMessage(latest);
  return latest;
}
```

**先看签名里那个不寻常的返回类型**：`AsyncGenerator<AgentEvent, AssistantMessage>`。异步生成器的泛型有**两个**参数：第一个 `AgentEvent` 是「**每次 `yield` 出来的东西**」，第二个 `AssistantMessage` 是「**整个生成器最终 `return` 的东西**」。也就是说 `_think` 是一个奇妙的双面体：**它一边流式吐出 `AgentEvent`（进度），一边在结束时郑重返回一条 `AssistantMessage`（结果）。** 这个双面性正是 1.6 要讲的 `yield*` 能「一箭双雕」的前提。

**逐段读函数体**：

1. **组装 `ModelContext`**。把 Agent 当前的 `prompt` / `messages` / `tools` 和取消 `signal` 打包成一个 [第 3 节](./03-model.md) 的 `ModelContext`。这里正是**第 3 节留下的接口第一次被真正填满**——当时我们说 `ModelContext` 只带 `NonSystemMessage[]`、由 `Model` 负责拼 system prompt，此刻 `_think` 就把 `this.messages`（不含 system）和 `this.prompt`（system 字符串）分别放进去，交给 `Model` 去拼装。`signal` 则来自 1.3 的 `_abortController`。

2. **`_beforeModel` 中间件钩子**（第 7 节）。它能在模型被调用前，最后修改一次 `modelContext`（比如注入技能说明）。本节当它是透明的。

3. **消费模型的流式快照**：

   ```ts
   for await (const snapshot of this.model.stream(modelContext)) {
     latest = snapshot;
     if (snapshot.streaming) {
       yield this._deriveProgress(snapshot);
     }
   }
   ```

   这三行把 [第 3 节](./03-model.md) 的一个核心约定用活了——**`model.stream()` 每次 `yield` 的都是「一份到目前为止的完整 `AssistantMessage` 快照」**（不是增量碎片）。所以 `_think` 的策略极简：用 `latest` 变量**始终指向最新的那份快照**（后一份覆盖前一份，天然就是「累积到现在的全部内容」）；同时，只要这份快照还带着 `streaming: true` 标志（表示还没说完），就调 `_deriveProgress` 把它转成一个 **progress 事件** `yield` 出去。这就是循环吐出的**第二类事件：进度**（1.7 讲它的形状，第 19 节讲 UI 怎么用它渲染「Thinking…」）。

4. **收尾与防御**：

   ```ts
   if (!latest) { throw new Error("Model stream ended without producing a message"); }
   if (latest.streaming) { delete latest.streaming; }   // 防御：确保定稿消息不再带 streaming 标志
   this._appendMessage(latest);
   return latest;
   ```

   流结束后，`latest` 就是那份「最终完整快照」。先防御性地检查它非空（模型流一条都没吐是异常）；再**删掉 `streaming` 标志**（正常情况下最后一帧应该已经不带这个标志了，但万一 provider 没清干净，这里兜底——保证外部拿到的定稿消息语义干净，呼应 [agent-event.ts](../../src/agent/agent-event.ts#L11) 里「`message.streaming` 在 message 事件上永远不存在」的注释）；然后 **`_appendMessage(latest)` 把这条助手消息追加进 `this.messages`**（对话历史又长了一条）；最后 `return latest`——**这个返回值，就会成为 `stream` 里 `yield* this._think()` 表达式的值**。

`_appendMessage` 本身平平无奇（[agent.ts](../../src/agent/agent.ts#L274-L276)），就是 `this.messages.push(message)`。但它是「记忆增长」的唯一途径：无论是用户消息、助手消息还是工具结果消息，都经由它进入那个「活」的 `messages` 数组。

### 1.6 生成器委托 `yield*`：本节最精妙的一处控制流

现在回答 1.4 埋下的问题：为什么 `const assistantMessage = yield* this._think()` 这一行能同时做「转发事件」和「取回消息」两件事？

关键在 **`yield*`（读作 yield-delegate，生成器委托）**。当你在生成器 A 里写 `yield* B()`（B 也是个生成器），它做两件事：

1. **透传**：把 B `yield` 出来的**每一个值**，都原样再 `yield` 一次（就好像这些值是 A 自己 `yield` 的）。
2. **取回**：等 B **结束**（`return`）时，把 B 的**返回值**作为 `yield* B()` 这个**表达式的值**交出来。

把它套到我们的场景：

```ts
const assistantMessage = yield* this._think();
//    ▲取回：_think 的 return 值（AssistantMessage）
//                  ▲透传：_think 里 yield 的每个 progress 事件，都被 stream 再 yield 给调用方
```

于是一行代码达成两个效果：`_think` 流式吐出的所有 progress 事件，**穿过** `stream` 一路冒泡到最外层的 `for await`；同时 `_think` 最终返回的那条 `AssistantMessage` 被**捞回来**存进 `assistantMessage`，供后续「抽 tool_use、判停」使用。**这正是 1.5 里 `_think` 要用 `AsyncGenerator<AgentEvent, AssistantMessage>` 这个「双类型参数」签名的原因**——它既是事件流（第一个类型参数），又是消息的生产者（第二个类型参数）。

同理，`stream` 里的 `yield* this._act(toolUses)`（[agent.ts](../../src/agent/agent.ts#L163)）也用了委托，只不过 `_act` 的返回值是 `void`（我们不需要它返回什么，只需要它把 `message` 事件透传出来、把工具结果 append 进 messages）。

这个设计的优雅之处在于：**`stream` 作为「总指挥」，无需关心 `_think` / `_act` 内部吐了多少事件、怎么吐的**——`yield*` 自动把子生成器的事件流「接」到主事件流上。控制流因此被拆成了几个各司其职、又能无缝拼接的小生成器。深度解释 Q4 会进一步讨论「为什么不把 `_think` 写成一个普通的 `async` 函数」。

### 1.7 事件系统：`agent-event.ts` 的两类事件（[agent-event.ts](../../src/agent/agent-event.ts)）

`stream` 对外 `yield` 的东西，类型都是 `AgentEvent`。它定义在一个只有 45 行的文件里（[agent-event.ts](../../src/agent/agent-event.ts#L45)）：

```ts
export type AgentEvent = AgentMessageEvent | AgentProgressEvent;
```

又是一个**可辨识联合**——和 [第 2 节](./02-message.md) 的 `Message`、[第 4 节](./04-tool.md) 的 `StructuredToolResult` 一模一样的模式，判别式是 `type` 字段。它分成两大类：

**① `message` 事件——「一件事情定稿了」**（[agent-event.ts](../../src/agent/agent-event.ts#L13-L16)）：

```ts
export interface AgentMessageEvent {
  type: "message";
  message: AssistantMessage | ToolMessage;
}
```

它在两个时机被吐出：一次完整的助手回合结束时（`stream` 里 `yield { type: "message", message: assistantMessage }`），以及每条工具结果产生时（`_act` 内部 `yield`）。注释特别强调：**这类事件上的 `message.streaming` 永远是缺席/false 的**——它代表「定稿」，不是「进行中」。这正是 1.5 里那句 `delete latest.streaming` 要保证的不变量。调用方拿到 `message` 事件，就可以把这条消息**追加进 UI 的消息列表**了（1.10 会看到）。

**② `progress` 事件——「正在进行中，给点动静」**（[agent-event.ts](../../src/agent/agent-event.ts#L42)）：

```ts
export type AgentProgressEvent = AgentProgressThinkingEvent | AgentProgressToolEvent;
```

它自己又分两个 `subtype`（嵌套的可辨识联合）：

- **`thinking`**（[agent-event.ts](../../src/agent/agent-event.ts#L22-L25)）：当前模型快照里**还只有文本/思考、没有任何 `tool_use`**——模型在「打字」。
- **`tool`**（[agent-event.ts](../../src/agent/agent-event.ts#L32-L39)）：当前快照里**已经出现了至少一个 `tool_use`**。payload 携带**最后一个** `tool_use` 的 `name` 和（可能还没拼完整的）`input`，注释明确写着 `input` 可能是 partial / in-progress 的 JSON。

这两类事件对应了「一个 Agent 循环对外该说些什么」的两种粒度：**progress 是「过程直播」（可丢弃、供实时反馈），message 是「结果快照」（要留存、是真相）**。第 19 节会看到 TUI 如何**故意只用 message 事件**当消息列表的真相源，而把 progress 事件用一个笼统的「Thinking…」闪烁来消化。

### 1.8 两个小工具函数：`_deriveProgress` 与 `_extractToolUses`

1.5 和 1.4 各用到一个私有辅助函数，顺带看清它们，本节的代码就全覆盖了。

**`_deriveProgress`**（[agent.ts](../../src/agent/agent.ts#L207-L216)）——把一份模型快照映射成一个 progress 事件：

```ts
private _deriveProgress(snapshot: AssistantMessage): AgentEvent {
  const toolUses = snapshot.content.filter(
    (c): c is ToolUseContent => c.type === "tool_use",
  );
  if (toolUses.length === 0) {
    return { type: "progress", subtype: "thinking" };
  }
  const last = toolUses[toolUses.length - 1]!;
  return { type: "progress", subtype: "tool", name: last.name, input: last.input };
}
```

逻辑和 1.7 描述的完全对应：快照里没有 `tool_use` → `thinking`；有 → `tool`，并取**最后一个** tool_use 的名字和当前（可能残缺的）input。它靠 [第 2 节](./02-message.md) 那个「content 是分段数组」的设计，用一句 `filter` 就能把 `tool_use` 段挑出来。

**`_extractToolUses`**（[agent.ts](../../src/agent/agent.ts#L218-L220)）——从一条定稿消息里抽出所有 `tool_use` 段：

```ts
private _extractToolUses(message: AssistantMessage): ToolUseContent[] {
  return message.content.filter((content): content is ToolUseContent => content.type === "tool_use");
}
```

它和 `_deriveProgress` 的第一句几乎一样，但用途不同：这个跑在 `stream` 主循环里，返回值的**长度**直接决定了那个生死攸关的判断——`toolUses.length === 0` 就停机，否则就 `_act`。两个函数都用了 TypeScript 的**类型谓词** `(c): c is ToolUseContent`，让 `filter` 之后的数组类型精确收窄成 `ToolUseContent[]`，这样访问 `.name` / `.input` 时才有类型保障（呼应第 2 节的可辨识联合收窄）。

### 1.9 `AbortController`：一条贯穿全链路的「取消通道」

前几节反复出现的 `AbortSignal`，源头就在这里。把散落各处的取消逻辑收拢起来看，它是一条完整的链：

```
Agent.abort()  ← 外部（如 TUI 按 Ctrl-C）调用
     │  this._abortController?.abort()
     ▼
_abortController.signal  这一个 signal 同时流向三个地方：
     ├──► stream 每轮开头 signal.throwIfAborted()      —— 站岗：进入下一步前先检查
     ├──► _think 里 modelContext.signal = signal        —— 传给 Model → provider → 中断在途网络请求（第 3/16/17 节）
     └──► _act 里 tool.invoke(input, signal)            —— 传给工具 → 中断慢命令（第 4 节的可选 signal、第 6 节详解）
```

四个关键点：

1. **每次 `stream()` 造一个全新的 `AbortController`**（1.4 的入口）。取消令牌是「一次性」的——`abort()` 过的 signal 永久处于 aborted 状态，所以每轮运行必须换新的，否则上一轮的取消会「粘」到下一轮。
2. **`abort()` 是公开方法**（[agent.ts](../../src/agent/agent.ts#L176-L178)）：`this._abortController?.abort()`。用 `?.` 是因为没在 `stream` 时 `_abortController` 为 `null`，此时 abort 是无操作。
3. **`throwIfAborted()` 站在循环顶端**：这是「主动检查点」。模型流和工具执行内部也会响应 signal（被动中断），但循环顶端这一哨，确保「即便上一步的工具已经跑完、正准备进入下一次昂贵的模型调用」，也能被取消卡住。
4. **`signal` 一路透传**：它被塞进 `ModelContext.signal`（第 3 节）流向 provider 去中断网络请求，又被塞进 `tool.invoke(..., signal)`（第 4 节那个可选的第二参数）流向工具去中断子进程。**一个 signal，贯穿「模型 + 工具」两条最耗时的路径**——这就是第 3、4 节反复为它「预留接口」的收束点。

至于 `finally` 里 `this._abortController = null` 的复位，保证了下次 `stream` 能干净地重造一个。取消，是一个 Agent「可被人类叫停」的底线能力——一个不能中断的 Agent，在真实终端里是不可接受的。

### 1.10 主循环的真实消费者：一圈 `for await`（[use-agent-loop.ts](../../src/cli/tui/hooks/use-agent-loop.ts#L126-L134)）

讲了半天「`stream` 吐事件」，到底谁在拉？瞄一眼真实消费者就全通了（[use-agent-loop.ts](../../src/cli/tui/hooks/use-agent-loop.ts#L126-L134)，第 19 节精讲，这里只看这一圈）：

```ts
const stream = agent.stream(userMessage);
for await (const event of stream) {
  if (event.type === "message") {
    enqueueMessage(event.message);
  }
  // progress events intentionally ignored: the UI shows a generic
  // "Thinking..." shimmer driven by the `streaming` boolean ...
}
```

清清楚楚：调用方拿到 `agent.stream(userMessage)` 这个异步生成器，用 **`for await`** 一个一个地拉事件。拉到 `message` 事件就把消息塞进 UI 队列（`enqueueMessage`）；`progress` 事件这里**故意忽略**（正如 1.7 所说，TUI 用一个笼统的「Thinking…」闪烁代替，把 message 事件当唯一真相源）。

这一圈 `for await` 完美诠释了「生成器驱动」的好处：**调用方掌握节奏**——它想处理就处理、想 `break` 提前退出也行、想在两次拉取之间做别的事（比如节流刷新 UI）都不受循环内部干扰。这是「pull（拉）」模型相对「push（回调/事件发射器）」模型的核心优势，深度解释 Q1 会展开。

顺带把桶文件补上：[agent/index.ts](../../src/agent/index.ts) 依旧是极薄的一层：

```ts
export * from "./agent";
export * from "./agent-event";
export * from "./agent-middleware";
export * from "./todos";
```

于是外部一律从 `@/agent` 这一个门拿到 `Agent`、`AgentEvent`、中间件类型等。这第 N 次印证了 [第 1 节](./01-overview.md) 的「桶文件 + 全具名导出」约定——**每一层只有一个入口**。

***

## 2. 亮点与关键设计

1. **`async *stream()` 生成器驱动的主循环——本节思想内核。**
   把整个 ReAct 循环实现成一个**异步生成器**，对外吐 `AgentEvent` 事件流，调用方用 `for await` 拉。这让「过程」（progress）与「结果」（message）能以统一的流式接口交付，且**调用方掌握节奏**（可暂停、可提前 break、天然背压），无需回调地狱或事件发射器。

2. **`yield*` 生成器委托——一行代码「转发事件 + 取回结果」。**
   `const assistantMessage = yield* this._think()` 靠 `AsyncGenerator<AgentEvent, AssistantMessage>` 的**双类型参数**，既把 `_think` 的 progress 事件透传给外层，又把它的 `return` 值捞回来。控制流因此被拆成若干各司其职、又能无缝拼接的小生成器（`_think` / `_act`）。

3. **「无工具调用即停机」——ReAct 最优雅的终止条件。**
   循环不靠什么「完成标志位」判停，而是看模型这一轮**有没有要求调工具**：没有 `tool_use`，就说明模型给出了最终答案。停机与否完全由模型的自然输出驱动，无需额外协议。

4. **`maxSteps` 熔断 + `finally` 善后——工程上的安全带。**
   `for` 循环上限 `maxSteps`（默认 100），跑满即 `throw`，防止模型死循环烧钱/烧时间。`finally` 确保无论正常返回、抛错、被取消，`_streaming` / `_abortController` 都复位，Agent 可被安全复用。

5. **`AbortController` 贯穿式取消——一个 signal 打通「模型 + 工具」两条耗时路径。**
   每轮运行一个全新令牌；`throwIfAborted()` 站在循环顶端当哨兵；`signal` 一路透传进 `ModelContext`（中断网络）和 `tool.invoke`（中断子进程）。呼应第 3、4 节为它预留的所有接口。

6. **每份 yield 都是「完整快照」的消费策略——`latest` 一个变量搞定累积。**
   因为 `model.stream()` 约定「每次 yield 是到目前为止的完整消息」（第 3 节），`_think` 只需用 `latest` 指向最新快照即可，无需自己做增量拼接——把累积的复杂度下沉给了 provider（第 16/17 节）。

***

## 3. 工业对比

把 Helixent 的主循环与业界主流的 Agent 执行器放一起看：

| 维度 | Helixent | LangChain `AgentExecutor` | OpenAI Agents SDK (`Runner`) | Vercel AI SDK (`generateText`) |
| --- | --- | --- | --- | --- |
| 循环形态 | `async *` 异步生成器 + `for await` | `while` 循环内部驱动，靠 callbacks 对外通知 | `Runner.run` / `run_streamed` 驱动 | `maxSteps` 内部循环，返回 steps 数组 |
| 事件交付 | **pull（拉）**：`yield` 事件流 | **push（推）**：`CallbackHandler` 回调 | 流式事件（`stream_events`） | 回调 `onStepFinish` + 最终结果 |
| 终止条件 | **无 tool_use 即停** | `AgentFinish`（解析输出得到）/ 无更多动作 | 无 tool call 即停 / 命中 output_type | 无 tool call 即停 / 命中 `stopWhen` |
| 步数上限 | `maxSteps`（默认 100），超限 **throw** | `max_iterations`，超限按 `early_stopping_method` 处理 | `max_turns`，超限抛 `MaxTurnsExceeded` | `maxSteps`，到顶正常返回 |
| 取消机制 | `AbortController` 贯穿模型+工具 | 靠 callbacks/外部控制，较分散 | `RunConfig` / 取消 | `abortSignal` 透传 |
| 抽象重量 | **极薄**（单文件、一个 `stream` + 几个私有方法） | 较重（Executor + Chain + Agent + Callbacks 多层） | 中（Runner + Agent + Guardrails） | 中（函数式，一个 `generateText` 吃很多参数） |

几点读法：

- **「无 tool call 即停」是行业共识。** Helixent、OpenAI Agents SDK、Vercel AI SDK 都用这个终止条件——它优雅、无需额外协议。而**老式** LangChain 走 prompt 解析路线（模型用文本写 `Final Answer:`，靠解析器识别 `AgentFinish`），更脆、更依赖格式约定。这正是 1.1 说的「结构化 tool calling vs 文本 ReAct」的分野。
- **pull vs push 是最大的气质差异。** LangChain 传统上靠 **callbacks**（你注册一堆 `on_llm_new_token` / `on_tool_end` 回调）对外通知——push 模型，控制权在框架手里。Helixent 用 **async generator + `for await`**——pull 模型，控制权在调用方手里。对一个要接终端 UI（需要节流、可中断、背压）的场景，pull 模型天然更顺手（1.10 的 TUI 就受益于此）。Vercel AI SDK 则两者兼有（既有 `onStepFinish` 回调，也有流式 API）。
- **超限时「抛」还是「不抛」，是个有意思的分歧。** Helixent 和 OpenAI Agents SDK 选择**抛异常**（`throw`）——把「跑满上限」当成一种需要调用方显式处理的异常情况。Vercel AI SDK 选择**正常返回**（到 `maxSteps` 就停，返回已有的 steps）。前者更「严格」（逼你面对「任务没做完」），后者更「宽容」（给你一个可能不完整的结果）。Helixent 的选择呼应它「宁可炸也不给你一个假装完成的结果」的诚实哲学（深度解释 Q3 展开）。
- **抽象的「薄」依然是刻意的。** LangChain 的 `AgentExecutor` 概念层叠（Chain / Agent / Executor / Callbacks / OutputParser），功能全但要读懂得爬一阵。Helixent 的整个循环就一个 `stream` 方法 + 几个私有 helper，**一屏能读完**——它把「一个 ReAct 循环的本质」剥到了最干净。

***

## 4. 深度解释：为什么这样设计？不这样会怎样？

**Q1：为什么把主循环写成 `async *` 生成器、对外吐事件流，而不是写成一个「跑完返回最终结果」的普通 `async` 函数？**
因为一个 Agent 循环**天生是「过程比结果更需要被观察」的东西**。它可能跑几十秒、调十几个工具，用户不能对着黑屏干等——你需要实时看到「模型在打字」「正在调 bash」「工具返回了」。如果写成 `async function run(): Promise<FinalMessage>`，调用方只能拿到最终结果，中间过程全黑盒；要暴露过程就得塞回调（`onToken` / `onToolCall`…），回调一多就是「回调地狱」，且控制权全在框架手里。而 `async *` + `for await` 是**pull 模型**：把「过程」和「结果」统一成一条事件流，调用方**主动拉**、自己掌握节奏——想节流刷新 UI（TUI 的 50ms 批量刷新，第 19 节）、想 `break` 提前退出、想在事件间隙做别的，都随意。生成器还自带**背压**：调用方不拉下一个，`stream` 就自然停在 `yield` 处等着，不会把内存吐爆。代价是调用方必须用 `for await` 这种略微「不熟悉」的写法，但换来的解耦和控制力非常值。

**Q2：为什么用「模型这一轮没调工具」作为停机条件？如果模型既想说一句话、又想继续调工具，会被误判为停机吗？**
不会——而且这正是这个条件优雅的地方。因为 [第 2 节](./02-message.md) 的 `AssistantMessage.content` 是**分段数组**，一条消息里可以**同时**有 `text` 段（说的话）和 `tool_use` 段（要调的工具）。`_extractToolUses` 只看**有没有 `tool_use` 段**：只要有，哪怕同时有一大段解释文字，也判定为「还要继续」，进入 `_act`；只有**一个 `tool_use` 都没有**（纯 text/thinking），才判停机。所以「模型想边说边做」被完美支持，不会误判。这个条件的深层含义是：**把「任务是否完成」的判断权，完全交给模型自己**——它不再要工具，就是它认为「话说完了、事办完了」。相比「让模型输出一个特殊结束标记再去解析」的老办法，这个条件零协议、零解析、零歧义。

**Q3：`maxSteps` 跑满了为什么是 `throw`（抛异常），而不是「优雅地返回目前为止的结果」？**
因为「跑满 100 步还没停」是一个**真正的异常状况**，不该被伪装成正常结束。设想它 `return` 了最后一条消息——调用方会以为「任务正常完成」，可实际上模型是被硬生生截断的，结果很可能是残缺的、误导性的。`throw new Error("Maximum number of steps reached")` 强迫调用方**显式面对**这个失败：TUI 的 `for await` 外面包着 `try/catch`（[use-agent-loop.ts](../../src/cli/tui/hooks/use-agent-loop.ts#L135-L142)），会把它作为一条错误消息展示给用户「出问题了，你可以重试」，而不是假装成功。这与第 4 节工具「宁可返回 `errorToolResult` 也不静默吞错」是同一种**诚实哲学**：**不确定成功，就不要给出「成功」的信号。** 至于 100 这个默认值（[agent.ts](../../src/agent/agent.ts#L72)），是「足够长以完成绝大多数真实任务」和「短到能兜住失控死循环」之间的经验平衡，且可通过 `AgentOptions.maxSteps` 覆盖。

**Q4：`_think` 为什么要写成生成器（`async *`）？直接写成一个返回 `Promise<AssistantMessage>` 的普通 async 函数，不是更简单吗？**
如果 `_think` 是普通 async 函数，它就**没法在「消费模型流的过程中」往外吐 progress 事件**了——它只能闷头把流消费完、返回最终消息，中间的「模型正在打字」「正在拼第 3 个工具调用」这些实时进度就全丢了。写成生成器，`_think` 才能**一边 `for await` 消费 `model.stream()`、一边 `yield` progress 事件、最后 `return` 定稿消息**。而外层 `stream` 用 `yield* this._think()` 把这两件事一次性接过来（1.6）。这就是为什么它的类型是 `AsyncGenerator<AgentEvent, AssistantMessage>`——**它既是「进度的生产者」（yield），又是「结果的生产者」（return）**。把「消费模型流 + 拼装 ModelContext + 追加历史」这一坨封装进 `_think`，还让 `stream` 主循环保持了清爽——主循环只关心「思考→判停→行动」的骨架，不被流式消费的细节淹没。这是「用生成器做关注点分离」的漂亮示范。

**Q5：为什么每次 `stream()` 都新建一个 `AbortController`，而不是复用一个成员变量？`throwIfAborted()` 为什么非要放在循环最顶端？**
先说新建：`AbortController` 的 signal 是**一次性、单向**的——一旦 `abort()`，它永久处于 aborted 状态，无法「重置」。如果复用同一个，那么用户在第一轮对话里按过一次 Ctrl-C 之后，这个 signal 就永久 aborted 了，第二轮对话一开始就会被 `throwIfAborted()` 立刻打断。所以**每次运行必须换一个全新令牌**，`finally` 里 `= null` 也是为了下次干净重建。再说位置：`throwIfAborted()` 放在 `for` 循环体的**第一行**，是为了守住一个特定窗口——「上一步的工具刚执行完、循环即将进入下一次（昂贵的）模型调用」这个间隙。模型流和工具内部虽然也会响应 signal（被动中断在途操作），但如果取消恰好发生在「两步之间」，就需要循环顶端这个**主动检查点**来兜住，避免白白发起一次注定要被取消的模型请求。一被动、一主动，两道防线合起来才让取消「随时都能生效」。

**Q6：ReAct 的「Observe（观察）」在代码里没有对应的方法，会不会是漏了一步？**
不会，这是刻意的。「观察」在这套设计里是**循环结构本身**完成的，无需一个独立方法。回看流程：`_act` 把工具执行结果封成 `ToolMessage` 并 `_appendMessage` 进 `this.messages`；循环回到顶部，下一轮 `_think` 组装 `ModelContext` 时用的就是这个**已经变长了的 `this.messages`**——模型于是「看到」了上一步的工具结果。**「把观察喂回模型」= 「把工具结果 append 进历史」+「下一轮 think 读取历史」**，这两个动作分别由 `_act` 和 `_think` 承担，中间靠 `this.messages` 这个共享的、不断增长的数组连接。所以「observe」不是一个动作，而是**数据在 `messages` 里沉淀、又被下一次 think 读取**这个循环闭环的自然结果。理解了这一点，你就理解了为什么 `messages` 必须是「活」的可变数组、以及为什么 `_appendMessage` 是整个循环里唯一的「记忆写入口」。

***

## 5. 参考资料

- 本项目源码：[agent.ts](../../src/agent/agent.ts)（`stream` [L140-171](../../src/agent/agent.ts#L140-L171)、`_think` [L180-205](../../src/agent/agent.ts#L180-L205)、`_deriveProgress` [L207-216](../../src/agent/agent.ts#L207-L216)、`_extractToolUses` [L218-220](../../src/agent/agent.ts#L218-L220)）、[agent-event.ts](../../src/agent/agent-event.ts)、[agent/index.ts](../../src/agent/index.ts)
- 真实消费者（第 19 节精讲）：[use-agent-loop.ts](../../src/cli/tui/hooks/use-agent-loop.ts#L126-L134)
- ReAct 原始论文 · *ReAct: Synergizing Reasoning and Acting in Language Models*（Yao et al., 2022）：<https://arxiv.org/abs/2210.03629>
- MDN · 异步生成器与 `for await...of`：<https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Statements/for-await...of>
- MDN · `yield*`（生成器委托）：<https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Operators/yield*>
- MDN · `AbortController` / `AbortSignal`：<https://developer.mozilla.org/en-US/docs/Web/API/AbortController>
- LangChain · Agent 概念（`AgentExecutor` / `max_iterations`）：<https://python.langchain.com/docs/concepts/agents/>
- OpenAI Agents SDK · Running agents（`Runner` / `max_turns`）：<https://openai.github.io/openai-agents-python/running_agents/>
- Vercel AI SDK · `generateText`（`maxSteps` / `stopWhen`）：<https://sdk.vercel.ai/docs/ai-sdk-core/tools-and-tool-calling>
- 上游依赖：[第 1 节 · 项目全景与四层架构](./01-overview.md)、[第 2 节 · Message 消息类型系统](./02-message.md)、[第 3 节 · Model 与 ModelProvider](./03-model.md)、[第 4 节 · Tool 工具系统](./04-tool.md)

***

## 6. 小结与下一节预告

本节你应该已经吃透了整个项目的**心脏**——ReAct 主循环的**控制流骨架**：

- **ReAct 三动作的落地**：`_think`（思考：调模型拿 `AssistantMessage`）、`_act`（行动：跑工具、结果入 `messages`）、以及**隐式的 observe**（下一轮 think 读到刚 append 的工具结果）。三者靠一个 `for step` 循环和「活」的 `messages` 数组串成闭环。
- **`async *stream()` 生成器驱动**：主循环是一个异步生成器，对外吐 `message`（定稿）与 `progress`（进行中）两类 `AgentEvent`，调用方用 `for await` **拉**取、自己掌握节奏。
- **`yield*` 委托的妙笔**：`const msg = yield* this._think()` 一行既转发了 `_think` 的进度事件、又捞回了它的返回消息，靠的是 `AsyncGenerator<AgentEvent, AssistantMessage>` 的双类型参数。
- **终止与安全**：「无 `tool_use` 即停机」是零协议的优雅终止条件；`maxSteps` 熔断（超限 `throw`）+ `finally` 复位是工程安全带；`AbortController` 一个 signal 贯穿「模型网络请求 + 工具子进程」两条耗时路径，`throwIfAborted()` 在循环顶端站岗。
- **回收前几节的钩子**：`_think` 组装的 `ModelContext`（含 system prompt 与不含 system 的 `messages`）第一次填满了第 3 节的接口；`signal` 兑现了第 3、4 节反复预留的取消接口；两类事件、tool_use 抽取都建立在第 2 节的可辨识联合内容模型之上。

**一处诚实的边界**：本节把 `_act`（[agent.ts](../../src/agent/agent.ts#L222-L272)）**当成了黑盒**——我们只知道「它并发跑完工具、把结果封成 `ToolMessage` 追加进 `messages`、并把每条结果作为 `message` 事件吐出」，但**没有拆开它内部是怎么并发的**。这是故意留的占位。

**承上启下（启下）**：主循环的骨架搭好了，但那个被跳过的 `_act` 藏着一个真实且有趣的工程问题：

> **当模型在一步里同时要求调用多个工具时，怎么并发执行它们？为什么不能简单地用 `Promise.all` 一把梭？如果其中一个工具很慢、另一个很快，能不能让「先完成的先把结果吐出来」？执行到一半用户按了 Ctrl-C，又该怎么把取消塞进这场并发里？**

这就是 [第 6 节](./00-roadmap.md) 的主题。我们会钻进 `_act` 的 `Promise.race` + pending 集合循环，看它如何实现「谁先完成谁先产出结果消息」，以及它「就地把工具错误捕获成 `Error:` 文本而非抛出」的容错哲学。

👉 下一节 **第 6 节：并行工具调度 —— `Promise.race` 循环 vs `Promise.all`**。它会填平本节故意留下的 `_act` 占位，让这台 ReAct 引擎彻底跑通。

准备好后，对我说「**生成第 6 节**」即可。
