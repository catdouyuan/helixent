# 第 3 节：Model 与 ModelProvider —— 模型抽象与适配契约

> 本节属于 **第二部分 · Foundation 层（一切的地基）**。它是三块地基里的第二块——[第 2 节](./02-message.md) 确立了「数据长什么样」（`Message`），本节回答「谁来生产这些数据、又如何做到不被任何一家厂商绑死」。
>
> 对应 roadmap 为本节设定的两个**核心问题**：
>
> 1. 如何做到「换一个大模型厂商，Agent 代码一行不改」？
> 2. `invoke` 和 `stream` 为何是一对？

***

## 0. 承上启下

[第 2 节](./02-message.md) 在结尾把话递到了这里。我们已经彻底看清了 `AssistantMessage` 的形状——它是一个带 `role: "assistant"` 的消息，`content` 里混排着 `thinking`、`text`、`tool_use` 三种段，还可能挂着 `usage`（token 用量）和 `streaming`（是否还在流式中）两个可选字段。当时留下的钩子是：

> **这些** **`AssistantMessage`** **是谁「生产」出来的？`usage`** **里的 token 数、`streaming`** **状态又是谁填的？**

答案是**模型**。更准确地说，是一台叫 `Model` 的「生产者」：它消费一段第 2 节的 `Message[]` 历史，向某个厂商（OpenAI / Anthropic / ……）发出请求，再把返回的内容组装成一条崭新的 `AssistantMessage`。

但这里有个绕不开的现实问题——**厂商不止一家，而且每家的 API 都长得不一样**。OpenAI 用 `chat.completions.create`、把系统提示放进 messages、工具调用挂在顶层 `tool_calls`；Anthropic 用 `messages.create`、把 system 当顶层独立参数、还要你手动给 `thinking.budget_tokens`。如果让上层的 Agent 直接去碰这些差异，那「换一家厂商就得改一遍 Agent」——这正是本节要消灭的问题。

本节就钻进 [models](../../src/foundation/models/) 这个只有四个文件、加起来一百行出头的目录，看它如何用一组极简的抽象，把「易变的厂商差异」和「稳定的编排逻辑」干净利落地劈成两半。

读本节时，请打开这几个文件对照：

- 编排壳：[model.ts](../../src/foundation/models/model.ts)
- 厂商契约：[model-provider.ts](../../src/foundation/models/model-provider.ts)
- 调用上下文：[model-context.ts](../../src/foundation/models/model-context.ts)
- 桶文件：[models/index.ts](../../src/foundation/models/index.ts)
- 两个「契约的实现」（用来印证抽象的价值）：[community/openai/model-provider.ts](../../src/community/openai/model-provider.ts)、[community/anthropic/model-provider.ts](../../src/community/anthropic/model-provider.ts)
- 两个「上层调用现场」：[agent.ts `_think`](../../src/agent/agent.ts#L180-L205)、[cli/index.tsx](../../src/cli/index.tsx#L45-L62)

***

## 1. 主题内容

### 1.1 先想清楚问题：怎样才能「换厂商不改代码」？

在看代码前，还是先自己当一次设计者。你手上有一个 Agent 主循环（第 5 节的主角），它需要「让模型思考一步」。最朴素的写法是让它直接调 OpenAI：

```ts
// ❌ 反面教材：把厂商写死在上层
const resp = await openai.chat.completions.create({ model, messages, tools });
```

这行代码有三个致命问题：

1. **绑死了厂商**：哪天想换 Anthropic，得把所有调用点全改一遍——而调用点可能散落在主循环、审批、eval 脚本等许多地方。
2. **绑死了 wire 格式**：`messages` 得是 OpenAI 的格式、返回值也是 OpenAI 的结构，第 2 节辛苦建立的「内部统一 `Message`」在这里破功了。
3. **绑死了调用方式**：`create` 一次性返回。可要做 TUI 实时刷新，你还得再写一套 `stream: true` 的分支，且两套逻辑纠缠在一起。

要解决它，经典答案是**依赖倒置（Dependency Inversion）**：让上层不要依赖「某个具体厂商」，而是依赖一个**抽象接口**；再让每个厂商去**实现**这个接口。上层只跟接口打交道，换厂商 = 换一个实现，上层一行不改。

Helixent 把这个思路落成了**两个角色**：

> - **`ModelProvider`（厂商契约）**：一个接口，规定「一个模型后端至少要会干哪两件事」——`invoke` 和 `stream`。每家厂商写一个实现类。
> - **`Model`（编排壳）**：一个具体类，它**持有**一个 `ModelProvider`，负责「请求前的统一编排」（比如把系统提示拼成消息），然后把活儿转发给手里的 provider。它**不知道**自己手里的 provider 到底是 OpenAI 还是 Anthropic。

这就是 roadmap 点名的第一个亮点——**「编排壳」与「厂商契约」的职责分离**。下面逐个拆。

### 1.2 全景：一次 `model.stream()` 的数据流

先给一张总图，建立空间感，后面再逐块对号入座：

```
  Agent 主循环（第 5 节）
        │  组装一个 ModelContext（prompt: string, messages: NonSystemMessage[], tools, signal）
        ▼
  ┌─────────────────────────────────────────────┐
  │  Model（编排壳，model.ts）                     │
  │   _buildModelProviderParams(context):         │
  │     • 把 prompt 字符串包装成 SystemMessage      │  ← 本节最巧的一步
  │     • 拼到 messages 最前面                       │
  │     • 补上 model 名、options（厂商参数）         │
  │   然后转发 →                                   │
  └─────────────────────────────────────────────┘
        │  ModelProviderInvokeParams（messages: Message[] 已含 system）
        ▼
  ┌─────────────────────────────────────────────┐
  │  ModelProvider（厂商契约，model-provider.ts）   │  ← 只是接口
  │   invoke(params): Promise<AssistantMessage>    │
  │   stream(params): AsyncGenerator<AssistantMsg> │
  └─────────────────────────────────────────────┘
        │  由某个「实现」承接（community 层）
        ├─────────────────────┬───────────────────
        ▼                     ▼
  OpenAIModelProvider     AnthropicModelProvider     （第 16 / 17 节）
   chat.completions        messages.create
        │                     │
        ▼                     ▼
     厂商 API           厂商 API
        │                     │
        └──── 累积成 AssistantMessage 快照，一路 yield 回上层 ────┘
```

三个关键类型分别站在不同的位置：

- **`ModelContext`**：**Agent → Model** 之间的入参。它是「面向使用者」的，字段贴近上层的心智。
- **`ModelProviderInvokeParams`**：**Model → Provider** 之间的入参。它是「面向厂商」的，是各家实现都要接的统一契约。
- **`AssistantMessage`**：贯穿始终的产物，从 Provider 一路 yield 回 Agent（就是第 2 节那个类型）。

`Model._buildModelProviderParams` 正是从第一种类型翻译到第二种类型的**唯一翻译器**——1.5 会把它逐行读透。

### 1.3 厂商契约：`ModelProvider`（[model-provider.ts](../../src/foundation/models/model-provider.ts)）

先看抽象本身，整个文件只有 36 行：

```ts
export interface ModelProviderInvokeParams {
  model: string;
  messages: Message[];
  tools?: Tool[];
  options?: Record<string, unknown>;
  signal?: AbortSignal;
}

export interface ModelProvider {
  invoke(params: ModelProviderInvokeParams): Promise<AssistantMessage>;
  stream(params: ModelProviderInvokeParams): AsyncGenerator<AssistantMessage>;
}
```

先看入参 `ModelProviderInvokeParams`，五个字段各司其职：

| 字段        | 类型                        | 含义                                                            |
| --------- | ------------------------- | ------------------------------------------------------------- |
| `model`   | `string`                  | 具体模型名（如 `"gpt-4o"`、`"claude-3-5-sonnet"`）                     |
| `messages` | `Message[]`               | 完整对话历史，**含 system**（注意是第 2 节的宽类型 `Message`，不是 `NonSystemMessage`） |
| `tools`   | `Tool?`                   | 可用工具列表（第 4 节的主角），可选                                           |
| `options` | `Record<string, unknown>?` | 厂商专属参数的「口袋」（`temperature` / `thinking` / `max_tokens`……）      |
| `signal`  | `AbortSignal?`            | 取消信号，用来中断在途的网络请求（呼应第 5 节的 `AbortController`）                  |

再看 `ModelProvider` 接口——它只要求实现两个方法，且这两个方法的**入参完全相同**（都是 `ModelProviderInvokeParams`），**产物也相同**（都是 `AssistantMessage`），区别只在返回的「形态」：

- **`invoke`**：返回 `Promise<AssistantMessage>`——一次性，等模型全部说完，给你一整条消息。
- **`stream`**：返回 `AsyncGenerator<AssistantMessage>`——流式，边生成边一次次 `yield` 出来。

这就直接回答了本节的第二个核心问题——**`invoke` 和 `stream` 为什么是一对**。请特别注意 [model-provider.ts](../../src/foundation/models/model-provider.ts#L26-L35) 上那段注释，它把二者的契约钉死了：

```ts
/**
 * Streams the model response, yielding accumulated snapshots.
 * Each yielded value is a progressively more complete AssistantMessage.
 * The final yielded value is equivalent to what invoke would return.
 */
```

翻译成一句话：

> **`stream`** **每次 yield 的都是一份「到目前为止的完整 `AssistantMessage` 快照」，而它的最后一次 yield，恰好等于** **`invoke`** **一次性返回的那条消息。**

所以 `invoke` 和 `stream` 不是两个功能，而是**同一个语义的两种交付方式**：一个「憋到最后一次给」，一个「边攒边给、最后一份和憋到最后一样」。这个「**每次 yield 都是完整快照**」的约定，是 roadmap 点名的第三个亮点，1.6 会专门讲它为什么如此重要。

### 1.4 调用上下文：`ModelContext`（[model-context.ts](../../src/foundation/models/model-context.ts)）

这个文件更短，只有 8 行，但藏着本节最妙的一处分工：

```ts
export interface ModelContext {
  prompt: string;
  messages: NonSystemMessage[];
  tools?: Tool[];
  signal?: AbortSignal;
}
```

把它和上一节的 `ModelProviderInvokeParams` 并排看，差异一目了然——**差异本身就是设计**：

| 字段        | `ModelContext`（面向 Agent） | `ModelProviderInvokeParams`（面向 Provider） |
| --------- | ------------------------ | ---------------------------------------- |
| 系统提示      | `prompt: string`（一个**字符串**） | —（没有独立字段，已被拼进 `messages`）                 |
| 对话历史      | `messages: NonSystemMessage[]`（**不含** system） | `messages: Message[]`（**含** system）       |
| 模型名       | —（Agent 不关心）             | `model: string`                          |
| 厂商参数      | —（Agent 不关心）             | `options?: Record<string, unknown>`      |
| 工具 / 取消信号 | `tools?` / `signal?`     | `tools?` / `signal?`（透传）                 |

两个关键差异，都是刻意的：

1. **系统提示：`ModelContext` 给的是一个** **`string`，而不是一个** **`SystemMessage`。** 这意味着上层（Agent）根本不需要知道「系统提示最终会变成一条 `role:"system"` 的消息」——它只管交出「我的人设是这段文字」，至于怎么包装成消息、放在历史的哪个位置，**全权交给** **`Model`**。这大大降低了上层的心智负担。
2. **历史：`ModelContext.messages`** **是第 2 节的** **`NonSystemMessage[]`。** 这正好呼应了第 2 节里我们特意拎出来的那个别名——「对话历史天然不含 system」。在这里它兑现了价值：Agent 维护的历史（`UserMessage` / `AssistantMessage` / `ToolMessage`）在类型上就**不可能**混入 system 消息，system 是运行时才由 `Model` 临时拼上去的。

这就是 roadmap 点名的第二个亮点——**`ModelContext`** **只带 `NonSystemMessage`、由** **`Model`** **负责拼装 system prompt 的巧思**。至于「怎么拼」，就是下一小节要逐行读的那个方法。

### 1.5 编排壳：`Model`（[model.ts](../../src/foundation/models/model.ts)）

现在看主角 `Model` 类。它做的事出奇地少——这恰恰是「编排壳」该有的样子。先看骨架：

```ts
export class Model {
  constructor(
    readonly name: string,
    readonly provider: ModelProvider,
    readonly options?: Record<string, unknown>,
  ) {}

  invoke(context: ModelContext) {
    const params = this._buildModelProviderParams(context);
    return this.provider.invoke(params);
  }

  stream(context: ModelContext) {
    const params = this._buildModelProviderParams(context);
    return this.provider.stream(params);
  }
  // ...
}
```

**构造函数**说明了 `Model` 是「名字 + 后端 + 默认参数」三者的捆绑：

- `name`：模型名，最终会填进 `ModelProviderInvokeParams.model`。
- `provider`：一个 `ModelProvider` **实现**——注意类型是**接口** `ModelProvider`，所以 `Model` 完全不知道自己手里握的是 OpenAI 还是 Anthropic。这正是「换厂商一行不改」的技术支点。
- `options`：这个 `Model` 的**默认厂商参数**，会被原样透传进 params。它就是你在 [cli/index.tsx](../../src/cli/index.tsx#L57-L62) 看到的那段：

  ```ts
  const model = new Model(entry.name, provider, {
    max_tokens: 16 * 1024,
    thinking: { type: "enabled" },
  });
  ```

**`invoke`** **和** **`stream`** **两个方法几乎是双胞胎**：都先调 `_buildModelProviderParams(context)` 把上下文翻译成 provider 契约的入参，然后**唯一的区别**是转发给 `provider.invoke` 还是 `provider.stream`。`Model` 对「流式与否」这件事本身**不做任何额外处理**——它只是个转发器。这份对称，正是 1.3 里「invoke/stream 是一对」在编排层的体现。

真正的核心是那个私有翻译器 `_buildModelProviderParams`——本节最该逐行读的一段（[model.ts](../../src/foundation/models/model.ts#L50-L63)）：

```ts
private _buildModelProviderParams(context: ModelContext): ModelProviderInvokeParams {
  const messages: Message[] = [];
  if (context.prompt) {
    messages.push({ role: "system", content: [{ type: "text", text: context.prompt }] });
  }
  messages.push(...context.messages);
  return {
    model: this.name,
    options: this.options,
    messages,
    tools: context.tools,
    signal: context.signal,
  };
}
```

逐行拆解：

1. **`const messages: Message[] = []`**——注意这个数组的类型是**宽类型** `Message[]`（能装 system），而入参 `context.messages` 是**窄类型** `NonSystemMessage[]`。这里正在发生一次「从窄到宽」的**重新组装**：把「不含 system 的历史」升级成「含 system 的完整消息序列」。
2. **`if (context.prompt)`**——只有 prompt **非空**才拼 system。空字符串会被跳过，从而**不会产生一条内容为空的 system 消息**——一个小而稳的边界处理。
3. **`messages.push({ role: "system", content: [{ type: "text", text: context.prompt }] })`**——把一个纯字符串 `prompt`，包装成一条标准的 `SystemMessage`。看它的形状：`role: "system"`，`content` 是一个**单元素数组** `[{ type: "text", text }]`。这正是第 2 节 `SystemMessageContent = TextContent[]` 那条「权限表」的严丝合缝的落地——system 消息只能装 `TextContent`，这里装的正是一段 `TextContent`。
4. **`messages.push(...context.messages)`**——把历史接在 system **之后**。于是「system 永远排在最前面」这个不变量，被 `Model` **在一处集中保证**，上层永远不用操心。
5. **`return { ... }`**——拼出最终的 `ModelProviderInvokeParams`：`model` 来自 `this.name`、`options` 来自 `this.options`（Model 自带的默认参数）、`messages` 是刚拼好的、`tools` 与 `signal` 从 context 原样透传。

一句话概括这个方法：

> **它是** **`ModelContext`（面向 Agent）→** **`ModelProviderInvokeParams`（面向 Provider）的唯一翻译器，核心动作就是「把字符串 prompt 变成 SystemMessage 塞到队首」。**

### 1.6 流式约定的回报：上层的消费代码有多简单

现在把镜头切到**消费端**，看看「每次 yield 都是完整快照」这个约定到底买到了什么。看 Agent 主循环里拉取模型输出的 `_think`（[agent.ts](../../src/agent/agent.ts#L180-L205)）：

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
  // ...
  this._appendMessage(latest);
  return latest;
}
```

请盯住这四行的极简：

```ts
let latest: AssistantMessage | null = null;
for await (const snapshot of this.model.stream(modelContext)) {
  latest = snapshot;                     // ← 每次只是「覆盖」，不是「累加」
  if (snapshot.streaming) { /* 发进度事件 */ }
}
return latest;                           // ← 循环结束，latest 天然就是最终完整消息
```

消费者**什么拼接都不用做**。它只需在每次收到快照时用 `latest = snapshot` 覆盖一下；循环自然结束时，`latest` 里躺着的就是那份「最后一次 yield」——也就是契约保证的、等价于 `invoke` 返回的完整消息。它甚至不用判断「流结束了没有」，`for await` 帮它兜住了。

**这就是「快照约定」的全部回报：把「增量拼接」的复杂度，从每一个消费者身上，收敛到了 provider 内部的一个** **`StreamAccumulator`** **里。** 你在两个 provider 的 `stream` 里都能看到那个统一的模式（[openai/model-provider.ts](../../src/community/openai/model-provider.ts#L73-L77)）：

```ts
const acc = new StreamAccumulator();
for await (const chunk of response) {
  acc.push(chunk);          // 累积厂商的增量碎片
  yield acc.snapshot();     // 但对外只吐「完整快照」
}
```

厂商的原生流（OpenAI 的 SSE、Anthropic 的事件流）本质上都是**增量 delta**——今天来半个词、明天来半个还没闭合的 tool-call JSON。`StreamAccumulator` 把这些碎片在 provider 内部悄悄拼好，对外只暴露「干净的完整快照」。至于它内部怎么处理「参数 JSON 还没解析完就先别吐 tool\_use」这类细节，是第 16、17 节的活儿——**本节你只需记住这条边界约定，以及它让上层代码简单成什么样。**

顺带解释 `streaming` 字段的归属（呼应第 2 节末尾的钩子）：快照在生成过程中带着 `streaming: true`，`_think` 靠它决定「还在动，发个 progress 事件让 TUI 转圈」；而最终那条消息不应再带这个标记，[agent.ts](../../src/agent/agent.ts#L199-L202) 甚至做了一层防御，若最后一条仍带 `streaming` 就主动 `delete` 掉。所以第 2 节问的「`streaming` 谁填的」，答案就在这里：**provider 在流式快照上打标、终态摘除。**

### 1.7 契约的两个实现：换厂商到底改了什么、没改什么

抽象讲完，来验货。看两个 provider 如何实现同一个 `ModelProvider` 接口，你就能亲眼确认「换厂商，上层一行不改」到底意味着什么。

**OpenAI**（[openai/model-provider.ts](../../src/community/openai/model-provider.ts#L80-L98)）的 `_baseChatCompletionParams`：

```ts
return {
  model,
  messages: convertToOpenAIMessages(messages),   // 内部 Message[] → OpenAI 格式
  tools: tools ? convertToOpenAITools(tools) : undefined,
  temperature: 0,                                 // 默认追求确定性
  ...options,                                     // Model 的 options 覆盖默认
};
```

**Anthropic**（[anthropic/model-provider.ts](../../src/community/anthropic/model-provider.ts#L49-L78)）的 `_baseMessageParams`：

```ts
const system = extractSystemPrompt(messages);     // 把 system 从 messages 里「抽」出来
const anthropicMessages = convertToAnthropicMessages(messages);
// ...thinking.budget_tokens 自动推导...
return {
  model,
  max_tokens: 8192,
  messages: anthropicMessages,
  ...(system ? { system } : {}),                  // Anthropic 的 system 是顶层独立参数
  ...(anthropicTools?.length ? { tools: anthropicTools } : {}),
  ...normalizedOptions,
};
```

把两者对照，「共性 vs 差异」就清清楚楚：

| 维度            | OpenAIModelProvider              | AnthropicModelProvider                   |
| ------------- | -------------------------------- | ---------------------------------------- |
| 实现的接口         | 同一个 `ModelProvider`              | 同一个 `ModelProvider`                      |
| 消息翻译          | `convertToOpenAIMessages`        | `convertToAnthropicMessages`             |
| system 放哪     | 留在 `messages` 里（OpenAI 就吃 messages 里的 system） | 用 `extractSystemPrompt` **抽出来**放顶层 `system` 参数 |
| 默认参数          | `temperature: 0`                 | `max_tokens: 8192` + thinking budget 自动推导 |
| 流式累积          | `StreamAccumulator` + `snapshot()` | `StreamAccumulator` + `snapshot()`（同名不同实现） |

这里有个特别有意思的细节，把本节的分工闭环了：**`Model`** **刚在 1.5 里辛辛苦苦把 prompt 拼成一条 `SystemMessage` 塞进 `messages`，Anthropic 的 provider 又用** **`extractSystemPrompt`** **把它从 `messages` 里抽了出来**，放到顶层 `system` 参数里。

这看起来「多此一举」，实则是**契约设计的正确姿势**：`ModelProviderInvokeParams.messages` 选用**最通用**的表示（system 就混在消息序列里，OpenAI 直接就能用），而 Anthropic 这种「system 要单独放」的**特例，由它自己的适配器去处理**。核心契约保持通用与稳定，个性化的活儿全部下沉到 community 边界——这与第 2 节「内部模型选一个通用表示、翻译的脏活收敛在边界」是同一种哲学。

至于 `cli/index.tsx` 那个 `new Model(...)` 的 `options`（`max_tokens: 16*1024, thinking: { type: "enabled" }`），此刻也能串起来了：它经 `Model` 透传进 params，最终被 Anthropic provider 接住——`max_tokens` 覆盖掉默认的 8192，`thinking: enabled` 触发 `budget_tokens` 自动推导为 `floor(16384 * 0.8)`。**上层只是往一个开放的 `options` 口袋里塞了两个厂商参数，具体怎么解释是 provider 的事。**

### 1.8 桶文件与导出：`Model` 也从 `@/foundation` 出来

和第 2 节一样，看这些类型/类是怎么被导出的。[models/index.ts](../../src/foundation/models/index.ts) 又是一个极薄的桶文件：

```ts
export * from "./model-context";
export * from "./model-provider";
export * from "./model";
```

再往上被 [foundation/index.ts](../../src/foundation/index.ts) 汇总，于是全项目任何地方都能写：

```ts
import type { Model, ModelProvider, ModelContext, ModelProviderInvokeParams } from "@/foundation";
```

你在 [agent.ts](../../src/agent/agent.ts#L1-L10)（`import type { Model, ModelContext } from "@/foundation"`）、两个 provider（`import type { ... ModelProvider ... } from "@/foundation"`）里看到的，都是这一个门。这再次印证第 1 节的「桶文件 + 全具名导出 + `@/*` 别名」——**地基的每一块，都只从** **`@/foundation`** **这一个入口出来。**

***

## 2. 亮点与关键设计

1. **`Model`（编排壳）/** **`ModelProvider`（厂商契约）的职责分离——本节思想内核。**
   `Model` 持有一个 `ModelProvider` **接口**（而非某个具体厂商），只做「稳定的编排」（拼 system、透传参数、转发调用）；`ModelProvider` 则把「易变的厂商适配」抽象成两个方法。这是**依赖倒置 + 策略模式**的教科书式落地——换厂商 = 在 [cli/index.tsx](../../src/cli/index.tsx#L45-L55) 换一个 `new XxxProvider()`，`Model` 与 Agent 一行不改。
2. **`ModelContext`** **只带** **`NonSystemMessage`、`prompt`** **是字符串——最妙的一处分工。**
   上层只交出「人设文字 + 不含 system 的历史」，把「字符串 → `SystemMessage` → 塞到队首」的组装全权交给 `Model._buildModelProviderParams`。既降低上层心智负担，又把「system 永远排第一」这个不变量集中到一处保证。它也让第 2 节 `NonSystemMessage` 这个别名兑现了价值。
3. **`invoke`** **/** **`stream`** **是一对，且「每次 yield 都是完整快照」——决定上层简洁度的边界约定。**
   二者入参、产物完全相同，只差交付形态；`stream` 的最后一次 yield 等价于 `invoke` 的返回。快照约定把「增量拼接」的复杂度收敛进 provider 的 `StreamAccumulator`，让消费端（[agent.ts `_think`](../../src/agent/agent.ts#L189-L195)）只需 `latest = snapshot` 一行。
4. **`options: Record<string, unknown>`** **的开放口袋——克制的扩展点。**
   厂商参数千差万别（`temperature` / `thinking` / `max_tokens` / `budget_tokens`……），用一个开放 record 承接，让每个 provider 自行解释（OpenAI `...options` 直接展开、Anthropic 还会 normalize thinking budget）。加一个厂商专属参数无需改动任何核心类型——与第 2 节 `ToolUseContent<T>` 的克制一脉相承。

***

## 3. 工业对比

把 Helixent 的模型抽象与业界主流放一起看：

| 维度        | Helixent                          | OpenAI SDK（原生）                   | Anthropic SDK（原生）              | LangChain                                  |
| --------- | --------------------------------- | -------------------------------- | ------------------------------ | ------------------------------------------ |
| 后端抽象      | `ModelProvider` 接口（**2 个方法**）      | 无（就是自家 client）                   | 无（就是自家 client）                 | `BaseChatModel`（方法多：`invoke`/`stream`/`batch`/`bindTools`…） |
| 换厂商成本     | 换一个 `new XxxProvider()`           | 换整套 SDK 调用                       | 换整套 SDK 调用                     | 换一个 chat model 类（较重）                        |
| 流式产出      | **完整快照**（每次 yield 是累积后的完整消息）       | **增量 delta**（chunk，需自己累加）        | **事件流**（`content_block_delta` 等，需自己累加） | `AIMessageChunk`（chunk，需 `concat` 累加）      |
| 系统提示      | 上层给 `string`，`Model` 拼成 `SystemMessage` | 放进 `messages`                    | 顶层独立 `system` 参数               | `SystemMessage` 或模板                         |
| 厂商专属参数    | 开放 `options` 口袋，provider 各自解释      | 直接作为 create 参数                   | 直接作为 create 参数                 | 构造参数 + `bind`                              |

几点读法：

- **「快照」vs「delta」是 Helixent 最鲜明的取舍。** OpenAI / Anthropic 的原生流、乃至 LangChain 的 `stream`，吐给你的都是**增量碎片**，消费方必须自己累加、自己判断「tool-call 的 JSON 拼完了没」。Helixent 反其道而行——**在 provider 内部累加，对外只给完整快照**。代价是 provider 实现要多写一个 `StreamAccumulator`（第 16/17 节），收益是**每一个消费者都省心**。对一个「消费点可能很多、但 provider 只有少数几个」的框架来说，这笔账非常划算。
- **抽象的「薄」是刻意的。** LangChain 的 `BaseChatModel` 功能全面（`batch`、`bindTools`、回调、缓存……），但概念也重。Helixent 只保留 `invoke` + `stream` 两个方法——**够用、能一眼读完**，这正是它作为教学标本的价值。想加能力（如批处理）时，也只需在契约上扩展，而非推翻。
- **依赖倒置是所有可插拔框架的共同底色。** Vercel AI SDK 的 provider、LiteLLM 的统一网关，本质都在做同一件事：给上层一个稳定接口、把厂商差异关进适配器。Helixent 用一百行把这件事讲清楚了。

***

## 4. 深度解释：为什么这样设计？不这样会怎样？

**Q1：为什么要拆成** **`Model`** **和** **`ModelProvider`** **两个东西？合成一个类不行吗？**
拆开是为了**隔离「稳定」与「易变」**。`Model` 承载的编排逻辑（把 prompt 拼成 system、透传 options、转发调用）几乎不随厂商变化，**只需写一遍**；`ModelProvider` 承载的厂商适配则**每家一个实现**、各自演化。若合成一个类，你要么把所有厂商的 `if (openai) … else if (anthropic) …` 塞进同一个类（每加一家就动核心），要么让每家厂商都重复实现一遍「拼 system」的编排（重复且易漂移）。拆开后还有一个隐形红利——**可测试性**：想测 `Model` 或上层 Agent，塞一个「假的」`ModelProvider`（返回预设的 `AssistantMessage`）即可，完全不碰真实网络。

**Q2：为什么** **`ModelContext.prompt`** **是** **`string`，而不是直接让上层传一条** **`SystemMessage`？**
为了**降低上层心智负担**并**集中保证不变量**。让 Agent 交出一个字符串，它就不必知道「系统提示最终会变成什么形状的消息、要放在历史的哪个位置」——这些是 `Model` 的职责。反过来，如果上层自己构造 `SystemMessage` 再塞进 `messages`，那么「system 必须在队首」「只能有一条 system」这类规则就得靠**每个调用点自觉遵守**，迟早出错。把它收敛到 `_buildModelProviderParams` 一处，规则只需保证一次。这也正是第 2 节区分 `NonSystemMessage` 的意义所在——历史里天然没有 system，system 是运行时拼的。

**Q3：流式为什么选「完整快照」而不是「增量 delta」？**
因为**要把复杂度放在「少」的一侧**。一个框架里，「消费流的地方」往往很多（主循环、进度渲染、日志、eval……），而「produce 流的 provider」只有少数几个。若对外吐 delta，那么**每个消费者**都得重复实现「累加 + 判断完整性 + 兜底半个 JSON」的逻辑，错一个地方就出 bug。选择在 provider 内部（`StreamAccumulator`）累加、对外只给完整快照，就把这份复杂度**收敛到少数几个 provider 里写一次**。代价是 provider 实现略复杂，但这是最划算的复杂度分配。1.6 里 `_think` 那四行的极简，就是这个决策的直接回报。

**Q4：`options: Record<string, unknown>`** **这么松散的类型，不怕出错吗？为什么不强类型化？**
这是**有意的松**。不同厂商的可调参数交集很小、并集很大且各自演化（OpenAI 有 `temperature`/`top_p`，Anthropic 有 `thinking`/`budget_tokens`/`max_tokens`……），强行用一个统一强类型去覆盖，要么挂一漏万，要么变成一个巨大的可选字段联合，且每加一家/一个新参数都要改核心类型。用开放 record 当「口袋」，让**每个 provider 自己解释自己认识的键**（OpenAI `...options` 直接展开、Anthropic 对 `thinking` 做 normalize），核心类型就此稳定。代价是失去编译期校验（塞错键不会报错，只会被 provider 忽略或报运行时错），但换来的是核心的开放封闭。这与第 2 节 `ToolUseContent<T>` 默认 `Record<string, unknown>`、第 4 节工具参数的取舍，是贯穿全项目的同一种「**核心求稳、边界求活**」哲学。

**Q5（一处精读小发现）：** `Model.invoke` / `Model.stream` 的 JSDoc 里写着 `@param messages` / `@param tools`，但方法签名其实只接收一个 `context: ModelContext`（[model.ts](../../src/foundation/models/model.ts#L29-L48)）。这是注释与签名的一处轻微不同步——不影响功能，但读源码时以**签名为准**。另外值得一提：当前 Agent 主循环（[agent.ts `_think`](../../src/agent/agent.ts#L190)）走的是 `stream`；`invoke` 更多是作为**契约对称性**与「不需要中间态」场景（如批处理、评测）的入口而存在，两个 provider 都完整实现了它。诚实地说，它在主链路上暂未被调用——理解它「与 stream 等价、随时可用」的定位即可，不必以为主循环里到处在用它。

***

## 5. 参考资料

- 本项目源码：[model.ts](../../src/foundation/models/model.ts)、[model-provider.ts](../../src/foundation/models/model-provider.ts)、[model-context.ts](../../src/foundation/models/model-context.ts)、[models/index.ts](../../src/foundation/models/index.ts)
- 依赖倒置原则（Dependency Inversion Principle）：<https://en.wikipedia.org/wiki/Dependency_inversion_principle>
- 策略模式（Strategy Pattern）：<https://refactoring.guru/design-patterns/strategy>
- OpenAI · Streaming Chat Completions（原生 delta 流）：<https://platform.openai.com/docs/api-reference/chat/streaming>
- Anthropic · Streaming Messages（事件流）：<https://docs.anthropic.com/en/api/messages-streaming>
- LangChain · Chat Model 接口（`invoke`/`stream`/`AIMessageChunk`）：<https://python.langchain.com/docs/concepts/chat_models/>
- 上游依赖：[第 1 节 · 项目全景与四层架构](./01-overview.md)、[第 2 节 · Message 消息类型系统](./02-message.md)

***

## 6. 小结与下一节预告

本节你应该已经吃透了「地基的第二块砖」——**模型抽象与适配契约**：

- **职责分离**：`Model`（编排壳）持有一个 `ModelProvider`（厂商契约）**接口**，只做稳定的编排（拼 system、透传 options、转发）；厂商差异全部下沉到各自的 provider 实现。这就是「**换厂商，Agent 一行不改**」的底层原理——依赖倒置 + 策略模式。
- **`ModelContext`** **的巧思**：上层只交出 `prompt: string` 和第 2 节的 `NonSystemMessage[]`，由 `Model._buildModelProviderParams` 统一把字符串 prompt 包装成 `SystemMessage` 塞到队首，集中保证「system 永远第一」。
- **`invoke`** **/** **`stream`** **是一对**：同一语义的两种交付形态，且 `stream` 的**每次 yield 都是完整快照**、最后一次等价于 `invoke` 的返回。这个约定把增量拼接的复杂度收敛进 provider 的 `StreamAccumulator`，让消费端（`_think`）简单到只需 `latest = snapshot`。
- **`options`** **开放口袋**：厂商专属参数由各 provider 自行解释，核心类型保持开放封闭。
- 至此也回收了第 2 节的钩子：`AssistantMessage` 由 `Model` 经 provider **生产**，`streaming` 由 provider 在流式快照上打标、终态摘除，`usage` 由 provider 从厂商响应映射填入。

**承上启下（启下）**：我们现在知道了模型如何「说话」（产出 `AssistantMessage`），也知道 `ModelProviderInvokeParams` 和 `ModelContext` 里都躺着一个还没细看的字段——**`tools?: Tool[]`**。模型光会说话还不够，它得能「动手」：

> **一个「工具」在代码里到底长什么样？模型是怎么知道「我有哪些工具、每个工具要什么参数」的？从工具定义、到 JSON Schema、再到 TypeScript 类型，这条链路如何做到「一处定义、三处受益」且全程类型安全？**

这就是 Foundation 三块地基的最后一块。下一节我们钻进 [function-tool.ts](../../src/foundation/tools/function-tool.ts)，看 `defineTool` 如何用一份 Zod schema，同时喂饱「模型需要的 JSON Schema」和「代码需要的 TS 类型」。

👉 下一节 **第 4 节：Tool 工具系统 —— defineTool 与 Zod 类型推导**。读完它，Foundation 三块地基（数据 / 模型 / 工具）就全部就位，我们便能进入第三部分，把它们串成一台会转的机器——**ReAct 主循环**。

准备好后，对我说「**生成第 4 节**」即可。
