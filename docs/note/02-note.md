# Message

## 组成

1. system prompt
2. user prompt
3. tool
4. Assisat message（智能回复）

```
第 1 层（用 role 辨识）           第 2 层（用 type 辨识每个内容段）
Message
├─ SystemMessage    role:"system"    content: TextContent[]
├─ UserMessage      role:"user"      content: (TextContent | ImageURLContent)[]
├─ AssistantMessage role:"assistant" content: (TextContent | ThinkingContent | ToolUseContent)[]
└─ ToolMessage      role:"tool"      content: ToolResultContent[]

内容段（Content）家族，各自带一个 type 判别字段：
   TextContent       type:"text"
   ImageURLContent   type:"image_url"
   ThinkingContent   type:"thinking"
   ToolUseContent    type:"tool_use"
   ToolResultContent type:"tool_result"
```

## 外层

```
export interface SystemMessage {
  role: "system";
  content: SystemMessageContent;
}
export interface UserMessage {
  role: "user";
  content: UserMessageContent;
}
export interface AssistantMessage {
  role: "assistant";
  content: AssistantMessageContent;
  usage?: TokenUsage;      // 厂商上报的 token 用量（可选）
  streaming?: boolean;     // 流式进行中为 true，完成后移除
}
export interface ToolMessage {
  role: "tool";
  content: ToolMessageContent;
}
```

## 重点

### 为什么用数组而不是字符串

**① 一条消息的内容是「异构」的：有think，tool，text**

**② 内容是「有序」的。**

**③ 内容是「多模态 / 多结果」的：用户可以文字+图片**

<br />

### 命名玄机

<br />

| 命名风格                | 出现的字段                                              | 属于哪一侧                            |
| :------------------ | :------------------------------------------------- | :------------------------------- |
| `snake_case`（多词下划线） | `image_url`、`tool_use`、`tool_result`、`tool_use_id` | **wire-facing**：会被翻译/透传到厂商 API   |
| `camelCase`（多词驼峰）   | `promptTokens`、`completionTokens`、`totalTokens`    | **internal**：纯 Helixent 内部运行时元数据 |

`tool_use` / `tool_result` / `tool_use_id` / `thinking` 这一整套命名，都与 Anthropic 的 content-block 术语对齐。

<br />

### 为什么使用Anthropic协议（delete）

Anthropic更结构化，OpenAI更散，至于为什么使用Anthropic，我觉得没有什么必要的理由

OpenAI：字段并列 + 多条独立 message

```
// 1. Assistant 回复：文本和工具调用是同一条 message 的平级字段
{
  "role": "assistant",
  "content": "让我帮你查一下天气。",       // 文本字段
  "tool_calls": [                          // 工具调用字段（与 content 平级）
    {
      "id": "call_abc123",
      "type": "function",
      "function": {
        "name": "get_weather",
        "arguments": "{\"city\": \"北京\"}"
      }
    }
  ]
}

// 2. 工具结果：必须作为一条独立的 message 返回
{
  "role": "tool",
  "tool_call_id": "call_abc123",
  "content": "{\"temp\": 28, \"condition\": \"晴\"}"
}

// 3. Assistant 再次回复
{
  "role": "assistant",
  "content": "北京现在 28°C，晴天。"
}


message 1 (assistant): content="我来查一下", tool_calls=[{search}]
message 2 (tool):      content="搜索结果..."
message 3 (assistant): content="查到了，结果如下"
```

Anthropic：一条 message 内的有序块数组

```
{
  "role": "assistant",
  "content": [
    {"type": "text", "text": "让我查一下。"},
    {"type": "tool_use", "name": "get_weather", "input": {"city": "北京"}},
    {"type": "tool_result", "content": "28°C 晴"},
    {"type": "text", "text": "北京现在 28°C，晴天。"}
  ]
}

"content": [
  {"type": "text", "text": "我来查一下"},        // 第1步
  {"type": "tool_use", "name": "search", ...},   // 第2步
  {"type": "text", "text": "查到了，结果如下"}    // 第3步
]
```

