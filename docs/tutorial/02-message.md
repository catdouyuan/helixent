# 第 2 节：Message 消息类型系统 —— 端到端的单一数据源

> 本节属于 **第二部分 · Foundation 层（一切的地基）**。它是整套教程真正的「第一块砖」——[第 1 节](./01-overview.md) 反复强调「一份 `Message` 贯穿始终」，本节就钻进定义 `Message` 的两个源文件，把这句话从口号变成你能逐字读懂的类型代码。
>
> 对应 roadmap 为本节设定的两个**核心问题**：
>
> 1. 对话历史用什么数据结构表示？
> 2. 为什么内容是「分段数组」而不是「一个字符串」？

***

## 0. 承上启下

[第 1 节](./01-overview.md) 给了你一张地图，并在末尾埋下一句关键判断：

> **`Message`** **的形状决定了它上面所有层的形状。**

它还留下了一个具体的钩子——在 1.6 里我们端到端追踪了一次运行，看到 `UserMessage`、`AssistantMessage`、`ToolMessage` 在 CLI → Coding → Agent → Foundation → Community 之间接力传递，中间**没有任何一层发明自己的私有格式**。当时我们没有拆开这几个类型的内部，只是先记住「它们都是 `Message` 的变体」。

本节就来兑现承诺：把 [message.ts](../../src/foundation/messages/types/message.ts) 与 [content.ts](../../src/foundation/messages/types/content.ts) 逐字读透，回答第 1 节末尾那个悬而未决的问题——**为什么消息内容是「分段数组」而不是「一个字符串」**。

读本节时，请打开这几个文件对照：

- 消息类型：[message.ts](../../src/foundation/messages/types/message.ts)
- 内容分段：[content.ts](../../src/foundation/messages/types/content.ts)
- 角色枚举：[role.ts](../../src/foundation/messages/types/role.ts)
- 桶文件：[messages/index.ts](../../src/foundation/messages/index.ts)、[messages/types/index.ts](../../src/foundation/messages/types/index.ts)
- 两个「边界翻译」现场（用来印证命名玄机）：[community/openai/utils.ts](../../src/community/openai/utils.ts)、[community/anthropic/utils.ts](../../src/community/anthropic/utils.ts)

***

## 1. 主题内容

### 1.1 先想清楚问题：一段对话到底要存什么？

在看代码前，先自己当一次设计者。你要给一个 Coding Agent 设计「对话历史」的数据结构，它至少得装下这些东西：

- 一段**系统提示词**（告诉模型「你是谁、要遵守什么规矩」）；
- **用户说的话**——可能是纯文字，也可能**夹着一张截图**（多模态）；
- **模型的回复**——这里最复杂：它可能先「想一段」（思考/reasoning），再「说一段」（文本），然后「要求调用两个工具」（比如同时 `read_file` 两个文件）——**思考、文本、工具调用混在一条回复里，还有先后顺序**；
- **工具执行的结果**——而且要能精确对上「这个结果是回答刚才哪一次调用的」。

**如果你试图用「一条消息 = 一个字符串」来存，立刻就卡住了：一条模型回复里既有思考又有文本又有两个工具调用，一个字符串怎么表达？图片怎么塞进字符串？工具结果怎么和调用配对？**

所以答案几乎是被逼出来的：

> **一条消息 = 一个「角色」+ 一个「内容段数组」**。每一段都有自己的类型（文本 / 图片 / 思考 / 工具调用 / 工具结果），数组保留了它们的**顺序**。

这就是 Helixent 消息系统的全部直觉。剩下的只是把它用 TypeScript 严谨地写出来——而它写得非常漂亮，用到了一个叫「**可辨识联合（discriminated union）**」的模式，而且是**双层**的。

### 1.2 全景：双层可辨识联合

先给你一张总图，后面逐块拆。整个消息系统就是**两层嵌套的联合类型**：

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

- **外层**：`Message` 是四种消息的联合，用字段 **`role`** 区分是哪一种。
- **内层**：每种消息的 `content` 是一个**数组**，数组元素是若干「内容段」，用字段 **`type`** 区分是哪一种段。

「可辨识联合」的意思是：联合里的每个成员都带一个**共同的字面量字段**（这里是 `role` 和 `type`），TypeScript 只要看一眼这个字段的值，就能**自动把类型收窄**到具体那一个成员。这一点非常关键，1.6 会用真实代码演示它的威力。

下面从外层往里层拆。

### 1.3 外层：四种角色（[message.ts](../../src/foundation/messages/types/message.ts)）

先看最外层的定义，它出人意料地短——整个文件只有 57 行：

```ts
export type Message = SystemMessage | NonSystemMessage;
export type NonSystemMessage = UserMessage | AssistantMessage | ToolMessage;
```

注意这里有个**小心思**：它没有直接写成 `Message = SystemMessage | UserMessage | AssistantMessage | ToolMessage` 一行拉平，而是先拎出一个 `NonSystemMessage`。为什么？因为在很多地方，「系统消息」和「其余三种消息」的待遇是不同的：

- 系统提示词往往是**单独管理**的（第 3 节你会看到 `Model` 自己负责把 `SystemMessage` 拼到消息列表最前面，而不是让上层塞进历史；第 17 节还会看到 Anthropic 干脆把 system 当成一个**顶层独立参数**，根本不放进 messages 数组）；
- 对话「历史记录」通常只由 `UserMessage / AssistantMessage / ToolMessage` 组成。

于是 `NonSystemMessage` 这个别名就成了一个**高频复用的词汇**——你在 [lead-agent.ts](../../src/coding/agents/lead-agent.ts)、[message-text.ts](../../src/cli/tui/message-text.ts)、[todo-view.ts](../../src/cli/tui/todo-view.ts) 等处都会看到它。把「非系统消息」命名出来，胜过每次都重复写三个类型的并集。

再看四种消息各自的定义（[message.ts](../../src/foundation/messages/types/message.ts#L12-L51)）：

```ts
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

三点值得停下来看：

1. **`role`** **是字面量类型**（`"system"` 而不是 `string`）。正是这个字面量让 `Message` 成为「可辨识联合」——编译器能靠它区分四种消息（见 1.6）。所有合法角色也被单独收拢在 [role.ts](../../src/foundation/messages/types/role.ts) 里：
   ```ts
   export type Role = "system" | "user" | "assistant" | "tool";
   ```
   这个 `Role` 类型是「角色」这一概念的**单一命名来源**，供需要「任意角色」的地方复用（例如渲染层做 `switch(role)`）。
2. **只有** **`AssistantMessage`** **多带两个字段**：`usage?` 和 `streaming?`。这不是随意的——因为「token 用量」和「是否还在流式生成」这两件事，**天然只属于模型产出的那条消息**。用户消息不消耗 completion token，工具结果也不是流式生成的。把这两个字段精确地挂在 `AssistantMessage` 上、而不是提到公共父类，是「让类型只表达它该表达的东西」的典范。
   - `usage` 会在第 16/17 节由 provider 填入、在第 20 节的 [token-usage.ts](../../src/cli/tui/token-usage.ts) 被统计；
   - `streaming` 会在第 3 节的流式约定与第 19 节的 TUI 渲染里发挥作用（UI 靠它决定「这条消息还在动，先别定稿」）。
3. **`content`** **的类型都是「某某 Content」别名**，暂时还没展开。它们全部定义在 [content.ts](../../src/foundation/messages/types/content.ts) 里——这就是内层。

### 1.4 内层：五种内容段（[content.ts](../../src/foundation/messages/types/content.ts)）

内层是整个系统的精华。先看五个「内容段」接口，每一个都带一个 `type` 判别字段：

```ts
export interface TextContent {
  type: "text";
  text: string;
}
export interface ImageURLContent {
  type: "image_url";
  image_url: { url: string; detail?: "auto" | "high" | "low" };
}
export interface ThinkingContent {
  type: "thinking";
  thinking: string;
}
export interface ToolUseContent<T extends Record<string, unknown> = Record<string, unknown>> {
  type: "tool_use";
  id: string;      // 本次调用的稳定 id
  name: string;    // 模型选择的工具名
  input: T;        // 传给工具的 JSON 参数
}
export interface ToolResultContent {
  type: "tool_result";
  tool_use_id: string;  // 对应上面某个 ToolUseContent.id
  content: string;      // 工具执行结果（通常是 JSON 字符串）
}
```

逐个理解它们的角色：

- **`TextContent`**：最普通的一段文字。系统提示、用户输入、模型回答里都会出现。
- **`ImageURLContent`**：用户输入里的一张图片（多模态）。注意它用 `url` 引用图片，还带一个 provider 相关的 `detail`（分辨率取舍）。**这是「为什么必须用数组」的第一个理由**——一条用户消息可能是「一段文字 + 一张图」的混合。
- **`ThinkingContent`**：模型的「思考 / 推理链」文本（当厂商愿意暴露时）。它和 `TextContent` 是**两种不同的段**——思考是「过程」，文本是「结论」，UI 上往往区别对待（思考默认折叠/灰显）。
- **`ToolUseContent<T>`**：模型发起的一次工具调用。三个字段缺一不可：`id`（这次调用的唯一编号）、`name`（调哪个工具）、`input`（参数）。**它是泛型的**，1.7 专门讲。
- **`ToolResultContent`**：一次工具执行的结果。它靠 `tool_use_id` **回指**到之前那次 `ToolUseContent` 的 `id`——这是「请求」与「响应」配对的唯一纽带。

然后是把「内容段」和「消息」联动起来的四个别名——**这是内外两层的接缝，也是整个设计里我最想让你盯住的地方**（[content.ts](../../src/foundation/messages/types/content.ts#L68-L78)）：

```ts
export type SystemMessageContent   = TextContent[];
export type UserMessageContent     = (TextContent | ImageURLContent)[];
export type AssistantMessageContent = (TextContent | ThinkingContent | ToolUseContent)[];
export type ToolMessageContent     = ToolResultContent[];
```

把它读成一张「谁能装什么」的权限表，一切就通透了：

| 消息类型               | 允许的内容段                                                 | 读法                    |
| ------------------ | ------------------------------------------------------ | --------------------- |
| `SystemMessage`    | `TextContent`                                          | 系统提示只有纯文本             |
| `UserMessage`      | `TextContent` \| `ImageURLContent`                     | 用户可以发文字**和/或**图片      |
| `AssistantMessage` | `TextContent` \| `ThinkingContent` \| `ToolUseContent` | 模型可以**思考+说话+调工具**混在一起 |
| `ToolMessage`      | `ToolResultContent`                                    | 工具消息**只**装工具结果        |

这张表是用类型**强制**出来的。它的威力在于「**让非法状态无法被表示（make illegal states unrepresentable）**」：

- 你**不可能**往 `SystemMessage` 里塞一张图片——`SystemMessageContent` 根本不接受 `ImageURLContent`，编译期就报错；
- 你**不可能**让 `UserMessage` 里出现 `ToolUseContent`——用户不会「调用工具」，这个组合从类型上就被禁止了；
- 你**不可能**把 `ToolResultContent` 放进 `AssistantMessage`——工具结果只能由 `ToolMessage` 承载。

这不是靠开发者「自觉遵守约定」，而是**编译器帮你把关**。相比「一个大 interface 塞一堆可选字段」的写法（那种写法允许 `{role:"user", toolUseId:"...", image:...}` 这种毫无意义的组合存在），可辨识联合从根上杜绝了「字段对不上角色」的脏数据。

### 1.5 回答核心问题：为什么是「分段数组」而不是「一个字符串」？

现在可以正面回答 roadmap 给本节的第二个核心问题了。答案有三条，层层递进：

**① 一条消息的内容是「异构」的。**
最典型的是 `AssistantMessage`：模型一次回复里，可能先输出一段 `thinking`（推理），再输出一段 `text`（给用户看的话），再输出一个甚至多个 `tool_use`（要调的工具）。这是**三种不同类型的东西**，一个 `string` 字段根本装不下。只有「元素类型不同的数组」才能表达。

**② 内容是「有序」的。**
「先想、再说、最后决定调工具」——这个顺序是有意义的。数组天然保留顺序；而如果你把它拆成 `text: string`、`thinking: string`、`toolCalls: []` 三个平行字段，就丢失了它们之间的先后关系（比如模型可能「说一句 → 调个工具 → 再说一句」交替进行）。

**③ 内容是「多模态 / 多结果」的。**
用户消息可以是「文字 + N 张图」；一条工具消息可以同时携带**多个** `tool_result`（对应第 6 节里「一步内并行调用了多个工具」的场景，多个结果打包回喂）。这些都要求 `content` 是一个能放**任意多段、任意类型组合**的数组。

一句话总结：

> **对话内容本质上是「一串有顺序的、类型各异的片段」，所以它的自然模型就是「可辨识联合的数组」，而不是一个扁平字符串。**

顺带一提：这也不是 Helixent 的独创——OpenAI 的 `content` parts、Anthropic 的 content blocks 都是数组。Helixent 的选择是**顺应了 LLM API 演进的方向**（从早期「content 就是一个字符串」到如今「content 是结构化分段」），并把它作为**内部单一数据源**固定下来。第 3 节的工业对比里会展开。

### 1.6 双层可辨识联合的「威力」：类型自动收窄

前面说「用 `role` / `type` 做判别字段」有什么实际好处？看两段**真实源码**，你立刻就懂。

**外层收窄**——[community/openai/utils.ts](../../src/community/openai/utils.ts#L16-L62) 里把内部 `Message` 翻译成 OpenAI 格式时：

```ts
for (const message of messages) {
  if (message.role === "system" || message.role === "user") {
    openaiMessages.push(message);            // 这里 message 被收窄为 System|User
  } else if (message.role === "assistant") {
    // 这里 message 被收窄为 AssistantMessage，才能安全访问 message.content 里的 thinking/tool_use
    for (const content of message.content) { /* ... */ }
  } else if (message.role === "tool") {
    // 这里 message 被收窄为 ToolMessage
  }
}
```

一旦你写下 `if (message.role === "assistant")`，在这个分支里 TypeScript 就**确信** `message` 是 `AssistantMessage`，于是允许你访问它专属的 `usage`、并知道 `content` 里可能有 `ThinkingContent`。你不需要任何类型断言（`as`），编译器自己算出来了。

**内层收窄**——[agent.ts](../../src/agent/agent.ts#L218-L219) 里从模型回复中挑出所有工具调用：

```ts
private _extractToolUses(message: AssistantMessage): ToolUseContent[] {
  return message.content.filter((content): content is ToolUseContent => content.type === "tool_use");
}
```

`content.type === "tool_use"` 这个判断，配合 `content is ToolUseContent` 类型谓词，就把一个「混杂着 text/thinking/tool\_use 的数组」精准过滤成「只剩 tool\_use 的数组」，且类型准确。第 5、6 节的整个「act 阶段」都建立在这一行之上——**主循环之所以能优雅地判断「模型这一步到底要不要调工具」，全靠** **`type`** **这个判别字段。**

这就是双层可辨识联合的回报：**跨层传递时零成本、零断言地做安全的类型区分**。它是「单一数据源」能落地的技术前提——如果 `Message` 不是这么设计，各层就得靠 `as` 硬转或运行时兜底，脏且易错。

### 1.7 `ToolUseContent<T>`：预留的泛型输入

单独把 `ToolUseContent` 拎出来，因为它是本节唯一的泛型，也是 roadmap 点名的亮点：

```ts
export interface ToolUseContent<T extends Record<string, unknown> = Record<string, unknown>> {
  type: "tool_use";
  id: string;
  name: string;
  input: T;   // ← 泛型
}
```

理解它的关键是分清**两个使用场景**：

- **从模型流里解析出来时**：provider 拿到的是一段 JSON 字符串（OpenAI 的 `tool_call.function.arguments`），`JSON.parse` 之后是一个「任意对象」。此时无法静态知道具体形状，所以用**默认参数** `T = Record<string, unknown>`——保持灵活。你在 [openai/utils.ts](../../src/community/openai/utils.ts#L85-L90) 看到的正是这种「无参默认」用法。
- **在工具执行侧需要类型安全时**：可以把 `T` 特化成某个具体工具的输入结构，让 `input` 拿到精确类型。这与第 4 节 [defineTool](../../src/foundation/tools/function-tool.ts) 用 Zod 推导出的 `z.infer<P>` 是同一套思路的两端——工具定义处用 Zod 描述参数、这里用泛型承接参数类型。

⚠️ **诚实说明（不要夸大）**：翻遍现有源码，绝大多数使用点（[agent.ts](../../src/agent/agent.ts#L209)、[approval-manager.ts](../../src/coding/permissions/approval-manager.ts)、[message-text.ts](../../src/cli/tui/message-text.ts) 等）用的都是**默认的** `ToolUseContent`（即 `input: Record<string, unknown>`）。也就是说，泛型参数 `T` 目前更像一个**预留的类型入口**——它让「未来想在某处拿到强类型 `input`」成为可能，而不改动这个核心类型。这是一种「**不用时零负担、要用时有入口**」的克制设计，理解它的意图即可，不必以为项目里到处都在特化它。

### 1.8 命名玄机：`snake_case`（wire）vs `camelCase`（internal）

这是 roadmap 点名、也是最容易被读者忽略的一个亮点。仔细看字段命名风格，你会发现一条**刻意划出的分界线**：

| 命名风格                | 出现的字段                                              | 属于哪一侧                            |
| ------------------- | -------------------------------------------------- | -------------------------------- |
| `snake_case`（多词下划线） | `image_url`、`tool_use`、`tool_result`、`tool_use_id` | **wire-facing**：会被翻译/透传到厂商 API   |
| `camelCase`（多词驼峰）   | `promptTokens`、`completionTokens`、`totalTokens`    | **internal**：纯 Helixent 内部运行时元数据 |

规律非常清晰：

> **凡是「要跨出边界、和厂商 API 打交道」的字段，一律** **`snake_case`；凡是「纯粹留在项目内部」的字段，一律** **`camelCase`。**

为什么这么分？看两处**边界翻译**的现场就明白了：

**证据一：贴 wire 能直接透传。** [openai/utils.ts](../../src/community/openai/utils.ts#L19-L20) 里，system 和 user 消息是**零转换**直接 push 的：

```ts
if (message.role === "system" || message.role === "user") {
  openaiMessages.push(message);   // 内部结构恰好就是 OpenAI 合法输入，直接透传
}
```

之所以能这么爽，正是因为 `{ type: "image_url", image_url: { url } }` 这种段的字段名和 OpenAI 的 wire 格式**一模一样**——命名贴着 wire，就省掉了翻译。

**证据二：内部模型其实更贴 Anthropic 的 content-block 风格。** 看 [anthropic/utils.ts](../../src/community/anthropic/utils.ts#L88-L93)，工具结果几乎是**同名透传**：

```ts
content.push({
  type: "tool_result",
  tool_use_id: part.tool_use_id,   // 内部字段名和 Anthropic 完全一致
  content: part.content,
});
```

`tool_use` / `tool_result` / `tool_use_id` / `thinking` 这一整套命名，都与 Anthropic 的 content-block 术语对齐。所以更准确的说法是：**Helixent 的内部 content 模型，选择向「更结构化的 Anthropic content-block 风格」看齐**（详见 1.9 之后的深度解释 Q2）。对 Anthropic 几乎同名透传，对 OpenAI 则只需少量改名（如 `tool_use_id` → `tool_call_id`，见 [openai/utils.ts](../../src/community/openai/utils.ts#L55)）。

**反过来看** **`camelCase`** **侧**：`TokenUsage` 的 `promptTokens/completionTokens/totalTokens`（[message.ts](../../src/foundation/messages/types/message.ts#L3-L7)）是 Helixent 自己定义的统计口径，厂商 wire 里并没有一个现成结构与它一一对应（各家字段名不同，需要重新映射填充），它纯粹服务于内部（如 TUI 的用量展示）。既然是「内部人」，就遵循项目统一的 TypeScript camelCase 惯例。`AssistantMessage.streaming` 同理——它是 Helixent 描述「这条消息还在流式中」的内部状态位，wire 上没有这个概念。

一句话记忆：

> **看字段是** **`snake_case`** **还是** **`camelCase`，就能猜出它「面朝厂商」还是「面朝自己」。** 这条不成文的约定，让 community 层的翻译代码薄得惊人。

### 1.9 桶文件与导出：一切从 `@/foundation` 出来

最后看这些类型是怎么被「导出去」的。messages 目录只有两层极薄的桶文件：

- [messages/types/index.ts](../../src/foundation/messages/types/index.ts)：把三个源文件原样 re-export。
  ```ts
  export * from "./content";
  export * from "./message";
  export * from "./role";
  ```
- [messages/index.ts](../../src/foundation/messages/index.ts)：再把 `types` 抬一层。
  ```ts
  export * from "./types";
  ```

再往上，[foundation/index.ts](../../src/foundation/index.ts) 把 `messages` 汇总，于是全项目任何地方都能写：

```ts
import type { Message, AssistantMessage, ToolUseContent } from "@/foundation";
```

这正是 [第 1 节](./01-overview.md) 讲过的「桶文件 + 全具名导出 + `@/*` 别名」在 Foundation 层的具体落地。你不需要记住 `message.ts` 到底在哪个子目录——**所有地基类型都从** **`@/foundation`** **这一个门出来**。这也是为什么后续章节里 agent、coding、community、cli 引用 `Message` 时，`import` 语句永远整齐划一。

***

## 2. 亮点与关键设计

1. **双层可辨识联合（role × type）——思想内核。**
   外层用 `role` 辨识四种消息、内层用 `type` 辨识五种内容段。它带来两个决定性收益：一是**类型自动收窄**（[agent.ts](../../src/agent/agent.ts#L218-L219) 的 `_extractToolUses`、community 层的 `switch(role)` 全部零断言），二是**非法状态不可表示**（系统消息塞不进图片、用户消息出不了工具调用）。这是「单一数据源」能够安全跨层流动的技术底座。
2. **`snake_case`（wire）/** **`camelCase`（internal）的命名分界——妙笔。**
   用一条命名约定，把「面朝厂商」和「面朝自己」的字段一眼分开。它让 community 层的翻译代码薄到极致——system/user 消息甚至能零转换透传（[openai/utils.ts](../../src/community/openai/utils.ts#L19-L20)）。
3. **`ToolUseContent<T>`** **的泛型输入——克制的扩展点。**
   默认 `Record<string, unknown>` 保证从模型流解析时的灵活，泛型参数则为「未来想要强类型 `input`」预留了入口，且不污染核心类型。
4. **`NonSystemMessage`** **与「多余字段只挂 AssistantMessage」——精确建模。**
   把「系统消息」从历史记录里区分出来（呼应第 3 节 Model 拼装 system、第 17 节 Anthropic 独立 system 参数）；把 `usage`/`streaming` 精确挂在唯一需要它们的 `AssistantMessage` 上，不做无意义的字段上提。

***

## 3. 工业对比

把 Helixent 的消息模型和业界主流 API / 框架对照，你会更懂它「为什么长这样」：

| 维度     | Helixent                                             | OpenAI Chat Completions                      | Anthropic Messages                                 | LangChain                                    |
| ------ | ---------------------------------------------------- | -------------------------------------------- | -------------------------------------------------- | -------------------------------------------- |
| 内容表示   | **分段数组** `content: Content[]`，靠 `type` 判别            | `content` 可为字符串或 parts 数组                    | **content blocks 数组**（text/thinking/tool\_use/...） | `BaseMessage.content` 可为 `string` 或数组，抽象层级较多 |
| 工具调用放哪 | 作为一段 `ToolUseContent` **混在** assistant 的 content 数组里 | 提到顶层 `message.tool_calls`，与 `content` **分离** | 作为 content block `tool_use`，**混在** content 里       | 顶层 `tool_calls` 字段                           |
| 工具结果关联 | `ToolResultContent.tool_use_id` 回指                   | `role:"tool"` + `tool_call_id`               | `tool_result` block + `tool_use_id`                | `ToolMessage.tool_call_id`                   |
| 思考/推理  | 独立段 `ThinkingContent`                                | `reasoning_content`（挂在 message 上）            | `thinking` block（带 `signature`）                    | 视集成而定                                        |
| 统一层    | **有**：一份内部 `Message` 贯穿全层                            | 无（就是自家 wire）                                 | 无（就是自家 wire）                                       | 有 `BaseMessage`，但概念更重                        |

要点读法：

- **Helixent 的内部模型更接近 Anthropic 的 content-block 风格**（工具调用/结果/思考都作为「段」混在 content 数组里，命名也同名）。这不是巧合，见下面 Q2。
- **OpenAI 是「较扁平」的结构**：工具调用被提到顶层 `tool_calls`、工具结果用独立的 `role:"tool"` 消息 + `tool_call_id`、思考走 `reasoning_content`。所以把内部 `Message` 翻成 OpenAI 格式时，[openai/utils.ts](../../src/community/openai/utils.ts) 需要做「拆分与改名」的活儿（把 content 里的 `tool_use` 收集到 `tool_calls`、`thinking` 映射到 `reasoning_content`）。
- **Helixent 相对 LangChain 的取舍**：LangChain 的 `BaseMessage` 体系功能更全，但概念（各种 Message 子类、content 可多形态）也更重；Helixent 只保留「四角色 × 五内容段」这一个最小闭集，**换来可以一眼读完的类型文件**——这正是它作为教学标本的价值。

***

## 4. 深度解释：为什么这样设计？不这样会怎样？

**Q1：`content`** **非用数组不可吗？用几个平行字段（`text`/`thinking`/`toolCalls`）行不行？**
不行，或者说会更糟。平行字段会**丢失顺序**（模型「说一句→调工具→再说一句」的交替无法表达），也**难以扩展**（每加一种内容段就要加一个顶层字段，且大多数消息里它们都是空的）。数组 + `type` 判别把「有哪些段、什么顺序」统一表达，新增段类型只需在联合里加一个成员、在对应 `XxxMessageContent` 别名里放行——**核心类型的其余部分一行不改**。这就是 1.5 那三条理由的类型学翻译。

**Q2：为什么内部命名向 Anthropic 靠，而不向 OpenAI 靠？**
因为**做「单一数据源」需要一个足够结构化的内部表示**，而 Anthropic 的 content-block 模型恰好更结构化：一切（文本、思考、工具调用、工具结果）都是 content 数组里的「块」，语义整齐。OpenAI 的 Chat Completions 相对扁平（工具调用挂顶层、工具结果单独成 message），信息更「散」。选一个更结构化的模型作内部标准，翻译时\*\*「散 → 聚」比「聚 → 散」更自然、更不容易丢信息\*\*。证据就是两个 utils：[anthropic/utils.ts](../../src/community/anthropic/utils.ts) 基本是同名搬运，而 [openai/utils.ts](../../src/community/openai/utils.ts) 需要主动拆分重组。当然，代价是对 OpenAI 的翻译更费劲些——但这份「费劲」被**集中收敛在 community 边界的一个文件里**，核心层完全无感。

**Q3：`snake_case`** **和** **`camelCase`** **混用，不别扭吗？为什么不全统一成 camelCase？**
这是**故意的、有信息量的不统一**。如果全改成 camelCase（`imageUrl`/`toolUse`/`toolUseId`），那么每次跨边界都要做一次「camelCase ↔ snake\_case」的机械转换，凭空增加翻译代码和出错面（漏转一个字段、`toolUseId` 对不上 `tool_use_id`）。让 wire-facing 字段直接采用 wire 的 `snake_case`，就把这类转换降到最少甚至为零（透传）。而 `usage`/`streaming` 这些内部字段厂商 wire 里没有对应物，本就要另行处理，于是回归项目统一的 camelCase。**「混用」在这里不是不讲究，恰恰是最讲究的选择：命名风格本身携带了「这个字段朝内还是朝外」的语义。**

**Q4：不用可辨识联合，用「一个大 interface + 一堆可选字段」会怎样？**
会退化成「什么都可能、什么都要判空」的泥潭：`{ role, content?, text?, image?, toolUseId?, toolCalls?... }`。这种结构允许非法组合存在（用户消息带 `toolCalls`？系统消息带图片？），把「保证数据合法」的责任从编译器推给了每一处运行时代码，既啰嗦又易错。可辨识联合让**每一种消息/内容段只携带它该有的字段**，配合 TS 的收窄与穷尽检查（`switch` 漏掉一个 `type` 编译器会提醒），把一整类 bug 消灭在编译期。第 5、6 节整个主循环之所以能写得那么干净，正是吃到了这份红利。

***

## 5. 参考资料

- 本项目源码：[message.ts](../../src/foundation/messages/types/message.ts)、[content.ts](../../src/foundation/messages/types/content.ts)、[role.ts](../../src/foundation/messages/types/role.ts)
- TypeScript 官方手册 · 可辨识联合与类型收窄：<https://www.typescriptlang.org/docs/handbook/2/narrowing.html#discriminated-unions>
- 「让非法状态不可表示（Make illegal states unrepresentable）」—— 类型驱动设计经典思想（Yaron Minsky）：<https://blog.janestreet.com/effective-ml-revisited/>
- OpenAI Chat Completions 消息格式：<https://platform.openai.com/docs/api-reference/chat/create>
- Anthropic Messages API · content blocks / tool use：<https://docs.anthropic.com/en/api/messages>
- 上游依赖：[第 1 节 · 项目全景与四层架构](./01-overview.md)（「单一数据源」的提出）

***

## 6. 小结与下一节预告

本节你应该已经彻底吃透了这块「地基的第一块砖」：

- 一条消息 = **一个** **`role`** **+ 一个「内容段数组」**；`Message` 是四种角色的联合，`content` 是若干带 `type` 的内容段的数组——这就是**双层可辨识联合**；
- 内容之所以是「**分段数组**」而非「一个字符串」，是因为它天生**异构、有序、多模态/多结果**（尤其 assistant 消息里 thinking/text/tool\_use 混排）；
- 命名遵循 **`snake_case`（面朝厂商 wire）/** **`camelCase`（面朝内部）** 的隐形分界，让 community 层翻译代码薄到能透传；
- `ToolUseContent<T>` 用泛型预留了「强类型 input」的入口，`ToolResultContent.tool_use_id` 则是请求/响应配对的唯一纽带；
- 这一切让 `Message` 能**零断言、零私有格式**地在四层之间流动——这就是第 1 节所说「单一数据源」的类型学实现。

**承上启下（启下）**：我们现在知道了 `AssistantMessage` 长什么样——它带着 thinking、text 和 tool\_use。但一个自然的问题浮现出来：

> **这些** **`AssistantMessage`** **是谁「生产」出来的？`usage`** **里的 token 数、`streaming`** **状态又是谁填的？**

答案是**模型**。是 `Model` 消费一段 `Message[]` 历史、向厂商发出请求、再把流式返回的碎片累积成一条崭新的 `AssistantMessage`。于是下一节我们就去看这台「生产者」是如何被抽象的——**它如何做到「换一个厂商，上层代码一行不改」**，以及一个巧妙的分工：为什么 `ModelContext` 只带本节的 `NonSystemMessage`、而把 `SystemMessage` 的拼装交给 `Model` 自己。

👉 下一节 **第 3 节：Model 与 ModelProvider —— 模型抽象与适配契约**，我们钻进 [model.ts](../../src/foundation/models/model.ts) 与 [model-provider.ts](../../src/foundation/models/model-provider.ts)，看清「编排壳」与「厂商契约」的职责分离，以及贯穿始终的流式约定「每次 yield 都是一份完整快照」。

准备好后，对我说「**生成第 3 节**」即可。
