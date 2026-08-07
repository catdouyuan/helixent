# 第 16 节：OpenAI Provider —— 消息转换与流式累积器

> 本节属于 **第五部分 · Community 层（第三方模型适配）**，是这一部分的**开篇**，也是整套教程里第一次让 Agent「真正连上大模型」的一节。[第 3 节](./03-model.md) 定义了 `ModelProvider` 契约（`invoke` / `stream` 一对，且「每次 yield 都是完整快照」），但**至今没有一个真实实现**——它一直是个「空接口」。[第 5～15 节](./05-react-loop.md) 造出的整台机器（ReAct 循环、中间件、工具、审批），到目前为止都跑在「假模型」上（测试里的 mock）。**本节就来补齐这一环：把 `ModelProvider` 契约落地成第一个能连真实 OpenAI API 的 `OpenAIModelProvider`。**
>
> 对应 roadmap 为本节设定的**核心问题**：
>
>> 第 2 节的内部 `Message` 如何翻译成 OpenAI 的 wire 格式？第 3 节约定的「完整快照」流式碎片如何拼回？
>>
>
> **一句边界声明**：本节精讲 **`src/community/openai/` 下的五个文件**，它们分工极其清晰，恰好对应「翻译」和「累积」两大职责——
>
> - **编排壳**：[model-provider.ts](../../src/community/openai/model-provider.ts)（99 行，`OpenAIModelProvider` 类，实现 `invoke` / `stream`）。
> - **静态翻译**：[utils.ts](../../src/community/openai/utils.ts)（107 行，三个纯函数：`convertToOpenAIMessages` 出、`parseAssistantMessage` 入、`convertToOpenAITools` 工具）。
> - **动态累积**：[stream-utils.ts](../../src/community/openai/stream-utils.ts)（98 行，`StreamAccumulator`——把增量碎片拼成完整快照，**本节的绝对核心**）。
> - **类型补丁**：[types.ts](../../src/community/openai/types.ts)（29 行，给 OpenAI SDK 的类型「打补丁」，塞进一个非官方的 `reasoning_content` 字段）。
> - **桶文件**：[openai/index.ts](../../src/community/openai/index.ts)（1 行，只导出 provider）。
>
> **本节最大的「啊哈时刻」**：[第 3 节](./03-model.md) 反复强调的那条「**每次 yield 都是完整快照**」的约定，把「拼接增量碎片」的全部复杂度**收敛进了 provider 内部的一个 `StreamAccumulator`**。而这个累积器最烧脑、也最见功力的一处，是它坚持——**「一段 tool-call 的参数 JSON 没解析成功前，绝不吐出这个 `tool_use`」**。看懂这一处「宁可暂时不给，也不给半个」的严谨，你就理解了「为什么上层的 [第 6 节](./06-parallel-tools.md) 并行工具、[第 15 节](./15-human-in-the-loop.md) 的 `ask_user_question`，永远只会拿到完整、合法的工具调用」——那份安全感，正是本节这个累积器在幕后兜底的。
>
> ⚠️ **一处「留到后面」的诚实标注**：本节是 `ModelProvider` 的**第一个**实现。它有意不去和第二家厂商做详细对比——那是 [第 17 节](./00-roadmap.md) Anthropic Provider 的任务（「先立范本，后作对照」）。本节只在个别地方点一句「Anthropic 那边会不同」，把系统性的「共性 vs 差异」留到下一节。

---

## 0. 承上启下

[第 15 节](./15-human-in-the-loop.md) 在结尾把伏笔收得很紧，几乎是「点名」本节。它的原话是这样的：

> 但请注意本节反复出现的一个**空白**——两个 Manager 都在「等一个 UI 来 `subscribe` 并 `respond`」……更根本的是：**整个 Coding Agent 目前还跑在内存里、连不上任何真实的大模型厂商**——[第 3 节](./03-model.md) 定义的 `ModelProvider` 契约，至今还没有一个真实实现！一个「连不上模型」的 Agent，本质上还是个「空壳」。

它还给了一个更具体的预告：

> 你会在第 16 节看到，接入 OpenAI 时最烧脑的是 `StreamAccumulator`——它要增量拼接**一段还没传完的 tool-call JSON**，并坚持「参数没解析成功前，绝不吐出 `tool_use`」。这个「严谨的流式累积」，正是让本节的 `ask_user_question`、以及第 6 节的并行工具，能拿到**完整、合法的工具调用**的底层保证。

本节就来兑现这个悬念。而在动手前，请先把**三条上游结论**装进脑子——它们是本节每一处设计的直接前提：

1. **[第 3 节](./03-model.md) 的 `ModelProvider` 契约。** 这是本节要实现的接口，共两个方法：`invoke`（一次性返回完整 `AssistantMessage`）和 `stream`（异步生成器，**每次 yield 一份「到目前为止的完整快照」，最后一次等价于 `invoke` 的返回**）。第 3 节还立了一条关键约定：**`streaming` 字段由 provider 在流式快照上打标、在终态摘除**；`usage` 由 provider 从厂商响应映射填入。本节就是这些约定的**第一次真实兑现**。
2. **[第 2 节](./02-message.md) 的 `Message` 形状与「wire vs internal」分界。** 内部 `Message` 是「`role` + `content` 分段数组」的可辨识联合；内容段用 `snake_case`（`tool_use` / `tool_result` / `tool_use_id`）——第 2 节说过，这套 `snake_case` **正是为了贴近 OpenAI 的 wire 格式而留的**。本节就是那句话的验证现场：你会看到 `system` / `user` 消息为何能「几乎原样」塞给 OpenAI，而 `assistant` / `tool` 消息为何需要「拆解重组」。
3. **[第 4 节](./04-tool.md) 的 `defineTool` 与 `toJSONSchema()`。** 工具的参数是一份 Zod schema，第 4 节说它「一处定义、三处受益」，其中一处就是「运行期由 community 层调用 `parameters.toJSONSchema()` 转成 JSON Schema 喂给模型」。本节的 `convertToOpenAITools` 就是那个「community 层」——它是 `toJSONSchema()` 的**唯一真实调用点之一**。

准备好了。我们先不看任何一个具体文件，而是先建立「**一个壳、两大职责、五个文件**」的全局地图——因为本节最容易让人迷路的地方，是「翻译」和「累积」这两件事交织在一起。有了地图，再逐个击破。

---

## 1. 主题内容

### 1.1 先建立地图：一个壳、两大职责、五个文件

本节五个文件，可以先按「一个编排壳 + 两大职责」归位。**一张图看清它们的关系：**

```
        ┌──────────────────────────────────────────────────────────────────┐
        │            Model（第 3 节的编排壳）: model.stream(context)          │
        │            provider.stream(params) / provider.invoke(params)        │
        └───────────────────────────────┬────────────────────────────────────┘
                                         │  实现 ModelProvider 契约
                                         ▼
        ┌──────────────────────────────────────────────────────────────────┐
        │  model-provider.ts  ——  OpenAIModelProvider（编排壳）               │
        │   · constructor: baseURL/apiKey → new OpenAI(...)                   │
        │   · _baseChatCompletionParams: invoke/stream 共享的参数构建          │
        │   · invoke():  create() → parseAssistantMessage                     │
        │   · stream():  create({stream:true}) → StreamAccumulator 循环        │
        └───────────┬──────────────────────────────────────┬─────────────────┘
                    │ 【职责一：静态翻译】                    │ 【职责二：动态累积】
                    │ 方向：内部 Message ⇄ OpenAI wire        │ 方向：碎片 chunk → 完整快照
                    ▼                                        ▼
        ┌────────────────────────────────┐   ┌──────────────────────────────────┐
        │ utils.ts（三个纯函数）           │   │ stream-utils.ts                    │
        │  · convertToOpenAIMessages  出→ │   │  · StreamAccumulator               │
        │  · parseAssistantMessage    ←入 │   │    push(chunk)  累积增量            │
        │  · convertToOpenAITools     工具│   │    snapshot()   吐完整快照          │
        └────────────────────────────────┘   └──────────────────────────────────┘
                    │                                        │
                    └──────────────┬─────────────────────────┘
                                   ▼
                    ┌────────────────────────────────┐
                    │ types.ts —— 给 OpenAI SDK 类型   │
                    │  打补丁，塞进 reasoning_content   │
                    │ index.ts —— 桶文件（只导出壳）    │
                    └────────────────────────────────┘
```

**这张图的核心是「一个壳 + 两大职责」，从上到下读：**

- **编排壳（[model-provider.ts](../../src/community/openai/model-provider.ts)）**：它是 `ModelProvider` 契约的**实现类**，本身几乎不干「脏活」——它把「怎么翻译消息」外包给 `utils.ts`、把「怎么拼流」外包给 `stream-utils.ts`，自己只负责「调 SDK + 编排这两件事」。**这是「壳薄、活外包」的分层**（1.2 精讲）。
- **职责一·静态翻译（[utils.ts](../../src/community/openai/utils.ts)）**：三个**纯函数**，做「内部 `Message` ⇄ OpenAI wire 格式」的**双向翻译**——`convertToOpenAIMessages`（出：内部→wire，1.3）、`parseAssistantMessage`（入：wire→内部，1.4）、`convertToOpenAITools`（工具定义→wire，1.5）。**它们是无状态的、可单测的（测试就在 `__tests__/utils.test.ts`）。**
- **职责二·动态累积（[stream-utils.ts](../../src/community/openai/stream-utils.ts)）**：一个**有状态的类** `StreamAccumulator`——把 OpenAI 流式返回的「增量碎片（delta）」在 provider 内部悄悄拼成「完整快照」，对外只暴露 `snapshot()`。**这是本节最烧脑、也最见功力的部分**（1.7 精讲）。

**还有两个「配角」文件**：[types.ts](../../src/community/openai/types.ts)（给 OpenAI SDK 的类型「打补丁」，塞进一个 SDK 类型里没有、但国产/兼容厂商常返回的 `reasoning_content` 字段，1.6 讲）、[openai/index.ts](../../src/community/openai/index.ts)（桶文件，只 `export * from "./model-provider"`）。

**本节的讲解顺序**：先看编排壳（1.2），建立「壳调用谁」的骨架；再走「静态翻译」这条线（1.3 出 → 1.4 入 → 1.5 工具）；然后是「类型补丁」这个前置知识（1.6）；接着精讲「动态累积」的核心 `StreamAccumulator`（1.7）；最后看装配与全景（1.8）。

### 1.2 `OpenAIModelProvider`：契约的第一个实现（编排壳）

先看 [model-provider.ts](../../src/community/openai/model-provider.ts) 的类骨架。它 `implements ModelProvider`——**这是 [第 3 节](./03-model.md) 那个「空接口」的第一次落地**：

```ts
export class OpenAIModelProvider implements ModelProvider {
  _client: OpenAI;

  constructor({ baseURL, apiKey }: { baseURL?: string; apiKey?: string } = {}) {
    this._client = new OpenAI({ baseURL, apiKey });
  }
  // invoke / stream / _baseChatCompletionParams ...
}
```

**构造函数极简**（[L24-L29](../../src/community/openai/model-provider.ts#L24-L29)）：接收可选的 `baseURL` 和 `apiKey`，直接透传给官方 `openai` SDK 的 `new OpenAI(...)`。**注意 `baseURL` 是可选且「原样透传」的**——这个不起眼的细节，正是 1.8 会揭示的「一个 provider 复用给近十家厂商」的关键（DeepSeek、Qwen、GLM…… 都是「换个 `baseURL` 的 OpenAI 兼容 API」）。这里和 [第 17 节](./00-roadmap.md) 的 Anthropic 会形成对比：Anthropic 的构造函数对 `baseURL` 做了「等于默认值就不传」的特殊处理，而 OpenAI 这边**毫无顾虑地原样透传**——先记住这个差异，第 17 节会解释为什么。

**关键设计一：`invoke` 和 `stream` 共享同一套参数构建**。看私有方法 `_baseChatCompletionParams`（[L80-L98](../../src/community/openai/model-provider.ts#L80-L98)）：

```ts
private _baseChatCompletionParams({ model, messages, tools, options }) {
  return {
    model,
    messages: convertToOpenAIMessages(messages),           // ← 职责一：翻译消息（1.3）
    tools: tools ? convertToOpenAITools(tools) : undefined, // ← 职责一：翻译工具（1.5）
    temperature: 0,                                         // ← 默认值决策（见下）
    ...options,                                             // ← 用户 options 可覆盖一切
  };
}
```

**这个方法是 `invoke` 和 `stream` 的「公约数」**——两者都要「把内部消息/工具翻译成 wire 格式、设默认参数」，唯一的区别只是「流不流」。把这段共享逻辑抽出来，`invoke` 和 `stream` 就只需在它之上加一点点自己的东西。（Q6 会讨论「为什么不干脆让 `invoke` 复用 `stream`」。）

**关键设计二：`temperature: 0` 是默认值，但可被覆盖**。注意那个 `...options` 放在 `temperature: 0` **之后**——这意味着**对象展开的「后者覆盖前者」规则**让用户传入的 `options.temperature` 能盖掉默认的 `0`。**为什么默认 `0`？** 因为这是一个**Coding Agent**——它要做的是「读文件、改代码、跑命令」这类**追求确定性、可复现**的任务，而非「写诗、头脑风暴」这类要创造性的任务。`temperature: 0` 让模型**尽可能确定性地**输出（同样输入尽量给同样输出），减少「今天能跑、明天报错」的抖动。**这是「为 Coding 场景选的默认」，是 roadmap 点名的一个决策**（Q5 深入）。

**再看 `invoke`**（[L31-L49](../../src/community/openai/model-provider.ts#L31-L49)）——一次性、非流式：

```ts
async invoke({ model, messages, tools, options, signal }) {
  const params = { ...this._baseChatCompletionParams({ model, messages, tools, options }) };
  const response = await this._client.chat.completions.create(params, { signal });
  return parseAssistantMessage(response.choices[0]!.message!, toTokenUsage(response.usage));
}
```

三步：构建参数 → 调 SDK 的 `chat.completions.create`（透传 `signal` 支持 [第 5 节](./05-react-loop.md) 的取消）→ 用 `parseAssistantMessage`（1.4）把 OpenAI 的响应**翻译回内部** `AssistantMessage`。`toTokenUsage`（[L9-L16](../../src/community/openai/model-provider.ts#L9-L16)）是个小映射函数，把 OpenAI 的 `{ prompt_tokens, completion_tokens, total_tokens }`（snake_case wire）转成内部的 `{ promptTokens, completionTokens, totalTokens }`（camelCase internal）——**又一处 wire/internal 的边界翻译**。

**最后是 `stream`**（[L51-L78](../../src/community/openai/model-provider.ts#L51-L78)）——本节的重点入口：

```ts
async *stream({ model, messages, tools, options, signal }): AsyncGenerator<AssistantMessage> {
  const response = await this._client.chat.completions.create(
    {
      ...this._baseChatCompletionParams({ model, messages, tools, options }),
      stream: true,
      stream_options: { include_usage: true },   // ← 关键：要求最后回一个带 usage 的 chunk
    },
    { signal },
  );

  const acc = new StreamAccumulator();
  for await (const chunk of response) {
    acc.push(chunk);          // ← 把厂商的增量碎片喂给累积器
    yield acc.snapshot();     // ← 但对外只吐「到目前为止的完整快照」
  }
}
```

**这七行就是 [第 3 节](./03-model.md) 那条「快照约定」的兑现现场**，逐点看：

- **`stream: true`**：告诉 SDK 用流式（SSE）返回，于是 `response` 变成一个可 `for await` 的异步迭代器，每次给一个 `chunk`（增量 delta）。
- **`stream_options: { include_usage: true }`**：这是一个**关键请求参数**——默认情况下 OpenAI 的流式**不返回 token 用量**（因为用量要等生成完才知道）。加上这个选项，OpenAI 会在**流的最后**额外补一个「`choices` 为空、只带 `usage`」的 chunk。**1.7 会看到，`StreamAccumulator` 正是靠「这个 usage 到没到」来判断「流是不是结束了」（`isFinal`）。** 没有这个选项，累积器就没法区分「还在流」和「流完了」。
- **`acc.push(chunk); yield acc.snapshot();`**：**这就是第 3 节说的「把增量拼接的复杂度收敛进 provider」**——`push` 把碎片喂进累积器（累积器内部拼接），`snapshot()` 吐出「到目前为止的完整 `AssistantMessage`」。**上层的 [第 5 节](./05-react-loop.md) `_think` 只需 `latest = snapshot` 覆盖一下**，什么拼接都不用做。

> 💡 **编排壳的「妙」在哪？** 它把 provider 拆成了「**薄壳 + 两个可替换的零件**」：壳只管「调 SDK、编排」，翻译外包给 `utils.ts`（纯函数、可单测）、拼流外包给 `stream-utils.ts`（有状态、可单测）。**这让最难测的部分（翻译逻辑、累积逻辑）都变成了「不依赖网络、不依赖 SDK」的纯逻辑单元**——你能看到 `__tests__/utils.test.ts` 和 `__tests__/stream-utils.test.ts` 完全不 mock 网络，就能把这两块逻辑测透。**壳薄、活外包、逻辑可测——这是本节分层的第一层价值。**

### 1.3 `convertToOpenAIMessages`（出）：内部 `Message` → OpenAI wire 格式

现在走「静态翻译」这条线，先看**出站方向**——把内部 `Message[]` 翻译成 OpenAI 的 `ChatCompletionMessageParam[]`。这是 [utils.ts](../../src/community/openai/utils.ts) 里最长、也最能体现「四种 role 各有各的翻译规则」的函数（[L16-L63](../../src/community/openai/utils.ts#L16-L63)）：

```ts
export function convertToOpenAIMessages(messages: Message[]): OpenAIChatCompletionMessageParam[] {
  const openaiMessages: OpenAIChatCompletionMessageParam[] = [];
  for (const message of messages) {
    if (message.role === "system" || message.role === "user") {
      openaiMessages.push(message);                    // ① system/user：原样透传
    } else if (message.role === "assistant") {
      // ② assistant：拆解重组（见下）
    } else if (message.role === "tool") {
      // ③ tool：一条拆成多条（见下）
    }
  }
  return openaiMessages;
}
```

**这个函数按 [第 2 节](./02-message.md) 的四种 role 分四路处理。逐路看它们「翻译难度」的递增：**

**① `system` / `user` —— 原样透传（零翻译）**：`openaiMessages.push(message)` 直接把内部消息推进去。**为什么能这么省事？** 因为 [第 2 节](./02-message.md) 设计内部 `Message` 时，`system`/`user` 的内容段（`{ type: "text", text }` / `{ type: "image_url", image_url }`）**本就是照着 OpenAI 的 wire 格式设计的**（snake_case、字段名一致）。**这就是第 2 节「wire vs internal」分界的红利兑现**——内部格式和 OpenAI 格式在这两种 role 上「碰巧一致」，于是翻译退化成「什么都不做」。（测试 [L8-L24](../../src/community/openai/__tests__/utils.test.ts#L8-L24) 验证了「原样透传」。）

**② `assistant` —— 拆解重组（翻译难度最高）**：这是最复杂的一路，因为内部 `AssistantMessage` 的 `content` 是一个「混装了 `text` / `thinking` / `tool_use` 三种段」的数组，而 OpenAI 的 assistant 消息把这三种东西放在**三个不同的字段**里（`content` / `reasoning_content` / `tool_calls`）。看完整逻辑（[L21-L49](../../src/community/openai/utils.ts#L21-L49)）：

```ts
} else if (message.role === "assistant") {
  const assistantMessage: OpenAIAssistantMessageParam = { role: "assistant", content: [] };
  assistantMessage.reasoning_content = "";
  for (const content of message.content) {
    if (content.type === "thinking") {
      assistantMessage.reasoning_content = content.thinking;        // → reasoning_content 字段
    } else if (content.type === "tool_use") {
      if (!assistantMessage.tool_calls) assistantMessage.tool_calls = [];
      assistantMessage.tool_calls.push({
        type: "function",
        id: content.id,
        function: { name: content.name, arguments: JSON.stringify(content.input) },  // ← 注意：对象→字符串
      });
    } else {
      (assistantMessage.content as ChatCompletionContentPart[]).push(content);        // text → content 数组
    }
  }
  if (assistantMessage.content?.length === 0) {
    assistantMessage.content = "";                                  // ← 空数组归一成空字符串
  }
  openaiMessages.push(assistantMessage);
}
```

**三个翻译点，个个是「wire 差异」的具体体现：**

- **`thinking` → `reasoning_content` 字段**：内部把「模型思考」建模成一个 `{ type: "thinking" }` 段，OpenAI（及兼容厂商）则用一个顶层的 `reasoning_content` 字段承载。**注意这个字段不是 OpenAI 官方 SDK 类型里的**——它是国产/兼容厂商（DeepSeek-R1、GLM 等）的扩展，所以要靠 1.6 的 `types.ts` 打补丁才能在类型上合法。
- **`tool_use` → `tool_calls` 数组，且 `input` 对象要 `JSON.stringify`**：**这是最关键的一处翻译**。内部 `ToolUseContent.input` 是一个**结构化对象** `Record<string, unknown>`（第 2 节的设计，方便代码直接用），但 OpenAI 的 `tool_calls[].function.arguments` 要的是**一个 JSON 字符串**。所以这里 `JSON.stringify(content.input)`。**记住这个「对象 → 字符串」的方向**——1.4 的入站翻译会做**完全相反**的 `JSON.parse`，两者是一对镜像。（测试 [L36-L58](../../src/community/openai/__tests__/utils.test.ts#L36-L58) 断言了 `arguments: '{"command":"ls"}'` 这个字符串。）
- **空 `content` 数组 → 空字符串 `""`**：如果这条 assistant 消息**只有 tool_use、没有 text**（模型「不说话，直接调工具」——这在 Agent 里极其常见），那 `content` 数组就是空的。此时 `if (content?.length === 0) content = ""`——把它归一成空字符串。**为什么？** 因为 OpenAI 的 API 对「assistant 消息的 content」有格式期待，一个空数组可能引发校验问题，而空字符串 `""` 是最安全的「我没有文本内容」表达。（测试 [L46-L58](../../src/community/openai/__tests__/utils.test.ts#L46-L58) 断言了 `content: ""`。）

**③ `tool` —— 一条内部消息「拆成多条」wire 消息**：内部一条 `ToolMessage` 的 `content` 数组里可能装了**多个** `tool_result`（对应 [第 6 节](./06-parallel-tools.md) 并行工具的多个结果），但 OpenAI 要求**每个工具结果是一条独立的 `role: "tool"` 消息**。所以要「一拆多」（[L50-L60](../../src/community/openai/utils.ts#L50-L60)）：

```ts
} else if (message.role === "tool") {
  for (const content of message.content) {
    if (content.type === "tool_result") {
      openaiMessages.push({
        role: "tool",
        tool_call_id: content.tool_use_id,   // ← 内部 tool_use_id → wire tool_call_id
        content: content.content,
      });
    }
  }
}
```

**注意 `tool_use_id` → `tool_call_id` 的字段改名**——内部叫 `tool_use_id`（呼应内部的 `tool_use`），OpenAI 叫 `tool_call_id`（呼应它的 `tool_calls`）。这个 id 是「把工具结果和当初的工具调用对上号」的关键（第 2 节讲过的「id 关联」）。**「一条拆多条」是本路的核心**——测试 [L79-L93](../../src/community/openai/__tests__/utils.test.ts#L79-L93) 专门验证「一条含两个 tool_result 的内部消息 → 两条 wire tool 消息」。

> 📌 **小结出站翻译的「难度阶梯」**：`system`/`user` 零翻译（格式天生一致）→ `tool` 需要「一拆多 + 改字段名」→ `assistant` 最难（三种段拆到三个字段、对象转字符串、空数组归一）。**这条阶梯恰好印证了第 2 节的设计意图**：内部格式在「输入侧」（system/user）刻意贴近 wire 以省翻译，而在「输出侧」（assistant）用更适合代码消费的结构（分段数组、结构化 input），代价是这里要做一次「重组」。**翻译成本被有意识地分配到了「只需写一次的 provider」里，换取「无数消费点」的便利。**

### 1.4 `parseAssistantMessage`（入）：OpenAI 响应 → 内部 `AssistantMessage`

出站讲完，看**入站方向**——把 OpenAI 返回的 `ChatCompletionMessage` 翻译回内部 `AssistantMessage`。它是 1.3 中 assistant 那一路的**精确逆操作**（[utils.ts L70-L95](../../src/community/openai/utils.ts#L70-L95)）：

```ts
export function parseAssistantMessage(message: OpenAIChatCompletionMessage, usage?: TokenUsage): AssistantMessage {
  const result: AssistantMessage = { role: "assistant", content: [], usage };
  if (typeof message.reasoning_content === "string") {
    result.content.push({ type: "thinking", thinking: message.reasoning_content });   // reasoning_content → thinking
  }
  if (typeof message.content === "string") {
    result.content.push({ type: "text", text: message.content });                      // content → text
  }
  if (message.tool_calls) {
    for (const tool_call of message.tool_calls) {
      if (tool_call.type === "function") {
        result.content.push({
          type: "tool_use",
          id: tool_call.id,
          name: tool_call.function.name,
          input: JSON.parse(tool_call.function.arguments),                              // ← 字符串→对象（1.3 的镜像）
        });
      }
    }
  }
  return result;
}
```

**它把 1.3 的三条翻译规则「反过来跑一遍」，一一对应：**

- **`reasoning_content` → `{ type: "thinking" }`**：1.3 是 thinking → reasoning_content，这里反向。用 `typeof === "string"` 守卫，只有真的有 reasoning 字段才加 thinking 段。
- **`content`（字符串）→ `{ type: "text" }`**：注意入站的 `message.content` 是**字符串**（OpenAI 非流式响应里 assistant 的 content 是 string），而非 1.3 出站时那个数组。用 `typeof === "string"` 守卫——**连空字符串 `""` 也会被加成一个 `{ type: "text", text: "" }` 段**（测试 [L167-L174](../../src/community/openai/__tests__/utils.test.ts#L167-L174) 专门验证了这个边界，因为 `typeof "" === "string"` 为真）。
- **`tool_calls` → `{ type: "tool_use" }`，且 `arguments` 字符串 `JSON.parse` 回对象**：**这就是 1.3 那个 `JSON.stringify` 的镜像**。OpenAI 回的 `arguments` 是 JSON 字符串，这里 `JSON.parse` 把它变回内部要的结构化 `input` 对象。**注意：这里的 `JSON.parse` 没有 try/catch**——因为**非流式**响应里，OpenAI 保证 `arguments` 是**完整合法**的 JSON（整个响应一次性到达，不存在「传一半」）。**这个「非流式无需容错」的假设，恰恰反衬出流式场景的凶险**——1.7 的 `StreamAccumulator` 里那个 `JSON.parse` 就**必须**包 try/catch，因为流式碎片随时可能是「半个 JSON」。**记住这个对比：入站解析的容错与否，取决于「数据是不是一次性完整到达」。**

`usage` 参数则由调用方（`invoke` 里的 `toTokenUsage(response.usage)`）传入，直接挂到 `result.usage`。**注意入站的 `parseAssistantMessage` 产出的消息不带 `streaming` 标记**——因为它是 `invoke`（非流式）的产物，天生就是「完整终态」。这呼应了第 3 节的约定：`streaming` 只在流式快照上出现。

> 💡 **出入两函数「成对镜像」的价值**：`convertToOpenAIMessages`（出）和 `parseAssistantMessage`（入）构成一对**可逆翻译**——出站 `JSON.stringify(input)`、入站 `JSON.parse(arguments)`；出站 thinking→reasoning_content、入站反之。**这种「成对镜像」不是巧合，而是「round-trip 一致性」的保证**：一条内部消息翻译成 wire、再翻译回来，应该**语义等价**。这让「多轮对话」成为可能——本轮模型产出的 assistant 消息（含 tool_use），下一轮要作为历史再翻译回 wire 发给模型，两个方向必须严丝合缝，否则多轮就会「串味」。

### 1.5 `convertToOpenAITools`（工具）：`toJSONSchema()` 的真实调用点

静态翻译的第三个纯函数，负责把 [第 4 节](./04-tool.md) 的 `Tool[]` 翻译成 OpenAI 的 `ChatCompletionTool[]`（[utils.ts L102-L107](../../src/community/openai/utils.ts#L102-L107)）：

```ts
export function convertToOpenAITools(tools: Tool[]): ChatCompletionTool[] {
  return tools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters.toJSONSchema(),   // ← 第 4 节「一处定义、三处受益」的兑现点
    },
  }));
}
```

**这个五行的小函数，是 [第 4 节](./04-tool.md) 那句「运行期由 community 层调用 `parameters.toJSONSchema()`」的字面兑现。** 回顾第 4 节的「一处定义、三处受益」：你只写一份 Zod schema（`tool.parameters`），它同时派生出「编译期 TS 类型」「运行期 JSON Schema」「人类可读描述」。**这里 `tool.parameters.toJSONSchema()` 就是「第二处受益」的发生地**——把 Zod schema 转成 OpenAI function calling 协议要的标准 JSON Schema（`{ type: "object", properties: {...}, required: [...] }`）。

**三个字段的映射直白得几乎不用解释**：`type: "function"`（OpenAI 的工具目前都是 function 类型）、`name`/`description` 原样搬、`parameters` 是那份自动生成的 JSON Schema。**这里没有任何「手写 schema」**——工具作者在第 4 节写下的那一个 `z.object({...})`，是整条链路唯一的真相源，到这里被自动转译，一个字都不用重写。（测试 [L177-L210](../../src/community/openai/__tests__/utils.test.ts#L177-L210) 用一个 mock 的 `toJSONSchema` 验证了转换结构，还测了「空工具数组 → 空数组」。）

**一个值得留意的细节**：`convertToOpenAITools` 只在「有工具」时被调用——回看 1.2 的 `_baseChatCompletionParams` 里 `tools: tools ? convertToOpenAITools(tools) : undefined`。**没工具就传 `undefined`（而非空数组）**，因为某些 OpenAI 兼容 API 对「空 tools 数组」和「无 tools 字段」的处理不同，传 `undefined` 让 SDK 干脆不发这个字段，最稳妥。

> 📌 **对照 [第 17 节](./00-roadmap.md) 埋一个钩子**：`convertToOpenAITools` 和 Anthropic 的 `convertToAnthropicTools` 会非常像——都调 `tool.parameters.toJSONSchema()`，只是「包装字段」不同（OpenAI 要 `{ type, function: { name, description, parameters } }`，Anthropic 要 `{ name, description, input_schema }`）。**这就是「契约共性 vs 厂商差异」的一个微观样本**：`toJSONSchema()` 是共性（Foundation 定义的能力），「怎么包装这份 schema」是差异（各厂商 wire 格式）。第 17 节会系统性地展开这类对照。

### 1.6 `types.ts`：给 OpenAI SDK 类型「打补丁」，塞进非官方的 `reasoning_content`

在精讲累积器之前，先补一个前置知识——1.3/1.4 反复出现的那个 `reasoning_content` 字段，**在 OpenAI 官方 SDK 的类型里根本不存在**。它是 DeepSeek-R1、GLM、Qwen 等「OpenAI 兼容但带思考链」的厂商**扩展出来的字段**。要在 TypeScript 里合法地读写它，就得给 SDK 类型「打补丁」——这就是 [types.ts](../../src/community/openai/types.ts)（29 行）的全部使命：

```ts
export interface OpenAIReasoningFields {
  reasoning_content?: string | null;                                   // ← 补丁字段
}

export type OpenAIAssistantMessageParam = ChatCompletionAssistantMessageParam & OpenAIReasoningFields;
export type OpenAIChatCompletionMessage = ChatCompletionMessage & OpenAIReasoningFields;
export type OpenAIChatCompletionMessageParam = ChatCompletionMessageParam | OpenAIAssistantMessageParam;

export type OpenAIChatCompletionChunk = ChatCompletionChunk & {
  choices: Array<
    ChatCompletionChunk["choices"][number] & {
      delta: ChatCompletionChunk["choices"][number]["delta"] & OpenAIReasoningFields;   // ← 给 delta 也打补丁
    }
  >;
};

export function getReasoningContent(value: OpenAIReasoningFields): string | undefined {
  const reasoning = value.reasoning_content;
  return typeof reasoning === "string" ? reasoning : undefined;
}
```

**逐块看这个「打补丁」的手法：**

- **`OpenAIReasoningFields`**：定义一个只含 `reasoning_content` 的小接口。**这是补丁的「核心料」**——把它交叉（`&`）到官方类型上，就给官方类型「加了一个字段」。
- **`... & OpenAIReasoningFields`（交叉类型）**：TypeScript 的**交叉类型**是「打补丁」的标准手法——`ChatCompletionMessage & OpenAIReasoningFields` 意思是「一个既满足官方 `ChatCompletionMessage`、又多了 `reasoning_content` 字段的类型」。**它不修改官方类型（那是 node_modules 里的，改不得），而是在外面「叠加」出一个增强版**。三个官方类型（响应消息、请求消息参数、流式 chunk）各叠加一份。
- **给 `chunk.choices[].delta` 深度打补丁**：`OpenAIChatCompletionChunk` 那段最绕——它要深入到 `chunk → choices[] → delta` 这一层去叠加 `reasoning_content`，因为**流式的思考链是逐字出现在每个 chunk 的 delta 里的**（1.7 的累积器要从 `delta.reasoning_content` 里读）。这种「深度改写嵌套类型某一层」是 TS 类型体操的典型场景。
- **`getReasoningContent` 守卫函数**：一个小工具，安全地从「带补丁字段的对象」里取出 reasoning——`reasoning_content` 可能是 `string | null | undefined`，这个函数用 `typeof === "string"` 归一成 `string | undefined`，**过滤掉 `null`**。1.7 的累积器里 `const reasoning = getReasoningContent(delta)` 就是它。

> 💡 **为什么要专门开一个 `types.ts` 打补丁，而不是到处 `as any`？** 因为 `reasoning_content` 是一个**贯穿多处**的字段（出站要写、入站要读、流式要累积），如果每处都用 `as any` 强转，就会**丢掉类型安全、且散落各地**。集中在 `types.ts` 里用交叉类型「一次性、类型安全地」补好，其余文件 `import` 这些增强类型即可——**既保住了类型检查（写错字段名 TS 会报错），又把「SDK 类型不全」这个现实的处理收敛到一个文件**。这是「面对第三方类型缺陷时，如何优雅地扩展而非破坏」的一个范本。（Q3 会深入「为什么容忍这个非标准字段」。）

### 1.7 `StreamAccumulator`：把「增量碎片」拼成「完整快照」（本节核心）

终于到本节的**绝对核心**——[stream-utils.ts](../../src/community/openai/stream-utils.ts) 的 `StreamAccumulator`。它就是 [第 3 节](./03-model.md) 说的「把增量拼接的复杂度收敛进 provider 内部」的那个「累积器」。我们逐块拆透。

先看**状态四件套**（[L18-L22](../../src/community/openai/stream-utils.ts#L18-L22)）：

```ts
export class StreamAccumulator {
  private reasoningContent = "";                                              // ① 思考链：拼接中
  private textContent = "";                                                   // ② 正文：拼接中
  private toolCalls = new Map<number, { id: string; name: string; arguments: string }>();  // ③ 工具调用：按 index 归组
  private usage: TokenUsage | undefined;                                      // ④ 用量：到了就代表流结束
  // push / snapshot ...
}
```

**这四个字段就是「一条流式消息的可变状态」**：`reasoningContent`/`textContent` 是两个「越拼越长」的字符串；`toolCalls` 是一个 **`Map<index, {id, name, arguments}>`**（按 OpenAI 给的 `index` 归组，因为一个 chunk 里可能同时推进多个工具调用的碎片）；`usage` 是个「哨兵」——**它一旦有值，就代表流结束了**（1.2 讲过，靠 `stream_options: { include_usage: true }` 换来的那个末尾 chunk）。

**核心方法一：`push(chunk)` —— 把一个碎片「累加」进状态**（[L24-L58](../../src/community/openai/stream-utils.ts#L24-L58)）：

```ts
push(chunk: OpenAIChatCompletionChunk): void {
  const delta = chunk.choices[0]?.delta;
  if (delta) {
    // 思考链：累加
    const reasoning = getReasoningContent(delta);
    if (reasoning) this.reasoningContent += reasoning;

    // 正文：累加
    if (typeof delta.content === "string") this.textContent += delta.content;

    // 工具调用：按 index 归组，各字段分别累加
    if (delta.tool_calls) {
      for (const tc of delta.tool_calls) {
        let entry = this.toolCalls.get(tc.index);
        if (!entry) {
          entry = { id: tc.id ?? "", name: tc.function?.name ?? "", arguments: "" };
          this.toolCalls.set(tc.index, entry);
        }
        if (tc.id) entry.id = tc.id;
        if (tc.function?.name) entry.name = tc.function.name;
        if (tc.function?.arguments) entry.arguments += tc.function.arguments;   // ← 关键：参数字符串「续接」
      }
    }
  }
  // 用量：到达即记录（这一 chunk 的 choices 通常为空）
  if (chunk.usage) this.usage = toTokenUsage(chunk.usage);
}
```

**`push` 的精髓在于「三种内容各有各的累加方式」：**

- **思考链、正文：字符串 `+=`**。最简单——每个 chunk 带来一小段，直接续到已有字符串后面。`getReasoningContent(delta)`（1.6 的守卫）安全取出思考碎片。
- **工具调用：先按 `index` 找到（或新建）entry，再分字段累加**。**这是最烧脑的一处**。OpenAI 流式的工具调用碎片是这样来的：第一个 chunk 给 `{ index: 0, id: "call_1", function: { name: "bash", arguments: "" } }`（id 和 name 齐了，但 arguments 是空的），后续 chunk 只给 `{ index: 0, function: { arguments: '{"comm' } }`、`{ index: 0, function: { arguments: 'and":"ls"}' } }`……**参数 JSON 是一个字符一个字符（其实是一小段一小段）流过来的！** 所以：
  - `id`、`name` 是「来了就覆盖」（`if (tc.id) entry.id = tc.id`）——它们通常只在第一个碎片里出现一次。
  - `arguments` 是「**续接**」（`entry.arguments += tc.function.arguments`）——把一段段的 JSON 文本拼起来，直到某一刻拼成一个完整的 `{"command":"ls"}`。
  - 用 `Map<index>` 归组，是因为模型可能**并行发起多个工具调用**（第 6 节的并行工具在流式层的体现）——`index: 0` 是第一个工具、`index: 1` 是第二个，各自的碎片靠 index 对号入座、互不串味。

（测试 [L46-L96](../../src/community/openai/__tests__/stream-utils.test.ts#L46-L96) 精确验证了「`arguments` 分三个 chunk 拼成 `{"command":"ls"}`」，[L178-L213](../../src/community/openai/__tests__/stream-utils.test.ts#L178-L213) 验证了「两个工具调用按 index 保序」。）

**核心方法二：`snapshot()` —— 把当前状态「导出」成一份完整快照**（[L60-L97](../../src/community/openai/stream-utils.ts#L60-L97)）。**这里藏着本节 roadmap 点名的那个最严谨的设计**：

```ts
snapshot(): AssistantMessage {
  const content: AssistantMessageContent = [];
  if (this.reasoningContent) content.push({ type: "thinking", thinking: this.reasoningContent });
  if (this.textContent) content.push({ type: "text", text: this.textContent });

  const sorted = [...this.toolCalls.entries()].sort((a, b) => a[0] - b[0]);   // ← 按 index 排序，保序
  const isFinal = this.usage !== undefined;                                   // ← usage 到了 = 流结束
  for (const [, tc] of sorted) {
    let input: Record<string, unknown> = {};
    let parsed = false;
    try {
      input = JSON.parse(tc.arguments);   // ← 尝试解析累积到现在的参数 JSON
      parsed = true;
    } catch {
      // arguments JSON is still streaming — fall through
    }
    // 关键三行：流式中途，参数没解析成功，就「先不吐这个 tool_use」
    if (!parsed && !isFinal) continue;
    content.push({ type: "tool_use", id: tc.id, name: tc.name, input });
  }

  return {
    role: "assistant",
    content,
    usage: this.usage,
    ...(this.usage ? {} : { streaming: true }),   // ← 没 usage 就打 streaming: true
  };
}
```

**这段代码有三个必须停下来品的设计：**

**（a）「参数没解析成功前，绝不吐出 tool_use」——本节最见功力的一处严谨**。看那三行：

```ts
if (!parsed && !isFinal) continue;   // 没解析成功 且 还在流式中 → 跳过这个 tool_use
content.push({ type: "tool_use", ... });
```

**这是什么意思？** 流式过程中，某个工具调用的 `arguments` 可能才拼到 `{"command`（半个 JSON）——`JSON.parse` 会抛错，`parsed = false`。此时如果贸然吐出一个 `tool_use`，它的 `input` 就是个空对象 `{}`（甚至是残缺的）。**下游消费者（[第 6 节](./06-parallel-tools.md) 的并行工具调度、[第 5 节](./05-react-loop.md) 的进度事件）如果拿到这个「半成品 tool_use」，就可能拿着残缺参数去执行工具——灾难。** 所以这里的策略是：**只要还在流式中（`!isFinal`）且参数还没解析成功（`!parsed`），就 `continue` 跳过它，这一帧快照里干脆不包含这个 tool_use。** 等后续 chunk 把 JSON 拼完整、`JSON.parse` 成功了，下一帧快照才让它「现身」。

> **这就是 roadmap 说的「参数没解析成功前，绝不吐出 tool_use」的严谨。** 它保证了一条铁律：**下游任何时候观察到的 tool_use，其 input 一定是完整、合法的**。宁可「暂时看不到这个工具调用」，也绝不「给你一个参数残缺的工具调用」。测试 [L98-L117](../../src/community/openai/__tests__/stream-utils.test.ts#L98-L117) 专门验证了这一点——一个 arguments 为 `'{"command'`（残缺）的 chunk，`snapshot().content` 长度为 **0**（tool_use 被扣下了）。

**（b）`isFinal` 的兜底：流结束时，即使 JSON 还残缺也要吐出**。看那个 `!isFinal` 条件——**它是「扣留」的例外**。如果流已经结束了（`usage` 到了，`isFinal === true`），但某个工具调用的 arguments 竟然还是残缺的（模型输出被截断、或厂商 bug），此时**不能再无限扣留**——否则这个 tool_use 就永远消失了。所以最终快照里，`!parsed && !isFinal` 为假（因为 `isFinal` 真），`continue` 不执行，它带着「兜底的空对象 `input = {}`」被吐出。**这是「尽力而为」的收尾：流式中途从严（宁缺毋滥），流终从宽（有总比没有强）——避免「合法的工具调用因末尾解析失败而彻底丢失」。** 测试 [L119-L153](../../src/community/openai/__tests__/stream-utils.test.ts#L119-L153) 验证了这个兜底：同样残缺的 arguments，加上一个带 usage 的末尾 chunk 后，tool_use **出现了**，且 `input: {}`。

**（c）`streaming` 标记的「有无 usage」判据**：`...(this.usage ? {} : { streaming: true })`——**没有 usage 就打 `streaming: true`，有 usage 就不打**。这精确兑现了 [第 3 节](./03-model.md) 的约定：「provider 在流式快照上打标、终态摘除」。因为 `usage` 只在最后一个 chunk 到达，所以「usage 有没有」天然就是「流结束没结束」的信号——中途的快照都 `streaming: true`（让 [第 5 节](./05-react-loop.md) 的 `_think` 发进度事件、TUI 转圈），最后一帧因为有了 usage 就不带 streaming（`_think` 据此知道「这是终态」）。**一个字段，两用：既是 token 统计，又是流终止的哨兵。** 测试 [L155-L176](../../src/community/openai/__tests__/stream-utils.test.ts#L155-L176) 验证了「末尾 chunk 带 usage 后 `streaming` 变 undefined」。

**顺带看排序**：`toolCalls.entries()` 是 Map，遍历顺序理论上按插入序，但代码仍显式 `.sort((a, b) => a[0] - b[0])` 按 index 升序排——**保证 tool_use 在快照里的顺序永远和模型意图的 index 顺序一致**（第一个工具在前、第二个在后），不依赖 Map 的遍历顺序这种「实现细节」。这是「不依赖不保证的行为」的防御性编程。

> 💡 **`StreamAccumulator` 为什么是本节核心？** 因为它一个人扛下了「流式」带来的**全部复杂度**：碎片续接（`+=`）、多工具按 index 归组、半个 JSON 的容错解析、「参数没齐不吐 tool_use」的严谨、「流终兜底吐出」的收尾、`streaming` 标记的打与摘、usage 作为终止哨兵。**而它对外只暴露两个方法：`push`（喂碎片）和 `snapshot`（要快照）。** 上层（1.2 的 `stream`）只是 `acc.push(chunk); yield acc.snapshot()` 两行——**所有的凶险都被封在这个类里。** 这就是第 3 节「把复杂度收敛到少数几个 provider」那句话的全部重量：它不是一句轻飘飘的架构口号，而是**具体地压在这 98 行代码里**。

### 1.8 装配与全景：一个 provider 如何服务近十家「OpenAI 兼容」厂商

零件都看完了，最后看它**怎么被接进系统**，以及一个「反直觉但极其实用」的事实：**这个 `OpenAIModelProvider` 不只服务 OpenAI，还服务 DeepSeek、Qwen、GLM、Kimi、Minimax、Volcengine 等近十家厂商。**

**先看装配**。回看 [cli/index.tsx L44-L55](../../src/cli/index.tsx#L44-L55)（[第 18 节](./00-roadmap.md) 会讲全貌，这里只看本节相关的分流）：

```ts
let provider: ModelProvider;
if (entry.provider === "anthropic") {
  provider = new AnthropicModelProvider({ baseURL: entry.baseURL, apiKey: entry.APIKey });
} else {
  provider = new OpenAIModelProvider({ baseURL: entry.baseURL, apiKey: entry.APIKey });   // ← 默认走 OpenAI
}
const model = new Model(entry.name, provider, { max_tokens: 16 * 1024, thinking: { type: "enabled" } });
```

**注意那个 `else` 分支**——除了 Anthropic，**其余厂商全部落到 `OpenAIModelProvider`**。为什么能这样？因为它们的 API 都是「**OpenAI 兼容**」的——同样的 `/chat/completions` 端点、同样的请求/响应格式，**只是 `baseURL` 不同**。看 [model-providers.ts](../../src/cli/model-providers.ts) 的注册表就一目了然：

```ts
export const MODEL_PROVIDERS: ModelProviderConfig[] = [
  { label: "Anthropic (Claude)", id: "anthropic", baseURL: "https://api.anthropic.com", providerType: "anthropic" },
  { label: "OpenAI", id: "openai", baseURL: "https://api.openai.com/v1", providerType: "openai" },
  { label: "Qwen (Aliyun)", ..., baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1", providerType: "openai" },
  { label: "DeepSeek ...", ..., baseURL: "https://api.deepseek.com/v1", providerType: "openai" },
  { label: "GLM (Zhipu AI)", ..., baseURL: "https://open.bigmodel.cn/api/paas/v4", providerType: "openai" },
  { label: "Kimi (Moonshot)", ..., baseURL: "https://api.moonshot.cn/v1", providerType: "openai" },
  // ... Minimax、Volcengine、"Other" 全是 providerType: "openai"
];
```

**十一个条目里，只有一个 `providerType: "anthropic"`，其余十个全是 `"openai"`。** 这就解释了 1.2 里那个「毫不设防地原样透传 `baseURL`」的设计——**正因为 `baseURL` 可以随意替换，一个 `OpenAIModelProvider` 才能一鱼多吃**，把 DeepSeek 的 `https://api.deepseek.com/v1`、GLM 的 `https://open.bigmodel.cn/api/paas/v4` 等等统统接进来。**也正是这个「兼容生态」，解释了 1.6 为什么要为 `reasoning_content` 打补丁**——因为 DeepSeek-R1、GLM 这些兼容厂商返回了 OpenAI 官方没有的思考链字段。**「OpenAI 兼容」这四个字，是本节所有设计（原样透传 baseURL、reasoning_content 补丁、温和的默认值）的隐藏动机。**

**再把本节所有零件连成一张「一次流式请求」的全景图：**

```
┌─────────────────────────────────────────────────────────────────────────────────────┐
│  Agent 主循环（第 5 节 _think）: for await (snapshot of model.stream(context)) { ... }  │
└───────────────────────────────────────┬───────────────────────────────────────────────┘
                                         │  Model.stream → provider.stream(params)
                                         ▼
┌─────────────────────────────────────────────────────────────────────────────────────┐
│  OpenAIModelProvider.stream（1.2）                                                     │
│   ① _baseChatCompletionParams:                                                        │
│      · convertToOpenAIMessages(messages) ── 内部 Message → wire（1.3：4 种 role 分路）  │
│      · convertToOpenAITools(tools)       ── Tool → wire（1.5：toJSONSchema）           │
│      · temperature: 0（Coding 默认）+ ...options（可覆盖）                              │
│   ② client.chat.completions.create({ ...params, stream: true,                          │
│                                       stream_options: { include_usage: true } })       │
│   ③ const acc = new StreamAccumulator()                                                 │
│      for await (chunk of response) { acc.push(chunk); yield acc.snapshot(); }           │
└───────────────────────────────────────┬───────────────────────────────────────────────┘
                                         │  每个 chunk 是增量 delta（半个词 / 半个 JSON）
                                         ▼
┌─────────────────────────────────────────────────────────────────────────────────────┐
│  StreamAccumulator（1.7）  —— 把碎片拼成完整快照                                        │
│   push:  reasoningContent += / textContent += / toolCalls[index].arguments += ...      │
│          （usage 到达 = 流结束哨兵）                                                    │
│   snapshot:  组装 content[]；tool_use 的 arguments 尝试 JSON.parse                       │
│          · 流式中途 & 未解析成功 → continue（扣留，绝不吐半成品 tool_use）               │
│          · isFinal（usage 到了）→ 兜底吐出（input={}）                                  │
│          · 无 usage → { streaming: true }；有 usage → 摘除标记                          │
└───────────────────────────────────────┬───────────────────────────────────────────────┘
                                         │  每帧都是「完整快照」AssistantMessage
                                         ▼
        _think: latest = snapshot（第 3 节约定：消费端只需一行覆盖，无需任何拼接）
        · snapshot.streaming → 发 progress 事件（TUI 转圈）
        · 循环自然结束 → latest 即终态完整消息（= invoke 的返回）
```

**一句话总括本节主题**：**`OpenAIModelProvider` 是 [第 3 节](./03-model.md) `ModelProvider` 契约的第一个真实实现，它用一个「薄壳」把两大职责外包出去——「静态翻译」（[utils.ts](../../src/community/openai/utils.ts) 三个纯函数，做内部 `Message` ⇄ OpenAI wire 的双向可逆翻译，兑现第 2 节的「wire vs internal」分界）和「动态累积」（[stream-utils.ts](../../src/community/openai/stream-utils.ts) 的 `StreamAccumulator`，把增量碎片拼成第 3 节约定的「完整快照」，并以「参数没解析成功前绝不吐出 tool_use」的严谨兜住下游）；再靠「`baseURL` 原样透传 + `reasoning_content` 类型补丁」，让这一个 provider 服务了近十家「OpenAI 兼容」厂商。至此，那台从第 5 节就造好、却一直空转的 Agent 机器，终于接上了真实的动力源。**

---

## 2. 亮点与关键设计

明确标注哪些是「妙笔」、哪些是「关键决策」：

1. **【核心妙笔】`StreamAccumulator` 坚持「参数没解析成功前，绝不吐出 tool_use」。** `snapshot()` 里那句 `if (!parsed && !isFinal) continue`——流式中途只要工具参数 JSON 还没拼完整、`JSON.parse` 失败，就把这个 tool_use「扣留」，绝不让下游看到一个 input 残缺的半成品。**这保证了「下游任何时候观察到的 tool_use，其 input 一定完整合法」**，是第 6 节并行工具、第 15 节 `ask_user_question` 那份「拿到的永远是干净工具调用」的底层来源（1.7）。
2. **【核心妙笔】把「流式复杂度」整个封进 `StreamAccumulator`，让上层只需两行。** 碎片续接、多工具按 index 归组、半个 JSON 容错、扣留与兜底、`streaming` 标记的打与摘、usage 作终止哨兵——**七种复杂度全压在 98 行的累积器里**，对外只暴露 `push` / `snapshot`。上层 `stream` 只有 `acc.push(chunk); yield acc.snapshot()`。这是第 3 节「把复杂度收敛到少数几个 provider」的具体兑现（1.2、1.7）。
3. **【关键决策】`invoke` / `stream` 共享 `_baseChatCompletionParams`。** 两个方法的差异只有「流不流」，公共的「翻译消息/工具 + 设默认参数」抽成一个私有方法，既 DRY 又让两个入口的差异一目了然（1.2）。
4. **【妙笔】出入翻译「成对镜像」，保证 round-trip 一致。** `convertToOpenAIMessages`（出：`JSON.stringify(input)`、thinking→reasoning_content）与 `parseAssistantMessage`（入：`JSON.parse(arguments)`、reasoning_content→thinking）互为逆操作——**这是多轮对话不「串味」的前提**：本轮产出的消息翻译成 wire、下轮作为历史再翻译回来，语义必须等价（1.3、1.4）。
5. **【关键决策】`temperature: 0` 作为 Coding 场景的默认值，且可被 `options` 覆盖。** `...options` 放在 `temperature: 0` 之后，用「后者覆盖前者」让用户能改。默认 `0` 是因为 Coding 任务追求**确定性、可复现**，而非创造性（1.2，Q5 深入）。
6. **【妙笔】`usage` 一字段两用：既是 token 统计，又是「流结束」哨兵。** 靠 `stream_options: { include_usage: true }` 让 OpenAI 在流末补一个带 usage 的 chunk；累积器用 `isFinal = usage !== undefined` 判断流是否结束，进而决定「扣留还是兜底吐出 tool_use」「打不打 streaming 标记」。一个信号，驱动了两处关键分支（1.2、1.7）。
7. **【关键决策】`types.ts` 用交叉类型给 SDK「打补丁」，而非到处 `as any`。** `reasoning_content` 是官方 SDK 类型没有、但兼容厂商常返回的字段。用 `官方类型 & OpenAIReasoningFields` 集中、类型安全地补好，其余文件 import 增强类型即可——保住类型检查，又把「SDK 类型不全」的处理收敛到一个文件（1.6，Q3）。
8. **【妙笔】`baseURL` 原样透传，让一个 provider 服务近十家「OpenAI 兼容」厂商。** DeepSeek、Qwen、GLM、Kimi、Minimax、Volcengine…… 都是「换个 `baseURL` 的 OpenAI API」。1.2 那个「毫不设防的透传」在 1.8 兑现成巨大的复用红利——注册表里十一家有十家走这一个 provider（1.8）。
9. **【一致性】出站翻译的「难度阶梯」印证第 2 节的设计意图。** `system`/`user` 零翻译（格式天生贴近 wire）、`tool` 一拆多、`assistant` 最难（三段拆三字段 + 对象转字符串 + 空数组归一）——翻译成本被有意分配到「只写一次的 provider」，换取无数消费点的便利（1.3）。

---

## 3. 工业对比

对比业界方案的做法与优缺点。

### 3.1 「provider 内部累积、对外给完整快照」 vs OpenAI SDK 原生的 `stream()`

OpenAI 官方 SDK 其实提供了两种流式 API，值得和本节的选择对比：

- **底层 `chat.completions.create({ stream: true })`**（本节用的）：返回一个 `chunk` 迭代器，**每个 chunk 是增量 delta**，消费方**必须自己累加**（自己拼 `arguments`、自己判断 tool-call 完整性）。这是「原始流」。
- **高层 `chat.completions.stream()`**（SDK 的便利封装）：SDK 内部帮你累加，还提供 `.on('content', ...)`、`.finalChatCompletion()` 等事件/方法。

**Helixent 选了底层 API + 自己写 `StreamAccumulator`，而没用 SDK 的高层封装。为什么？**

- **要产出的是内部 `AssistantMessage`，不是 OpenAI 的 `ChatCompletion`**。SDK 高层封装帮你累加出的是**OpenAI 格式**的完整对象，Helixent 还得再翻译一道。而自己写累积器，可以**边累加边直接产出内部格式的快照**——少一层转换。
- **「参数没齐不吐 tool_use」这类严谨，SDK 高层封装未必替你做**。SDK 累加出的 tool-call，中途可能就带着半个 `arguments`。Helixent 要的是「下游永远只看到合法 tool_use」，这个策略**必须自己掌控**（1.7）。
- **要兼容近十家「OpenAI 兼容」厂商**（1.8）。这些厂商的高层封装行为可能和官方 SDK 不一致（比如 `reasoning_content` 字段、usage 的返回时机），**用底层 API 自己累加，行为最可控、最不依赖 SDK 的「贴心封装」**。

**取舍**：用 SDK 高层封装**更省事**（少写一个累积器），但**受制于 SDK 的行为、且产出的是 wire 格式**；自己写累积器**要多写 98 行**，但**换来对「产出格式、严谨策略、多厂商兼容」的完全掌控**。对一个「要接多家厂商、且对 tool_use 完整性有强要求」的框架，自己写是更稳的选择。

### 3.2 「完整快照」流式约定 vs LangChain 的 `AIMessageChunk` 增量

LangChain 的流式（`.stream()`）吐给消费方的是 `AIMessageChunk`——**增量块**，消费方要用 `concat` 自己累加（`chunk1.concat(chunk2)`）。这和 OpenAI 原生流一样，是「delta 语义」。

**对比 Helixent 的「完整快照」语义**（第 3 节的核心约定）：

- **LangChain / OpenAI 原生**：对外吐 **delta**，**每个消费者**都要实现「累加 + 判断完整性」。消费点越多，重复的累加逻辑越多，出 bug 的面越大。
- **Helixent**：在 provider 内部（`StreamAccumulator`）累加一次，对外只吐**完整快照**。消费者（`_think`）只需 `latest = snapshot` 一行。

**取舍**（第 3 节 Q3 已论证，这里从「本节实现」角度再看）：Helixent 的「快照」语义把复杂度**集中到 provider**——代价是每个 provider（第 16、17 节）都要写一个累积器；收益是**每一个消费点都极简**。**关键洞察是「消费点多、provider 少」**——把复杂度放在「少」的一侧（provider），是这个取舍成立的前提。LangChain 面向的是「通用编排」，消费方式千变万化，它选择把累加能力做成 `AIMessageChunk.concat` 这个「通用工具」交给用户；Helixent 面向的是「自己那个固定的 Agent 循环」，消费点可控，于是选择在源头就吐好完整快照。**两者的选择都符合各自的定位。**

### 3.3 「一个 OpenAI 兼容 provider 服务多家」 vs LiteLLM / OpenRouter 的「统一网关」

「让一份代码对接多家 LLM 厂商」是业界的普遍需求，主流方案有几种：

- **LiteLLM / OpenRouter（统一网关/SDK）**：提供一个「统一 API」，内部把请求翻译成各家厂商的原生格式。你对着一个接口写代码，它帮你适配 100+ 家。
- **Helixent 的做法**：**不做统一网关**，而是「**为每种 wire 协议写一个 provider**」——OpenAI 一个、Anthropic 一个。而「OpenAI 兼容」的厂商（DeepSeek/Qwen/GLM…）因为**共享 OpenAI 的 wire 协议**，天然复用 `OpenAIModelProvider`，只换 `baseURL`（1.8）。

**取舍**：LiteLLM 那种统一网关**覆盖面广**（100+ 厂商），但**多一层抽象/依赖**，且「统一 API」往往要迁就「最小公倍数」，损失各家的特色能力。Helixent 的「一协议一 provider」**覆盖面窄**（就 OpenAI-wire 和 Anthropic-wire 两大阵营），但**没有额外依赖、每个 provider 都能吃透该协议的特色**（比如 `reasoning_content`）。**对一个「教学样本 + 精简工具」，Helixent 的选择更符合它「代码量小、分层干净」的气质**——它不追求「对接一切」，而是「把两大主流协议吃透，并让兼容生态自然复用」。**这也是一个重要认知：所谓「支持很多模型」，很多时候不是「写很多 provider」，而是「利用好『OpenAI 兼容』这个事实标准」。**

### 3.4 `reasoning_content` 补丁 vs 官方「标准化 reasoning」的缺位

「模型思考链（reasoning / thinking）」是 2024–2025 年才普及的能力，**至今没有一个跨厂商的标准字段**：

- **OpenAI 官方**：o 系列的 reasoning 在 API 上是**不透明**的（你拿不到思考过程原文，只有 token 计数）。
- **DeepSeek-R1 / GLM 等**：把思考链放在一个**非官方**的 `reasoning_content` 字段里返回。
- **Anthropic**：用 `thinking` 内容块 + `signature`（第 17 节会讲）。

**Helixent 的 `types.ts` 补丁（1.6）正是「标准缺位」下的务实应对**——它承认「`reasoning_content` 不是官方标准，但它事实上存在于我要对接的兼容厂商里」，于是用交叉类型把它「合法化」。**这是一个很真实的工程处境：标准滞后于能力，框架必须在『等标准』和『先支持起来』之间选择，Helixent 选了后者**。代价是这个字段有朝一日若被官方标准取代，`types.ts` 要跟着改；但收益是**今天就能用上国产思考链模型**。**这类「补丁」是所有『适配层』的宿命——它们注定要吸收上游的不规整，好让核心层保持干净**（呼应第 1 节：`community` 层作为「可插拔适配器隔离第三方 SDK」，脏活烂活都留在这一层）。

### 3.5 一览表

| 维度                 | Helixent OpenAI Provider               | OpenAI SDK 高层`stream()` | LangChain                          | LiteLLM/OpenRouter |
| -------------------- | -------------------------------------- | --------------------------- | ---------------------------------- | ------------------ |
| 流式对外语义         | **完整快照**（provider 内累积）  | 累积后的**wire 对象** | **增量 chunk**（`concat`） | 视底层而定         |
| tool-call 完整性保证 | **参数没解析成功不吐出**         | SDK 行为，未必保证          | 消费方自理                         | 网关行为           |
| 多厂商策略           | **一协议一 provider + 兼容复用** | 单一 OpenAI                 | 各家 integration                   | **统一网关** |
| 思考链处理           | `reasoning_content` 类型补丁         | 官方不透明                  | 各 integration 各异                | 网关归一           |
| 额外依赖             | 仅官方`openai` SDK                   | 官方 SDK                    | LangChain 全家桶                   | LiteLLM/网关       |
| 代码量               | **极小（五个文件）**             | —                          | 大                                 | 中（含网关）       |

---

## 4. 深度解释：为什么这样设计？不这样会怎样？

用 Q&A 形式讲清几个「为什么」，以及「不这样会出什么问题」。

### Q1：`StreamAccumulator` 为什么非要「参数没解析成功就不吐 tool_use」？吐一个 input 为空的占位、后面再补全不行吗？

**不行——因为下游消费者（尤其是 [第 6 节](./06-parallel-tools.md) 的并行工具调度）一旦看到一个 tool_use，就可能立刻拿它去执行，而一个 input 残缺的 tool_use 会导致「拿着错误参数跑工具」这种灾难性后果。**

先想清楚「吐半成品」会发生什么。假设累积器在流式中途吐出一个 `{ type: "tool_use", name: "bash", input: {} }`（参数还没拼完，先给个空对象占位）。下游有两类消费者会立刻遭殃：

1. **进度渲染（[第 5 节](./05-react-loop.md) 的 `_deriveProgress`）**：它会从快照里 `filter` 出 tool_use 来显示「正在调用 bash」。如果这个 tool_use 一会儿有、一会儿没有（因为 input 补全后又变了），或者显示出一个「参数为空的 bash」，**UI 就会闪烁、显示错误信息**。
2. **更致命——如果快照被当作「终态」误用**：虽然正常流程里 `_think` 只在流结束后才用 `latest` 执行工具，但「累积器对外的每一帧快照都应该是自洽的」是一条更强的保证。**如果某一帧快照里有个 `input: {}` 的 `bash`，任何『拿到快照就执行』的代码路径都会用空参数去跑 bash**——轻则报错，重则跑出预期外的命令。

**「宁缺毋滥」的策略从根本上消除了这个风险**：一个 tool_use 要么**不出现**（参数还没齐），要么**带着完整合法的 input 出现**（`JSON.parse` 成功了）。下游永远不会看到「参数残缺的中间态」。**这就是 1.7 那句「保证下游任何时候观察到的 tool_use，其 input 一定完整合法」的分量**——它把「流式的不确定性」挡在了累积器内部，让上层可以「一看到 tool_use 就放心地信任它」。

**那「吐空占位、后面补全」为什么诱人却错误？** 因为它假设「所有下游都会耐心等补全」。但事件驱动系统里，**你无法保证下游不会在『补全前』就对某一帧快照采取行动**。**「让每一帧快照都自洽、合法」远比「吐出去再打补丁」健壮**——这是「不变量（invariant）优先」的设计哲学：与其让消费者处理「可能残缺」的数据，不如在源头保证「永远完整」。

### Q2：既然流式中途会「扣留」tool_use，为什么流结束时（`isFinal`）又要「兜底吐出」一个 input 为空的？这不是自相矛盾吗？

**不矛盾——这是「两个阶段、两种风险权衡」的精准区分：流式中途的风险是『过早暴露半成品』，流结束时的风险是『合法调用彻底丢失』，两者的最优策略恰好相反。**

把两个阶段摆在一起看：

| 阶段               | 判据                       | 若参数 JSON 没解析成功               | 主要风险                          | 最优策略             |
| ------------------ | -------------------------- | ------------------------------------ | --------------------------------- | -------------------- |
| **流式中途** | `!isFinal`（usage 未到） | **扣留**（`continue`）       | 过早暴露残缺 tool_use → 下游误用 | 宁缺毋滥（等它拼完） |
| **流已结束** | `isFinal`（usage 到了）  | **兜底吐出**（`input = {}`） | 合法工具调用彻底消失              | 有总比没有强         |

**流式中途「扣留」的逻辑**（Q1 已讲）：反正流还没完，这个工具调用的参数**下一帧很可能就拼齐了**，此刻扣留它零成本——等它 `JSON.parse` 成功，下一帧自然让它现身。**「等得起」是中途扣留的前提。**

**流结束「兜底」的逻辑**：`usage` 到了意味着**再也没有后续 chunk 了**。如果此刻某个工具调用的 `arguments` 仍然残缺（可能是模型输出被 `max_tokens` 截断、或厂商传输 bug），**再扣留就等于永久丢弃它**——它承载的信息（模型「想调 bash」这个意图、以及那个 `id`）就彻底消失了。**此时「吐出一个 input 为空的 tool_use」是两害相权取其轻**：至少保留了「模型想调用某工具」这个事实和 `id`，下游（比如工具执行层）可以对着空参数报一个「参数无效」的错误，模型下一轮能据此重试——**这远好于「工具调用凭空消失，模型和用户都不知道发生了什么」**。

**「不这样会怎样」**：假设流结束也一律扣留残缺 tool_use。那么一旦模型输出在「工具参数传到一半」时被截断，**这个工具调用就人间蒸发**——Agent 循环会以为「模型这轮没调工具」，可能直接终止（第 5 节的「无工具调用即停机」），或者陷入「模型明明想做事却什么都没发生」的诡异状态。**兜底吐出让这个失败『显式化』**（变成一个可观察、可报错、可重试的空参数调用），而非『静默丢失』。**「显式的失败」永远优于「静默的消失」——这是健壮系统的通则**，兜底逻辑正是它的体现。

### Q3：`reasoning_content` 是个非官方字段，`types.ts` 还专门为它打补丁——这不是把「不标准的东西」固化进代码了吗？为什么值得？

**值得——因为 `community` 层的职责恰恰就是『吸收厂商的不规整』，好让上面的 Foundation/Agent 层保持干净。把不标准的东西挡在适配层，正是分层架构的目的。**

先承认这个「不干净」的事实：`reasoning_content` 确实不是 OpenAI 官方标准（官方 o 系列的 reasoning 是不透明的），它是 DeepSeek-R1、GLM、Qwen 等兼容厂商的扩展。为它打补丁，等于把一个「事实标准、但非官方」的字段固化进了代码。**但关键问题不是「它标不标准」，而是「这个不标准，应该由哪一层来吸收」。**

**回看 [第 1 节](./01-overview.md) 的分层原则**：`community` 层被定位为「**可插拔适配器，隔离第三方 SDK**」。它存在的全部意义，就是当「上游厂商的现实」和「Helixent 内部的理想模型」之间有落差时，**由它来当『缓冲垫』**——把厂商的 `reasoning_content`（不规整的现实）翻译成内部统一的 `{ type: "thinking" }`（干净的理想）。**这样一来：**

- **Foundation 层的 `ThinkingContent` 保持纯净**——它只知道「有一种内容叫 thinking」，完全不知道 `reasoning_content` 这个厂商细节的存在。
- **Agent 层、CLI 层更是毫不知情**——它们消费的永远是内部 `{ type: "thinking" }`，无论底层接的是 DeepSeek 还是 Claude。
- **「不干净」被精确地隔离在 `src/community/openai/` 这一个目录里**——将来 `reasoning_content` 若被官方标准取代，只需改这里，上层一行都不用动。

**「不这样会怎样」**：假设不打补丁，而是让上层直接处理 `reasoning_content`。那么「思考链字段叫什么」这个厂商细节就会**泄漏**到 Agent 层甚至 UI 层——每个用到思考链的地方都得知道「OpenAI 兼容厂商叫 reasoning_content、Anthropic 叫 thinking block」。**一旦某个厂商改字段名，整个上层都要跟着改**。这正是分层要极力避免的「细节泄漏」。**所以 `types.ts` 的补丁不是『把脏东西固化进代码』，而是『把脏东西精确地关进它该待的房间（community 层）』**——这恰恰是分层架构最想要的效果。**判断一个『补丁/hack』该不该存在，关键看它有没有被限制在正确的层里**：关在适配层的 hack 是「负责任的适配」，泄漏到核心层的 hack 才是「技术债」。

### Q4：为什么 `invoke` 和 `stream` 要各写一遍调 SDK 的逻辑？既然「`stream` 的最后一帧等价于 `invoke`」，让 `invoke` 内部跑一遍 `stream` 取最后一帧不就省了？

**理论上能省，但实践中不划算——因为『非流式』和『流式』是 OpenAI API 两种不同的调用，各有各的最优路径，强行让 invoke 复用 stream 会带来性能损耗和语义混淆。**

先确认「能不能这么写」：确实可以。`invoke` 可以写成「跑一遍 `this.stream(params)`，`for await` 到最后拿 `latest` 返回」。第 3 节也确实保证了「`stream` 的最后一帧 === `invoke` 的返回」。**但这么做有三个实际代价：**

1. **性能与开销**：非流式的 `chat.completions.create()`（不带 `stream: true`）是**一次请求、一次响应**，OpenAI 服务端可以做整体优化。而流式是 **SSE 长连接、逐块推送**，客户端要处理几十上百个 chunk、跑几十上百次 `acc.push` + `snapshot`。**用「流式」去实现「我只要最终结果」，等于为了拿一个苹果租了一整条流水线**——`invoke` 的场景（批处理、评测，第 3 节 Q5 提过）恰恰是「不需要中间态、只要终态」的，用非流式最直接、最省。
2. **语义清晰**：`invoke` 调 `create(params)`、`stream` 调 `create({ ...params, stream: true })`——**两者的差异在代码里一目了然**（差一个 `stream: true` 和 `stream_options`）。读代码的人立刻明白「哦，一个非流一个流」。若 `invoke` 内部绕一圈 `stream`，反而**藏起了「invoke 本可以走更直接的非流式 API」这个事实**。
3. **它们本就共享了该共享的部分**：注意 `invoke` 和 `stream` **已经共享了 `_baseChatCompletionParams`**（1.2）——即「翻译消息、翻译工具、设默认参数」这些**真正重复**的逻辑。剩下没共享的，只是「调不调 stream、怎么处理响应」——**而这部分本就应该不同**（一个 `parseAssistantMessage(response)`，一个 `StreamAccumulator` 循环）。**DRY 要消除的是『真正重复的知识』，而 invoke/stream 剩下的差异恰恰是『本质不同的知识』**，不该强行合并。

**「不这样（强行复用）会怎样」**：`invoke` 会平白背上「流式的全部开销」，且丧失「走非流式 API」的能力；代码里「流与非流」的清晰对立会被一层不必要的间接性糊住。**所以这里的『看似重复』是恰当的**——它们共享了该共享的（参数构建），区分了该区分的（流式处理）。**这与 [第 15 节 Q4](./15-human-in-the-loop.md) 「两个 Manager 95% 相同却不抽基类」是同一种判断：DRY 的对象是『知识』不是『代码行』。** invoke/stream 的调用逻辑看着像，实则是「非流式」和「流式」两种不同的知识，分开写反而更清晰。

### Q5：`temperature: 0` 凭什么是个好默认？万一用户就是想要有创造性的输出呢？

**因为这是一个 Coding Agent，而『写代码、跑命令』的绝大多数场景都追求确定性与可复现；同时这个默认『可被 options 覆盖』，想要创造性的用户随时能改。默认值的艺术是『照顾多数、不挡少数』。**

先说「为什么 `0` 是好默认」。`temperature` 控制模型输出的随机性：越高越发散（适合头脑风暴、写诗），越低越确定（同样输入趋向同样输出）。**对 Coding Agent 而言：**

- **它的任务是「读文件、改代码、调工具」**——这些是**有正确答案、要求精确**的操作。你不希望「同一个 bug，模型今天这么修、明天那么修」，更不希望它「创造性地」发明一个不存在的 API。
- **可复现性对调试至关重要**——`temperature: 0` 让「同样的对话历史 → 同样的下一步」尽可能成立，这让「为什么 Agent 上次那么做」变得可追溯、可复现。**对一个要跑测试、要排查行为的工具，确定性是刚需。**
- **工具调用尤其需要稳定**——模型要产出结构化的、参数合法的 tool_use（1.7 那么费劲就为了保证这个）。低 temperature 减少「模型把参数名拼错、把 JSON 格式写歪」的概率。

**再说「为什么不怕挡住想要创造性的用户」**：回看 1.2 的 `{ temperature: 0, ...options }`——`...options` 在后，**用户传入的 `options.temperature` 会覆盖默认的 `0`**。想写有创意的文档、想让模型发散一下？在配置里设个 `temperature: 0.7` 即可。**默认值只是「不配置时的合理起点」，从不剥夺用户的选择权。**

**「不这样（比如默认 0.7 或不设）会怎样」**：如果默认一个较高的 temperature，那么**开箱即用的体验就是「不稳定」**——新用户第一次跑，可能就撞见「模型乱调工具、参数出错」，会觉得「这 Agent 不靠谱」。**而 Coding 场景下，『稳定』是比『有创意』重要得多的第一印象。** 把「照顾多数场景」设为默认、把「少数特殊需求」交给覆盖机制，是默认值设计的通则。**这也呼应了第 3 节 `Model` 那层的 `options` 设计——默认值定在 provider（照顾 Coding），个性化通过 `options` 逐层透传覆盖，两层配合，既有好开箱体验，又留足灵活性。**

### Q6：本节是 `ModelProvider` 的第一个实现。它为「第 17 节接入 Anthropic」立了哪些「范本」？哪些地方第 17 节会不一样？

**本节立的范本是『provider = 薄壳 + 翻译（utils）+ 累积（stream-utils）』这个三件套结构，以及 invoke/stream 共享参数构建、StreamAccumulator 的 push/snapshot 双方法约定。第 17 节会沿用这个骨架，但在「协议差异」处各处不同。**

**先看第 17 节会「照抄」的范本（契约共性）：**

- **文件结构**：Anthropic 也会有 `model-provider.ts`（薄壳）、`utils.ts`（翻译）、`stream-utils.ts`（累积）、`index.ts`（桶文件）——**一模一样的三件套**。
- **`invoke` / `stream` 的骨架**：同样是「构建参数 → 调 SDK → 翻译/累积」；同样有一个 `_baseMessageParams` 抽取共享参数（对应本节的 `_baseChatCompletionParams`）。
- **`StreamAccumulator` 的对外约定**：同样只暴露 `push(event)` + `snapshot()`；同样用「有没有最终 usage」判断 `streaming` 标记的打与摘；同样在 tool 输入 JSON 没解析成功时给空对象兜底。**这个「累积器接口」是跨 provider 的稳定契约。**

**再看第 17 节会「不一样」的地方（厂商差异）——这些恰是第 17 节的看点：**

- **system prompt 的位置**：OpenAI 把 system 消息**放在 messages 数组里**（1.3 的「原样透传」），而 **Anthropic 要求 system 作为顶层独立参数**——所以 Anthropic 的 utils 有一个 `extractSystemPrompt`（本节没有对应物），把 system 从 messages 里「抽出来」单独放。
- **流式协议的形态**：OpenAI 是「**扁平的 delta**」（`chunk.choices[0].delta`，靠 `index` 归组 tool_calls）；Anthropic 是「**事件序列**」（`message_start` / `content_block_start` / `content_block_delta` / `content_block_stop` / `message_delta`，靠 block index 归组）。**两个 `StreamAccumulator` 因此内部实现迥异**——一个消费扁平 delta，一个是消费带「开始/增量/结束」的状态机式事件。
- **thinking 的处理**：OpenAI 兼容厂商用 `reasoning_content` 字符串（1.6 的补丁）；Anthropic 用 `thinking` 内容块 + 一个 `signature`（多轮对话要回传签名，本节完全没有这个概念）。
- **`baseURL` 的处理**：本节「毫不设防原样透传」（1.2、1.8），而 Anthropic 的构造函数会判断「若等于默认 URL 就不传，让 SDK 自己构造」——**这个差异第 17 节会解释原因**。
- **`thinking.budget_tokens` 的自动推导**、**tools 空数组的处理**等：Anthropic 有一些 OpenAI 没有的参数归一逻辑。

> 💡 **这正是 roadmap 为「先 OpenAI 后 Anthropic」排序的深意**：**先用 OpenAI 立一个「provider 长什么样」的完整范本**，再用 Anthropic 去「对照」——当你看第 17 节时，`model-provider.ts`/`utils.ts`/`stream-utils.ts` 的**骨架**你已经熟悉了，注意力就能全部集中到「**协议差异**」上（system 抽取、事件流累积、signature、budget_tokens）。**第一个实现教你『provider 的共性骨架』，第二个实现教你『厂商的差异所在』——这就是「先范本、后对照」的教学价值**，也印证了 `ModelProvider` 这个抽象的成功：它让「换一家厂商」变成「只改协议差异处，骨架照旧」。

---

## 5. 参考资料

**本节精讲的源码（五个文件）**：

`src/community/openai/`：

- [model-provider.ts](../../src/community/openai/model-provider.ts)（99 行）——`OpenAIModelProvider` 编排壳
  - 构造函数（`baseURL`/`apiKey` 原样透传）：[L24-L29](../../src/community/openai/model-provider.ts#L24-L29)
  - `invoke`（非流式：create → parseAssistantMessage）：[L31-L49](../../src/community/openai/model-provider.ts#L31-L49)
  - `stream`（流式：create + StreamAccumulator 循环）：[L51-L78](../../src/community/openai/model-provider.ts#L51-L78)
  - `_baseChatCompletionParams`（invoke/stream 共享、`temperature: 0`）：[L80-L98](../../src/community/openai/model-provider.ts#L80-L98)
  - `toTokenUsage`（wire→internal 用量映射）：[L9-L16](../../src/community/openai/model-provider.ts#L9-L16)
- [utils.ts](../../src/community/openai/utils.ts)（107 行）——三个静态翻译纯函数
  - `convertToOpenAIMessages`（出：内部→wire，四种 role 分路）：[L16-L63](../../src/community/openai/utils.ts#L16-L63)
  - `parseAssistantMessage`（入：wire→内部，出站的镜像）：[L70-L95](../../src/community/openai/utils.ts#L70-L95)
  - `convertToOpenAITools`（工具：`toJSONSchema()` 调用点）：[L102-L107](../../src/community/openai/utils.ts#L102-L107)
- [stream-utils.ts](../../src/community/openai/stream-utils.ts)（98 行）——`StreamAccumulator` 流式累积器（本节核心）
  - 状态四件套（reasoning/text/toolCalls/usage）：[L18-L22](../../src/community/openai/stream-utils.ts#L18-L22)
  - `push`（碎片累加、tool_calls 按 index 归组、arguments 续接）：[L24-L58](../../src/community/openai/stream-utils.ts#L24-L58)
  - `snapshot`（组装快照、「参数没解析成功不吐 tool_use」、isFinal 兜底、streaming 标记）：[L60-L97](../../src/community/openai/stream-utils.ts#L60-L97)
- [types.ts](../../src/community/openai/types.ts)（29 行）——用交叉类型给 SDK 打补丁，塞入 `reasoning_content`
  - `OpenAIReasoningFields` 与三个增强类型：[L8-L24](../../src/community/openai/types.ts#L8-L24)
  - `getReasoningContent` 守卫：[L26-L29](../../src/community/openai/types.ts#L26-L29)
- [openai/index.ts](../../src/community/openai/index.ts)（1 行）——桶文件，只导出 `model-provider`

**co-located 测试（[第 21 节](./00-roadmap.md) 会讲这套约定）**：

- [utils.test.ts](../../src/community/openai/__tests__/utils.test.ts)——出站四种 role 翻译 / 入站解析 / 工具转换 / 各种边界（空 content、混合内容、一拆多）
- [stream-utils.test.ts](../../src/community/openai/__tests__/stream-utils.test.ts)——文本累加 / reasoning 累加 / tool_calls 跨 chunk 拼接 / **流式扣留残缺 tool_use** / **isFinal 兜底吐出** / usage 捕获 / 多工具保序 / 空 chunk

**上游依赖章节**：

- [第 3 节 · Model 与 ModelProvider](./03-model.md)：本节要实现的 `ModelProvider` 契约（`invoke`/`stream` 一对、「每次 yield 完整快照」、`streaming` 打标与摘除、`usage` 映射）——本节是这份契约的**第一个真实实现**
- [第 2 节 · Message 消息类型系统](./02-message.md)：内部 `Message` 的四种 role 与「wire vs internal」分界（`snake_case` 内容段贴近 OpenAI wire）——本节的翻译逻辑处处以它为前提
- [第 4 节 · Tool 工具系统](./04-tool.md)：`defineTool` 与 `parameters.toJSONSchema()`（`convertToOpenAITools` 是「一处定义、三处受益」中「运行期 JSON Schema」的真实调用点）
- [第 5 节 · ReAct 主循环](./05-react-loop.md)：`_think` 如何消费 `stream`（`latest = snapshot`）、`AbortController` 的 `signal` 透传、`_deriveProgress` 消费流式快照
- [第 6 节 · 并行工具调度](./06-parallel-tools.md)：多个 tool_use 的来源（累积器按 index 归组的对应场景）；「参数没齐不吐 tool_use」正是为了保证它拿到干净的工具调用

**下游承接章节（本节埋的接口）**：

- [第 17 节 · Anthropic Provider](./00-roadmap.md)：`ModelProvider` 的第二个实现，与本节「先范本、后对照」（system 抽取、事件流累积、signature、budget_tokens、baseURL 特殊处理等差异，见 Q6）
- [第 18 节 · CLI 入口、配置与持久化](./00-roadmap.md)：`OpenAIModelProvider` 如何在 `cli/index.tsx` 被实例化、`MODEL_PROVIDERS` 注册表（近十家「OpenAI 兼容」厂商共用本 provider，见 1.8）、`baseURL`/`apiKey` 从配置读入

**关联源码（本节引用但不精讲）**：

- 契约定义：[model-provider.ts](../../src/foundation/models/model-provider.ts)、[model.ts](../../src/foundation/models/model.ts)
- 消费端：[agent.ts `_think` L179-L204](../../src/agent/agent.ts#L179-L204)
- 装配处：[cli/index.tsx L44-L62](../../src/cli/index.tsx#L44-L62)、[model-providers.ts](../../src/cli/model-providers.ts)
- 对照实现：[anthropic/model-provider.ts](../../src/community/anthropic/model-provider.ts)、[anthropic/stream-utils.ts](../../src/community/anthropic/stream-utils.ts)（第 17 节精讲）

**外部资料**：

- OpenAI Chat Completions API（`stream` / `stream_options.include_usage` / `tool_calls`）：[https://platform.openai.com/docs/api-reference/chat/create](https://platform.openai.com/docs/api-reference/chat/create)
- OpenAI Node SDK（`chat.completions.create` 底层流 vs `.stream()` 高层封装，3.1 对比）：[https://github.com/openai/openai-node](https://github.com/openai/openai-node)
- Server-Sent Events（SSE，流式底层传输机制）：[https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events](https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events)
- DeepSeek `reasoning_content` 字段（1.6 补丁的现实来源）：[https://api-docs.deepseek.com/guides/reasoning_model](https://api-docs.deepseek.com/guides/reasoning_model)
- TypeScript 交叉类型（Intersection Types，`types.ts` 打补丁的语言机制）：[https://www.typescriptlang.org/docs/handbook/2/objects.html#intersection-types](https://www.typescriptlang.org/docs/handbook/2/objects.html#intersection-types)
- LiteLLM（统一网关方案，3.3 对比）：[https://github.com/BerriAI/litellm](https://github.com/BerriAI/litellm)

---

## 6. 小结与下一节预告

本节我们拆透了 Helixent 的第一个 `ModelProvider` 实现——**五个文件、一个薄壳、两大职责**：

- **编排壳**：`OpenAIModelProvider` 用 `_baseChatCompletionParams` 让 `invoke`（非流式）和 `stream`（流式）共享参数构建，自己只管「调 SDK + 编排」，把脏活外包给两个可单测的零件（1.2）。
- **职责一·静态翻译**：`utils.ts` 三个纯函数做「内部 `Message` ⇄ OpenAI wire」的**双向可逆翻译**——`convertToOpenAIMessages`（出：四种 role 分路，`system`/`user` 零翻译、`tool` 一拆多、`assistant` 拆三字段 + 对象转字符串）、`parseAssistantMessage`（入：出站的精确镜像）、`convertToOpenAITools`（`toJSONSchema()` 的调用点）。这正是 [第 2 节](./02-message.md)「wire vs internal」分界的兑现（1.3–1.5）。
- **职责二·动态累积**：`StreamAccumulator` 把 OpenAI 的增量碎片拼成 [第 3 节](./03-model.md) 约定的「完整快照」——`push` 累加（tool_calls 按 index 归组、arguments 续接）、`snapshot` 导出，其中**「参数没解析成功前绝不吐出 tool_use」是本节最见功力的严谨**，配合「流终 isFinal 兜底吐出」和「usage 作为 streaming 哨兵」，把流式的全部复杂度封在 98 行里（1.7）。
- **两个配角**：`types.ts` 用交叉类型给 SDK 打补丁、合法化非官方的 `reasoning_content`（1.6）；`index.ts` 桶文件。
- **一个实用红利**：靠「`baseURL` 原样透传」，这一个 provider 服务了 DeepSeek/Qwen/GLM/Kimi/Minimax/Volcengine 等近十家「OpenAI 兼容」厂商（1.8）。

**一条主线**：**`ModelProvider` 契约（第 3 节）+ Message 形状（第 2 节）+ Tool schema（第 4 节）三份上游约定，在本节第一次汇聚成一个能连真实模型的实现**。那台从第 5 节造好、却一直靠 mock 空转的 Agent 机器，到这里终于接上了真实动力源。

**承上启下（启下）**：但请注意，本节只讲了「OpenAI 一家」。虽然它靠「兼容生态」覆盖了近十家厂商，但**世界上还有一大阵营用的是完全不同的 wire 协议——Anthropic（Claude）**。它的 system prompt 不放在 messages 里、它的流式是「事件序列」而非「扁平 delta」、它的思考链带 `signature`、它连 `baseURL` 都要特殊处理（Q6 已剧透）。

**所以下一步是接入第二家厂商**——这是 [第 17 节](./00-roadmap.md) 的任务。有了本节这个「范本」，第 17 节就能清晰地对照出：**哪些是 `ModelProvider` 契约的共性（照抄本节的三件套骨架），哪些是厂商的差异（system 抽取、事件流累积、signature、budget_tokens）**。**「先立范本、后作对照」——第 16 节教你 provider 长什么样，第 17 节教你厂商的差异在哪，两节合起来，你就真正理解了「换一个大模型厂商，Agent 代码一行不改」这句话的全部分量。**

> 预告一个对比：你会在第 17 节看到，Anthropic 的 `StreamAccumulator` 和本节**同名却迥异**——它不消费「扁平 delta」，而是消费一串带「开始 / 增量 / 结束」的**事件**（`content_block_start` / `content_block_delta` / `content_block_stop`），像一台小状态机。但它对外暴露的**依然是** `push` + `snapshot`，依然吐「完整快照」，依然用「usage 到没到」判断 streaming。**接口相同、实现迥异——这正是 `ModelProvider` 这个抽象成功的最好证明。**

👉 下一节 **第 17 节：Anthropic Provider —— 多 Provider 的共性与差异**。

准备好后，对我说「**生成第 17 节**」即可。
