# 第 17 节：Anthropic Provider —— 多 Provider 的共性与差异

> 本节属于 **第五部分 · Community 层（第三方模型适配）**，是这一部分的**收官**，也是整套教程里第一次让你**同时看两个 Provider**、并从对照中总结规律的一节。[第 16 节](./16-openai-provider.md) 立起了 `ModelProvider` 契约的**第一个范本**（`OpenAIModelProvider`），并在结尾反复许诺：「有了范本，第 17 节接入第二家厂商时，就能清晰对照出『哪些是契约共性、哪些是厂商差异』」。**本节就来兑现这个承诺：把 `ModelProvider` 契约落地成第二个实现 `AnthropicModelProvider`，并借这次「二次实现」，把散落在两处的设计规律拎成一条明线——「共性照抄骨架，差异各表一枝」。**
>
> 对应 roadmap 为本节设定的**核心问题**：
>
>> 接入第二个厂商时，哪些能复用、哪些必须定制？两家 API 的差异体现在哪？
>>
>
> **一句边界声明**：本节精讲 **`src/community/anthropic/` 下的四个文件**——注意，是**四个**，比第 16 节的 OpenAI **少了一个 `types.ts`**（这个「缺失」本身就是一处差异，1.6 会解释）：
>
> - **编排壳**：[model-provider.ts](../../src/community/anthropic/model-provider.ts)（88 行，`AnthropicModelProvider` 类，实现 `invoke` / `stream`，含 `baseURL` 谨慎处理与 `budget_tokens` 自动推导）。
> - **静态翻译**：[utils.ts](../../src/community/anthropic/utils.ts)（158 行，四个纯函数：`extractSystemPrompt`（Anthropic 独有）、`convertToAnthropicMessages` 出、`parseAssistantMessage` 入、`convertToAnthropicTools` 工具）。
> - **动态累积**：[stream-utils.ts](../../src/community/anthropic/stream-utils.ts)（157 行，`StreamAccumulator`——**与第 16 节同名，实现却是一台「事件状态机」**，本节的对照重心）。
> - **桶文件**：[anthropic/index.ts](../../src/community/anthropic/index.ts)（1 行，只导出 provider）。
>
> **本节最大的「啊哈时刻」**：两家的 `StreamAccumulator` **同名、同接口（`push` / `snapshot`）、同产出（第 3 节的「完整快照」），内部却是两套完全不同的机器**——OpenAI 消费「扁平 delta」（靠 `index` 把碎片归组），Anthropic 消费「一串带『开始 / 增量 / 结束』的事件」（像一台状态机，靠 `content_block` 事件驱动）。**当你看懂『接口相同、实现迥异』这八个字，你就真正理解了 [第 3 节](./03-model.md) 那句「换一个大模型厂商，Agent 代码一行不改」的全部分量**——因为「不改的那部分」正是被 `ModelProvider` 契约焊死的共性，「要改的那部分」全被关进了 provider 内部。
>
> ⚠️ **一处「诚实标注」**：本节会不断和 [第 16 节](./16-openai-provider.md) 对照，因此**强烈建议先读完第 16 节再读本节**。本节不会重复讲解「什么是快照约定」「什么是 `toJSONSchema()`」这些第 16 节已经讲透的共性机制，而是把笔墨集中在**差异**上。凡是「和 OpenAI 一样」的地方，本节会一句带过并给出第 16 节的链接；凡是「和 OpenAI 不同」的地方，本节会停下来重点剖析——**这正是「先范本、后对照」的读法**。

---

## 0. 承上启下

[第 16 节](./16-openai-provider.md) 在结尾把这个悬念埋得明明白白，几乎是「点名」本节。它的原话是这样的：

> 但请注意，本节只讲了「OpenAI 一家」。虽然它靠「兼容生态」覆盖了近十家厂商，但**世界上还有一大阵营用的是完全不同的 wire 协议——Anthropic（Claude）**。它的 system prompt 不放在 messages 里、它的流式是「事件序列」而非「扁平 delta」、它的思考链带 `signature`、它连 `baseURL` 都要特殊处理。

它还专门为本节的核心零件——`StreamAccumulator`——剧透了一句：

> 你会在第 17 节看到，Anthropic 的 `StreamAccumulator` 和本节**同名却迥异**——它不消费「扁平 delta」，而是消费一串带「开始 / 增量 / 结束」的**事件**（`content_block_start` / `content_block_delta` / `content_block_stop`），像一台小状态机。但它对外暴露的**依然是** `push` + `snapshot`，依然吐「完整快照」，依然用「usage 到没到」判断 streaming。**接口相同、实现迥异——这正是 `ModelProvider` 这个抽象成功的最好证明。**

本节就来兑现这个悬念。而在动手前，请先把**一个总纲**装进脑子——它是本节所有对照的「坐标轴」：

> **一个 `ModelProvider` 的实现 = 一份「共性骨架」+ 一组「厂商差异」。**
>
> - **共性骨架**（照抄第 16 节，由 [第 3 节](./03-model.md) 的契约焊死）：四文件分工（壳 / 翻译 / 累积 / 桶）、`invoke` 走非流式、`stream` 走流式、二者共享一个「参数构建」私有方法、`StreamAccumulator` 只暴露 `push` / `snapshot` 并吐「完整快照」、用「usage 到没到」判断 `streaming` 标记、工具输入 JSON 没解析成功时给 `{}` 兜底。
> - **厂商差异**（本节的看点，源于两家 wire 协议的形态不同）：**① system prompt 的位置**（OpenAI 在 messages 里 / Anthropic 抽成顶层参数）、**② 流式协议的形态**（扁平 delta / 事件序列）、**③ 思考链的载体**（`reasoning_content` 字符串 / `thinking` 块 + `signature`）、**④ `baseURL` 处理**（原样透传 / 等于默认就不传）、**⑤ Anthropic 独有的参数归一**（`max_tokens` 必填默认、`thinking.budget_tokens` 自动推导、空 tools 数组的省略）。

**记住这条坐标轴**：本节接下来的每一小节，都会明确标注「这是共性（照抄）」还是「这是差异（差在哪、为什么差）」。有了它，你读本节时就不会迷失在细节里，而是始终能把每一处代码归位到「共性」或「差异」的某一格。

准备好了。我们同样先不看任何一个具体文件，而是先建立「**四个文件、共性骨架、五处差异**」的全局地图。

---

## 1. 主题内容

### 1.1 先建立地图：四个文件，以及与第 16 节的「差异对照表」

本节四个文件，**分工和第 16 节几乎一一对应**（这本身就是「共性」的第一个证据）——唯一的结构差异是**没有 `types.ts`**。一张图看清它们的关系，以及每一块「相对 OpenAI 差在哪」：

```
        ┌──────────────────────────────────────────────────────────────────┐
        │            Model（第 3 节的编排壳）: model.stream(context)          │
        │            provider.stream(params) / provider.invoke(params)        │
        └───────────────────────────────┬────────────────────────────────────┘
                                         │  实现同一个 ModelProvider 契约（共性）
                                         ▼
        ┌──────────────────────────────────────────────────────────────────┐
        │  model-provider.ts  ——  AnthropicModelProvider（编排壳）            │
        │   · constructor: baseURL「等于默认就不传」   ← 差异④               │
        │   · _baseMessageParams: 共享参数构建                                │
        │       - extractSystemPrompt（抽 system 到顶层）  ← 差异①            │
        │       - max_tokens 必填默认 8192 / budget_tokens 推导  ← 差异⑤     │
        │   · invoke():  messages.create() → parseAssistantMessage           │
        │   · stream():  messages.create({stream:true}) → StreamAccumulator   │
        └───────────┬──────────────────────────────────────┬─────────────────┘
                    │ 【职责一：静态翻译】                    │ 【职责二：动态累积】
                    │ 方向：内部 Message ⇄ Anthropic wire     │ 方向：事件 event → 完整快照
                    ▼                                        ▼
        ┌────────────────────────────────┐   ┌──────────────────────────────────┐
        │ utils.ts（四个纯函数）           │   │ stream-utils.ts                    │
        │  · extractSystemPrompt   ← 独有 │   │  · StreamAccumulator（事件状态机） │
        │  · convertToAnthropicMessages 出│   │    push(event)  按事件类型分发      │
        │  · parseAssistantMessage    ←入 │   │    blocks: Map<index, BlockState>  │
        │  · convertToAnthropicTools  工具│   │    snapshot()   吐完整快照          │
        │    （thinking 带 signature 差异③）│   │    （思考链带 signature   差异③）  │
        └────────────────────────────────┘   └──────────────────────────────────┘
                    │                                        │
                    └──────────────┬─────────────────────────┘
                                   ▼
                    ┌────────────────────────────────┐
                    │ index.ts —— 桶文件（只导出壳）    │
                    │ （注意：没有 types.ts！ 差异③）   │
                    └────────────────────────────────┘
```

**把它和第 16 节的地图并排看，「共性 vs 差异」一目了然：**

| 维度                       | OpenAI（§16 范本）                                 | Anthropic（§17 对照）                                    | 性质                             |
| -------------------------- | --------------------------------------------------- | --------------------------------------------------------- | -------------------------------- |
| 文件数                     | 5（含`types.ts`）                                 | **4（无 `types.ts`）**                            | 差异③                           |
| 编排壳                     | `model-provider.ts`                               | `model-provider.ts`                                     | **共性**                   |
| 参数构建私有方法           | `_baseChatCompletionParams`                       | `_baseMessageParams`                                    | **共性**（名不同、职责同） |
| 翻译函数个数               | 3                                                   | **4**（多一个 `extractSystemPrompt`）             | 差异①                           |
| system prompt              | 留在 messages 里（原样透传）                        | **抽成顶层 `system` 参数**                        | 差异①                           |
| 累积器对外接口             | `push` / `snapshot`                             | `push` / `snapshot`                                   | **共性**                   |
| 累积器内部                 | 消费**扁平 delta**，按 `index` 归组         | 消费**事件序列**，状态机                            | 差异②                           |
| 思考链载体                 | `reasoning_content` 字符串（`types.ts` 打补丁） | `thinking` 块 + **`signature`**（运行期塞属性） | 差异③                           |
| `baseURL`                | 原样透传                                            | **等于默认就不传**                                  | 差异④                           |
| `max_tokens`             | 可选                                                | **必填**（默认 8192）                               | 差异⑤                           |
| `thinking.budget_tokens` | 无                                                  | **自动推导**                                        | 差异⑤                           |
| 空 tools 数组              | `tools ? ... : undefined`                         | **`length > 0` 才带 tools 字段**                  | 差异⑤                           |

**这张表就是本节的「地图 + 提纲」**：凡标「共性」的，本节一句带过（去看第 16 节）；凡标「差异①～⑤」的，就是本节要逐个剖开的看点。

**本节的讲解顺序**：先看编排壳（1.2）建立骨架，顺带看 `baseURL` 谨慎处理（差异④）；再走「参数构建」这条线（1.3），集中攻克 `system` 抽取（差异①）和 Anthropic 独有的参数归一（差异⑤）；接着走「静态翻译」（1.4 出 → 1.5 入 → 1.6 工具），重点看 `signature` 的往返（差异③）；然后精讲「动态累积」的事件状态机 `StreamAccumulator`（1.7，差异②）；最后看装配与全景（1.8），并回收「一协议一 provider」的整体图景。

### 1.2 `AnthropicModelProvider`：契约的第二个实现（编排壳）与 `baseURL` 谨慎处理

先看 [model-provider.ts](../../src/community/anthropic/model-provider.ts) 的类骨架。它同样 `implements ModelProvider`——**这是 [第 3 节](./03-model.md) 那个契约的第二次落地**，也是你**第一次能把两个实现摆在一起对照**：

```ts
export class AnthropicModelProvider implements ModelProvider {
  _client: Anthropic;

  constructor({ baseURL, apiKey }: { baseURL?: string; apiKey?: string } = {}) {
    // Only pass baseURL if it differs from the SDK default, so the SDK's
    // own URL construction logic is used for the standard Anthropic endpoint.
    const isDefaultURL = !baseURL || baseURL === "https://api.anthropic.com";
    this._client = new Anthropic({
      ...(isDefaultURL ? {} : { baseURL }),
      apiKey,
    });
  }
  // invoke / stream / _baseMessageParams ...
}
```

**类结构 100% 是共性**（[L16-L27](../../src/community/anthropic/model-provider.ts#L16-L27)）：一个 `_client`（这里是 `Anthropic` 而非 `OpenAI`）、一个接收 `{ baseURL, apiKey }` 的构造函数、`invoke` / `stream` / 一个共享参数构建的私有方法——**和第 16 节的 `OpenAIModelProvider` 摆在一起，骨架严丝合缝**。这就是「先范本、后对照」的第一层红利：你不用再重新理解「provider 类长什么样」，注意力可以直接投向**唯一不同的那处细节**——构造函数里的 `baseURL`。

**差异④：`baseURL`「等于默认值就不传」**（[L19-L27](../../src/community/anthropic/model-provider.ts#L19-L27)）。这是本节第一处、也是最微妙的一处差异。回忆第 16 节 1.2：OpenAI 的构造函数是「毫不设防地原样透传」——`new OpenAI({ baseURL, apiKey })`，`baseURL` 是 `undefined` 也照传。而 Anthropic 这里多了一层判断：

```ts
const isDefaultURL = !baseURL || baseURL === "https://api.anthropic.com";
this._client = new Anthropic({
  ...(isDefaultURL ? {} : { baseURL }),   // ← 是默认 URL 就「压根不传 baseURL 字段」
  apiKey,
});
```

**这段代码在说：如果 `baseURL` 没传、或者恰好等于官方默认 `https://api.anthropic.com`，那就干脆不把 `baseURL` 字段交给 SDK**（`...{}` 展开一个空对象）；只有当 `baseURL` 是一个**非默认**的值（比如某个代理网关）时，才显式传入。

**为什么 Anthropic 要这么谨慎，OpenAI 却不用？** 关键在于**两家 SDK 对「传入 `baseURL`」的内部处理不同**。Anthropic 的官方 SDK 在你**不传** `baseURL` 时，会用自己的一套逻辑去构造标准 endpoint（可能涉及版本路径拼接、区域端点、`anthropic-version` 头的默认配套等）。**如果你显式把 `baseURL: "https://api.anthropic.com"` 递进去，可能会绕过或干扰 SDK 那套「默认 URL 构造逻辑」，反而不如「什么都不传、让 SDK 自己决定」来得稳妥。** 代码注释把这层意思讲得很直白：

> Only pass baseURL if it differs from the SDK default, so the SDK's own URL construction logic is used for the standard Anthropic endpoint.

**而 OpenAI 那边为什么敢原样透传？** 因为第 16 节 1.8 揭示过：`OpenAIModelProvider` 的核心使命之一就是**服务近十家「OpenAI 兼容」厂商**，它们**必然要传一个非默认的 `baseURL`**（DeepSeek、GLM、Qwen…）——对 OpenAI provider 而言，「传 `baseURL`」是常态而非例外，SDK 也被设计成「你传什么我用什么」。**两家 provider 对 `baseURL` 的不同态度，本质上是两家的『定位』不同**：OpenAI provider 是「一鱼多吃的兼容底座」（透传是主场景），Anthropic provider 主要就服务 Claude 官方（默认 URL 是主场景，非默认才是例外）。**记住这个「同一个参数，两种处理」的对照**——它是「共性接口下，厂商差异如何体现」的第一个微观样本。

> 💡 **一个容易被忽略的共性**：注意 Anthropic 的 `_client` 字段名也叫 `_client`，`invoke`/`stream` 也都透传 `params.signal` 支持 [第 5 节](./05-react-loop.md) 的取消——**这些「不言自明的一致」恰恰是契约在起作用**。`ModelProvider` 契约（[第 3 节](./03-model.md) 的 [model-provider.ts](../../src/foundation/models/model-provider.ts)）规定了 `invoke`/`stream` 的签名（都收 `ModelProviderInvokeParams`、都可带 `signal`），两个实现自然长得像。**你甚至能想象：如果明天要接第三家（比如 Google Gemini），它的 `model-provider.ts` 也会是这个骨架。** 这就是抽象的力量——它让「第 N 个实现」变成一道「填空题」而非「问答题」。

**`invoke` 与 `stream` 也是共性骨架**（[L29-L47](../../src/community/anthropic/model-provider.ts#L29-L47)）：

```ts
async invoke(params: ModelProviderInvokeParams) {
  const response = await this._client.messages.create(this._baseMessageParams(params), {
    signal: params.signal,
  });
  return parseAssistantMessage(response, toTokenUsage(response.usage));
}

async *stream(params: ModelProviderInvokeParams): AsyncGenerator<AssistantMessage> {
  const response = await this._client.messages.create(
    { ...this._baseMessageParams(params), stream: true },
    { signal: params.signal },
  );

  const acc = new StreamAccumulator();
  for await (const event of response) {
    acc.push(event);          // ← 把厂商的「事件」喂给累积器（注意：叫 event，不叫 chunk）
    yield acc.snapshot();     // ← 对外只吐「到目前为止的完整快照」
  }
}
```

**把它和第 16 节 1.2 的 `invoke`/`stream` 并排，结构完全一致**——`invoke` 是「构建参数 → `create()` → `parseAssistantMessage` 翻译回内部」；`stream` 是「构建参数 + `stream: true` → `new StreamAccumulator()` → `push` + `yield snapshot` 循环」。**这七行 `stream` 就是第 3 节「快照约定」的第二次兑现现场**，和 OpenAI 逐行对应。只有三个**措辞级**的差异，恰好折射出协议差异：

- **调的是 `this._client.messages.create`**（Anthropic 的端点是 `/v1/messages`），而非 OpenAI 的 `chat.completions.create`（`/v1/chat/completions`）。**这是两家 API 最顶层的形态差异**——一个叫 "Messages API"，一个叫 "Chat Completions API"。
- **循环变量叫 `event` 而非 `chunk`**：这不是随意命名——它精确反映了「Anthropic 流式给的是**事件**（`message_start` / `content_block_delta`…），OpenAI 给的是**增量块**（delta chunk）」。**1.7 会看到这个命名差异背后是两台完全不同的累积器机器。**
- **没有 `stream_options: { include_usage: true }`**：回忆第 16 节 1.2，OpenAI 必须显式加这个选项，才能在流末拿到一个带 `usage` 的 chunk。**Anthropic 不需要**——因为它的流式协议**天生就在 `message_start` 事件里带 input tokens、在 `message_delta` 事件里带 output tokens**（1.7 详解）。usage 是 Anthropic 事件流的「原生公民」，无需额外「点单」。**这是「同一个需求（拿 usage 判断流结束），两家用不同机制满足」的又一样本**。

### 1.3 `_baseMessageParams`：`system` 抽取（差异①）与 Anthropic 独有的参数归一（差异⑤）

`invoke`/`stream` 共享的参数构建方法 `_baseMessageParams`（[L49-L78](../../src/community/anthropic/model-provider.ts#L49-L78)），是本节**差异最密集**的地方——差异①（system 抽取）和差异⑤（参数归一）全在这里。先看全貌：

```ts
private _baseMessageParams({
  model, messages, tools, options,
}: ModelProviderInvokeParams): Anthropic.MessageCreateParamsNonStreaming {
  const system = extractSystemPrompt(messages);              // ← 差异①：把 system 抽出来
  const anthropicMessages = convertToAnthropicMessages(messages);
  const anthropicTools = tools ? convertToAnthropicTools(tools) : undefined;

  // 差异⑤之一：thinking 开启时，Anthropic 要求 budget_tokens
  const normalizedOptions = { ...options };
  const thinking = normalizedOptions.thinking as { type: string; budget_tokens?: number } | undefined;
  if (thinking?.type === "enabled" && !thinking.budget_tokens) {
    const maxTokens = (normalizedOptions.max_tokens as number | undefined) ?? 8192;
    thinking.budget_tokens = Math.floor(maxTokens * 0.8);    // ← 自动推导为 max_tokens 的 80%
    normalizedOptions.thinking = thinking;
  }

  return {
    model,
    max_tokens: 8192,                                        // ← 差异⑤之二：max_tokens 必填默认
    messages: anthropicMessages,
    ...(system ? { system } : {}),                           // ← 差异①：有 system 才带这个顶层字段
    ...(anthropicTools && anthropicTools.length > 0 ? { tools: anthropicTools } : {}),  // ← 差异⑤之三
    ...normalizedOptions,                                    // ← 和 OpenAI 一样：options 可覆盖一切
  };
}
```

**先认「共性」**：它和第 16 节的 `_baseChatCompletionParams` 一样，是 `invoke`/`stream` 的「公约数」——都做「翻译消息 + 翻译工具 + 设默认参数」，也都把 `...normalizedOptions`（对应 OpenAI 的 `...options`）放在**最后**，用「后者覆盖前者」让用户能盖掉任何默认值（第 16 节 Q5 讲过的默认值哲学，这里同样适用）。**骨架照抄，无需重讲。** 下面逐个拆「差异」。

**差异①：`system` prompt 被抽成顶层参数**。看这两行的配合：

```ts
const system = extractSystemPrompt(messages);   // ① 从 messages 里把 system 文本抽出来
// ...
...(system ? { system } : {}),                  // ② 作为顶层字段放进请求（有才放）
```

**这是两家 API 最结构性的一处差异。** 回忆第 16 节 1.3：OpenAI 的 `convertToOpenAIMessages` 对 `system`/`user` 消息是「**原样透传**」——system 消息**留在 messages 数组里**，和 user/assistant 平级。但 **Anthropic 的 Messages API 要求 `system` 作为一个和 `messages` 平级的顶层参数**，`messages` 数组里**只能有 `user` 和 `assistant`**（没有 `system` 这个 role）。

所以 Anthropic provider 必须比 OpenAI **多做一步「抽取」**：`extractSystemPrompt(messages)` 把所有 system 消息的文本捞出来拼成一个字符串（1.4 精讲这个函数），放到顶层的 `system` 字段；同时 `convertToAnthropicMessages` 里会**跳过 system 消息**（1.4 会看到那个 `if (message.role === "system") continue`）。**这就是为什么 Anthropic 的 utils 有四个函数、比 OpenAI 多一个——多出来的 `extractSystemPrompt` 正是为了应对「system 位置不同」这处差异。**

**注意 `...(system ? { system } : {})` 这个「条件展开」**——只有 `system` 非空时才把 `system` 字段放进请求对象；没有 system prompt（`extractSystemPrompt` 返回 `undefined`）时，就展开一个空对象、干脆不带这个字段。**这是本节反复出现的一个惯用法**（下面 `tools` 也用它），比「先建对象再 `delete`」或「传 `undefined`」都更干净——**「有才带，没有就当这个字段不存在」**。

**差异⑤之一：`thinking.budget_tokens` 的自动推导**（[L62-L68](../../src/community/anthropic/model-provider.ts#L62-L68)）。这是 roadmap 为本节点名的一个亮点：

```ts
const normalizedOptions = { ...options };
const thinking = normalizedOptions.thinking as { type: string; budget_tokens?: number } | undefined;
if (thinking?.type === "enabled" && !thinking.budget_tokens) {
  const maxTokens = (normalizedOptions.max_tokens as number | undefined) ?? 8192;
  thinking.budget_tokens = Math.floor(maxTokens * 0.8);
  normalizedOptions.thinking = thinking;
}
```

**背景**：Anthropic 的「扩展思考（extended thinking）」功能，在开启时（`thinking: { type: "enabled" }`）**强制要求**你同时给一个 `budget_tokens`——即「允许模型花在思考上的 token 预算」。如果你只写 `type: "enabled"` 却漏了 `budget_tokens`，Anthropic API 会直接**报错拒绝**。

**回看装配处**（[cli/index.tsx L57-L62](../../src/cli/index.tsx#L57-L62)）：Helixent 创建 `Model` 时传的 options 是 `{ max_tokens: 16*1024, thinking: { type: "enabled" } }`——**只写了 `type: "enabled"`，没写 `budget_tokens`**！如果原样发给 Anthropic，必然报错。所以 provider 必须**兜这个底**：检测到「思考开启但没给预算」时，**自动**把预算推导为 `max_tokens` 的 80%（`Math.floor(maxTokens * 0.8)`）。

**为什么是 80%、为什么用 `max_tokens` 推导？** 因为 `max_tokens` 是「整个响应（思考 + 正文）的总上限」，而 `budget_tokens` 是「其中能花在思考上的部分」——思考不能占满全部预算，否则**没有 token 留给最终答案**了。留 20% 给正式回答（`max_tokens - budget_tokens`），是一个「既给足思考空间、又保证有余量作答」的经验配比。**注意这里读的是 `normalizedOptions.max_tokens`**——如果用户在 options 里传了 `max_tokens`，就按用户的算；没传则回退到函数体里的默认 `8192`（`?? 8192`）。

> 💡 **这处「自动推导」是「适配层吸收厂商约束」的典型**：上层（`Model`、CLI）只想表达一个**朴素意图**——「我要开思考」（`thinking: { type: "enabled" }`），它**不该也不想**知道「Anthropic 还强制要一个 `budget_tokens`」这种厂商细节。于是 provider 层默默把这个「厂商特有的强制要求」补齐了。**上层保持干净（只说意图），脏活（补齐 budget）留在 community 层**——这与第 16 节 1.6 的 `reasoning_content` 补丁是**同一种分层哲学**（Q4 会把这两处并起来讲）。

**差异⑤之二：`max_tokens: 8192` 是必填默认**。看 return 里那行 `max_tokens: 8192`——它**不在 `...normalizedOptions` 的条件里，而是硬写在对象字面量里**（当然仍能被后面的 `...normalizedOptions` 覆盖）。**为什么 Anthropic 要硬给一个默认，OpenAI 却不用？** 因为 **Anthropic 的 Messages API 把 `max_tokens` 列为必填字段**——不传直接报错。而 OpenAI 的 `max_tokens` 是可选的（不传就用模型的默认上限）。所以 Anthropic provider 必须保证「无论如何都有一个 `max_tokens`」，于是硬编一个 `8192` 兜底。**这又是一处「厂商强制要求」被 provider 默默满足的例子**——和 `budget_tokens` 推导是同一个动机。

**差异⑤之三：空 tools 数组的「更严格省略」**。对比两家对 tools 的处理：

- **OpenAI**（第 16 节 1.5）：`tools: tools ? convertToOpenAITools(tools) : undefined`——**有 tools 参数就转，哪怕转出来是空数组也照传**（传 `undefined` 只在「压根没传 tools」时）。
- **Anthropic**（本节）：`...(anthropicTools && anthropicTools.length > 0 ? { tools: anthropicTools } : {})`——**不仅要「有 tools 参数」，还要「转换后数组长度 > 0」，才带 `tools` 字段**；否则连字段都不带。

**Anthropic 的判断多了一个 `.length > 0`**——它对「空 tools 数组」比 OpenAI 更「零容忍」：一个空的 `tools: []` 也不许出现在请求里。**为什么？** 因为某些 Anthropic API 版本对「`tools` 字段存在但为空数组」的处理更严格（可能校验报错），最稳妥的做法就是「要么带一个非空的 tools，要么干脆不带这个字段」。**这依然是那个「有才带」惯用法的体现，只是判断条件比 OpenAI 更严一档**。

> 📌 **小结 1.2–1.3 的差异**：编排壳这一层，共性是「类结构 + invoke/stream 骨架 + 参数构建私有方法 + options 覆盖」（照抄第 16 节），差异是「① system 要抽到顶层、④ baseURL 等于默认就不传、⑤ 三处 Anthropic 独有的参数归一（max_tokens 必填、budget_tokens 推导、空 tools 更严格省略）」。**你会发现，所有差异都指向同一个根源——Anthropic 的 Messages API 和 OpenAI 的 Chat Completions API 是两套不同的『请求契约』**：system 的位置不同、必填字段不同、思考参数不同。provider 层的使命，就是把内部统一的调用意图，翻译成各家 API 各自的『规矩』。

### 1.4 `extractSystemPrompt` + `convertToAnthropicMessages`（出）：内部 `Message` → Anthropic wire

现在走「静态翻译」这条线，先看**出站方向**。和第 16 节不同，Anthropic 的出站被拆成了**两个**函数——因为 system 要单独抽走（差异①）。

**先看 Anthropic 独有的 `extractSystemPrompt`**（[utils.ts L13-L21](../../src/community/anthropic/utils.ts#L13-L21)）——**OpenAI 完全没有的对应物**：

```ts
export function extractSystemPrompt(messages: Message[]): string | undefined {
  const systemMessages = messages.filter((m) => m.role === "system");
  if (systemMessages.length === 0) return undefined;
  return systemMessages
    .flatMap((m) => m.content)          // 把所有 system 消息的 content 段摊平
    .filter((c) => c.type === "text")   // 只要 text 段
    .map((c) => c.text)                 // 取出文本
    .join("\n\n");                      // 用双换行拼成一个大字符串
}
```

**它的职责单一而清晰**：把 `messages` 里**所有** system 消息的**所有** text 段，用双换行 `\n\n` 拼成一个字符串返回；一个 system 消息都没有就返回 `undefined`（对应 1.3 里 `...(system ? {system} : {})` 的「没有就不带字段」）。**为什么用 `flatMap` + `join("\n\n")`？** 因为内部可能有**多条** system 消息（比如「基础人设」+「AGENTS.md 注入」+「技能列表注入」分成几条），每条又可能有多个 text 段——`flatMap` 把它们全摊平成一个 text 段序列，再用双换行连接成一整段 system prompt。（测试 [L12-L38](../../src/community/anthropic/__tests__/utils.test.ts#L12-L38) 覆盖了「无 system 返回 undefined」「单条」「多条用 `\n\n` 连」「一条内多个 text 段」四种情况。）

> 💡 **这个函数是差异①的「另一半」**：1.3 的 `_baseMessageParams` 负责「把抽出来的 system 放到顶层」，`extractSystemPrompt` 负责「抽」。两者配合，才完成了「system 从 messages 数组 → 顶层参数」的搬运。**OpenAI 因为 system 天生就该待在 messages 里，所以根本不需要这个函数**——这个「多出来的函数」本身，就是「协议差异催生代码差异」的最直白证据。

**再看 `convertToAnthropicMessages`**（[utils.ts L30-L101](../../src/community/anthropic/utils.ts#L30-L101)）——它和第 16 节的 `convertToOpenAIMessages` 一样按 role 分路，但**每一路都和 OpenAI 有微妙不同**：

```ts
export function convertToAnthropicMessages(messages: Message[]): Anthropic.MessageParam[] {
  const result: Anthropic.MessageParam[] = [];
  for (const message of messages) {
    if (message.role === "system") {
      continue;                                    // ① system：直接跳过（已被 extractSystemPrompt 抽走）
    }
    if (message.role === "user") {
      // ② user：text 原样，image_url → Anthropic 的 image/source 结构
    } else if (message.role === "assistant") {
      // ③ assistant：text/thinking/tool_use → Anthropic 的内容块（thinking 带 signature）
    } else if (message.role === "tool") {
      // ④ tool：变成一条 role: "user" 消息，内含 tool_result 块
    }
  }
  return result;
}
```

**逐路对照 OpenAI，看差异：**

**① `system` —— 直接 `continue` 跳过**。这是 OpenAI 那边完全没有的一路。因为 system 已经被 `extractSystemPrompt` 抽到顶层了，这里遇到 system 消息**必须跳过**，否则就会重复。（测试 [L41-L49](../../src/community/anthropic/__tests__/utils.test.ts#L41-L49) 验证「system 消息被排除、结果里只剩 user」。）

**② `user` —— 需要「重建内容块」，而非 OpenAI 的原样透传**（[L41-L58](../../src/community/anthropic/utils.ts#L41-L58)）：

```ts
if (message.role === "user") {
  const content: Anthropic.ContentBlockParam[] = [];
  for (const part of message.content) {
    if (part.type === "text") {
      content.push({ type: "text", text: part.text });         // text：字段一致，重建一份
    } else if (part.type === "image_url") {
      content.push({
        type: "image",                                          // ← 注意：不叫 image_url，叫 image
        source: { type: "url", url: part.image_url.url },       // ← 结构完全不同！
      });
    }
  }
  result.push({ role: "user", content });
}
```

**这里出现了本节第一处「同一种内容，两家结构不同」的鲜明对照**。回忆第 16 节 1.3：OpenAI 的 user 消息是「**原样透传**」（`openaiMessages.push(message)`），因为内部 `Message` 的 user 内容段本就照着 OpenAI wire 设计。但 **Anthropic 的图片格式和内部/OpenAI 完全不同**：

- 内部（= OpenAI）：`{ type: "image_url", image_url: { url } }`。
- Anthropic：`{ type: "image", source: { type: "url", url } }`——**块类型叫 `image`（不是 `image_url`），URL 藏在一个 `source` 子对象里**。

所以 Anthropic 这一路**不能原样透传**，必须逐段「重建」：text 段虽然字段名一致（`{type:"text", text}`）但也重新 `push` 了一份（因为要装进新数组）；image 段则要做「`image_url` → `image`/`source`」的结构改写。**这印证了第 16 节 1.3 那句话的另一面**——「内部格式贴近 OpenAI wire」是相对 OpenAI 而言的红利，一旦换到 Anthropic，连 user 消息都要重新翻译。（测试 [L51-L73](../../src/community/anthropic/__tests__/utils.test.ts#L51-L73) 分别验证了 text 和 image_url 两种 user 内容的转换。）

**③ `assistant` —— 三种段各自重建，`thinking` 要带回 `signature`（差异③登场）**（[L59-L83](../../src/community/anthropic/utils.ts#L59-L83)）：

```ts
} else if (message.role === "assistant") {
  const content: Anthropic.ContentBlockParam[] = [];
  for (const part of message.content) {
    if (part.type === "text") {
      content.push({ type: "text", text: part.text });
    } else if (part.type === "thinking") {
      // 取回 parseAssistantMessage 时保存的 signature
      const signature =
        (part as unknown as Record<string, unknown>)._anthropicSignature as string | undefined;
      content.push({
        type: "thinking",
        thinking: part.thinking,
        signature: signature ?? "",              // ← 差异③：Anthropic 的 thinking 块要带 signature
      });
    } else if (part.type === "tool_use") {
      content.push({
        type: "tool_use",
        id: part.id,
        name: part.name,
        input: part.input,                        // ← 注意：input 保持对象，不像 OpenAI 要 JSON.stringify
      });
    }
  }
  result.push({ role: "assistant", content });
}
```

**这一路和 OpenAI 的 assistant 翻译（第 16 节 1.3 那个「三段拆三字段」）形成鲜明对照**，三个关键差异：

- **结构模型完全不同**：OpenAI 把三种段拆进 assistant 消息的**三个不同字段**（`content` / `reasoning_content` / `tool_calls`）；**Anthropic 则把三种段都作为「内容块」放进同一个 `content` 数组**（`{type:"text"}` / `{type:"thinking"}` / `{type:"tool_use"}` 并列）。**这是「扁平字段」vs「内容块数组」两种建模范式的对照**——而 Anthropic 的「内容块数组」其实和 Helixent 内部的 `content` 数组**更像**（都是「分段数组」），所以这一路的翻译反而比 OpenAI「更直白」（几乎是段对块的一一映射）。
- **`tool_use.input` 保持对象、无需 `JSON.stringify`**：**这是和 OpenAI 最醒目的一处差异！** 回忆第 16 节 1.3：OpenAI 要求 `tool_calls[].function.arguments` 是**JSON 字符串**，所以出站要 `JSON.stringify(content.input)`。但 **Anthropic 的 `tool_use` 块的 `input` 字段直接就是一个对象**（`Record<string, unknown>`）——所以这里 `input: part.input` **原样传对象即可，不用 stringify**。（对应地，1.5 的入站也不用 `JSON.parse`——见下。）**这一对差异非常适合记忆：OpenAI 工具参数走「字符串」，Anthropic 走「对象」。**
- **差异③：`thinking` 块必须带 `signature`**。这是 Anthropic 独有、且**最需要理解**的一处。Anthropic 的 extended thinking 要求：在**多轮对话**里把之前的 thinking 块回传给模型时，**必须带上当初那个 thinking 块的 `signature`**（一个加密签名，用于让 Anthropic 校验「这段思考确实是模型自己产生的、没被篡改」）。**问题来了**：Helixent 内部的 `ThinkingContent` 类型（[content.ts](../../src/foundation/messages/types/content.ts#L33-L38)）**只有 `{ type, thinking }`，压根没有 `signature` 字段**！那 signature 存哪？答案就在这行——`(part as unknown as Record<string, unknown>)._anthropicSignature`——**它被作为一个「运行期额外属性」`_anthropicSignature` 偷偷挂在 thinking 段对象上**（1.5 的入站会看到「怎么挂上去的」）。这里出站时再把它取出来，放进 Anthropic 要的 `signature` 字段；取不到就用 `signature: signature ?? ""`（空字符串兜底）。

> 💡 **差异③的精妙——「不污染 Foundation 类型，用运行期属性承载厂商特有数据」**。这里有一个漂亮的取舍：Anthropic 需要 `signature`，但这是**纯厂商细节**，不该让 Foundation 层的 `ThinkingContent` 类型为它加一个字段（那样 OpenAI、以及未来所有 provider 都得看到这个跟自己无关的字段）。于是 Anthropic provider 选择——**把 signature 作为一个带下划线前缀的「私有运行期属性」`_anthropicSignature` 挂在对象上**，靠 `as unknown as Record<string, unknown>` 绕过类型检查读写它。**这是「厂商特有数据不进类型系统、只在运行期附着」的手法**，和第 16 节 1.6 的 `reasoning_content`「用 `types.ts` 交叉类型打补丁」形成有趣对比：OpenAI 选择「在类型层扩展」（因为 reasoning_content 是它要在多个函数间正经传递的字段），Anthropic 选择「在运行期附着」（因为 signature 只是要「原样存、原样还」的透传数据，犯不上进类型系统）。**Q3 会深入这个对比。**

**④ `tool` —— 变成 `role: "user"` 消息！（又一处结构性差异）**（[L84-L97](../../src/community/anthropic/utils.ts#L84-L97)）：

```ts
} else if (message.role === "tool") {
  const content: Anthropic.ToolResultBlockParam[] = [];
  for (const part of message.content) {
    if (part.type === "tool_result") {
      content.push({
        type: "tool_result",
        tool_use_id: part.tool_use_id,     // ← 字段名保持 tool_use_id（和 OpenAI 的 tool_call_id 不同！）
        content: part.content,
      });
    }
  }
  result.push({ role: "user", content });  // ← 关键：role 是 "user"，不是 "tool"
}
```

**这是和 OpenAI 差别巨大的一路。** 回忆第 16 节 1.3：OpenAI 把内部一条 `tool` 消息「**一拆多**」成多条 `role: "tool"` 的 wire 消息（每个 tool_result 一条），且字段名从 `tool_use_id` 改成 `tool_call_id`。而 Anthropic 是**另一套完全不同的做法**：

- **不「一拆多」，而是「一合一」**：内部一条 tool 消息里的**多个** tool_result，被塞进**同一条** wire 消息的 `content` 数组里（多个 `tool_result` 块并列）。
- **role 是 `"user"` 而非 `"tool"`**：**Anthropic 没有 `tool` 这个 role**！它把「工具结果」建模成「用户发回来的一条消息，内含若干 tool_result 内容块」。这在概念上很自然——「工具执行结果」相当于「环境/用户」反馈给模型的信息。
- **字段名保持 `tool_use_id`**：Anthropic 内部就叫 `tool_use_id`（呼应它的 `tool_use` 块），**恰好和 Helixent 内部字段同名**，所以这里**不用改名**（而 OpenAI 要改成 `tool_call_id`）。

**这一路把两家的差异体现得淋漓尽致**：OpenAI 是「一拆多 + role:tool + 改名 tool_call_id」，Anthropic 是「一合一 + role:user + 保名 tool_use_id」。**同一条内部 tool 消息，翻译成两家 wire 的形态截然不同**——而这一切差异都被关在各自的 `convertTo*Messages` 里，上层永远只看到内部那条统一的 `ToolMessage`。（测试 [L113-L126](../../src/community/anthropic/__tests__/utils.test.ts#L113-L126) 验证了「tool 消息 → role:user + tool_result 块」。）

> 📌 **小结出站翻译的「四路差异」**：相比 OpenAI，Anthropic 出站**每一路都不同**——system 要跳过（因已抽走）、user 要重建（image 结构不同）、assistant 是内容块数组（且 input 保持对象、thinking 带 signature）、tool 变成 role:user 的合并消息。**这恰恰说明「内部 Message 贴近 OpenAI wire」是一个『相对 OpenAI』的设计红利**——换到 Anthropic，红利消失，翻译工作量陡增。但这**正是分层的意义**：把「贴近谁」的不对称，用「每家一个 convert 函数」消化掉，让上层 `Message` 保持中立、统一。

### 1.5 `parseAssistantMessage`（入）：Anthropic 响应 → 内部 `AssistantMessage`（signature 的「存」）

出站讲完，看**入站方向**——把 Anthropic 返回的 `Anthropic.Message` 翻译回内部 `AssistantMessage`（[utils.ts L109-L144](../../src/community/anthropic/utils.ts#L109-L144)）。它是 1.4 中 assistant 那一路的逆操作，也是 `signature` 被「存起来」的地方：

```ts
export function parseAssistantMessage(response: Anthropic.Message, usage?: TokenUsage): AssistantMessage {
  const result: AssistantMessage = { role: "assistant", content: [], usage };

  for (const block of response.content) {          // ← 遍历 Anthropic 的「内容块数组」
    if (block.type === "text") {
      result.content.push({ type: "text", text: block.text } as never);
    } else if (block.type === "thinking") {
      const thinkingContent: Record<string, unknown> = {
        type: "thinking",
        thinking: block.thinking,
      };
      if (block.signature) {
        thinkingContent._anthropicSignature = block.signature;   // ← 差异③：把 signature 存进运行期属性
      }
      result.content.push(thinkingContent as never);
    } else if (block.type === "tool_use") {
      result.content.push({
        type: "tool_use",
        id: block.id,
        name: block.name,
        input: block.input,                          // ← 差异：input 直接是对象，无需 JSON.parse！
      } as never);
    }
  }

  return result;
}
```

**和第 16 节 1.4 的 `parseAssistantMessage`（OpenAI 入站）对照，看三处差异：**

- **数据源是「内容块数组」而非「三个字段」**：OpenAI 入站要分别读 `message.content`（字符串）、`message.reasoning_content`、`message.tool_calls` 三个字段；Anthropic 入站是**遍历 `response.content` 这个内容块数组**，靠每个块的 `type` 分派。**这再次体现「内容块数组」范式和内部 `content` 数组的天然契合**——几乎是块到段的一一映射。
- **`tool_use.input` 无需 `JSON.parse`**：**这是 1.4 那处「不用 stringify」的入站镜像**。OpenAI 入站要 `JSON.parse(tool_call.function.arguments)` 把字符串转回对象（第 16 节 1.4）；而 Anthropic 的 `block.input` **本来就是对象**，`input: block.input` 直接用。**记住这对镜像：OpenAI 工具参数出站 stringify、入站 parse；Anthropic 出入两头都是对象、不转换。**（也因此，Anthropic 这里**没有** OpenAI 1.4 里那个「非流式无需 try/catch」的讨论——因为压根不 parse。）
- **差异③：`signature` 在这里被「存」进 `_anthropicSignature`**。这是理解差异③的**关键一环**。当 Anthropic 返回一个 thinking 块时，块上带着 `block.signature`。provider 把它**作为运行期额外属性 `_anthropicSignature` 挂到内部 thinking 段对象上**（`thinkingContent._anthropicSignature = block.signature`）。**这就和 1.4 出站的「取回 signature」闭环了**：入站存进来 → 存入对话历史 → 下一轮出站时（1.4）再取出来回传给 Anthropic。**一存一取，构成 signature 的完整往返（round-trip）。**

> 💡 **`signature` 往返的意义——为什么非存不可**：Anthropic 的 extended thinking 有一条硬规矩——**多轮对话中，如果你把带思考的 assistant 消息作为历史回传，thinking 块必须携带原始 signature**，否则 API 会报错（它要用 signature 验证思考内容的完整性/真实性）。**所以这个 signature 是「必须原样保存、原样归还」的透传数据**。Helixent 的处理堪称教科书：**入站时把它「藏」进内部对象的一个下划线属性（不进类型系统），出站时再「取」出来还给 Anthropic**——内部的 `ThinkingContent` 类型对此毫不知情，Agent 层、CLI 层更是完全无感。**这就是「厂商特有的透传数据，如何在不污染核心模型的前提下被携带」的范本**。（测试 [utils.test.ts L144-L159](../../src/community/anthropic/__tests__/utils.test.ts#L144-L159) 验证了「带 signature 的 thinking 块被解析后，`_anthropicSignature` 等于原 signature」。）

**其余是共性**：`usage` 参数由调用方（`invoke` 里的 `toTokenUsage(response.usage)`）传入直接挂上；入站产物**不带 `streaming` 标记**（因为它是 `invoke` 非流式的产物，天生终态）——这些都和第 16 节 1.4 一致，无需展开。

> 📎 **一个「防御性 `as never`」的旁注**：你会注意到 Anthropic 的 `parseAssistantMessage` 里几处 `push(... as never)`。这是因为内部把 signature 存成「类型系统里不存在的属性」，为了让 TS 不报错，用 `as never` 绕过（一种在「运行期附着属性」手法下不得不付的类型代价）。**这也从侧面印证了「运行期附着」和「类型层扩展」的取舍**：OpenAI 选 `types.ts` 交叉类型，享受了完整类型检查；Anthropic 选运行期属性，省了一个文件，代价是这几处 `as never`。**没有免费的午餐，只有「适合场景」的取舍**（Q3 详谈）。

### 1.6 `convertToAnthropicTools`（工具）：和 OpenAI「几乎一样」的共性样本

静态翻译的最后一个函数，把 [第 4 节](./04-tool.md) 的 `Tool[]` 翻译成 Anthropic 的工具定义（[utils.ts L152-L158](../../src/community/anthropic/utils.ts#L152-L158)）。**这是本节难得的「几乎纯共性」的一处**，正好用来收一收「共性」这条线：

```ts
export function convertToAnthropicTools(tools: Tool[]): Anthropic.Tool[] {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.parameters.toJSONSchema() as Anthropic.Tool["input_schema"],  // ← 和 OpenAI 同一个调用
  }));
}
```

**把它和第 16 节 1.5 的 `convertToOpenAITools` 并排——这正是第 16 节结尾埋的那个钩子的兑现现场**：

```ts
// OpenAI（第 16 节 1.5）
{ type: "function", function: { name, description, parameters: tool.parameters.toJSONSchema() } }
// Anthropic（本节）
{ name, description, input_schema: tool.parameters.toJSONSchema() }
```

**共性（核心）**：两家都调用**同一个** `tool.parameters.toJSONSchema()`——这就是 [第 4 节](./04-tool.md)「一处定义、三处受益」里「运行期 JSON Schema」的受益点。**工具作者写的那一份 Zod schema，是整条链路唯一的真相源**，无论接哪家厂商，都由这个方法自动转成标准 JSON Schema，一个字都不用重写。**这是「Foundation 定义能力、community 消费能力」的完美体现**——`toJSONSchema()` 是 Foundation 给的共性能力，跨 provider 稳定不变。

**差异（表层）**：只是「**包装字段不同**」——OpenAI 要 `{ type: "function", function: { name, description, parameters } }`（多一层 `function` 嵌套 + `type` 判别），Anthropic 要 `{ name, description, input_schema }`（扁平，且那份 schema 的字段叫 `input_schema` 而非 `parameters`）。**这正是第 16 节 1.5 结尾预言的**：

> `convertToOpenAITools` 和 Anthropic 的 `convertToAnthropicTools` 会非常像——都调 `tool.parameters.toJSONSchema()`，只是「包装字段」不同……这就是「契约共性 vs 厂商差异」的一个微观样本：`toJSONSchema()` 是共性（Foundation 定义的能力），「怎么包装这份 schema」是差异（各厂商 wire 格式）。

**至此这个预言完全兑现。** 这个五行小函数是全节「共性 vs 差异」结构最纯粹的一个标本：**能力（toJSONSchema）是共性、包装（字段名/嵌套）是差异**。（测试 [utils.test.ts L197-L227](../../src/community/anthropic/__tests__/utils.test.ts#L197-L227) 用一个 mock 的 `toJSONSchema` 验证了转换结构、以及「空工具数组 → 空数组」——和 OpenAI 的测试几乎一模一样，连测试都体现了共性。）

> 📌 **小结 1.4–1.6 的静态翻译**：出入两个方向依然「成对镜像」（共性，保证 round-trip 一致），但**镜子里照出的内容与 OpenAI 全然不同**：多一个 `extractSystemPrompt`（差异①）、user/assistant/tool 每一路的结构都不同（image 结构、内容块数组、role:user 合并）、`tool_use.input` 出入都是对象（无需 stringify/parse）、`thinking` 靠 `_anthropicSignature` 运行期属性携带 signature 往返（差异③）。唯有 `convertToAnthropicTools` 因为站在 `toJSONSchema()` 这个共性能力上，和 OpenAI「只差一层包装」。**「翻译逻辑各表一枝、但都由成对镜像函数承担、都产出统一的内部 Message」——这就是静态翻译层的『共性骨架 + 厂商差异』。**

### 1.7 `StreamAccumulator`：一台「事件状态机」（差异②，本节对照重心）

终于到本节的**对照重心**——[stream-utils.ts](../../src/community/anthropic/stream-utils.ts) 的 `StreamAccumulator`。它和第 16 节的 `StreamAccumulator` **同名、同接口（`push` / `snapshot`）、同产出（第 3 节的完整快照）、同职责（把流式碎片拼成快照）**，但**内部是两台完全不同的机器**。**这是全节最能诠释「接口相同、实现迥异」的一处**，我们逐块拆，并处处和 OpenAI 对照。

**先理解「差异②」的根源：两家流式协议形态不同。** 回忆第 16 节 1.7：OpenAI 的流式是「**扁平 delta**」——每个 `chunk` 都长得差不多（`chunk.choices[0].delta`），文本、思考、工具参数都以「增量片段」的形式散落在 delta 里，靠 `tool_calls[].index` 把工具碎片归组。而 **Anthropic 的流式是「事件序列」**——它发的不是「同构的 delta」，而是**一串有类型、有生命周期的事件**：

```
message_start          → 消息开始，带初始 usage（input tokens）
content_block_start    → 一个内容块「开始」了（在某个 index 上，声明这是 text/thinking/tool_use）
content_block_delta    → 给「当前块」追加增量（text 增量 / thinking 增量 / 工具 JSON 增量 / signature）
content_block_stop     → 一个内容块「结束」了
content_block_start    → 下一个块开始……（如此往复）
message_delta          → 消息将结束，带最终 usage（output tokens）
message_stop           → 消息结束
```

**看出区别了吗？** OpenAI 是「一种 chunk 走天下，字段有没有值全靠猜」；Anthropic 是「**块有明确的开始/增量/结束**，像一台状态机在开合括号」。**所以 Anthropic 的累积器本质上是一台『事件驱动的状态机』**——它要根据事件类型（`switch`）做不同的状态转移，而不是像 OpenAI 那样「每个 chunk 都跑同一套累加逻辑」。

先看**状态**（[L26-L30](../../src/community/anthropic/stream-utils.ts#L26-L30)）——和 OpenAI 的「四件套」对照：

```ts
export class StreamAccumulator {
  private readonly blocks = new Map<number, BlockState>();   // ① 按 index 归组的「内容块」状态
  private inputTokens = 0;                                    // ② input tokens（message_start 带来）
  private outputTokens = 0;                                   // ③ output tokens（message_delta 带来）
  private hasFinalUsage = false;                              // ④ 是否已到终态（= 流结束哨兵）
  // push / snapshot ...
}
```

**和 OpenAI 状态四件套的对照很有意思：**

- **OpenAI 用「三个独立字段（reasoningContent/textContent/toolCalls）」分别累加三种内容**；**Anthropic 用一个统一的 `blocks: Map<index, BlockState>`**——因为 Anthropic 的一切都是「带 index 的内容块」，无论 text/thinking/tool_use，都是 `blocks` 里的一个条目。**这个 `BlockState` 是个可辨识联合**（[L10-L13](../../src/community/anthropic/stream-utils.ts#L10-L13)）：

```ts
type BlockState =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string; signature?: string }
  | { type: "tool_use"; id: string; name: string; partialJson: string };
```

  **注意 `tool_use` 块的字段叫 `partialJson`**——它对应 OpenAI 那边 toolCalls 里的 `arguments`，都是「一段段拼起来的、可能还不完整的工具参数 JSON」。命名（`partial`）直白地承认了「这玩意儿在拼完之前是残缺的」。

- **usage 的表达不同**：OpenAI 用一个 `usage: TokenUsage | undefined`（有值 = 流结束）；Anthropic 用 `inputTokens` / `outputTokens` **两个数**分别累计，外加一个**显式的布尔哨兵 `hasFinalUsage`**。**为什么 Anthropic 要多一个布尔？** 因为它的 usage 是**分两次到达**的——`message_start` 先给 input tokens，`message_delta` 最后才给 output tokens。**「usage 有没有值」不再能直接当『流结不结束』的信号**（因为 input tokens 一开始就有了），所以需要一个独立的 `hasFinalUsage` 布尔，专门在 `message_delta`（真正的终态事件）到达时置 `true`。**这就是差异②在状态设计上的直接后果**：OpenAI 的 usage「一次到齐」，可以一字段两用；Anthropic 的 usage「分两批到」，必须拆成「数值累计」+「终态布尔」。

**核心方法一：`push(event)` —— 一台 `switch` 驱动的状态机**（[L32-L51](../../src/community/anthropic/stream-utils.ts#L32-L51)）：

```ts
push(event: Anthropic.RawMessageStreamEvent): void {
  switch (event.type) {
    case "message_start":
      this.inputTokens = event.message.usage.input_tokens ?? 0;
      this.outputTokens = event.message.usage.output_tokens ?? 0;
      return;
    case "content_block_start":
      this._handleBlockStart(event);      // 开一个新块
      return;
    case "content_block_delta":
      this._handleBlockDelta(event);      // 给当前块追加增量
      return;
    case "message_delta":
      this._handleMessageDelta(event);    // 收最终 usage + 置 hasFinalUsage
      return;
    // content_block_stop 和 message_stop 不携带我们需要的数据
    default:
      return;
  }
}
```

**这和 OpenAI 的 `push` 是两种完全不同的写法**。OpenAI 的 `push`（第 16 节 1.7）是「一个 chunk 进来，挨个检查 delta 里有没有 content、有没有 reasoning、有没有 tool_calls，有就累加」——**线性、无分派**。Anthropic 的 `push` 则是**一个 `switch(event.type)`**——先看「这是什么事件」，再路由到对应的处理器（`_handleBlockStart` / `_handleBlockDelta` / `_handleMessageDelta`）。**这是「事件状态机」的典型形态**：不同事件触发不同的状态转移。（注意 `content_block_stop` 和 `message_stop` 落到 `default` 被忽略——因为 Anthropic 的「块结束」不需要我们做任何事，我们只关心「开始」和「增量」。**这是一个善用「忽略无关事件」的干净处理**。）

**分头看三个处理器：**

**`_handleBlockStart`（开块）**（[L70-L88](../../src/community/anthropic/stream-utils.ts#L70-L88)）——**这是 OpenAI 完全没有的一步**：

```ts
private _handleBlockStart(event: Anthropic.RawContentBlockStartEvent): void {
  const { index, content_block } = event;
  if (content_block.type === "text") {
    this.blocks.set(index, { type: "text", text: content_block.text });
  } else if (content_block.type === "thinking") {
    this.blocks.set(index, {
      type: "thinking",
      thinking: content_block.thinking,
      ...(content_block.signature ? { signature: content_block.signature } : {}),
    });
  } else if (content_block.type === "tool_use") {
    this.blocks.set(index, { type: "tool_use", id: content_block.id, name: content_block.name, partialJson: "" });
  }
}
```

**`content_block_start` 事件明确声明「第 index 个块是什么类型」**，于是这里在 `blocks` Map 里**创建一个对应类型的初始条目**。**这一步是 Anthropic 独有的「显式开块」**——对比 OpenAI：OpenAI 那边**没有「开块」事件**，它是「第一个带 `tool_calls[0]` 的 chunk 到了，发现 `Map` 里没有 index 0 的条目，就顺手新建一个」（第 16 节 1.7 那个 `if (!entry) { entry = {...}; }`）——**懒创建**。而 Anthropic 是「收到明确的 start 事件才创建」——**显式创建**。**这个对照很能说明两种协议的性格**：OpenAI「隐式、靠推断」，Anthropic「显式、有仪式」。注意 tool_use 块开始时 `id` 和 `name` **就已经齐了**（在 start 事件里），只有 `partialJson` 是空的、等后续 delta 来填——这比 OpenAI「id/name 也可能分几个碎片来」要清爽。

**`_handleBlockDelta`（追加增量）**（[L90-L103](../../src/community/anthropic/stream-utils.ts#L90-L103)）——**这里体现了 Anthropic delta 的「强类型」**：

```ts
private _handleBlockDelta(event: Anthropic.RawContentBlockDeltaEvent): void {
  const block = this.blocks.get(event.index);
  if (!block) return;
  const delta = event.delta;
  if (delta.type === "text_delta" && block.type === "text") {
    block.text += delta.text;                       // 文本增量
  } else if (delta.type === "thinking_delta" && block.type === "thinking") {
    block.thinking += delta.thinking;               // 思考增量
  } else if (delta.type === "signature_delta" && block.type === "thinking") {
    block.signature = delta.signature;              // ← signature 增量（差异③在流式里的体现）
  } else if (delta.type === "input_json_delta" && block.type === "tool_use") {
    block.partialJson += delta.partial_json;        // ← 工具参数 JSON「续接」（对应 OpenAI 的 arguments +=）
  }
}
```

**对照 OpenAI 的 delta 处理，两个关键差异：**

- **delta 自带「类型标签」**：Anthropic 的每个增量都有 `delta.type`（`text_delta` / `thinking_delta` / `signature_delta` / `input_json_delta`），**明确告诉你「这段增量是给哪种内容的」**。OpenAI 那边则是「delta 里有 `content` 字段就是文本、有 `tool_calls` 就是工具」——靠字段存在性推断。**又一次「显式 vs 隐式」的性格对照。**
- **多了一个 `signature_delta`（差异③在流式的体现）**：Anthropic 的 thinking 块的 signature 也是**流式逐步到达**的（`signature_delta`），到了就更新 `block.signature`。**这是 OpenAI 完全没有的概念**——OpenAI 的 reasoning 只有文本、没有签名。（注意这里 signature 是「来了就覆盖」`block.signature = delta.signature`，而非 `+=` 续接——因为 signature 是一个整体，不是拼出来的。）
- **共性内核**：抛开类型标签，**「工具参数 JSON 靠 `+=` 续接」这个核心和 OpenAI 一模一样**——`block.partialJson += delta.partial_json`，对应 OpenAI 的 `entry.arguments += tc.function.arguments`。**两家的工具参数都是「一段段 JSON 文本流过来、要拼起来」**，这个底层事实是共性，只是「碎片装在哪个字段里」（`partial_json` vs `arguments`）是差异。

**`_handleMessageDelta`（收最终 usage）**（[L105-L114](../../src/community/anthropic/stream-utils.ts#L105-L114)）：

```ts
private _handleMessageDelta(event: Anthropic.RawMessageDeltaEvent): void {
  if (event.usage.output_tokens != null) this.outputTokens = event.usage.output_tokens;  // 最终 output tokens
  if (event.usage.input_tokens != null) this.inputTokens = event.usage.input_tokens;
  this.hasFinalUsage = true;                                                              // ← 置终态哨兵
}
```

**这就是「usage 分两批到达」的收尾**：`message_start` 给了 input tokens，`message_delta` 这里给最终的 output tokens，并把 `hasFinalUsage` 置 `true`——**这个布尔一旦为真，就等价于 OpenAI 那边「usage 有值了」，是「流结束」的信号**。（测试 [stream-utils.test.ts L114-L136](../../src/community/anthropic/__tests__/stream-utils.test.ts#L114-L136) 验证了「message_start + message_delta 后，usage 正确合并为 {20,10,30}、且 streaming 变 undefined」。）

**核心方法二：`snapshot()` —— 导出快照（和 OpenAI「神似」）**（[L53-L68](../../src/community/anthropic/stream-utils.ts#L53-L68)）：

```ts
snapshot(): AssistantMessage {
  const content: AssistantMessageContent = [];
  const ordered = [...this.blocks.entries()].sort((a, b) => a[0] - b[0]);   // ← 按 index 排序，保序（同 OpenAI）
  for (const [, block] of ordered) {
    const item = blockToContent(block);      // 把一个块转成一个内容段
    if (item) content.push(item);            // ← null 会被跳过（空 text 块）
  }

  return {
    role: "assistant",
    content,
    usage: this.hasFinalUsage ? this._buildUsage() : undefined,
    ...(this.hasFinalUsage ? {} : { streaming: true }),   // ← 和 OpenAI 同样的 streaming 判据
  };
}
```

**`snapshot` 的骨架和 OpenAI「神似」（共性）**：都是「按 index 排序 → 逐个转成内容段 → 组装 AssistantMessage → 用『终态哨兵』决定 streaming 标记」。那句 `...(this.hasFinalUsage ? {} : { streaming: true })` 和 OpenAI 的 `...(this.usage ? {} : { streaming: true })` **逻辑完全一致**——只是「哨兵」从「usage 有没有值」换成了「hasFinalUsage 布尔」（原因见上：usage 分两批到）。**按 index 排序保序也和 OpenAI 一样**（第 16 节 1.7 那个防御性 sort）。

**真正的逻辑落在 `blockToContent` 和 `parseToolInput` 两个辅助函数里**（[L130-L157](../../src/community/anthropic/stream-utils.ts#L130-L157)）——**「参数没解析成功就给空对象」的严谨在这里**：

```ts
function blockToContent(block: BlockState): AssistantMessageContent[number] | null {
  if (block.type === "text") {
    return block.text ? { type: "text", text: block.text } : null;   // ← 空 text 块返回 null（被跳过）
  }
  if (block.type === "thinking") {
    const thinkingContent: Record<string, unknown> = { type: "thinking", thinking: block.thinking };
    if (block.signature) thinkingContent._anthropicSignature = block.signature;   // ← 差异③：signature 再次附着
    return thinkingContent as never;
  }
  // tool_use
  return { type: "tool_use", id: block.id, name: block.name, input: parseToolInput(block.partialJson) };
}

function parseToolInput(partialJson: string): Record<string, unknown> {
  if (!partialJson) return {};
  try {
    return JSON.parse(partialJson);
  } catch {
    return {};   // ← Input JSON 还没拼完整 → 先给空对象
  }
}
```

**这里是本节和 OpenAI 对照最微妙、也最值得停留的地方——「参数没解析成功」的处理策略，两家『同中有异』：**

- **共性（大方向一致）**：两家都不会吐出「一个带残缺 JSON 的 tool_use」。工具参数 JSON 只要 `JSON.parse` 失败，就**不把残缺 JSON 当 input**——OpenAI 用 `input = {}` 兜底，Anthropic 的 `parseToolInput` 也是 `catch { return {} }`。**这个「宁可空对象、不给残缺」的底线是共性。**
- **差异（严谨程度不同）**：**这是一个容易被忽略、但很重要的差异！** 回忆第 16 节 1.7 那个「最见功力」的设计——OpenAI 在**流式中途**（`!isFinal`）会**彻底扣留**残缺的 tool_use（`if (!parsed && !isFinal) continue`，那一帧快照里干脆不出现这个 tool_use），只在流结束（`isFinal`）时才兜底吐出空对象。而 **Anthropic 这里没有「扣留」逻辑**——它**任何时候**（无论流式中途还是结束）遇到残缺 JSON，都是「吐出一个 `input: {}` 的 tool_use」，而不是「让这个 tool_use 从快照里消失」。

**为什么 Anthropic 敢「不扣留」，OpenAI 却要「扣留」？** 关键在于**差异②带来的信息优势**——**Anthropic 有明确的 `content_block_start` 事件**。这意味着：**一旦 Anthropic 开了一个 tool_use 块，它的 `id` 和 `name` 就已经确定了**（在 start 事件里就给全了，见 `_handleBlockStart`），只有 `input` 还在拼。所以哪怕 input 暂时是 `{}`，这个 tool_use 也**已经携带了完整的 `id` 和 `name`**——它是一个「身份明确、只是参数暂缺」的调用，吐出去下游也能识别（知道「模型要调 bash，只是参数还没到」）。**而 OpenAI 那边，工具的 `id`/`name` 也可能是分碎片来的**（第 16 节 1.7 提到 id/name「来了就覆盖」），流式极早期可能连 `name` 都还没到——此时吐出一个 `{id:"", name:"", input:{}}` 的 tool_use 就是**纯粹的噪声**，所以 OpenAI 选择「扣留到 JSON 能解析为止」更稳妥。

> 💡 **这个「同中有异」是全节最深的一处对照**：**两家的「底线」相同（不给残缺 JSON 当参数），但「策略」因协议信息量不同而不同**。Anthropic 因为有「显式开块」事件，tool_use 的身份（id/name）早早确定，所以可以「大方地」把「参数暂缺」的 tool_use 也吐出去（反正身份是全的）；OpenAI 因为身份也可能残缺，所以要「谨慎地」扣留到能解析为止。**这生动说明了「协议的信息量，会直接影响累积器的策略选择」**——不是谁比谁「更严谨」，而是**各自协议下的最优解不同**。（测试 [stream-utils.test.ts L91-L112](../../src/community/anthropic/__tests__/stream-utils.test.ts#L91-L112) 验证了 Anthropic 的行为：残缺 JSON `'{"command"'` 时，snapshot 里 tool_use **依然出现**、只是 `input: {}`——这和 OpenAI「残缺时 content 长度为 0」的测试恰成鲜明对比。）

**顺带看两个共性小细节**：① 空 text 块返回 `null` 被 `snapshot` 跳过（`block.text ? {...} : null`）——对应 OpenAI 那边「`if (this.textContent)` 才 push」，都是「没内容就不产出空段」；② thinking 块在 `blockToContent` 里**再次**把 `signature` 附着到 `_anthropicSignature`——**这样流式快照里的 thinking 段也带着 signature**，和非流式的 `parseAssistantMessage`（1.5）行为一致，保证「无论流式还是非流式，signature 都能被存下来供下一轮回传」。（测试 [L45-L61](../../src/community/anthropic/__tests__/stream-utils.test.ts#L45-L61) 验证了「signature_delta 更新后，snapshot 里 `_anthropicSignature` 是最新值」。）

> 💡 **`StreamAccumulator` 对照总结——「接口相同、实现迥异」的活教材**：把两家的累积器摆在一起，你会看到一组精确的对应与背离：
>
> | 维度             | OpenAI 累积器                | Anthropic 累积器                                     |
> | ---------------- | ---------------------------- | ---------------------------------------------------- |
> | 对外接口         | `push` / `snapshot`      | `push` / `snapshot` ✅ **相同**            |
> | 对外产出         | 完整快照 AssistantMessage    | 完整快照 AssistantMessage ✅**相同**           |
> | 输入             | 扁平 delta chunk             | 类型化 event（状态机）                               |
> | 内部状态         | 3 字段 + usage               | `blocks` Map + 2 token 数 + `hasFinalUsage` 布尔 |
> | 块的创建         | 懒创建（遇到就建）           | 显式（`content_block_start`）                      |
> | 增量识别         | 靠字段存在性推断             | 靠`delta.type` 标签                                |
> | 工具参数拼接     | `arguments +=`             | `partialJson +=` ✅ **同理**                 |
> | 残缺 JSON 策略   | 中途**扣留**、终态兜底 | **始终吐出**（id/name 已全）                   |
> | usage/流结束哨兵 | `usage !== undefined`      | `hasFinalUsage` 布尔                               |
> | signature        | 无                           | `signature_delta` 累积 + 附着                      |
>
> **对外那两行（接口 + 产出）纹丝不动，内部几乎每一格都不同**——这就是 [第 3 节](./03-model.md) `ModelProvider` 抽象「换厂商、上层不改」的**微观证据**：`Model.stream` 和 [第 5 节](./05-react-loop.md) 的 `_think` 只认「`push`/`snapshot`/完整快照」这个接口，**它们根本不知道、也不需要知道**下面接的是「扁平 delta」还是「事件状态机」。**抽象的价值，就在这张表『左右两列的上半截相同、下半截迥异』里体现得淋漓尽致。**

### 1.8 装配与全景：一协议一 provider，二者殊途同归

零件都看完了，最后看它**怎么被接进系统**，并把「共性 vs 差异」收进一张全景图。

**先看装配**（[cli/index.tsx L44-L62](../../src/cli/index.tsx#L44-L62)）——这正是第 16 节 1.8 见过的那段分流代码，现在我们看**它的另一半**：

```ts
let provider: ModelProvider;
if (entry.provider === "anthropic") {
  provider = new AnthropicModelProvider({ baseURL: entry.baseURL, apiKey: entry.APIKey });  // ← 本节的主角
} else {
  provider = new OpenAIModelProvider({ baseURL: entry.baseURL, apiKey: entry.APIKey });      // ← 第 16 节 + 兼容生态
}
const model = new Model(entry.name, provider, { max_tokens: 16 * 1024, thinking: { type: "enabled" } });
```

**注意那个 `if/else` 的极简**——**整个系统里「厂商差异」的分流，就浓缩在这一个 `if` 里**。除了这一处 `new XxxModelProvider`，**上面所有层（`Model`、Agent、中间件、工具、CLI/TUI）没有任何一行代码关心「现在接的是哪家」**。这就是 [model-providers.ts](../../src/cli/model-providers.ts) 里 `providerType` 字段的用武之地：注册表里 11 个厂商，只有 Anthropic 是 `providerType: "anthropic"`（走 `AnthropicModelProvider`），其余 10 家都是 `"openai"`（走 `OpenAIModelProvider` + 兼容生态，第 16 节 1.8 详解）。

**再注意那行 `new Model(...)` 传的 options**：`{ max_tokens: 16*1024, thinking: { type: "enabled" } }`——**这就是 1.3 讲 `budget_tokens` 自动推导时说的「上层只表达朴素意图」的现场**。上层在这里只说「我要 16K 上限、开思考」，它**完全不知道** Anthropic 还需要 `budget_tokens`、需要 `system` 抽取、thinking 需要 signature……**这些厂商差异，全被 `AnthropicModelProvider` 在内部消化了**。同一个 `Model` 配置、同一份 options，喂给 OpenAI provider 就走 OpenAI 那套，喂给 Anthropic provider 就走 Anthropic 那套——**上层「一份意图」，provider「各自翻译」**。

**最后把本节的「共性 vs 差异」连成一张全景图：**

```
┌─────────────────────────────────────────────────────────────────────────────────────┐
│  上层（Model / Agent / _think）: for await (snapshot of model.stream(context))         │
│  —— 只认 ModelProvider 契约：invoke/stream + 完整快照。不知道下面接的是谁。（纯共性）  │
└───────────────────────────────────────┬───────────────────────────────────────────────┘
                          cli/index.tsx 的一个 if/else 分流（唯一「知道厂商」的地方）
                    ┌────────────────────┴─────────────────────┐
                    ▼                                          ▼
┌──────────────────────────────────┐      ┌──────────────────────────────────────────┐
│ OpenAIModelProvider（第 16 节）   │      │ AnthropicModelProvider（本节）             │
│ · baseURL 原样透传（服务近十家）  │      │ · baseURL 等于默认就不传        ← 差异④   │
│ · _baseChatCompletionParams       │      │ · _baseMessageParams                       │
│   temperature:0                   │      │   extractSystemPrompt（system 抽顶层）← ① │
│                                   │      │   max_tokens 必填 / budget_tokens 推导 ← ⑤ │
├──────────────────────────────────┤      ├──────────────────────────────────────────┤
│ utils.ts（3 函数）                │      │ utils.ts（4 函数，多 extractSystemPrompt） │
│ · system/user 原样透传            │      │ · system 跳过、user 重建(image 结构不同)   │
│ · assistant 拆 3 字段             │      │ · assistant 内容块数组（input 保持对象）   │
│ · tool 一拆多 role:tool           │      │ · tool 合并 role:user（tool_use_id 保名）  │
│ · tool_use.input: JSON.stringify  │      │ · tool_use.input: 直接对象（不转）  ← 差异 │
│                                   │      │ · thinking 带 _anthropicSignature   ← ③   │
├──────────────────────────────────┤      ├──────────────────────────────────────────┤
│ stream-utils.ts: StreamAccumulator│      │ stream-utils.ts: StreamAccumulator         │
│ · 消费扁平 delta，按 index 归组   │      │ · 消费事件序列，状态机（switch）    ← ②   │
│ · 残缺 JSON 中途扣留、终态兜底    │      │ · 残缺 JSON 始终吐出（id/name 已全）       │
│ · usage 一次到齐（哨兵=有无 usage）│      │ · usage 分两批（哨兵=hasFinalUsage 布尔）  │
├──────────────────────────────────┤      ├──────────────────────────────────────────┤
│ types.ts（交叉类型补 reasoning）  │      │ （无 types.ts —— signature 走运行期属性）  │
│ index.ts（桶）                    │      │ index.ts（桶）                             │
└──────────────────┬───────────────┘      └──────────────────┬─────────────────────────┘
                   │                                          │
                   └──────────────► 都产出统一的「完整快照 AssistantMessage」◄──────────┘
                                     （殊途同归：上层拿到的东西一模一样）
```

**一句话总括本节主题**：**`AnthropicModelProvider` 是 [第 3 节](./03-model.md) `ModelProvider` 契约的第二个真实实现。它照抄了第 16 节立下的「薄壳 + 静态翻译 + 动态累积」三件套骨架（共性），却在每一处协议接触面上各表一枝（差异）——① system 抽成顶层参数、② 流式累积器是消费事件序列的状态机（而非扁平 delta）、③ 思考链靠 `_anthropicSignature` 运行期属性携带 signature 往返（而非 `types.ts` 补丁）、④ baseURL 等于默认就不传、⑤ 一组 Anthropic 独有的参数归一（max_tokens 必填、budget_tokens 推导、空 tools 更严省略）。而无论内部如何殊途，两个 provider 最终都『同归』于同一件产出——第 3 节约定的「完整快照 AssistantMessage」，让上层「换厂商、代码一行不改」。至此，Helixent 的两大 wire 协议阵营（OpenAI 兼容 + Anthropic）全部就位，那台从第 5 节造好的 Agent 机器，拥有了两条可自由切换的真实动力源。**

---

## 2. 亮点与关键设计

明确标注哪些是「妙笔」、哪些是「关键决策」——本节的亮点大多是**「对照式」的**：不是孤立地看一处设计，而是看它「相对第 16 节 OpenAI 差在哪、为什么」。

1. **【核心妙笔·对照】两个 `StreamAccumulator` 同名同接口、内部却是两台机器。** OpenAI 的累积器消费「扁平 delta」（线性累加、按 index 懒建条目），Anthropic 的是「事件状态机」（`switch(event.type)` + 显式开块 + 类型化 delta）。但**两者对外都只有 `push` / `snapshot`、都吐「完整快照」**。这是 [第 3 节](./03-model.md) `ModelProvider` 抽象「换厂商上层不改」最有力的微观证据——**接口是焊死的共性，实现是自由的差异**（1.7）。
2. **【关键决策·差异①】`system` prompt 抽成顶层参数（`extractSystemPrompt`）。** Anthropic 的 Messages API 不允许 `system` 待在 messages 数组里，必须作为顶层参数。于是 Anthropic 的 utils 比 OpenAI **多一个函数** `extractSystemPrompt`，配合 `convertToAnthropicMessages` 里的 `continue` 跳过 system。**「多出来的这个函数」本身，就是「协议差异催生代码差异」的最直白标本**（1.3、1.4）。
3. **【核心妙笔·差异③】`signature` 用「运行期附着属性」`_anthropicSignature` 承载，不污染 Foundation 类型。** Anthropic 的 thinking 块在多轮对话里必须回传 `signature`，但这是纯厂商细节。Helixent 选择把它作为一个下划线私有属性挂在内部 thinking 对象上（入站存、出站取），**让 Foundation 的 `ThinkingContent` 类型对此一无所知**。这与 OpenAI 用 `types.ts` 交叉类型「在类型层扩展 `reasoning_content`」形成对比——**两种「携带厂商特有数据」的手法，各有适用场景**（1.4、1.5、Q3）。
4. **【关键决策·差异⑤】`thinking.budget_tokens` 自动推导为 `max_tokens` 的 80%。** Anthropic 开启思考时强制要求 `budget_tokens`，但上层（CLI）只传了 `thinking: { type: "enabled" }`。provider 检测到「开思考但没给预算」时自动补齐（留 20% 给正式作答）。**这是「适配层默默吸收厂商强制约束、让上层保持朴素意图」的典范**（1.3、Q4）。
5. **【妙笔·同中有异】残缺工具 JSON 的处理，两家「底线同、策略异」。** 都不把残缺 JSON 当 input（都 `{}` 兜底，共性）；但 OpenAI **流式中途扣留** tool_use（因 id/name 也可能残缺），Anthropic **始终吐出**（因 `content_block_start` 已确定 id/name）。**这说明「协议的信息量直接影响累积器的最优策略」——不是谁更严谨，而是各自协议下的最优解不同**（1.7，Q2）。
6. **【关键决策·差异④】`baseURL` 等于默认值就不传，让 SDK 自己构造 URL。** 与 OpenAI「原样透传」相反。因为 Anthropic provider 主要服务 Claude 官方（默认 URL 是主场景），而 OpenAI provider 要服务近十家兼容厂商（传 baseURL 是主场景）。**同一个参数，两种处理，根源是两个 provider 的『定位』不同**（1.2）。
7. **【一致性·共性】`invoke`/`stream` 共享参数构建、成对镜像翻译、`toJSONSchema()` 工具转换——三处骨架照抄第 16 节。** `_baseMessageParams`（对应 `_baseChatCompletionParams`）、出入两函数的可逆镜像、`convertToAnthropicTools` 站在 `toJSONSchema()` 上——这些**共性**证明了「第二个 provider 是填空题而非问答题」：抽象立得越好，新实现要写的「自由部分」越少（1.2、1.6）。
8. **【妙笔·差异②的连锁反应】usage 从「一字段两用」变成「两数值 + 一布尔哨兵」。** OpenAI 的 usage 一次到齐，`usage !== undefined` 既是统计又是流终止信号。Anthropic 的 usage 分两批到达（`message_start` 给 input、`message_delta` 给 output），于是必须拆成 `inputTokens`/`outputTokens` 两个累计值 + 一个独立的 `hasFinalUsage` 布尔。**一处协议差异（事件序列），会连锁引发状态设计的差异**（1.7）。
9. **【妙笔·内容块范式的红利】Anthropic 的「内容块数组」比 OpenAI「扁平字段」更贴近内部 `content` 数组。** assistant 的 text/thinking/tool_use 在 Anthropic 里都是并列的内容块（和内部分段数组同构），所以 assistant 翻译反而比 OpenAI「三段拆三字段」更直白。**这提示一个洞察：内部模型「贴近谁」是相对的——它贴近 OpenAI 的 wire（system/user 原样透传），却在结构范式上更像 Anthropic（内容块数组）**（1.4、1.5）。

---

## 3. 工业对比

对比业界方案的做法与优缺点。本节的对比，重心从第 16 节的「单个 provider 怎么设计」上升到「**多个 provider 如何共存、多厂商适配有哪几种范式**」。

### 3.1 「每种 wire 协议一个 provider」 vs 「一个万能适配器」

有了两个 provider，我们终于能回答一个第 16 节没法回答的问题：**Helixent 面对「多厂商」，选择的是哪种架构范式？**

- **Helixent 的做法——「一协议一 provider，共享一份内部 Message」**：为 OpenAI-wire 写一个 `OpenAIModelProvider`、为 Anthropic-wire 写一个 `AnthropicModelProvider`，两者都 `implements` 同一个 `ModelProvider` 契约、都把内部统一的 `Message` 翻译成各自的 wire。**新增一种 wire 协议 = 新增一个 provider 文件夹**（照抄三件套骨架、填入协议差异）。
- **另一种常见做法——「一个万能适配器 + 配置驱动」**：写一个巨大的 `UniversalProvider`，内部用 `if (vendor === "openai") {...} else if (vendor === "anthropic") {...}` 分派。**新增厂商 = 在这个大类里加一堆分支**。

**Helixent 的选择明显更优，本节就是活证据：** 如果把 OpenAI 和 Anthropic 的逻辑塞进一个类，你会得到一个「system 有时抽有时不抽、input 有时 stringify 有时不 stringify、流式有时是 delta 有时是 event」的**巨型分支泥潭**——两套逻辑的每一处差异都要用 `if` 缝在一起。而「一协议一 provider」让**每个 provider 内部都是『单一协议的干净实现』**：`AnthropicModelProvider` 里没有一行 `if (openai)`，它只关心「怎么把内部 Message 翻译成 Anthropic wire」。**代价是「两个文件夹有相似的骨架」（三件套结构重复），但这个重复是良性的**——它换来了「每个 provider 内聚、可独立测试、可独立演进」。**本节 1.7 那张『接口相同、实现迥异』的表，正是这个架构范式的最好注脚：共性靠契约锁定，差异靠独立实现容纳。**

### 3.2 Helixent「两个 provider」 vs LangChain 的 `ChatOpenAI` / `ChatAnthropic`

LangChain 也是「一厂商一个类」（`ChatOpenAI`、`ChatAnthropic`、`ChatGoogleGenerativeAI`…），看起来和 Helixent 一样。但**内部机制有一处关键差异**：

- **LangChain**：每个 Chat 模型类**各自定义**如何把 LangChain 的 `BaseMessage` 转成自家格式、如何把流式转成 `AIMessageChunk`。它的「统一层」是 `BaseMessage` / `AIMessageChunk`，但**流式对外仍是「增量 chunk」**，消费方要 `concat`（第 16 节 3.2 讲过）。
- **Helixent**：统一层是内部 `Message` / `AssistantMessage`，且**流式对外是「完整快照」**（累积在 provider 内完成）。**所以 Helixent 的两个 provider 有一个 LangChain 没有的额外约束——都必须内部实现一个「把碎片拼成快照」的 `StreamAccumulator`**（无论 delta 还是 event）。

**取舍**：LangChain 覆盖的厂商多得多（几十上百个 integration），生态庞大；但「增量 chunk」语义把累加负担丢给了每个消费点。Helixent 只做两个 provider（+ OpenAI 兼容生态），覆盖面窄，但「完整快照」语义让**消费端（`_think`）极简到一行 `latest = snapshot`**。**关键在于两者的『消费点 vs provider 数量』权衡不同**：LangChain 面向「无数种消费场景」，选择把累加做成通用工具交给用户；Helixent 面向「自己那个固定的 Agent 循环」，选择在少数 provider 内部就把快照拼好。**本节 Anthropic 的事件状态机累积器，正是为兑现『完整快照』这个自定约束而必须写的——这是 Helixent 比 LangChain『每个 provider 多干的一件事』，也是它换来消费端极简的代价。**

### 3.3 `signature` 运行期附着 vs 「为每个厂商特性扩展统一模型」

「模型返回了一个『我们内部模型里没有的字段』（如 Anthropic 的 `signature`、OpenAI 兼容厂商的 `reasoning_content`）该怎么办」——这是所有适配层都要面对的问题。业界（和 Helixent 内部）有几种典型答法：

- **答法 A：扩展统一模型（往 `ThinkingContent` 加 `signature?` 字段）**。简单直接，但**污染核心类型**——OpenAI provider、未来所有 provider 都会看到一个跟自己无关的 `signature` 字段，语义上「不属于这里」。
- **答法 B：类型层交叉扩展（OpenAI 的 `types.ts` 做法）**。用 `官方类型 & { reasoning_content }` 在**适配层内部**扩展，不动核心类型。适合「这个字段要在适配层的多个函数间正经传递、且希望有类型检查」。
- **答法 C：运行期属性附着（Anthropic 的 `_anthropicSignature` 做法）**。把厂商特有数据作为一个下划线私有属性**挂在对象上**，靠 `as unknown` 绕过类型。适合「这个字段只是要『原样存、原样还』的透传数据，不参与任何逻辑运算」。

**Helixent 在两个 provider 里分别用了 B 和 C，这个「同一团队、两种答法」的对照极具教学价值**：**不是 B 比 C 好或反之，而是看数据的『性格』**。`reasoning_content` 在 OpenAI provider 里要被 `convertToOpenAIMessages`（写）、`parseAssistantMessage`（读）、`StreamAccumulator`（累积）**多处读写**，值得用 `types.ts` 换来类型安全（答法 B）。而 `signature` 对 Helixent 而言**是纯粹的「黑盒透传物」**——provider 从不解读它，只负责「入站存进对象、出站从对象取出还给 Anthropic」，为这么个透传物专门建类型/文件不划算，运行期附着（答法 C）更轻。**取舍的标尺是：这个厂商特有数据,『参与逻辑』还是『纯透传』？参与逻辑就上类型（B），纯透传就运行期附着（C）。** 而两种答法**共同拒绝了答法 A**（污染核心）——这才是分层的底线（Q3 详谈）。

### 3.4 「显式事件流」 vs 「隐式增量流」：两种流式协议设计哲学

跳出 Helixent，看 OpenAI 和 Anthropic **两家 API 厂商自己的流式协议设计**，本身就是一组值得玩味的工业对比：

- **OpenAI 的「隐式增量流」**：所有 chunk 同构（`choices[0].delta`），靠「字段有没有值」和「`index`」推断语义。**优点**：协议简单、chunk 结构统一、解析代码短。**缺点**：语义靠推断（「这个 chunk 是文本还是工具？」要看哪个字段非空），且「一个逻辑单元（如 tool_call）何时开始、何时结束」没有明确边界——累积器只能靠「JSON 能不能 parse」来间接判断工具参数是否完整（第 16 节 1.7 的扣留逻辑正是为此）。
- **Anthropic 的「显式事件流」**：`content_block_start` / `_delta` / `_stop` 明确标出每个内容块的生命周期，delta 自带 `type` 标签。**优点**：语义显式（一看事件类型就知道在干什么）、块边界清晰（`start` 就知道 id/name、`stop` 就知道结束）——所以累积器能「大方地」尽早吐出身份明确的 tool_use（1.7）。**缺点**：协议更复杂、事件种类多、累积器要写成状态机（`switch`）。

**没有绝对优劣，是两种设计哲学**：OpenAI 追求「协议极简」（chunk 越统一越好，复杂度丢给消费方推断），Anthropic 追求「语义显式」（协议自带结构，消费方少猜）。**Helixent 的两个 `StreamAccumulator` 就是这两种哲学的『下游承受者』**——一个写成「线性累加 + 靠 parse 判断完整性」，一个写成「事件状态机 + 靠 start 事件拿身份」。**读这两个累积器，你其实在读两家公司对『流式协议该显式还是该简约』的不同回答**——而 Helixent 用同一个 `push`/`snapshot` 接口把两种哲学都收编了。

### 3.5 一览表

| 维度               | Helixent（一协议一 provider）        | 万能适配器（if 分支） | LangChain（一厂商一类） | LiteLLM/网关     |
| ------------------ | ------------------------------------ | --------------------- | ----------------------- | ---------------- |
| 新增厂商成本       | 加一个 provider 文件夹（照抄骨架）   | 在大类里加分支        | 加一个 integration      | 网关侧适配       |
| 单 provider 内聚性 | **高（单协议干净实现）**       | 低（多协议缠绕）      | 高                      | 不涉及（在网关） |
| 流式对外语义       | **完整快照**                   | 视实现                | 增量 chunk              | 视底层           |
| 厂商特有数据       | 类型扩展 / 运行期附着（分场景）      | 常污染统一模型        | 各 integration 各异     | 网关归一         |
| 覆盖面             | 两大协议 + 兼容生态                  | 视实现                | **极广**          | **极广**   |
| 额外依赖           | 仅两家官方 SDK                       | 视实现                | 全家桶                  | 网关             |
| 契约共性保证       | **`ModelProvider` 接口焊死** | 靠自觉                | `BaseChatModel` 基类  | 网关 API         |

---

## 4. 深度解释：为什么这样设计？不这样会怎样？

用 Q&A 形式讲清几个「为什么」，以及「不这样会出什么问题」。本节的 Q&A 大多围绕「差异」展开——**因为『共性』第 16 节已经论证透了，本节的增量价值在于讲清『为什么两家要不一样』**。

### Q1：为什么两家的 `StreamAccumulator` 不抽一个公共基类？明明都有 `push`/`snapshot`、都拼工具 JSON、都用哨兵判断 streaming——这不是重复吗？

**不该抽——因为两者『共享的是接口（`push`/`snapshot` 的签名与语义），而非实现（怎么 push、怎么 snapshot）』。强行抽基类，会把两套本质不同的累积逻辑硬缝在一起，得不偿失。**

先看「像」在哪、又「不像」在哪。表面上两个累积器都有 `push`/`snapshot`、都拼 arguments、都判断 streaming——但**这些「像」全在『对外契约』层面**（因为它们都实现同一个 `ModelProvider.stream` 的隐含要求）。往内部一寸，就全不一样了：

- **`push` 的输入类型不同**：一个收 `OpenAIChatCompletionChunk`（扁平 delta），一个收 `Anthropic.RawMessageStreamEvent`（事件联合）。**这俩类型毫无公共父类**，`push` 的函数体也一个是「线性检查字段」、一个是「`switch` 分派」。
- **内部状态结构不同**：一个是「3 个字段 + usage」，一个是「`blocks` Map + 2 数值 + 布尔」。**没有公共状态可以提到基类**。
- **连「拼工具 JSON」这个最像的点，落地也不同**：一个在 `toolCalls` Map 的 entry 上 `arguments +=`，一个在 `blocks` Map 的 tool_use 块上 `partialJson +=`；一个「中途扣留」，一个「始终吐出」。

**如果强行抽一个 `BaseStreamAccumulator`**，你能提取的「公共部分」少得可怜（也许就一个 `sort by index`、一个 `streaming` 标记的三元表达式），却要为此付出沉重代价：基类得用泛型容纳两种 chunk 类型、得留一堆 `abstract` 方法给子类填、`push` 因为一个是线性一个是 switch 根本没法共享……**最后你会得到一个「为了复用 5 行、引入 50 行抽象脚手架」的糟糕设计**。

**这正是 [第 15 节 Q4](./15-human-in-the-loop.md)「两个 Manager 95% 相同却不抽基类」、[第 16 节 Q4](./16-openai-provider.md)「invoke/stream 看似重复实则不同」的同一种判断，在本节的第三次印证**：**DRY 要消除的是『重复的知识』，不是『长得像的代码』。** 两个累积器「长得像」（都叫 push/snapshot），但它们承载的**知识**（怎么消费 OpenAI 的 delta vs 怎么消费 Anthropic 的事件流）是**两份完全不同的知识**。让它们各自独立、只共同遵守 `ModelProvider` 这个**接口契约**，才是对的——**共性用『接口』表达（`implements ModelProvider`），而非用『继承』表达（`extends BaseProvider`）。这也是「组合优于继承」「面向接口而非实现」在本项目的一次教科书示范。**

**「不这样（强行抽基类）会怎样」**：将来接第三家（比如 Gemini，又是另一种流式协议），这个勉强的基类会被第三种协议撑爆——要么基类越来越臃肿（塞进三种协议的公约数），要么第三个子类被迫扭曲自己去适配基类。**而「一协议一独立累积器」的方案，接第三家就是『再写一个独立累积器』，互不干扰**。独立，反而是最可扩展的。

### Q2：Q1 说两家累积器策略不同——OpenAI 流式中途「扣留」残缺 tool_use，Anthropic 却「始终吐出」。同一个团队写的，为什么标准不统一？是不是 Anthropic 那个写得不够严谨？

**不是不严谨，而是『两家协议给的信息量不同，导致最优策略不同』。判断一个 tool_use 该不该吐出，取决于『它的身份（id/name）是否已确定』——而这一点，两家协议的『确定时机』截然不同。**

把「吐出一个 tool_use」的**前提条件**想清楚：下游（[第 6 节](./06-parallel-tools.md) 的并行调度、[第 5 节](./05-react-loop.md) 的进度渲染）拿到一个 tool_use，至少要能**识别它是谁**（`id` 用于关联结果、`name` 用于知道调哪个工具）。所以「能不能吐」的关键是——**这个 tool_use 的 `id` 和 `name` 齐了没有？**

- **Anthropic：id/name 在 `content_block_start` 事件里『一次性给全』**（1.7 的 `_handleBlockStart`：开 tool_use 块时 `id` 和 `name` 立刻确定，只有 `partialJson` 待填）。**所以只要一个 tool_use 块开始了，它的身份就是完整的**——哪怕 `input` 暂时是 `{}`（参数还在拼），吐出去也是一个「身份明确、参数待定」的合法调用，下游能识别「模型要调 bash，参数马上到」。**既然身份已定，就没必要扣留**——始终吐出，反而让下游更早看到「有个工具要来了」。
- **OpenAI：id/name 也可能『分碎片来』**（第 16 节 1.7 提到 id/name 是「来了就覆盖」，意味着它们不保证在第一个 chunk 就齐）。流式极早期，一个 tool_call 可能 `id` 和 `name` **都还是空的**。**此时吐出一个 `{id:"", name:"", input:{}}` 的 tool_use，就是个『三无产品』——下游既不知道调什么、也没法关联结果，纯噪声。** 所以 OpenAI 累积器选择「扣留到 JSON 能解析（意味着参数齐了，通常 id/name 也早齐了）为止」，更稳妥。

**看清了吗？两家的策略差异，根源是『身份信息的确定时机』不同**——Anthropic 靠「显式开块事件」让身份**早早确定**（于是能大方吐出），OpenAI 因为身份也可能**渐进到达**（于是要谨慎扣留）。**这不是「谁更严谨」的问题，而是「在各自协议给的信息约束下，什么是最优解」的问题。** 两者的**共同底线是一致的**——都绝不把「残缺的 JSON」当合法 input（都用 `{}` 兜底）；差异只在「身份已定但参数暂缺的 tool_use，要不要提前给下游看」，而这恰恰由协议决定。

**「不这样会怎样」**：如果 Anthropic 也照搬 OpenAI 的「扣留」逻辑，它会**平白牺牲一个优势**——本可以让下游早早知道「有个 bash 要来」（利于进度提示、利于下游提前准备），却非要等参数拼完才吐，晚了几帧、体验更差，且毫无收益（因为身份本来就是全的，扣留防不住任何「噪声」）。反过来，如果 OpenAI 照搬 Anthropic 的「始终吐出」，它就可能在流式早期吐出 `{id:"", name:""}` 的三无 tool_use，**污染下游**。**所以『因协议而异』恰恰是严谨的表现——严谨不是『所有地方用同一套规矩』，而是『针对每种情况用最合适的规矩』。**

### Q3：`reasoning_content`（OpenAI）用 `types.ts` 类型补丁，`signature`（Anthropic）用运行期属性 `_anthropicSignature`——都是「厂商特有字段」，为什么同一个项目里用两种截然不同的手法？

**因为这两个字段的『性格』不同：`reasoning_content` 是『要在适配层内部多处正经读写、值得类型安全』的字段，`signature` 是『纯黑盒透传、provider 从不解读』的字段。手法的选择，服从于数据的性格，而非追求形式统一。**

先把两个字段的「一生」摊开对比：

**`reasoning_content` 在 OpenAI provider 里的一生**（第 16 节 1.3/1.4/1.7）：

- **出站**：`convertToOpenAIMessages` 要**写**它（thinking → reasoning_content）。
- **入站**：`parseAssistantMessage` 要**读**它（reasoning_content → thinking）。
- **流式**：`StreamAccumulator` 要从 `delta.reasoning_content` **累积**它。
- **它在三个函数里被正经读写，且每次读写都希望『写错字段名时编译器能报错』。** → **值得用 `types.ts` 交叉类型给它一个正式的类型身份（答法 B）**，换来全程类型检查。

**`signature` 在 Anthropic provider 里的一生**（1.4/1.5/1.7）：

- **入站**：`parseAssistantMessage` 把 `block.signature` **原封不动**存进 `_anthropicSignature`。
- **出站**：`convertToAnthropicMessages` 把 `_anthropicSignature` **原封不动**取出来还给 Anthropic。
- **provider 从头到尾『不解读、不运算、不依赖』它的值**——它就是个「Anthropic 发来、下轮要还给 Anthropic」的黑盒令牌。
- **它不参与任何逻辑，只需要『存得住、取得回』。** → **不值得为它建一个类型/文件，运行期挂个属性（答法 C）最轻便**。

**这就是「同项目两手法」的答案——不是不统一，而是精准匹配数据性格**：一个字段「深度参与逻辑、多处读写」，就给它类型身份（B）；一个字段「纯透传、零解读」，就运行期附着（C）。**若强行统一成一种手法，反而更糟**：

- 若 `signature` 也照 `reasoning_content` 建一个 `types.ts`——为一个「provider 根本不看内容」的透传物，专门造一套类型 + 一个文件，是**过度工程**。
- 若 `reasoning_content` 也照 `signature` 用运行期属性（`as any` 到处飞）——它在三处被读写，失去类型检查后，**写错字段名、拼错大小写都不会报错**，是**埋雷**。

**而两种手法有一个『共同的、不可退让的底线』——都绝不把厂商字段塞进 Foundation 的 `ThinkingContent`（答法 A）。** 这才是本题最重要的洞察：**无论 B 还是 C，它们都把「厂商特有」这件事严格关在了 `src/community/xxx/` 这一层内部**，让 [第 1 节](./01-overview.md) 的 `ThinkingContent`（Foundation 层）保持纯净——它永远只有 `{ type, thinking }`，既不知道 `reasoning_content`，也不知道 `signature`。**「用什么手法携带厂商数据」是战术（可以因字段而异），「绝不污染核心类型」是战略（绝不动摇）。** 这正是第 16 节 Q3 那句「判断一个 hack 该不该存在，关键看它有没有被限制在正确的层里」的延续——本节更进一步：**即便在正确的层里，也要根据数据性格选择最贴切的携带手法。**

### Q4：`budget_tokens` 自动推导（本节）和 `reasoning_content` 类型补丁（第 16 节）——这两处「适配层的贴心」，本质是同一件事吗？

**是——它们是同一种分层哲学的两个侧面：『适配层主动吸收厂商的特殊性，让上层只需表达朴素、统一的意图』。一个吸收『厂商的强制要求』，一个吸收『厂商的非标准返回』，方向相反，本质相同。**

把两处并排看，你会发现它们是一对「镜像」：

|                    | `budget_tokens` 推导（本节 1.3）                  | `reasoning_content` 补丁（§16 1.6）                           |
| ------------------ | --------------------------------------------------- | ---------------------------------------------------------------- |
| 吸收的是           | 厂商的**强制输入要求**（开思考必须给 budget） | 厂商的**非标准输出字段**（兼容厂商返回 reasoning_content） |
| 方向               | **出站**（请求发出前补齐）                    | **双向**（出站写、入站读）                                 |
| 上层的「朴素意图」 | 「我要开思考」（`type: "enabled"`）               | 「有一种内容叫 thinking」                                        |
| 适配层做的「脏活」 | 自动算一个 budget 补进请求                          | 把 reasoning_content 翻译成内部 thinking                         |
| 上层是否感知       | **完全无感**                                  | **完全无感**                                               |

**共同的本质是——『意图向下、脏活留层』**：上层（Agent、CLI）只表达**跨厂商统一的朴素意图**（「开思考」「有 thinking 内容」），而**每家厂商为实现这个意图所需的特殊操作**（Anthropic 要 budget、OpenAI 兼容厂商用 reasoning_content 字段），全部被**关进各自的 provider 内部消化**。这样一来，**上层的代码对『接的是哪家』完全免疫**——`cli/index.tsx` 里那句 `thinking: { type: "enabled" }`，无论下面接 OpenAI 还是 Anthropic 都原样能用，差异被 provider 吸收了。

**这正是 [第 1 节](./01-overview.md)「`community` 层作为可插拔适配器隔离第三方 SDK」的深层含义**——「隔离」不只是「隔离 SDK 的 import」，更是**隔离「每家厂商的脾气」**：厂商 A 要你多传个参数、厂商 B 返回个怪字段、厂商 C 要求签名回传……**这些五花八门的「脾气」，全被适配层一一吸收，好让上面的世界保持简单而统一。**

**「不这样会怎样」**：假设 provider **不**吸收这些差异，而是「透明地」把厂商要求暴露给上层。那么 `cli/index.tsx` 就得写成「如果是 Anthropic，记得补 budget_tokens；如果是 OpenAI 兼容，注意 reasoning_content 字段；如果是 Anthropic，thinking 要存 signature……」——**上层被迫成为「所有厂商差异的百科全书」**，每接一家新厂商，上层都要改。这就是「细节泄漏」的灾难。**而『意图向下、脏活留层』让新厂商的接入成本被牢牢摁在『一个 provider 文件夹』内**——这是本节（乃至整个 community 层设计）最值得带走的一条工程原则。

### Q5：本节反复强调「共性靠契约、差异靠实现」。如果明天要接第三家厂商（比如 Google Gemini），根据本节的规律，我大概要写什么、不用写什么？

**根据本节总结的规律，你会『照抄一套三件套骨架（共性），填入 Gemini 的协议差异（差异）』——而完全不用碰上面任何一层。这道『填空题』的边界，正是本节两个 provider 对照出来的规律。**

**你『不用写、也不用改』的（因为是共性，被契约焊死）：**

- **`ModelProvider` 契约本身**（[第 3 节](./03-model.md)）：`invoke`/`stream` 的签名、「完整快照」约定、`streaming` 打标规则——照着实现即可，一个字不改。
- **上面所有层**：`Model`、Agent 循环、中间件、工具、CLI/TUI——它们只认契约，对新 provider 零感知。你**唯一要碰的「上层」，是 `cli/index.tsx` 那个 `if/else` 加一个分支**（以及 `model-providers.ts` 注册表加一行），仅此而已。
- **内部 `Message` / `AssistantMessage` 类型**：保持中立、纯净，绝不为 Gemini 加字段（Q3 的战略底线）。

**你『必须写』的（因为是差异，Gemini 的协议自有脾气）——照本节的「五处差异」清单逐一回答 Gemini 是怎样的：**

- **`model-provider.ts`（薄壳）**：照抄骨架，然后回答——Gemini 的 `baseURL` 要不要特殊处理（差异④）？有没有类似 `budget_tokens`/`max_tokens` 的强制参数要归一（差异⑤）？
- **`utils.ts`（翻译）**：回答——Gemini 的 system prompt 放哪（差异①，Gemini 用 `systemInstruction`，又是一种放法，得写个类似 `extractSystemPrompt` 的抽取）？它的 message/content 结构长啥样（user/assistant/tool 各怎么翻译）？工具参数走字符串还是对象？思考链（如果有）怎么表达？
- **`stream-utils.ts`（累积）**：回答——Gemini 的流式是扁平 delta 还是事件序列（差异②）？据此把 `StreamAccumulator` 写成「线性累加」还是「状态机」？它的 usage 一次到齐还是分批（决定用 `usage!==undefined` 还是布尔哨兵）？残缺工具 JSON 时能不能尽早拿到 id/name（决定「扣留」还是「始终吐出」）？
- **厂商特有字段**：如果 Gemini 有什么特殊透传物，按 Q3 的标尺判断——参与逻辑就上类型（B）、纯透传就运行期附着（C）。

**看出来了吗？** 本节（配合第 16 节）实际上为你**提炼出了一张「接入新厂商的检查清单」**——它就是那「五处差异」。**接第三家、第四家厂商，本质上就是『拿着这张清单，逐项回答新厂商是怎样的』**。这就是「先范本、后对照」教学法的最终目的：**第 16 节给你看『一个 provider 的完整长相』，第 17 节带你对照出『provider 之间会在哪五个关节处产生差异』——两节合起来，你手里就有了一张可复用的、接入任意新厂商的地图。** 这，也正是 `ModelProvider` 这个抽象最大的价值：**它把「接入一家新厂商」从一道开放的『问答题』，收敛成了一道边界清晰的『填空题』。**

---

## 5. 参考资料

**本节精讲的源码（四个文件）**：

`src/community/anthropic/`：

- [model-provider.ts](../../src/community/anthropic/model-provider.ts)（88 行）——`AnthropicModelProvider` 编排壳
  - 构造函数（`baseURL` 等于默认就不传，差异④）：[L19-L27](../../src/community/anthropic/model-provider.ts#L19-L27)
  - `invoke`（非流式：messages.create → parseAssistantMessage）：[L29-L34](../../src/community/anthropic/model-provider.ts#L29-L34)
  - `stream`（流式：messages.create + StreamAccumulator 循环）：[L36-L47](../../src/community/anthropic/model-provider.ts#L36-L47)
  - `_baseMessageParams`（system 抽取、max_tokens 必填、budget_tokens 推导、空 tools 省略，差异①⑤）：[L49-L78](../../src/community/anthropic/model-provider.ts#L49-L78)
  - `toTokenUsage`（wire→internal 用量映射，input/output → prompt/completion）：[L81-L88](../../src/community/anthropic/model-provider.ts#L81-L88)
- [utils.ts](../../src/community/anthropic/utils.ts)（158 行）——四个静态翻译纯函数
  - `extractSystemPrompt`（Anthropic 独有：抽 system 到顶层，差异①）：[L13-L21](../../src/community/anthropic/utils.ts#L13-L21)
  - `convertToAnthropicMessages`（出：system 跳过 / user 重建 / assistant 内容块 / tool 变 role:user）：[L30-L101](../../src/community/anthropic/utils.ts#L30-L101)
  - `parseAssistantMessage`（入：内容块数组 → 内部段，signature 存入 `_anthropicSignature`，差异③）：[L109-L144](../../src/community/anthropic/utils.ts#L109-L144)
  - `convertToAnthropicTools`（工具：`toJSONSchema()` → `input_schema`，共性）：[L152-L158](../../src/community/anthropic/utils.ts#L152-L158)
- [stream-utils.ts](../../src/community/anthropic/stream-utils.ts)（157 行）——`StreamAccumulator` 事件状态机（本节对照重心，差异②）
  - `BlockState` 可辨识联合（text/thinking/tool_use，tool_use 用 `partialJson`）：[L10-L13](../../src/community/anthropic/stream-utils.ts#L10-L13)
  - 状态（`blocks` Map + input/outputTokens + `hasFinalUsage` 布尔哨兵）：[L26-L30](../../src/community/anthropic/stream-utils.ts#L26-L30)
  - `push`（`switch(event.type)` 分派的状态机）：[L32-L51](../../src/community/anthropic/stream-utils.ts#L32-L51)
  - `snapshot`（按 index 保序、hasFinalUsage 决定 streaming 标记）：[L53-L68](../../src/community/anthropic/stream-utils.ts#L53-L68)
  - `_handleBlockStart`（显式开块，tool_use 的 id/name 此时已定）：[L70-L88](../../src/community/anthropic/stream-utils.ts#L70-L88)
  - `_handleBlockDelta`（类型化增量：text/thinking/signature/input_json 各自累加）：[L90-L103](../../src/community/anthropic/stream-utils.ts#L90-L103)
  - `_handleMessageDelta`（收最终 usage、置 hasFinalUsage）：[L105-L114](../../src/community/anthropic/stream-utils.ts#L105-L114)
  - `blockToContent` / `parseToolInput`（块转内容段、残缺 JSON 给 `{}`）：[L130-L157](../../src/community/anthropic/stream-utils.ts#L130-L157)
- [anthropic/index.ts](../../src/community/anthropic/index.ts)（1 行）——桶文件，只导出 `model-provider`

**co-located 测试（[第 21 节](./00-roadmap.md) 会讲这套约定）**：

- [utils.test.ts](../../src/community/anthropic/__tests__/utils.test.ts)——`extractSystemPrompt`（多种拼接）/ 出站四种 role（system 排除、user image、assistant thinking、tool→user）/ 入站解析（含 signature）/ 工具转换
- [stream-utils.test.ts](../../src/community/anthropic/__tests__/stream-utils.test.ts)——text/thinking 累加 / **signature_delta 更新** / tool_use JSON 渐进拼接 / **残缺 JSON 仍吐出 `input:{}`**（与 OpenAI 扣留对比）/ message_start+message_delta 的 usage 合并 / 多块保序 / 忽略无关事件 / 空 text 块过滤

**上游依赖章节**：

- [第 3 节 · Model 与 ModelProvider](./03-model.md)：本节实现的 `ModelProvider` 契约（`invoke`/`stream`、完整快照、`streaming` 打标、`usage` 映射）——本节是这份契约的**第二个真实实现**，与第 16 节共同证明「换厂商上层不改」
- [第 2 节 · Message 消息类型系统](./02-message.md)：内部 `Message` 的四种 role 与内容段——本节的翻译逻辑处处以它为「中立目标格式」（Anthropic 的内容块数组反而比 OpenAI 扁平字段更贴近它）
- [第 4 节 · Tool 工具系统](./04-tool.md)：`parameters.toJSONSchema()`（`convertToAnthropicTools` 与 OpenAI 版共享的调用点，只是包装成 `input_schema`）
- [第 16 节 · OpenAI Provider](./16-openai-provider.md)：**本节的「范本」与全程对照对象**——三件套骨架、`StreamAccumulator` 的 push/snapshot 约定、`reasoning_content` 的 `types.ts` 补丁、`temperature:0` 默认、baseURL 原样透传，都是本节反复对照的基准

**下游承接章节（本节埋的接口）**：

- [第 18 节 · CLI 入口、配置与持久化](./00-roadmap.md)：`AnthropicModelProvider` 如何在 `cli/index.tsx` 被 `if (entry.provider === "anthropic")` 分流实例化、`MODEL_PROVIDERS` 注册表里 Anthropic 的 `providerType` 与 `baseURL`、`baseURL`/`apiKey` 从配置读入
- [第 5 节 · ReAct 主循环](./05-react-loop.md)：`_think` 如何消费本节 `stream` 吐出的快照（`latest = snapshot`）——它对「下面接 OpenAI 还是 Anthropic」完全无感，正是本节「共性」的受益者

**关联源码（本节引用但不精讲）**：

- 契约定义：[model-provider.ts](../../src/foundation/models/model-provider.ts)、[model.ts](../../src/foundation/models/model.ts)（`options` 如何透传到 provider）
- 内部类型：[content.ts](../../src/foundation/messages/types/content.ts)（`ThinkingContent` 只有 `{type,thinking}`——signature 无处安放，故用运行期属性）
- 装配处：[cli/index.tsx L44-L62](../../src/cli/index.tsx#L44-L62)、[model-providers.ts](../../src/cli/model-providers.ts)（11 家厂商，仅 Anthropic 是 `providerType: "anthropic"`）
- 对照实现：[openai/model-provider.ts](../../src/community/openai/model-provider.ts)、[openai/utils.ts](../../src/community/openai/utils.ts)、[openai/stream-utils.ts](../../src/community/openai/stream-utils.ts)、[openai/types.ts](../../src/community/openai/types.ts)（第 16 节精讲，本节全程对照）

**外部资料**：

- Anthropic Messages API（`system` 顶层参数、`max_tokens` 必填、`tools`/`tool_use`/`tool_result`）：[https://docs.anthropic.com/en/api/messages](https://docs.anthropic.com/en/api/messages)
- Anthropic 流式事件（`message_start` / `content_block_start` / `content_block_delta` / `message_delta`）：[https://docs.anthropic.com/en/docs/build-with-claude/streaming](https://docs.anthropic.com/en/docs/build-with-claude/streaming)
- Anthropic Extended Thinking（`thinking.budget_tokens`、thinking 块与 `signature` 的多轮回传）：[https://docs.anthropic.com/en/docs/build-with-claude/extended-thinking](https://docs.anthropic.com/en/docs/build-with-claude/extended-thinking)
- Anthropic TypeScript SDK（`messages.create`、`RawMessageStreamEvent` 类型）：[https://github.com/anthropics/anthropic-sdk-typescript](https://github.com/anthropics/anthropic-sdk-typescript)
- OpenAI vs Anthropic 消息格式差异（system 位置、内容块 vs 扁平字段）：[https://docs.anthropic.com/en/api/openai-sdk](https://docs.anthropic.com/en/api/openai-sdk)（Anthropic 官方的「OpenAI 兼容」说明，反向印证两家差异）

---

## 6. 小结与下一节预告

本节我们拆透了 Helixent 的第二个 `ModelProvider` 实现，并借这次「二次实现」把「多 Provider 的共性与差异」拎成了一条明线——**四个文件、共性骨架、五处差异**：

- **编排壳**（1.2–1.3）：`AnthropicModelProvider` 照抄「薄壳 + `_baseMessageParams` 共享参数」骨架（共性），差异在于 `baseURL` 等于默认就不传（差异④）、`system` 抽成顶层参数（差异①）、以及一组 Anthropic 独有的参数归一——`max_tokens` 必填默认、`thinking.budget_tokens` 自动推导为 80%、空 tools 更严省略（差异⑤）。
- **静态翻译**（1.4–1.6）：`utils.ts` 四个纯函数（比 OpenAI 多一个 `extractSystemPrompt`），依然「出入成对镜像」（共性），但每一路都与 OpenAI 不同——system 跳过、user 的 image 结构重建、assistant 是「内容块数组」（`tool_use.input` 保持对象、无需 stringify/parse）、tool 变成 `role:user` 合并消息、`thinking` 靠 `_anthropicSignature` 运行期属性携带 signature 往返（差异③）。唯 `convertToAnthropicTools` 站在 `toJSONSchema()` 共性能力上，与 OpenAI「只差一层包装」。
- **动态累积**（1.7）：`StreamAccumulator` 与 OpenAI **同名、同接口（`push`/`snapshot`）、同产出（完整快照）**，内部却是一台**事件状态机**（`switch(event.type)` + 显式开块 + 类型化 delta），消费 Anthropic 的「事件序列」而非「扁平 delta」（差异②）；usage 分两批到达故用 `hasFinalUsage` 布尔哨兵；残缺工具 JSON「始终吐出」（因 `content_block_start` 已定 id/name）而非 OpenAI 的「中途扣留」——**底线同、策略异**。
- **一张地图**（1.8、Q5）：本节把「接入新厂商」提炼成一张**五处差异的检查清单**（system 位置 / 流式形态 / 思考链载体 / baseURL 处理 / 参数归一），让接第三、第四家厂商从「问答题」变成「填空题」。

**一条主线**：**`ModelProvider` 契约（第 3 节）的第二个实现落地，让「共性 vs 差异」第一次能被并排验证**——共性（三件套骨架、push/snapshot 接口、成对镜像翻译、完整快照产出）由契约焊死、照抄即可；差异（五处协议接触面）由各 provider 独立容纳、互不缠绕。**这就是第 3 节那句「换一个大模型厂商，Agent 代码一行不改」的全部分量**：不改的是被契约锁定的共性，要改的全被关进 provider 内部。至此，Helixent 的两大 wire 协议阵营（OpenAI 兼容生态 + Anthropic）全部就位，第五部分 · Community 层圆满收官。

**承上启下（启下）**：到这里，一台**完整的 Agent** 已经在代码层面彻底跑通了——**大脑**（第 5–10 节的循环 + 中间件 + 插件）、**双手**（第 11–15 节的编程工具与人机确认）、**动力源**（第 16–17 节的两个真实 Provider），三者齐备。但请注意 [第 15 节](./15-human-in-the-loop.md) 结尾埋下、至今**仍未兑现**的那个空白——两个 Manager（审批、提问）都还在「等一个 UI 来 `subscribe` 并 `respond`」；以及本节 1.8 那个 `cli/index.tsx` 里的分流代码，它读的 `entry.baseURL` / `entry.APIKey` 究竟**从哪来、存在哪、怎么读写**？

**所以下一步，是把这台跑在内存里的 Agent『交到用户手里』**——做成一个**能配置、能对话、能审批**的命令行程序。这正是第六部分的任务，从 [第 18 节](./00-roadmap.md) 的「CLI 入口、配置、命令与设置持久化」开始：你会看到敲下 `helixent` 之后到底发生了什么、模型配置（就是本节 `new AnthropicModelProvider({ baseURL, apiKey })` 读的那些值）究竟存在 `~/.helixent/config.yaml` 的哪里、以及第 15 节那个悬而未决的审批白名单，如何被真正**落盘**。

👉 下一节 **第 18 节：CLI 入口、配置、命令与设置持久化**。

准备好后，对我说「**生成第 18 节**」即可。
