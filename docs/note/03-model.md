# model

<br />

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

## ModelProvider

**策略模式**

抽象接口，用于适配不同场景

<br />

| 字段         | 类型                         | 含义                                                                |
| :--------- | :------------------------- | :---------------------------------------------------------------- |
| `model`    | `string`                   | 具体模型名（如 `"gpt-4o"`、`"claude-3-5-sonnet"`）                         |
| `messages` | `Message[]`                | 完整对话历史，**含 system**（注意是第 2 节的宽类型 `Message`，不是 `NonSystemMessage`） |
| `tools`    | `Tool?`                    | 可用工具列表（第 4 节的主角），可选                                               |
| `options`  | `Record<string, unknown>?` | 厂商专属参数的「口袋」（`temperature` / `thinking` / `max_tokens`……）          |
| `signal`   | `AbortSignal?`             | 取消信号，用来中断在途的网络请求（呼应第 5 节的 `AbortController`）                      |

- **`invoke`**：返回 `Promise<AssistantMessage>`——一次性，等模型全部说完，给你一整条消息。
- **`stream`**：返回 `AsyncGenerator<AssistantMessage>`——流式，边生成边一次次 `yield` 出来。
- **`stream`** **每次 yield 的都是一份「到目前为止的完整 `AssistantMessage` 快照」，StreamAccumulator会来实现这个逻辑**

# ModelContext-上下文

```TypeScript
export interface ModelContext {
  prompt: string;
  messages: NonSystemMessage[];
  tools?: Tool[];
  signal?: AbortSignal;
}
```

<br />

| 字段        | `ModelContext`（面向 Agent）                      | `ModelProviderInvokeParams`（面向 Provider） |
| :-------- | :-------------------------------------------- | :--------------------------------------- |
| 系统提示      | `prompt: string`（一个**字符串**）                   | —（没有独立字段，已被拼进 `messages`）                |
| 对话历史      | `messages: NonSystemMessage[]`（**不含** system） | `messages: Message[]`（**含** system）      |
| 模型名       | —（Agent 不关心）                                  | `model: string`                          |
| 厂商参数      | —（Agent 不关心）                                  | `options?: Record<string, unknown>`      |
| 工具 / 取消信号 | `tools?` / `signal?`                          | `tools?` / `signal?`（透传）                 |

## Model-编排层

- \_buildModelProviderParams会将system prompt放入到Messages【】中，并且放到第一个

```TypeScript
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

## 具体实现

**OpenAI**（[openai/model-provider.ts](https://file+.vscode-resource.vscode-cdn.net/Users/bytedance/go/src/code.byted.org/life/helixent/src/community/openai/model-provider.ts#L80-L98)）的 `_baseChatCompletionParams`：

```
return {
  model,
  messages: convertToOpenAIMessages(messages),   // 内部 Message[] → OpenAI 格式
  tools: tools ? convertToOpenAITools(tools) : undefined,
  temperature: 0,                                 // 默认追求确定性
  ...options,                                     // Model 的 options 覆盖默认
};

```

**Anthropic**（[anthropic/model-provider.ts](https://file+.vscode-resource.vscode-cdn.net/Users/bytedance/go/src/code.byted.org/life/helixent/src/community/anthropic/model-provider.ts#L49-L78)）的 `_baseMessageParams`：

```
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

<br />

| 维度        | OpenAIModelProvider                           | AnthropicModelProvider                         |
| :-------- | :-------------------------------------------- | :--------------------------------------------- |
| 实现的接口     | 同一个 `ModelProvider`                           | 同一个 `ModelProvider`                            |
| 消息翻译      | `convertToOpenAIMessages`                     | `convertToAnthropicMessages`                   |
| system 放哪 | 留在 `messages` 里（OpenAI 就吃 messages 里的 system） | 用 `extractSystemPrompt` **抽出来**放顶层 `system` 参数 |
| 默认参数      | `temperature: 0`                              | `max_tokens: 8192` + thinking budget 自动推导      |
| 流式累积      | `StreamAccumulator` + `snapshot()`            | `StreamAccumulator` + `snapshot()`（同名不同实现）     |

这里有个特别有意思的细节，把本节的分工闭环了：**`Model`** **刚在 1.5 里辛辛苦苦把 prompt 拼成一条** **`SystemMessage`** **塞进** **`messages`，Anthropic 的 provider 又用** **`extractSystemPrompt`** **把它从** **`messages`** **里抽了出来**，放到顶层 `system` 参数里。

这看起来「多此一举」，实则是**契约设计的正确姿势**：`ModelProviderInvokeParams.messages` 选用**最通用**的表示（system 就混在消息序列里，OpenAI 直接就能用），而 Anthropic 这种「system 要单独放」的**特例，由它自己的适配器去处理**。核心契约保持通用与稳定，个性化的活儿全部下沉到 community 边界——这与第 2 节「内部模型选一个通用表示、翻译的脏活收敛在边界」是同一种哲学。
