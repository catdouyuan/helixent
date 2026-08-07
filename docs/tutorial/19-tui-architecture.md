# 第 19 节：TUI 架构与状态编排 —— Ink + React 的 Agent Loop Hook

> 本节属于 **第六部分 · CLI / TUI 层（人机交互界面）**，是这一部分的**中段**，也是整套教程里第一次让你看到「一个终端界面，为什么能用 React 写、又怎么被 Agent 的流式事件驱动起来」的一节。[第 18 节](./18-cli-config-persistence.md) 在结尾把舞台交到了这里——它讲完「命令行外壳 + 磁盘落盘」后，在 `cli/index.tsx` 的最后一步 `render(<App/>)` 处**戛然而止**，留下三个悬而未决的问题：**终端界面为什么能用 React 写？** [第 5 节](./05-react-loop.md) 那个 `agent.stream()` 吐出的流式事件，如何被接进 React 的状态、驱动界面刷新？[第 15 节](./15-human-in-the-loop.md) 那两个「还在等 UI 来 `subscribe`」的 Manager，究竟是**谁**、**怎么**去订阅它们、把「一个待响应的请求」变成屏幕上弹出的审批 / 提问表单？**本节就来一次性回答这三问：走进 `render(<App/>)` 之后的世界，看 Ink + React 如何把「Agent 的输出」和「两个 Manager 的等待」编织成一个会实时刷新、会弹窗交互的终端界面。**
>
> 对应 roadmap 为本节设定的**核心问题**：
>
>> 终端界面为什么能用 React 写？第 5 节的流式事件、第 15 节两个 Manager 的「等待响应」，如何被接进 React 的状态与渲染？
>>
>
> **一句边界声明**：本节精讲 **`src/cli/tui/` 下负责「状态编排 + 交互回路」的那半边**——注意，是**半边**。`tui/` 目录也由两块拼成：一块是**「状态编排 + 人机交互回路」**（本节：Agent 循环 Hook、两个 Manager Hook、审批 / 提问弹窗、`App` 骨架），另一块是**「用户输入 + 消息渲染」**（`input-editor`、`command-registry`、输入组件、`markdown` / `message-text` 渲染器、主题——留给 [第 20 节](./00-roadmap.md)）。本节精讲的文件清单如下，可分为**三组**：
>
> - **Agent 循环 Hook（心脏）**：[use-agent-loop.ts](../../src/cli/tui/hooks/use-agent-loop.ts)（189 行，`AgentLoopProvider` 用 React Context 分发状态；`enqueueMessage` + 50ms 批量刷新的节流渲染；`onSubmit` 消费 `agent.stream()` 事件流）。
> - **两个 Manager Hook（交互桥）**：[use-approval-manager.ts](../../src/cli/tui/hooks/use-approval-manager.ts)（25 行）、[use-ask-user-question-manager.ts](../../src/cli/tui/hooks/use-ask-user-question-manager.ts)（28 行）——它们 `subscribe` 第 15 节的两个 global Manager，把「单活跃请求」变成一个 React state。
> - **两个弹窗组件 + App 骨架（交互面）**：[approval-prompt.tsx](../../src/cli/tui/components/approval-prompt.tsx)（90 行，审批弹窗）、[ask-user-question-prompt.tsx](../../src/cli/tui/components/ask-user-question-prompt.tsx)（263 行，多问题选择表单）、[app.tsx](../../src/cli/tui/app.tsx)（103 行，把上面所有 Hook 组合成一屏，并「互斥」地决定此刻该显示输入框还是某个弹窗）。
>
> **本节最大的「啊哈时刻」**：**Ink = 「用 React 渲染到终端」**——你写的 `<Box>` / `<Text>` 不会变成浏览器 DOM，而是被 Ink 翻译成终端里的字符、颜色和布局。一旦接受了这个设定，一整套 React 的武器（`useState` / `useEffect` / `useContext` / `useMemo` / 自定义 Hook）就都能拿来管理一个**命令行界面**的状态了。于是「Agent 吐出一条消息」= 「一次 `setState`」= 「界面重渲染一帧」；「模型要跑危险命令」= 「一个 Manager 把请求推给订阅者」= 「弹出一个 React 表单」。**当你看懂『把终端当成一块可以用 React 刷新的画布』这句话，本节所有设计——节流刷新、Context 分发、订阅式弹窗——就都顺理成章了。**
>
> ⚠️ **一处「诚实标注」**：本节会**频繁提到输入与渲染**（`<InputBox>`、`<MessageHistoryItem>`、`<Markdown>`、斜杠命令 `commands`），但**只讲到「把它们摆进 `App` 的哪个位置、由哪个状态驱动它们显示 / 隐藏」为止**——它们内部「输入框的光标 / 历史 / 斜杠补全怎么实现」「消息怎么被渲染成带颜色的文本 / Markdown」的机制，是 [第 20 节](./00-roadmap.md) 的任务。凡遇到输入 / 渲染组件，本节一律「摆位即止」，并给出后续章节的链接。请把本节读成一部**「状态如何流动 + 交互如何回环」的编排手册**，而不是「组件绘制教程」。

---

## 0. 承上启下

[第 18 节](./18-cli-config-persistence.md) 在结尾把这个悬念埋得明明白白，几乎是「点名」本节。它的原话是这样的：

> 本节在 1.8 第 ⑦ 步 `render(<App/>)` 处**戛然而止**——我们把装配好的 `agent`、注入好的两个 Manager、加载好的斜杠命令，一股脑交给了 `AgentLoopProvider` 和 `App`，然后就「把舞台让给了 TUI」。但一连串问题仍悬而未决：**终端界面为什么能用 React 写？** …… [第 15 节](./15-human-in-the-loop.md) 那两个「还在等 UI 来 `subscribe`」的 Manager，究竟是**谁**、**怎么**去订阅它们……？

而更早的 [第 15 节](./15-human-in-the-loop.md)，在讲两个 Manager 时也留了同一个钩子：

> 两个 `Manager` 共享同一套**队列 + 单活跃请求 + 订阅**模型来桥接异步 Promise 与（尚未登场的）React UI。

本节就来一次性兑现这两处伏笔。而在动手前，请先把**三条上游结论**装进脑子——它们是本节每一处设计的直接前提：

1. **[第 5 节](./05-react-loop.md) 的 `agent.stream()` 是一个 `AsyncGenerator<AgentEvent>`。** 回忆第 5 节：Agent 的主循环是一个 `async *stream()`，每完成一个「助手回合」或「一条工具结果」就 `yield` 一个 `{ type: "message", message }` 事件，在模型还在流式吐字时则 `yield` `{ type: "progress" }` 事件（见 [agent-event.ts](../../src/agent/agent-event.ts)）。**「谁来 `for await` 这个生成器、把 message 事件变成界面上的一条消息？」——第 5 节把这个问题留给了 UI 层。本节的 `AgentLoopProvider.onSubmit` 就是那个消费者。**
2. **[第 15 节](./15-human-in-the-loop.md) 的两个 `Manager` 都在「等一个 UI 来 `subscribe` 并 `respond`」。** 审批用 [approval-manager.ts](../../src/coding/permissions/approval-manager.ts) 的 `globalApprovalManager`，提问用 [ask-user-question-manager.ts](../../src/coding/tools/ask-user-question-manager.ts) 的 `globalAskUserQuestionManager`。它们的共同形状是「**队列 + 单活跃请求 + 单订阅者**」：`askUser(...)` / `askUserQuestion(...)` 返回一个 `Promise`（Agent 那边 `await` 它、被阻塞），同时把请求推进队列；`subscribe(cb)` 注册唯一的订阅者，队列一有「当前活跃请求」就回调它，队列空了就回调 `null`；`respond(...)` 用一个决定 resolve 掉那个 Promise。**「谁来 subscribe、谁来 respond？」——第 15 节明说了「留给尚未登场的 React UI」。本节的两个 `use*Manager` Hook 就是那个 UI。**
3. **[第 18 节](./18-cli-config-persistence.md) 第 ⑦ 步的 `render(<AgentLoopProvider><App/></AgentLoopProvider>)`。** 装配好的 `agent`、`commands` 被传进 `AgentLoopProvider`，`App` 挂在它下面。**本节要做的，就是打开 `AgentLoopProvider` 和 `App` 这两个「黑盒」，看它们内部怎么工作。**

准备好了。我们同样先不看任何一个具体文件，而是先建立**「一个数据流 + 两条交互回路」**的全局地图——因为本节最容易让人迷路的地方，就是**把「Agent 输出消息」这条『单向数据流』和「审批 / 提问」这两条『双向交互回路』搅在一起**。有了地图，再逐个击破。

---

## 1. 主题内容

### 1.1 先建立地图：一个「单向数据流」与两条「双向交互回路」

Helixent 的 TUI 看似组件很多，但只要抓住**「数据往哪流、交互怎么回环」**这一个视角，整张图就清晰了。它由**三条独立的线**编织而成：

```
┌───────────────────────────────────────────────────────────────────────────┐
│                          <AgentLoopProvider>（Context）                      │
│                                                                             │
│  【线一：单向数据流】用户输入 → Agent → 消息列表 → 渲染                       │
│                                                                             │
│   用户在 InputBox 敲字/回车                                                   │
│        │ onSubmit(submission)                                                │
│        ▼                                                                     │
│   agent.stream(userMessage)  ──►  for await (event)                          │
│        │                              │ event.type === "message"             │
│        │                              ▼                                       │
│        │                        enqueueMessage(msg) ──50ms批量──► setMessages │
│        │                                                          │           │
│        ▼                                                          ▼           │
│   streaming=true/false                                    <MessageHistoryItem>│
│        └──► <StreamingIndicator>（Thinking… 微光）           （渲染到终端）    │
└───────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────┐   ┌─────────────────────────────────────┐
│ 【线二：审批回路（双向）】       │   │ 【线三：提问回路（双向）】          │
│                                 │   │                                     │
│ Agent 要跑危险工具              │   │ Agent 调 ask_user_question 工具     │
│   → globalApprovalManager       │   │   → globalAskUserQuestionManager    │
│       .askUser() 返回 Promise   │   │       .askUserQuestion() 返回 Promise│
│       （Agent 被阻塞）          │   │       （Agent 被阻塞）              │
│          │ subscribe            │   │          │ subscribe               │
│          ▼                      │   │          ▼                          │
│   useApprovalManager (Hook)     │   │   useAskUserQuestionManager (Hook)  │
│          │ setRequest           │   │          │ setRequest              │
│          ▼                      │   │          ▼                          │
│   <ApprovalPrompt> 弹窗         │   │   <AskUserQuestionPrompt> 弹窗      │
│          │ 用户按键 → onDecision │   │          │ 用户选择 → onSubmit     │
│          ▼                      │   │          ▼                          │
│   manager.respond(decision)     │   │   manager.respondWithAnswers(result)│
│          │ resolve Promise      │   │          │ resolve Promise         │
│          ▼                      │   │          ▼                          │
│   Agent 继续（放行/拒绝）       │   │   Agent 拿到答案继续                │
└─────────────────────────────────┘   └─────────────────────────────────────┘
```

**三条线的性质截然不同，务必分清**：

| 维度                     | 线一：Agent 数据流                                  | 线二 / 线三：审批 / 提问回路                                        |
| ------------------------ | --------------------------------------------------- | ------------------------------------------------------------------- |
| **方向**           | **单向**（Agent → UI，只输出）               | **双向**（Agent ↔ UI，一问一答）                             |
| **载体**           | `agent.stream()` 的 `AgentEvent` 生成器         | 第 15 节两个 Manager 的`Promise` + `subscribe`                  |
| **UI 侧入口**      | `AgentLoopProvider` 的 `onSubmit`               | `useApprovalManager` / `useAskUserQuestionManager`              |
| **状态落点**       | `messages` 数组（+ `streaming` 布尔）           | `approvalRequest` / `askUserQuestionRequest`（单个请求或 null） |
| **是否阻塞 Agent** | 否（消息只是流过）                                  | **是**（Manager 的 Promise 没 resolve，Agent 就卡住等人类）   |
| **对应组件**       | `<MessageHistoryItem>` + `<StreamingIndicator>` | `<ApprovalPrompt>` / `<AskUserQuestionPrompt>`                  |

**记住这张表**：本节接下来的 1.2 先讲清「Ink 是什么、为什么终端能用 React」这个大前提；1.3～1.5 讲**线一**（`use-agent-loop.ts`：Context、节流刷新、`onSubmit` 消费事件流）；1.6～1.7 讲**线二、线三**（两个 `use*Manager` Hook + 两个弹窗组件）；1.8 回到 `app.tsx`，看三条线如何在一屏里**互斥地**合流（同一时刻，要么显示输入框，要么显示某个弹窗）。**每讲一块，我都会先标注它属于哪条线**，你就不会迷路。

**一个关键澄清（现在就说清）**：线一是「Agent **主动**吐、UI **被动**收」的**推流**；线二 / 线三是「Agent **主动**问、**卡住等**、UI 收集人类回答后**回**给它」的**阻塞式握手**。前者用「异步生成器」这个 pull 语义的东西承载（UI `for await` 主动拉），后者用「Promise + 订阅」这个 push 语义的东西承载（Manager 主动推给订阅者）。**这个「数据流用生成器、交互回路用 Promise+订阅」的分工，是理解本节的总钥匙。**

### 1.2 Ink 是什么：把 React 渲染到终端，于是状态管理全盘复用

在拆任何一个文件之前，必须先回答那个让所有人第一次读都发懵的问题：**一个命令行程序，为什么会 `import { Box, Text } from "ink"`、为什么会写 `<App/>`、为什么能用 `useState`？**

答案只有一句话：**[Ink](https://github.com/vadimdemedes/ink) 是一个「React 渲染器（renderer）」，它把 React 组件树渲染成的目标，不是浏览器的 DOM，而是终端里的文本。**

回忆 React 的架构：`react` 这个包只管「组件、状态、Hook、diff」这套**与平台无关**的核心逻辑；真正「把虚拟 DOM 画到某个地方」的活，是交给一个**渲染器**做的——网页用 `react-dom`（画到浏览器 DOM），手机用 `react-native`（画到原生控件），而**终端就用 `ink`（画到 stdout 的字符）**。所以：

- 你写的 `<Box flexDirection="column">` 不会变成 `<div>`，而是被 Ink 用 [Yoga](https://www.yogalayout.dev/)（Flexbox 布局引擎）算出位置、再输出成终端里排好版的一块区域。
- 你写的 `<Text color="yellow" bold>` 不会变成 `<span>`，而是被翻译成带 ANSI 转义码（`\x1b[33m…`）的黄色粗体文本。
- 你调的 `useState` / `useEffect` / `useContext` / `useMemo` / 自定义 Hook——**和网页里一模一样**，因为它们来自 `react` 核心包，与「画到哪」无关。状态一变，Ink 就重新 diff、把变化的部分重画到终端。
- Ink 还提供了几个「终端特有」的 Hook：`useInput`（监听键盘按键，本节两个弹窗都用它）、`useStdout`（拿到 stdout 的 `write`，本节 `useFlushToScrollback` 会用）。

**这就是本节所有设计的「地基假设」**：既然终端是一块「可以用 React 刷新的画布」，那么——

> **Agent 状态的每一次变化（多一条消息、streaming 开 / 关、弹出一个审批），都可以表达成一次 React `setState`；React 负责把这次状态变化，高效地重绘成终端里的新一帧。**

于是 Helixent 才敢把「一个会实时刷新、会弹窗、会滚动历史的复杂终端界面」的状态管理，**整个托付给 React**——用 `Context` 跨组件共享 Agent 状态、用自定义 Hook 封装「订阅一个外部 Manager」、用 `useMemo` 缓存派生数据。**看懂「Ink = React 的终端渲染器」这一句，你就拿到了读懂本节每一个 `.tsx` 文件的钥匙。**

> 💡 **为什么值得这么做？** 传统写 CLI 交互（比如手动 `readline` + 一堆 `console.log` + 手动清屏重画）会陷入「命令式地拼字符串、手动管理光标位置」的泥潭；而 Ink 让你**声明式地描述「界面此刻应该长什么样」**（`messages` 有几条就渲染几条、`streaming` 为真就显示微光），剩下的「怎么从上一帧变到这一帧」交给 React diff。**这与网页开发从 jQuery 命令式操作 DOM 进化到 React 声明式渲染，是同一次思想解放——只不过舞台从浏览器换成了终端。** 3.x 的工业对比会展开这一点。

有了这个大前提，我们正式走进第一条线——Agent 数据流的心脏 `use-agent-loop.ts`。

### 1.3 `AgentLoopProvider`：用 Context 分发「一次会话的全部状态」

> **这是线一（Agent 数据流）的核心，也是整个 TUI 的状态中枢。** [use-agent-loop.ts](../../src/cli/tui/hooks/use-agent-loop.ts) 做了两件事：定义一个 React Context 存放「一次会话的全部状态」，并用 `AgentLoopProvider` 组件把这些状态**装进 Context、分发给整棵组件树**。

先看它想分发的到底是**哪些状态**——这个 `AgentLoopState` 类型就是「一次会话的全部对外可见状态」的清单（[L11-L19](../../src/cli/tui/hooks/use-agent-loop.ts#L11-L19)）：

```ts
type AgentLoopState = {
  agent: Agent;                                       // 第 11 节装配好的 Agent 本尊
  streaming: boolean;                                 // Agent 此刻在不在「思考 / 干活」
  messages: NonSystemMessage[];                       // 要渲染的对话历史（第 2 节的 Message）
  onSubmit: (submission: PromptSubmission) => Promise<void>;  // 用户提交一条输入时调它
  abort: () => void;                                  // 中断当前流（Esc）
  tokenUsage: TokenUsageSummary;                      // token 用量（Footer 显示）
};

const AgentLoopContext = createContext<AgentLoopState | null>(null);
```

**为什么要用 Context？** 因为这些状态**散落在多个不相邻的组件里被消费**：`messages` 要给 `<MessageHistoryItem>` 渲染、`streaming` 要给 `<StreamingIndicator>` 和 `onSubmit`（防重入）用、`onSubmit`/`abort` 要给 `<InputBox>`、`tokenUsage` 要给 `<Footer>`、`agent` 要给 `<Header>`/`<Footer>` 读模型名。如果一层层 `props` 往下传（prop drilling），会非常啰嗦；用 Context 一次「广播」，任何后代组件用 `useAgentLoop()` 就能就近取用。这正是 [第 18 节](./18-cli-config-persistence.md) 第 ⑦ 步 `render(<AgentLoopProvider agent={agent} commands={commands}><App/></AgentLoopProvider>)` 的用意——**`AgentLoopProvider` 包在 `App` 外面，`App` 内部所有组件才能共享同一份会话状态**。

`AgentLoopProvider` 内部用几个 `useState` / `useRef` 建立状态（[L32-L37](../../src/cli/tui/hooks/use-agent-loop.ts#L32-L37)）：

```ts
const [streaming, setStreaming] = useState(false);
const [messages, setMessages] = useState<NonSystemMessage[]>([]);

const streamingRef = useRef(streaming);            // streaming 的「镜像」，供闭包同步读取
const pendingMessagesRef = useRef<NonSystemMessage[]>([]);  // 「待刷新」的消息缓冲区
const flushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);  // 50ms 批量刷新定时器
```

**注意这里同时用了 `useState` 和 `useRef` 来「配对」管理 `streaming`**（`streaming` + `streamingRef`）——这是一个下面 1.5 会重度依赖的技巧：`useState` 版负责**触发重渲染**（界面要跟着变），`useRef` 版负责**在异步闭包里读到「此刻真实的最新值」**（因为闭包会捕获旧的 `streaming` 变量，而 ref 永远指向最新）。所以有一个专门的 `useEffect` 把 ref 同步到 state（[L38-L40](../../src/cli/tui/hooks/use-agent-loop.ts#L38-L40)）：

```ts
useEffect(() => {
  streamingRef.current = streaming;
}, [streaming]);
```

**`pendingMessagesRef` 和 `flushTimerRef` 这一对 ref，则是下面 1.4「节流刷新」的核心道具**——它们不参与渲染（所以用 ref 而非 state），只是「攒消息的篮子」和「攒够了就倒出来的闹钟」。

### 1.4 `enqueueMessage` + 50ms 批量刷新：为什么不「来一条渲染一条」

> **这是本节 roadmap 点名的第一个亮点。** 问题的起点很朴素：Agent 的 `stream()` 在一个回合里可能**密集地**吐出很多条消息（一条 assistant 文本、紧接着好几条工具结果……），如果**每来一条就 `setMessages`**，React 就会被逼着在极短时间内**重渲染很多帧**——在终端这种「重绘代价不低」的画布上，这会造成明显的闪烁和卡顿。

Helixent 的解法是**「攒一批、50ms 刷一次」的节流（throttle）渲染**。看这一对函数（[L42-L65](../../src/cli/tui/hooks/use-agent-loop.ts#L42-L65)）：

```ts
const flushPendingMessages = useCallback(() => {
  if (flushTimerRef.current) {
    clearTimeout(flushTimerRef.current);
    flushTimerRef.current = null;
  }
  if (pendingMessagesRef.current.length === 0) return;

  const pending = pendingMessagesRef.current;
  pendingMessagesRef.current = [];                     // ① 清空篮子
  setMessages((prev) => [...prev, ...pending]);        // ② 一次性并入，只触发一次重渲染
}, []);

const enqueueMessage = useCallback(
  (message: NonSystemMessage) => {
    pendingMessagesRef.current.push(message);          // ③ 先扔进篮子，不立刻 setState
    if (flushTimerRef.current) return;                 // ④ 已经有闹钟在走了，什么都不做

    flushTimerRef.current = setTimeout(() => {          // ⑤ 没闹钟就设一个，50ms 后统一倒篮子
      flushPendingMessages();
    }, 50);
  },
  [flushPendingMessages],
);
```

**逐步拆解这套「篮子 + 闹钟」机制**：

1. **`enqueueMessage` 不直接 `setMessages`**，而是把消息 `push` 进 `pendingMessagesRef` 这个「篮子」（第 ③ 步）。篮子是 ref，改它**不触发重渲染**。
2. **第一次入篮时，设一个 50ms 的定时器**（第 ⑤ 步）；之后 50ms 内再来的消息，因为 `flushTimerRef.current` 已存在，直接 `return`（第 ④ 步）——**只是默默进篮子，不再设新闹钟**。
3. **50ms 到点，`flushPendingMessages` 把整篮消息一次性 `setMessages`**（第 ②）——**无论这 50ms 内攒了 1 条还是 10 条，都只触发一次重渲染**。这就是「节流」省下的重绘。
4. **`flushPendingMessages` 也可被主动调用**（不等闹钟）——它会先 `clearTimeout` 取消挂起的闹钟、再倒篮子。1.5 会看到，在「一个回合结束」「切换 / 清屏」这些**需要立刻把界面对齐到最新**的时刻，代码会主动调它「立即刷新」，不留尾巴。

**为什么选 50ms？** 这是一个经典的「人眼感知 vs 性能」权衡：50ms ≈ 20fps，对「文字流」这种内容，人眼几乎感觉不到「攒了一下」的延迟（低于「感觉卡顿」的阈值），却能把「一个回合内密集的 N 次 setState」压成「每 50ms 至多一次」，大幅减少终端重绘。**这是「节流」在 UI 刷新上的教科书用法**——不追求「每一条都即时」，而追求「肉眼流畅 + 机器省力」的平衡点。

**别忘了清理**：组件卸载时要把可能挂着的定时器清掉，避免「组件没了、闹钟还响、往一个已卸载组件 setState」的经典 React 警告（[L67-L73](../../src/cli/tui/hooks/use-agent-loop.ts#L67-L73)）：

```ts
useEffect(() => {
  return () => {
    if (flushTimerRef.current) {
      clearTimeout(flushTimerRef.current);
    }
  };
}, []);
```

> 💡 **`useCallback` 为什么在这里是「必要」而非「优化」**：`enqueueMessage` / `flushPendingMessages` 都被 `useCallback` 包住，让它们的「引用」在多次渲染间保持稳定。这不只是性能优化——`onSubmit`（下面 1.5）的 `useCallback` 依赖数组里列了 `enqueueMessage`、`flushPendingMessages`，如果它们每次渲染都换一个新引用，`onSubmit` 就会跟着不断重建，进而让依赖 `onSubmit` 的 `<InputBox>` 反复 re-render。**稳定的引用是 Hook 依赖链条正确工作的前提。**

### 1.5 `onSubmit`：消费 `agent.stream()` 事件流的「主循环消费者」

> **这是线一的「引擎」，也是第 5 节 `agent.stream()` 生成器的唯一消费者。** 当用户在输入框敲下一行字按回车，`<InputBox>` 就会调 `onSubmit(submission)`。这个 `useCallback` 是本文件最长、也最能体现「Agent 事件 → React 状态」桥接的一段（[L83-L150](../../src/cli/tui/hooks/use-agent-loop.ts#L83-L150)）。

我们分段读。**第一段：先处理「斜杠内建命令」的分流**（[L84-L117](../../src/cli/tui/hooks/use-agent-loop.ts#L84-L117)）：

```ts
const onSubmit = useCallback(
  async (submission: PromptSubmission) => {
    const { text, requestedSkillName } = submission;
    const invocation = resolveBuiltinCommand(text);        // 解析是不是 /exit /clear /help 之类

    if (invocation?.name === "exit" || invocation?.name === "quit") {
      process.exit(0);                                     // /exit：直接退进程
      return;
    }
    if (streamingRef.current) return;                      // ★ 防重入：正在跑就忽略新输入

    if (invocation?.name === "clear") {
      agent.clearMessages();                               // 清 Agent 内部对话历史（第 5 节）
      flushPendingMessages();                              // 先把篮子倒干净
      setMessages([]);                                     // 清 UI 消息
      clearTerminal();                                     // 清屏（写 ANSI 转义码）
      return;
    }
    if (invocation?.name === "help") {
      flushPendingMessages();
      const userMessage: UserMessage = { role: "user", content: [{ type: "text", text }] };
      const helpMessage: AssistantMessage = {
        role: "assistant",
        content: [{ type: "text", text: formatHelp(commands, invocation.args || undefined) }],
      };
      setMessages((prev) => [...prev, userMessage, helpMessage]);  // 把帮助文本「伪装」成一轮对话直接显示
      return;
    }
    // ... 下面才是真正跑 Agent
```

**这一段的关键点**：

- **`resolveBuiltinCommand(text)`**（来自 [command-registry.ts](../../src/cli/tui/command-registry.ts)，第 20 节精讲）识别出以 `/` 开头的内建命令。**`exit`/`quit`/`clear`/`help` 这几条是「UI 本地就能处理、根本不该惊动 Agent」的**——它们在这里被**就地拦截**并 `return`，压根不会走到下面的 `agent.stream()`。这是「命令」与「对话」的第一道分流（斜杠命令体系的完整实现留给第 20 节，本节只看它在这里被消费）。
- **`if (streamingRef.current) return;` 这行是「防重入」的命门**（[L93](../../src/cli/tui/hooks/use-agent-loop.ts#L93)）。**注意它读的是 `streamingRef.current` 而非 `streaming`**——正是 1.3 埋下的伏笔：`onSubmit` 是个异步闭包，它捕获的 `streaming` 变量是「创建这个闭包那一刻的旧值」，可能已经过期；而 `streamingRef.current` 永远是最新的真值。**如果 Agent 正在跑（streaming），再敲输入就直接忽略**——避免「上一轮还没结束就又发起一轮」把 Agent 搞乱（`agent.stream()` 本身也有「已在 streaming 就抛错」的保护，见第 5 节，这里是 UI 侧的第一道拦截）。
- **`clear` / `help` 都先调 `flushPendingMessages()`**：因为它们要**立刻**改 `messages`（清空 / 追加帮助），必须先把「篮子里可能还没倒的消息」处理掉，保证顺序不乱。这就是 1.4 说的「主动立即刷新」的用武之地。

**第二段：真正驱动 Agent，消费事件流**（[L119-L150](../../src/cli/tui/hooks/use-agent-loop.ts#L119-L150)）：

```ts
    setStreaming(true);                                    // ① 标记「开始跑」，界面显示微光
    try {
      agent.setRequestedSkillName(requestedSkillName);     // ② 若用户 @了某技能，告知 Agent（第 9 节）
      const userMessage: UserMessage = { role: "user", content: [{ type: "text", text }] };
      setMessages((prev) => [...prev, userMessage]);       // ③ 立刻把「用户这句话」上屏

      const stream = agent.stream(userMessage);            // ④ 第 5 节的主循环生成器
      for await (const event of stream) {                  // ⑤ 逐个消费事件
        if (event.type === "message") {
          enqueueMessage(event.message);                   // ⑥ message 事件 → 进节流篮子
        }
        // progress 事件被「故意忽略」——见下方注释
      }
    } catch (error) {
      if (isAbortError(error)) return;                     // ⑦ 用户主动中断，静默收场
      const errorMessage = error instanceof Error ? error.message : String(error);
      enqueueMessage({                                     // ⑧ 其它错误 → 变成一条 assistant 消息显示
        role: "assistant",
        content: [{ type: "text", text: `Error: ${errorMessage}\n\nYou can try again.` }],
      });
    } finally {
      agent.setRequestedSkillName(null);                   // ⑨ 清理技能标记
      flushPendingMessages();                              // ⑩ 回合结束，把篮子彻底倒干净
      setStreaming(false);                                 // ⑪ 标记「跑完了」，微光消失
    }
  },
  [agent, commands, enqueueMessage, flushPendingMessages],
);
```

**这段就是「第 5 节的生成器」与「React 状态」的接缝，逐点看**：

- **① / ⑪ `setStreaming(true/false)` 包住整个过程**：`streaming` 这个布尔一开一关，`<StreamingIndicator>`（1.8 会看到）就据此显示 / 隐藏「Thinking… 微光」。**它是「Agent 在不在忙」的唯一真相源**——注意界面并**不**逐字显示模型输出，而是「忙就转个圈、不忙就收起来」，具体消息内容由 `messages` 负责。
- **③ 用户消息「立刻上屏」，用 `setMessages` 不走节流**：因为用户刚敲的话必须**零延迟**回显（这是交互的即时反馈），不能进 50ms 篮子。而 Agent 吐的消息（第 ⑥ 步）才走 `enqueueMessage` 节流——**「用户输入即时、Agent 输出节流」这个区别对待，是体验和性能的精准取舍**。
- **⑤⑥ `for await` 消费事件流**：这就是第 5 节结尾追问的「谁来 `for await` 这个生成器」的答案。只挑 `event.type === "message"` 的事件 `enqueueMessage`；**`progress` 事件被故意忽略**。源码里那段注释把原因写得很清楚（[L131-L133](../../src/cli/tui/hooks/use-agent-loop.ts#L131-L133)）：

  > progress events intentionally ignored: the UI shows a generic "Thinking..." shimmer driven by the `streaming` boolean, and MessageHistory is the single source of truth for tool calls.
  >

  **翻译一下这个设计决策**：进度事件（模型正在逐字吐 thinking / 正在拼某个工具的参数）**不驱动界面**——界面不搞「逐字打字机」效果，只用一个笼统的「Thinking… 微光」表示「在忙」（由 `streaming` 驱动）；而**所有工具调用的展示，都以 `messages`（`MessageHistory`）为唯一真相源**。这样做既避免了「进度事件太密集导致的刷新风暴」，又保证了「工具调用只有一处显示逻辑，不会两处打架」。**这是一个「少即是多」的克制决策——不是所有能显示的都要显示。**
- **⑦ `isAbortError` 静默收场**：用户按 Esc → `abort()` → `agent.stream()` 抛 AbortError。这不是「错误」，是「用户主动喊停」，所以 `return` 掉、什么都不显示。`isAbortError`（[L179-L184](../../src/cli/tui/hooks/use-agent-loop.ts#L179-L184)）还特意认了 `DOMException` 的 `AbortError`、`Error.name === "AbortError"`、以及 Anthropic SDK 的 `APIUserAbortError` 三种形态——**因为「中断」这个信号在不同层可能被包装成不同的异常类型**，得都识别出来。
- **⑧ 其它错误「变成一条 assistant 消息」而非崩溃**：模型 API 报错（限流、余额不足、网络断）时，**不让整个 TUI 崩掉**，而是把错误信息包装成一条普通的 assistant 文本消息 `enqueueMessage` 上屏，并附一句 "You can try again."。**这是「错误也是一种要展示的内容」的容错哲学**——呼应第 5 节 `_act` 里「工具错误就地捕获成文本」的同一种思路：**宁可把错误变成界面上一条可读的消息，也不让异常冒泡到顶层把程序打死。**
- **⑨⑩⑪ `finally` 做收尾**：无论成功、报错、还是中断，都要清技能标记、`flushPendingMessages()` 把篮子倒干净（保证最后几条消息一定上屏，不残留在篮子里）、并 `setStreaming(false)` 关掉微光。**`finally` 保证这三件收尾无论走哪条分支都执行**——这是「资源 / 状态一定要复位」的稳妥写法。

**最后，把状态打包进 Context 分发出去**（[L152-L165](../../src/cli/tui/hooks/use-agent-loop.ts#L152-L165)）：

```ts
const value = useMemo(
  () => ({ agent, streaming, messages, onSubmit, abort, tokenUsage }),
  [abort, agent, messages, onSubmit, streaming, tokenUsage],
);
return createElement(AgentLoopContext.Provider, { value }, children);
```

`useMemo` 把这六个字段打包成一个稳定对象，只有依赖变化时才重建 `value`——避免「每次渲染都给 Context 一个新对象、导致所有消费者无谓重渲染」。`tokenUsage` 则由另一个 `useMemo` 从 `messages` 派生（[L79-L81](../../src/cli/tui/hooks/use-agent-loop.ts#L79-L81)，调 [token-usage.ts](../../src/cli/tui/token-usage.ts) 的 `calculateTokenUsage`，累加每条 assistant 消息的 usage——细节属第 20 节的「用量统计」，本节只看它挂进 Context）。

配套的消费端 Hook 极简（[L167-L177](../../src/cli/tui/hooks/use-agent-loop.ts#L167-L177)）：

```ts
export function useAgentLoop() {
  const state = useContext(AgentLoopContext);
  if (!state) {
    throw new Error("useAgentLoop() must be used within <AgentLoopProvider agent={...}>");
  }
  return state;
}
```

**那个 `if (!state) throw` 是一个防御性好习惯**：如果有人不小心在 `AgentLoopProvider` 外面用了 `useAgentLoop()`，Context 会是 `null`，这里立刻抛出一句清晰的错误（而不是让代码在更晚的地方因为 `state.messages` 读 `null` 而崩在莫名其妙的位置）。**「在契约被违反的第一现场就 fail fast」——这与第 18 节 `getHelixentHomePath` 未设环境变量就抛错是同一种防御哲学。**

**至此线一讲完**：用户输入 → `onSubmit` → （斜杠命令就地处理 / 否则）`agent.stream()` → `for await` 挑 message 事件 → `enqueueMessage` 节流进篮子 → 50ms 批量 `setMessages` → 界面重渲染。全程 `streaming` 布尔驱动微光、`messages` 数组驱动内容、错误被收编成消息。**这条「单向数据流」把第 5 节那台生成器，稳稳接进了 React 的状态循环。** 下面转向两条「双向交互回路」。

### 1.6 两个 `use*Manager` Hook：把第 15 节的「等待响应」变成一个 React state

> **这是线二、线三的 UI 侧入口，也是 [第 15 节](./15-human-in-the-loop.md) 那句「等一个 UI 来 subscribe」的兑现现场。** 这两个 Hook——[use-approval-manager.ts](../../src/cli/tui/hooks/use-approval-manager.ts) 和 [use-ask-user-question-manager.ts](../../src/cli/tui/hooks/use-ask-user-question-manager.ts)——短到几乎可以背下来，但它们承载的思想（「把一个外部的、命令式的订阅源，包装成一个声明式的 React state」）却非常重要。

先回到第 15 节的悬念。[第 15 节](./15-human-in-the-loop.md) 造了两个 global Manager，它们的形状（1.1 的表格已经列过）是「队列 + 单活跃请求 + 单订阅者」：

- `askUser(toolUse)` / `askUserQuestion(params)`：**Agent 侧**调用，返回一个 `Promise`。Agent `await` 它——**于是 Agent 被阻塞，卡在这里等人类回应**。同时请求被推进队列。
- `subscribe(callback)`：**UI 侧**调用，注册**唯一**的订阅者。队列一有「当前活跃请求」，就 `callback(request)`；队列空了，就 `callback(null)`。返回一个「取消订阅」函数。
- `respond(decision)` / `respondWithAnswers(result)`：**UI 侧**调用，用人类的回应 `resolve` 掉那个 Promise——**于是 Agent 解除阻塞，继续往下跑**。

**现在的问题是：UI 怎么把这个「命令式的订阅」接进 React？** 答案就是这个只有 20 来行的自定义 Hook。先看审批的（[use-approval-manager.ts](../../src/cli/tui/hooks/use-approval-manager.ts) 全文）：

```ts
import { useEffect, useState } from "react";
import { globalApprovalManager, type ApprovalDecision, type ApprovalRequest } from "@/coding";

export function useApprovalManager() {
  const [request, setRequest] = useState<ApprovalRequest | null>(null);

  useEffect(() => {
    return globalApprovalManager.subscribe((req) => {
      // req will be null when queue is empty, or the next request object
      setRequest(req);
    });
  }, []);

  const respond = (decision: ApprovalDecision) => {
    if (request) {
      globalApprovalManager.respond(decision);
    }
  };

  return {
    approvalRequest: request,
    respondToApproval: respond,
  };
}
```

**这短短几行，做了一次漂亮的「范式转换」——把『命令式订阅』翻译成『声明式 state』**，逐点拆：

1. **`useState<ApprovalRequest | null>(null)`**：用一个 React state 存「当前活跃的审批请求」。`null` 表示「此刻没有待审批的请求」，非 `null` 表示「有一个请求正等着人类决定」。**这个 state 就是线二在 UI 侧的『落点』。**
2. **`useEffect(() => { return manager.subscribe(setRequest); }, [])`**：这是全 Hook 的精华。`useEffect` 在组件挂载时（`[]` 空依赖 → 只跑一次）调 `globalApprovalManager.subscribe(...)`，把 Manager 每次推来的 `req`（请求对象或 `null`）直接 `setRequest` 进 state。**于是「Manager 队列的活跃请求」和「React 的 request state」被绑定成同步的**——Manager 一推，state 一变，界面就重渲染。
3. **`return manager.subscribe(...)` 的返回值 = 取消订阅函数**：`useEffect` 的返回值会被 React 当作「清理函数」在组件卸载时调用。而 `subscribe` 恰好返回一个「取消订阅」函数（第 15 节设计的）。**两者一拍即合**——这就是为什么可以直接 `return globalApprovalManager.subscribe(...)`：订阅的生命周期，正好绑定到组件的生命周期。**这是「用 `useEffect` 管理外部订阅」的标准模式**（React 官方推荐的「订阅外部数据源」写法）。
4. **`respond(decision)`**：包一层 `globalApprovalManager.respond`，供弹窗组件在用户做出决定时调用。那个 `if (request)` 的守卫确保「没有活跃请求时按键不会误触发」。

**提问的那个 Hook 几乎是逐字镜像**（[use-ask-user-question-manager.ts](../../src/cli/tui/hooks/use-ask-user-question-manager.ts)）——只是把 `globalApprovalManager` 换成 `globalAskUserQuestionManager`、`respond` 换成 `respondWithAnswers`、类型换成 `AskUserQuestionRequest`/`AskUserQuestionResult`：

```ts
export function useAskUserQuestionManager() {
  const [request, setRequest] = useState<AskUserQuestionRequest | null>(null);

  useEffect(() => {
    return globalAskUserQuestionManager.subscribe((req) => {
      setRequest(req);
    });
  }, []);

  const respondWithAnswers = (result: AskUserQuestionResult) => {
    if (request) {
      globalAskUserQuestionManager.respondWithAnswers(result);
    }
  };

  return { askUserQuestionRequest: request, respondWithAnswers };
}
```

**两个 Hook 几乎一模一样，这不是巧合——它正是第 15 节「两个 Manager 共享同一套队列 + 单活跃 + 订阅模型」的直接回响**：既然两个 Manager 的接口形状（`subscribe`/`respond`）被设计成一致，那么消费它们的 Hook 自然也长得一样。**第 15 节在 coding 层把「审批」和「提问」抽象成同构的基础设施，本节就在 cli 层收到了这份『同构』的红利——两个 Hook 可以照着同一个模板写。** （至于「为什么第 15 节不把两个 Manager 抽成一个基类」，第 15 节 Q4 已论证过：接口相同、语义不同，共享接口而非继承实现——这里两个 Hook 的「相似而不合并」是同一种判断的延续。）

> 💡 **这个 Hook 的深层价值——「异步 Promise」与「React 渲染」两个世界的桥**：Agent 那边是「`await` 一个 Promise、被阻塞」的**异步命令式**世界；React 这边是「state 变了就重渲染」的**声明式**世界。这两个世界本来说不上话。而这个 Hook 就是**桥**：它把「Manager 有个待响应请求」这件**异步事件**，翻译成「`request` state 非 null」这个**可渲染状态**；再把「用户在界面上的操作」，翻译回「调 `respond` resolve Promise」这个**异步动作**。**第 15 节把 Manager 设计成『队列 + 订阅』，正是为了能被这样一座桥接进任意 UI**——第 18 节 Q5 甚至预言过「换成 Web 界面，也能 subscribe 同一个 Manager」，本节就是那个预言在「终端 UI」上的落地实例。

**但请注意**：这两个 Hook 只负责「拿到当前请求 state」和「提供 respond 方法」——它们**不负责画弹窗**。「把 `request` 画成一个能让用户操作的表单」，是下面两个 `.tsx` 弹窗组件的活。

### 1.7 两个弹窗组件：`useInput` 驱动的键盘表单

> **这是线二、线三的「交互面」。** 拿到 `request` state 后，得把它画成一个用户能用键盘操作的表单，并在用户操作完后调 `respond`。这就是 [approval-prompt.tsx](../../src/cli/tui/components/approval-prompt.tsx) 和 [ask-user-question-prompt.tsx](../../src/cli/tui/components/ask-user-question-prompt.tsx) 的职责。两者都靠 Ink 的 **`useInput`** Hook 监听键盘——这也是本节唯一深入「组件如何响应按键」的地方（其余输入 / 渲染留给第 20 节）。

**先看审批弹窗 `<ApprovalPrompt>`**——它相对简单，是一个「上下选、回车确认、或按快捷键」的单选菜单。先看选项定义（[L7-L21](../../src/cli/tui/components/approval-prompt.tsx#L7-L21)）：

```ts
const ALL_OPTIONS = [
  { decision: "allow_once", label: "Yes — this time only", shortcut: "y", color: "green" },
  { decision: "allow_always_project", label: "Yes, always allow in this project", shortcut: "a", color: "green" },
  { decision: "deny", label: "No", shortcut: "n", color: "red" },
] as const;
```

**这三个选项正好对应第 15 节 `ApprovalDecision` 的三个值**（`allow_once` / `allow_always_project` / `deny`）。还记得第 18 节吗？——`allow_always_project`（永久允许本项目）那个决定，最终会被 `SettingsWriter.appendAllowedTool` 写进 `settings.local.json`。**所以用户在这个弹窗里按下的 `a`，就是第 18 节那套「审批白名单落盘」的触发源头**。三条线（第 15 节的 Manager、第 18 节的落盘、本节的弹窗）在这个小菜单上闭环了。

组件先根据 `supportProjectWideAllow` 决定「要不要显示『永久允许本项目』这一项」（[L33-L36](../../src/cli/tui/components/approval-prompt.tsx#L33-L36)）：

```ts
const options = useMemo(
  () => (supportProjectWideAllow ? ALL_OPTIONS : ALL_OPTIONS.filter((o) => o.decision !== "allow_always_project")),
  [supportProjectWideAllow],
);
```

**这个 `supportProjectWideAllow` 就是第 18 节第 ⑦ 步 `<App commands={commands} supportProjectWideAllow />` 传进来的那个开关**——它一路从 `cli/index.tsx` 传到 `App`、再传到这个弹窗，控制「永久允许」这个高权限选项是否出现。**一个 prop 贯穿三层，把「是否允许项目级永久授权」这个策略从最外层的装配点，一直贯彻到最里层的按钮——这是 props 作为『配置通道』的典型用法。**

核心是 `useInput` 的键盘处理（[L42-L65](../../src/cli/tui/components/approval-prompt.tsx#L42-L65)）：

```ts
useInput((input, key) => {
  if (key.upArrow)   { setIndex((i) => (i > 0 ? i - 1 : options.length - 1)); return; }
  if (key.downArrow) { setIndex((i) => (i < options.length - 1 ? i + 1 : 0)); return; }
  if (key.return)    { onDecision(options[index]!.decision); return; }   // 回车 = 选中当前高亮项

  const k = input.toLowerCase();
  if (k === "y" || input === "1") {
    onDecision("allow_once");                                             // 快捷键直接下决定
  } else if (supportProjectWideAllow && (k === "a" || input === "2")) {
    onDecision("allow_always_project");
  } else if (supportProjectWideAllow && (k === "n" || input === "3")) {
    onDecision("deny");
  } else if (!supportProjectWideAllow && (k === "n" || input === "2")) {
    onDecision("deny");
  }
});
```

**这里有两种操作路径，都很符合终端用户的直觉**：

1. **方向键移动高亮 + 回车确认**：`↑`/`↓` 改 `index`（带循环回绕：到顶再上就跳到底），`Enter` 提交当前高亮项。
2. **字母 / 数字快捷键直接下决定**：`y`（allow_once）、`a`（allow_always_project）、`n`（deny），或对应的数字 `1`/`2`/`3`。**注意数字的映射随 `supportProjectWideAllow` 变化**——开启时 `n` 是第 3 项（数字 `3`），关闭时 `deny` 变成第 2 项（数字 `2`）。这个细节保证「数字快捷键」始终和屏幕上看到的编号一致。

无论走哪条路径，最终都是调 `onDecision(decision)`——**而这个 `onDecision`，就是 1.6 那个 Hook 返回的 `respondToApproval`**（由 `App` 传入，1.8 会看到接线）。**闭环达成**：用户按键 → `onDecision` → `globalApprovalManager.respond(decision)` → resolve 掉 Agent 那边 `await` 的 Promise → Agent 继续（放行则执行工具，拒绝则把 `deny` 当成工具结果喂回模型）。

组件的渲染部分（[L70-L88](../../src/cli/tui/components/approval-prompt.tsx#L70-L88)）用一个黄色圆角边框的 `<Box>` 显示：⚠️ 标题 + 工具名、工具入参（`JSON.stringify` 后**超过 500 字符会截断**，避免一个巨型 patch 撑爆屏幕）、以及带高亮光标 `❯` 的选项列表。**这些 `<Box>`/`<Text>` 就是 1.2 说的「被 Ink 渲染成终端字符」的声明式描述**——你只说「长这样」，Ink 负责画。

**再看提问弹窗 `<AskUserQuestionPrompt>`**——它是本节**最复杂的组件**（263 行），因为 `ask_user_question` 工具（第 15 节）支持「一次问 1～4 个平行问题、每个问题可单选或多选、单选项还能带 Markdown 预览」。但**再复杂，它的骨架和审批弹窗是同一个套路**：`useState` 管选择状态 + `useInput` 处理按键 + 最后调 `onSubmit` 回传。我们抓其主干，不逐行陷进去。

**状态设计**（[L41-L46](../../src/cli/tui/components/ask-user-question-prompt.tsx#L41-L46)）：

```ts
const [tabIndex, setTabIndex] = useState(0);                             // 当前在第几个问题（或「确认」页）
const [selections, setSelections] = useState<string[][]>(() => buildInitialSelections(questions));  // 每个问题选了哪些 label
const [focusIdx, setFocusIdx] = useState<number[]>(() => buildInitialFocus(questions));  // 每个问题当前高亮到第几个选项

const stateRef = useRef({ tabIndex, selections, focusIdx, questions, qCount, reviewTabIndex });
stateRef.current = { tabIndex, selections, focusIdx, questions, qCount, reviewTabIndex };
```

- **多个问题 → 用 `tabIndex` 在「标签页」间切换**：多问题时，顶部渲染一排 tab（每个问题一个 + 一个「Confirm 确认」页），`←`/`→` 切换。单个问题时则没有 tab、直接显示。
- **`selections: string[][]`**：二维数组——外层对应「第几个问题」，内层是「这个问题选中的 label 列表」（单选恒为 1 个、多选可多个）。
- **`focusIdx: number[]`**：每个问题「当前光标停在第几个选项」。
- **注意那个 `stateRef`**（[L45-L46](../../src/cli/tui/components/ask-user-question-prompt.tsx#L45-L46)）：它把所有状态镜像进一个 ref，**每次渲染都同步刷新**。**为什么？** 和 1.3/1.5 的 `streamingRef` 同一个道理——`useInput` 的回调是一个「注册一次」的闭包，如果直接读 `tabIndex`/`selections`，会读到「注册那一刻的旧值」；改读 `stateRef.current`，就能拿到「按键那一刻的最新值」。**这是「在长期存活的事件回调里读最新 state」的通用解法，本节出现了三次（`streamingRef`、这里、以及贯穿始终的这个模式）——值得记牢。**

**键盘处理**（[L59-L145](../../src/cli/tui/components/ask-user-question-prompt.tsx#L59-L145)）分几类按键，主干如下：

- **`←`/`→`（多问题时）**：切 `tabIndex`（在「各问题」和「确认页」间循环）。
- **`↑`/`↓`（在问题页时）**：移动该问题的 `focusIdx`（带回绕）；**如果是单选题，移动光标的同时就把选择更新为当前项**（单选「移到哪就选哪」）。
- **`Space`（在多选题时）**：切换当前高亮项的「选中 / 取消」——`indexOf` 找到就 `splice` 删掉、没找到就 `push` 加入。**这是「多选」区别于「单选」的关键交互。**
- **`Enter`**：语义随上下文变化——单个问题时直接提交；在「确认页」时提交；否则「前进到下一个问题 / 跳到确认页」。**这个「Enter 有时是下一步、有时是提交」的分派，是多步表单的常见设计。**

提交走 `trySubmit`（[L48-L57](../../src/cli/tui/components/ask-user-question-prompt.tsx#L48-L57)）：

```ts
const trySubmit = useCallback(() => {
  const { selections: sel, questions: qs } = stateRef.current;
  if (!canSubmit(qs, sel)) return;                            // 校验：每个问题都满足「单选恰好1个/多选至少1个」
  onSubmit({
    answers: qs.map((_, i) => ({
      question_index: i,
      selected_labels: [...sel[i]!],
    })),
  });
}, [onSubmit]);
```

**它先用 `canSubmit` 校验「每个问题都答够了」**（单选恰好 1 个、多选至少 1 个），不满足就拒绝提交（避免交回残缺答案）；满足则把 `selections` 打包成第 15 节 `AskUserQuestionResult` 的 `{ answers: [{ question_index, selected_labels }] }` 结构，调 `onSubmit` 回传。**这个 `onSubmit` 就是 1.6 那个 Hook 的 `respondWithAnswers`**——闭环同样达成：用户选完 → `onSubmit` → `globalAskUserQuestionManager.respondWithAnswers(result)` → resolve 掉 `ask_user_question` 工具 `await` 的 Promise → 工具返回 `JSON.stringify(result)` 给模型 → Agent 拿到用户的选择继续。

> 💡 **两个弹窗的「同构」再次印证第 15 节的抽象**：审批弹窗和提问弹窗，一个简单一个复杂，但**骨架完全一致**——`useState` 存本地交互状态、`useInput` 处理键盘、校验后调一个 `onXxx` 回调回传。这个回调最终都接到「1.6 的 Hook → 第 15 节的 Manager.respond*」。**第 15 节把两种人机交互抽象成同一套『队列 + 单活跃 + 订阅 + respond』，使得它们在 UI 层能用同一个『Hook + 键盘表单』模板落地**——无论交互本身多简单（审批三选一）或多复杂（多问题多选带预览），接进系统的方式都一样。**这就是好的抽象的复利：一次设计，多处受益。**（提问弹窗里的 `<Markdown>` 预览、`<ReviewPanel>`/`<QuestionPanel>` 的具体绘制，属于「渲染」范畴，第 20 节的 `markdown` 一节会讲，本节按边界声明「摆位即止」。）

### 1.8 回到 `app.tsx`：三条线在一屏里「互斥合流」

> **三条线在这里汇合成一屏。** [app.tsx](../../src/cli/tui/app.tsx) 是「界面总装图」——它把前面所有 Hook 拉进来、决定此刻该渲染什么。**它最关键的设计，是『互斥』：同一时刻，屏幕底部要么是输入框、要么是审批弹窗、要么是提问弹窗，三者只能有一个。**

先看 `App` 开头怎么把三条线的状态一次性取齐（[L32-L37](../../src/cli/tui/app.tsx#L32-L37)）：

```ts
const { streaming, messages, onSubmit, abort } = useAgentLoop();              // 线一
const { approvalRequest, respondToApproval } = useApprovalManager();          // 线二
const { askUserQuestionRequest, respondWithAnswers } = useAskUserQuestionManager();  // 线三
const { latestTodos, todoSnapshots } = useMemo(() => buildTodoViewState(messages), [messages]);
const nextTodo = getNextTodo(latestTodos)?.content;
const hideTodos = !streaming && allDone(latestTodos);
```

**一眼就能看出三条线各自的入口**：`useAgentLoop()` 取线一的 Agent 状态，`useApprovalManager()` / `useAskUserQuestionManager()` 各取一条交互回路的「当前请求 + respond 方法」。`todoView` 那几行是从 `messages` 派生待办清单（`buildTodoViewState` 来自 [todo-view.ts](../../src/cli/tui/todo-view.ts)，把历史消息里的 `todo_write` 工具调用「重放」成当前待办状态——属第 10 节 Todos 的展示端，本节只看它被 `App` 用来渲染 `<TodoPanel>`）。

**核心是 `return` 里的渲染结构，尤其是那段「互斥三选一」**（[L48-L81](../../src/cli/tui/app.tsx#L48-L81)）：

```tsx
return (
  <Box flexDirection="column" width="100%">
    {messages.length === 0 && <Header />}                          {/* 空会话才显示大 Logo 头部 */}
    <Box flexDirection="column" marginTop={1} rowGap={1}>
      {lastMessage && (
        <MessageHistoryItem                                        {/* 只渲染「最后一条」消息（见下） */}
          key={`msg:${lastMessage.role}:${messages.length - 1}`}
          message={lastMessage}
          messageIndex={messages.length - 1}
          todoSnapshots={todoSnapshots}
        />
      )}
      {approvalRequest || askUserQuestionRequest ? null : (         {/* 有弹窗时不显示微光 */}
        <StreamingIndicator streaming={streaming} nextTodo={nextTodo} />
      )}
      {!hideTodos && <TodoPanel todos={latestTodos} />}
      {approvalRequest ? (                                          {/* ★ 互斥三选一从这里开始 */}
        <ApprovalPrompt
          toolUse={approvalRequest.toolUse}
          supportProjectWideAllow={supportProjectWideAllow}
          onDecision={respondToApproval}                           {/* 线二接线：弹窗 → Hook.respond */}
        />
      ) : askUserQuestionRequest ? (
        <AskUserQuestionPrompt
          questions={askUserQuestionRequest.params.questions}
          onSubmit={respondWithAnswers}                            {/* 线三接线：弹窗 → Hook.respond */}
        />
      ) : (
        <InputBox commands={commands} onSubmit={onSubmit} onAbort={abort} />  {/* 默认：输入框 */}
      )}
    </Box>
    <Footer />
  </Box>
);
```

**这段三元表达式链，就是本节「三条线合流」的收束点，逐层看它的『互斥』逻辑**：

1. **`approvalRequest ? <ApprovalPrompt/> : askUserQuestionRequest ? <AskUserQuestionPrompt/> : <InputBox/>`**——这条链保证**同一时刻只渲染三者之一**：有审批请求就显示审批弹窗，否则有提问请求就显示提问弹窗，否则（两条回路都空闲）才显示输入框。**为什么必须互斥？** 因为它们都要抢占键盘（都用 `useInput` 或输入）——如果同时挂载两个 `useInput`，用户的按键会被两个组件同时截获，行为错乱。**「同一时刻只有一个组件在监听键盘」是终端 UI 的硬约束**，这条互斥链就是它的落地。**这也解释了第 15 节两个 Manager 为什么是『单活跃请求』**——因为 UI 一次只能显示一个弹窗、处理一个请求，Manager 层的「单活跃 + 排队」正好和 UI 层的「互斥渲染」严丝合缝地对上了。
2. **接线在这里完成**：`<ApprovalPrompt onDecision={respondToApproval}/>` 和 `<AskUserQuestionPrompt onSubmit={respondWithAnswers}/>`——**把 1.6 两个 Hook 返回的 `respond` 方法，作为回调传给 1.7 两个弹窗组件**。这就是 1.7 反复说的「`onDecision`/`onSubmit` 最终接到 Hook.respond」的**物理接线现场**。至此线二、线三的完整回路贯通：Manager 推请求 → Hook `setRequest` → `App` 渲染弹窗 → 用户操作 → 弹窗调 `respond` → Manager resolve Promise → Agent 继续。
3. **`approvalRequest || askUserQuestionRequest ? null : <StreamingIndicator/>`**：**有弹窗时，连「Thinking… 微光」都不显示**——因为此刻 Agent 正卡在「等人类回应」上，显示「思考中」会误导用户（它不是在思考，是在等你）。这个小细节体现了「界面状态要诚实反映系统真实状态」的严谨。

**另一个值得停留的设计——「只渲染最后一条消息」**（[L42-L44](../../src/cli/tui/app.tsx#L42-L44) + [L52-L59](../../src/cli/tui/app.tsx#L52-L59)）：

```ts
const lastMessage = messages.length > 0 ? messages[messages.length - 1]! : undefined;
// ... 渲染时只渲染 lastMessage 这一条，而非整个 messages 数组
```

**等等——只渲染最后一条，那前面的历史消息去哪了？** 答案在 `useFlushToScrollback` 这个自定义 Hook（[L84-L102](../../src/cli/tui/app.tsx#L84-L102)）：

```ts
function useFlushToScrollback(messages, flushedRef, write) {
  useEffect(() => {
    const targetCount = messages.length > 0 ? messages.length - 1 : 0;   // 除了最后一条，其余都该「定稿」
    if (targetCount <= flushedRef.current) return;

    const toFlush = messages.slice(flushedRef.current, targetCount);       // 取「新定稿」的那些消息
    for (const msg of toFlush) {
      const text = messageToPlainText(msg);                               // 转成带 ANSI 颜色的纯文本
      if (text) {
        write(text + "\n");                                               // ★ 直接写进终端 scrollback
      }
    }
    flushedRef.current = targetCount;                                     // 记录「已定稿到第几条」
  }, [messages, write, flushedRef]);
}
```

**这是一个非常精巧的「Ink 活动区 + 终端 scrollback」的分工设计**：

- **Ink 只负责渲染「最后一条消息 + 弹窗 / 输入框 + 页脚」这一小块「活动区」**——这块区域会随状态频繁重绘（微光在转、输入框在打字）。**Ink 重绘的代价，和它管理的区域大小成正比**，所以让它只管一小块「活动区」，重绘极快。
- **一旦一条消息「定稿」（不再是最后一条，即它后面又来了新消息），就用 `useStdout().write` 把它的纯文本『打印』进终端本身的 scrollback（回滚缓冲区）**，然后**从 Ink 的管辖中「毕业」**。`messageToPlainText`（来自 [message-text.ts](../../src/cli/tui/message-text.ts)，第 20 节精讲）把消息转成带 ANSI 颜色码的一段纯文本。
- **`flushedRef` 记录「已经 flush 到第几条」**，避免重复打印。它是 ref（不触发渲染），纯粹当「进度游标」。

**为什么要这么设计？** 如果让 Ink 渲染**整个** `messages` 数组，那么随着对话变长，Ink 要管理的区域越来越大，每次微光跳动都要重绘成百上千行——**会越用越卡**。而「定稿的消息交给终端原生 scrollback（就像普通的 `console.log` 输出，终端自己高效管理、还能用鼠标滚轮回看），Ink 只盯着一小块活动区」——**就把「重绘成本」从 O(对话长度) 压到了 O(1)**。这也顺带带来一个好处：**定稿的历史消息像普通终端输出一样留在滚动历史里，可以用终端的原生滚动查看**，不受 Ink 活动区的限制。

> 💡 **这个「活动区 vs scrollback」的分工，是终端 TUI 的一个高级技巧**（`useFlushToScrollback` 的完整价值第 20 节还会从「渲染」角度再谈一次）。它的思想内核是：**把「频繁变化的一小块」和「一旦定稿就不再变的一大片」分开——前者用 React/Ink 声明式管理，后者交还给终端原生能力。** 这与网页里「虚拟滚动（virtual scrolling）只渲染可视区」异曲同工——都是「不要让渲染成本随内容总量线性增长」。**本节把它列为 roadmap 点名的亮点之一，正因为它是「让 TUI 在长对话下依然流畅」的关键一招。**

**至此，`App` 把三条线收成了一屏**：顶部（空会话时）是 Logo 头部，中间活动区是「最后一条消息 + 微光 + 待办面板」，底部「互斥地」是输入框 / 审批弹窗 / 提问弹窗之一，最下方是显示模型名和 token 用量的页脚；而定稿的历史消息则「毕业」进终端 scrollback。**线一的数据流、线二线三的交互回路，都在这一个 `return` 里各就各位。**

---

## 2. 亮点与关键设计

回顾全节，把散落的「妙笔」和「关键决策」拎出来，明确标注哪些是**关键决策**（架构层面、影响深远）、哪些是**妙笔**（局部精巧、值得抄作业）：

1. **【关键决策】Ink = 用 React 渲染到终端，于是状态管理全盘复用**：把终端当成「一块可以用 React 刷新的画布」，从而让 `useState`/`useEffect`/`useContext`/`useMemo`/自定义 Hook 这套成熟的状态管理武器，原样用于一个命令行界面。**这是本节所有其他设计得以成立的地基假设**——没有它，就没有「Context 分发状态」「Hook 封装订阅」「声明式渲染」。
2. **【关键决策】「一个单向数据流 + 两条双向交互回路」的三线分离**：Agent 输出用「异步生成器」承载（UI 主动 `for await` 拉、单向、不阻塞 Agent），审批 / 提问用「Promise + 订阅」承载（Manager 主动推、双向、阻塞 Agent 直到人类回应）。**「数据流用生成器、交互回路用 Promise+订阅」的分工，是全节的总纲**——它把两种本质不同的通信清晰地分开。
3. **【关键决策】`App` 的「互斥三选一」渲染**：同一时刻，底部只渲染输入框 / 审批弹窗 / 提问弹窗之一。因为它们都要抢占键盘，**「同一时刻只有一个组件监听键盘」是终端 UI 的硬约束**。这条互斥链，与第 15 节两个 Manager 的「单活跃请求」在语义上严丝合缝——UI 一次只显示一个，Manager 一次只激活一个。
4. **【妙笔】`enqueueMessage` + 50ms 批量刷新的节流渲染**：不「来一条消息渲染一帧」，而是「攒进篮子、50ms 倒一次」，把一个回合内密集的 N 次 setState 压成「每 50ms 至多一次」。50ms ≈ 20fps，肉眼流畅、机器省力——节流在 UI 刷新上的教科书用法。
5. **【妙笔】`useFlushToScrollback`：Ink 活动区 + 终端 scrollback 的分工**：Ink 只渲染「最后一条消息 + 弹窗 / 输入框 + 页脚」这一小块频繁变化的活动区；一旦消息「定稿」就用 `stdout.write` 打印进终端原生滚动缓冲区、从 Ink 毕业。**把重绘成本从 O(对话长度) 压到 O(1)**，是让 TUI 在长对话下依然流畅的关键一招。
6. **【妙笔】`state` + `ref` 配对，在长期存活的回调里读最新值**：`streaming`/`streamingRef`、以及提问弹窗的 `stateRef`——`useState` 版触发重渲染，`useRef` 版供 `onSubmit`/`useInput` 这类「注册一次的闭包」读到「此刻的最新值」而非「注册那刻的旧值」。这个模式在本节出现三次，是「异步闭包读 state 过期」这一 React 常见坑的通用解法。
7. **【妙笔】两个 `use*Manager` Hook 用 `useEffect(() => manager.subscribe(setRequest), [])` 把命令式订阅翻译成声明式 state**：订阅的生命周期恰好绑定组件生命周期（`subscribe` 的返回值直接当 `useEffect` 清理函数），把「Manager 有个待响应请求」这件异步事件，变成「`request` state 非 null」这个可渲染状态。**这是「异步 Promise 世界」与「React 渲染世界」之间的那座桥。**
8. **【妙笔】`progress` 事件被故意忽略，工具调用以 `MessageHistory` 为唯一真相源**：界面不搞逐字打字机，只用一个 `streaming` 布尔驱动的笼统「Thinking… 微光」表示忙碌；所有工具调用只在 `messages` 里显示一处。既躲过「进度事件刷新风暴」，又保证「工具展示不会两处打架」——「少即是多」的克制。
9. **【妙笔】API 错误被收编成 assistant 消息而非崩溃**：模型报错时把错误信息包装成一条普通消息上屏（附 "You can try again."），而 abort 则静默收场。**「错误也是一种要展示的内容」**——呼应第 5 节 `_act` 工具错误「就地捕获成文本」的同一种容错哲学。
10. **【妙笔】`supportProjectWideAllow` 一个 prop 贯穿三层**：从 `cli/index.tsx` → `App` → `<ApprovalPrompt>`，控制「永久允许本项目」这个高权限选项是否出现，并最终决定第 18 节的白名单是否落盘。props 作为「配置通道」把最外层的授权策略贯彻到最里层的按钮。

---

## 3. 工业对比

把 Helixent 本节的做法，与业界主流 CLI / TUI / Agent 前端方案对照，看它的取舍落在哪。

### 3.1 终端 UI 框架：Ink（React）vs Ratatui / Bubbletea / blessed

Helixent 用 [Ink](https://github.com/vadimdemedes/ink)（React 渲染到终端）写 TUI。对比几种主流路线：

| 方案                           | 语言 / 范式                                | 状态管理                       | 代表项目                                      |
| ------------------------------ | ------------------------------------------ | ------------------------------ | --------------------------------------------- |
| **Ink（Helixent 选择）** | JS/TS，**React 声明式**              | React（useState/Context/Hook） | Claude Code、GitHub Copilot CLI、Codex CLI 等 |
| **Bubbletea**            | Go，**Elm 架构（MVU）**              | `Model`+`Update`+`View`  | Charm 系工具                                  |
| **Ratatui**              | Rust，**即时模式（immediate mode）** | 自己管，每帧重画               | 各种 Rust TUI                                 |
| **blessed / ncurses**    | JS/C，**命令式操作「窗口对象」**     | 手动                           | 老派 TUI                                      |

**Helixent 选 Ink 的理由，与它的整体技术栈一脉相承**：项目本就是 Bun + TypeScript + Zod 的 JS/TS 生态，用 Ink 意味着**「UI 层和业务层同语言、同心智模型」**——写 Agent 循环用 async generator，写界面用 React Hook，都是 JS 开发者熟悉的东西，无需引入第二种语言 / 范式。而且**「声明式」比「命令式」在这种『状态多、变化频繁』的交互式界面上优势明显**：你只描述「界面此刻该长什么样」，不用手动算「从上一帧到这一帧要改哪几个字符、光标移到哪」。**代价**是 Ink 背后拖着 React + Yoga 布局引擎，比 Ratatui 那种「零运行时、直接画字符」的方案重、也慢一些——但对一个「主要瓶颈在等模型返回、而非等界面刷新」的 Agent CLI 来说，这点开销完全可接受。**关键洞察**：Claude Code、Copilot CLI、Codex CLI 等一票现代 AI 编程 CLI **不约而同都选了 Ink**——因为「AI CLI」这个品类的界面特征（流式文本、频繁状态变化、要弹窗交互）恰好是 React 声明式模型的舒适区。

### 3.2 状态编排：Helixent 的 Context+Hook vs Redux / Zustand / MVU

界面状态放哪、怎么流转，是任何交互式应用的核心问题。

- **Helixent 的做法——「Context 分发 + 自定义 Hook 封装副作用」**：一个 `AgentLoopProvider` 用 Context 广播会话状态，几个自定义 Hook（`useAgentLoop`/`use*Manager`）各自封装「一块状态 + 与外部世界的交互」。**没有引入任何状态管理库**，纯用 React 内置能力。
- **Redux / Zustand 路线**：引入一个中心化 store，用 action/reducer 或 setter 改状态，组件订阅 store 切片。**优点**是状态变更可追踪、可时间旅行调试；**缺点**是对一个「状态没那么多、且高度局部」的 CLI 是重武器。
- **Bubbletea 的 MVU（Model-View-Update）**：所有状态集中在一个 `Model`，所有事件走 `Update` 函数产生新 `Model`，`View` 是 `Model` 的纯函数。**极其规整**，但要求你把一切都塞进单一 Model + 单一 Update。

**Helixent 的取舍恰如其分**：它的状态其实分成清晰的几块（Agent 会话、审批、提问、待办、输入），且每块都有明确的「归属 Hook」。用 Context+Hook 而非 Redux，是因为**「状态天然按 Hook 分片、又不需要跨分片的复杂事务」**——引入 store 反而是过度设计。**这与第 18 节「用 Commander 而非 oclif」是同一种判断**：为「中小规模、职责清晰」的场景选最轻的够用工具，不为「未来可能的复杂度」预付成本。

### 3.3 人机交互接入：「Manager 队列 + 订阅」 vs 直接在工具里 `await` UI

Agent 要向人类要一个输入（审批 / 回答），架构上有两种典型接法：

- **Helixent 的做法（第 15 节 + 本节）——「Manager 队列 + 订阅 + 单活跃」间接接入**：coding 层的工具 / 中间件只调 `manager.askUser()` 拿一个 Promise，**完全不知道 UI 长什么样**；UI 层通过 `subscribe`/`respond` 从另一端接入。二者被 Manager 解耦。
- **另一种常见做法——工具直接持有 UI 句柄、`await` 一个「弹窗函数」**：比如工具里直接 `await showApprovalDialog(toolUse)`。**简单直接**，但把「coding 逻辑」和「具体 UI」焊死了——换个界面（Web、或无头自动化测试）就得改工具代码。

**Helixent 的间接接入明显更优，本节就是活证据**：正因为有「Manager 队列 + 订阅」这层解耦，本节的 UI 才能用一个 20 行的 `use*Manager` Hook「从外部」接上去，而 coding 层一行不用动。**第 18 节 Q5 预言的「换成 Web 界面也能 subscribe 同一个 Manager」，本节在终端 UI 上做了第一个实现**——如果哪天要加 Web 前端，只要再写一套「订阅同一个 global Manager、用 WebSocket 把请求推给浏览器」的适配即可，Manager 和工具全部复用。**这就是「窄接口解耦」的复利**：一次设计（队列+订阅），撑起「任意 UI 都能接」的扩展性。代价是多一层 Manager 的间接（比起直接调弹窗函数要多绕一下），但换来的「界面可替换、逻辑可脱离 UI 测试」远超这点成本。

### 3.4 长列表渲染：`useFlushToScrollback` vs 全量渲染 vs 虚拟滚动

「对话越来越长，界面怎么保持流畅」是所有聊天式 UI 的共同难题。

- **Helixent——「活动区 + scrollback 分工」**：Ink 只渲染最后一条 + 交互区，定稿消息写进终端原生滚动缓冲。**利用了「终端本身就是一个高效的、支持滚动回看的文本缓冲区」这一平台特性**——把「历史」还给终端，Ink 只管「当下」。
- **全量渲染**：Ink 渲染整个 `messages` 数组。**最简单，但会越用越卡**（重绘成本随对话长度线性增长）。
- **网页的虚拟滚动（virtual scrolling）**：只渲染视口内的元素。**思想和 Helixent 一致**（不让渲染成本随总量线性增长），但网页没有「原生 scrollback」可借，只能自己算「哪些在视口内」。

**Helixent 的方案是「顺应平台特性」的典范**：网页里要费劲实现虚拟滚动，是因为浏览器没有「打印一行就永久留在可滚动历史里」的原生能力；而**终端天生就有**（这就是普通 `console.log` 的行为）。Helixent 敏锐地利用了这一点——**定稿消息像 `console.log` 一样「打印并遗忘」，只有活动区归 Ink 管**。**结论**：在合适的平台上，「借力平台原生能力」往往比「在框架层重新发明一个通用方案」更省、更快。这是 TUI 相比 GUI 的一个独特红利。

---

## 4. 深度解释：为什么这样设计？不这样会怎样？

用五个「Q&A」把本节最容易产生疑问、也最见设计功力的点讲透。

### Q1：为什么 Agent 输出用「异步生成器」（`for await`），审批 / 提问却用「Promise + 订阅」？两者都是异步，为什么不统一成一种？

**因为两者的通信模式本质不同——一个是「单向推流」，一个是「双向阻塞式握手」。用错载体，代码会别扭到写不下去。**

先看两者的**通信形状**：

- **Agent 输出（线一）**：Agent 在一个回合里会**陆续产生多个**事件（多条消息、多个进度），UI 要**逐个接收并处理**，且 UI 收不收、处理多快，**不影响 Agent 继续产出**（Agent 只管 `yield`，不等 UI）。**这是「一个源源不断产出多个值的序列」——正是异步生成器（`AsyncGenerator`）的主场**：`yield` 一个个吐、`for await` 一个个收，天生的「流」语义。
- **审批 / 提问（线二 / 线三）**：Agent 产生**一个**请求，然后**必须停下来等一个回应**才能继续——`await manager.askUser()` 会**阻塞 Agent**，直到人类回应。**这是「一次性的、要等结果的往返」——正是 Promise 的主场**（一个 Promise 对应「一次会有结果的异步操作」）。而「订阅」则是因为「谁来提供这个结果」在另一个世界（UI），需要一个 push 通道把请求推给 UI。

**如果强行统一会怎样？**

- **全用生成器**：审批怎么表达「阻塞等一个回应」？生成器是「拉」模型（消费者主动拉），而审批需要「Agent 推一个请求、然后卡住等 UI 推回一个回应」——你得在生成器里塞一个「暂停并等待外部注入值」的机制，这恰恰是生成器不擅长的（生成器的 `yield` 能往外传值，但「等一个从外面传回来的值」要靠 `.next(value)`，用它做 UI 交互会极其扭曲）。
- **全用 Promise+订阅**：Agent 输出是「一个回合多个事件的流」，用单个 Promise 表达不了「多个陆续到达的值」（Promise 只 resolve 一次）；硬要用就得搞成「每条消息一个 Promise + 手动串起来」，等于自己重新发明一个残缺的生成器。

**所以「数据流用生成器、交互回路用 Promise+订阅」不是随意，而是『让通信模式匹配语言原语』**：序列（多值、单向、不阻塞）→ 生成器；一次性握手（单值、双向、阻塞）→ Promise。**用对了原语，代码就顺；用错了，处处是别扭的胶水。** 这也是第 5 节把主循环设计成 `AsyncGenerator`、第 15 节把 Manager 设计成「Promise + 订阅」的深层原因——它们各自选的原语，恰好匹配各自的通信形状，本节只是把这两种原语分别接进了 React。

### Q2：`enqueueMessage` 的 50ms 节流，会不会导致「最后几条消息丢失」或「顺序错乱」？

**不会——因为有两道保险：`finally` 里的强制 flush，和「篮子是有序数组」。这个设计在『省重绘』和『不丢消息』之间做到了两全。**

先说**会不会丢**。担心来自：如果最后一批消息进了篮子，但 50ms 定时器还没触发，会话就结束了，这批消息会不会永远留在篮子里、上不了屏？**答案是不会**，因为 `onSubmit` 的 `finally` 块里有一行 `flushPendingMessages()`（1.5 第 ⑩ 步）——**无论回合怎么结束（正常 / 报错 / abort），都会主动把篮子彻底倒干净**。定时器还没到？`flushPendingMessages` 会先 `clearTimeout` 再倒。**所以「篮子里的消息最终一定上屏」有 `finally` 兜底保证。** 此外 `clear`/`help` 分支也各自先 `flushPendingMessages()`，组件卸载时还有 `useEffect` 清理定时器——多道保险。

再说**会不会乱序**。篮子 `pendingMessagesRef.current` 是一个**数组**，`enqueueMessage` 用 `push` 追加（尾部入队）、`flushPendingMessages` 用 `[...prev, ...pending]` 顺序并入——**FIFO，严格保序**。而且 `agent.stream()` 本身就是「一个回合内事件按产生顺序 `yield`」，`for await` 也按序接收，`push` 也按序入篮——**从产生到上屏，顺序全程不变**。

**「不这样（不节流、来一条 setState 一条）会怎样」**：功能上完全正确、也不丢不乱，但**性能上会在「一个回合密集吐消息」时触发大量重渲染**——每次 setState 都让 Ink 重新 diff + 重绘活动区。在消息密集时（比如一次并行调用好几个工具、结果集中返回），这会造成肉眼可见的闪烁 / 卡顿。**节流用「至多 50ms 一次重绘」换来了流畅，而 `finally` 强制 flush + 数组保序则守住了「不丢、不乱」的正确性底线**——这才是这个设计的完整面貌：**为性能做的优化，绝不以牺牲正确性为代价。**

### Q3：为什么 `onSubmit` 里的防重入检查读 `streamingRef.current`，而不直接读 `streaming`？这个 `ref` 镜像是不是多此一举？

**不是多此一举，而是绕开 React 的「闭包捕获旧值」这个经典陷阱的必需手段。直接读 `streaming` 会读到过期的值，防重入就会失效。**

要理解这一点，得先明白 React 里一个反直觉的事实：**`onSubmit` 这个函数，是在「某一次渲染」时被 `useCallback` 创建出来的，它内部捕获的 `streaming`，是「创建它那一次渲染时的 `streaming` 值」——一个被「冻结」在闭包里的常量，不会随后续 state 变化而更新。**

设想这个时序：

1. 初次渲染，`streaming = false`，`useCallback` 创建了一个 `onSubmit`（记作 `onSubmit_A`），它闭包里的 `streaming` 是 `false`。
2. 用户提交，`onSubmit_A` 跑起来，`setStreaming(true)`。但**注意**：`onSubmit_A` 是个 async 函数，它会一直跑到 `agent.stream()` 结束——**在它整个执行期间，它闭包里的 `streaming` 仍然是当初那个 `false`**（React 重渲染会创建新的 `onSubmit_B`，但正在跑的还是 `onSubmit_A`）。
3. 如果此时（Agent 还在跑）用户又快速提交一次——**如果 `onSubmit_A` 里读的是闭包的 `streaming`（=false），防重入检查 `if (streaming) return` 就会失效**，误以为「没在跑」，于是发起第二轮，把 Agent 搞乱。

**而 `streamingRef.current` 不受这个陷阱影响**：ref 是一个「所有渲染共享的、稳定的盒子」，`streamingRef.current` 永远指向「最新写入的值」。1.3 那个 `useEffect(() => { streamingRef.current = streaming }, [streaming])` 保证每次 `streaming` 变化都把新值写进这个盒子。**所以 `onSubmit_A` 里读 `streamingRef.current`，读到的是「此刻真实的 streaming」（=true），防重入正确生效。**

**「不这样（直接读 streaming）会怎样」**：防重入形同虚设，用户在 Agent 忙时连按两次回车，就可能发起并发的第二轮 `agent.stream()`——而第 5 节的 Agent 有「已在 streaming 就抛错」的保护，于是第二轮会抛错、被 `catch` 成一条 "Error: Agent is already streaming" 的消息糊到屏幕上，体验很差。**`ref` 镜像正是为了在这个「async 闭包长期存活、期间 state 已变」的场景里读到最新值。** 这个模式（state 管渲染、ref 管「闭包内读最新」）在本节出现了三次（`streamingRef`、提问弹窗的 `stateRef`、以及贯穿的这个思路），是 React 老手的必备工具。

### Q4：`App` 为什么只渲染「最后一条消息」、把历史都 flush 进 scrollback？直接渲染整个 `messages` 数组不是更简单吗？

**直接全量渲染确实更简单，但会让 TUI「越用越卡」。`useFlushToScrollback` 用「活动区 + scrollback 分工」把重绘成本从 O(对话长度) 降到 O(1)——这是长对话下保持流畅的刚需。**

先说**全量渲染的问题**。假设 `App` 渲染整个 `messages`（比如用 `<MessageHistory messages={messages}/>`）。Ink 的工作原理是：**每次任何 state 变化，都要把它管辖的整棵组件树重新 diff、并把变化重绘到终端**。而「Thinking… 微光」是每 120ms 跳动一次的（`<StreamingIndicator>` 用 `useAnimationFrame` 驱动，见 [streaming-indicator.tsx](../../src/cli/tui/components/streaming-indicator.tsx)）——**这意味着 Agent 忙的时候，Ink 每 120ms 就要重绘一次它管辖的全部内容**。如果它管着整个对话历史（成百上千行），每次微光跳动都要 diff + 重绘这么多行——**对话越长，每一帧越慢，最终肉眼可见地卡。**

**`useFlushToScrollback` 的解法（1.8 详解）**：让 Ink 只管「最后一条消息 + 弹窗 / 输入框 + 页脚」这一小块「活动区」；消息一「定稿」（后面来了新消息），就用 `stdout.write` 把它的纯文本打印进终端**原生 scrollback**、从 Ink 毕业。**于是无论对话多长，Ink 管辖的区域始终是「一条消息 + 交互区」这么大——微光跳动时的重绘成本恒定（O(1)），与对话总长无关。** 定稿的历史则像普通 `console.log` 输出一样躺在终端滚动缓冲里，用鼠标滚轮就能回看。

**为什么能这么做？** 关键洞察是：**「已定稿的历史消息」是永远不会再变的**——它不会重新流式、不会改颜色。既然不变，就没必要让「负责处理变化」的 Ink 继续盯着它，交给「擅长堆放不变文本」的终端 scrollback 更合适。**「把不变的交给平台原生能力、把在变的交给框架」——这是这个设计的思想内核。**

**「不这样会怎样」**：短对话时全量渲染完全没问题（甚至更简单）；但一旦对话变长（几十轮、上百条消息），全量渲染会让「微光跳动」「打字回显」这些高频操作卡顿，严重时每次刷新肉眼可见地闪。**`useFlushToScrollback` 是「为长对话场景付的一点复杂度，换来恒定的渲染性能」**——对一个「主要用途就是长时间和 Agent 对话」的工具，这个投资完全值得。3.4 的工业对比里,它对应网页的「虚拟滚动」,但更省——因为它借了终端 scrollback 这个原生能力。

### Q5：本节的 UI 层，和前面 5、11、15、18 节的关系到底是什么？如果我要给 Helixent 换一个「Web 聊天界面」，本节哪些要重写、哪些能复用？

**这个问题能检验你有没有真正理解「本节 = 一套『把 Agent 接进某种 UI』的适配层」。答案是：本节几乎全部要重写（因为它是 Ink 特有的），但它接入的所有『接缝』都能复用——而这正是前几节精心设计的成果。**

先厘清**本节在整个架构里的位置**——它是一个**「适配层」**：把前面几节造好的、与 UI 无关的「引擎」，接到一种具体的界面（Ink 终端）上。它依赖的「接缝」有四个，全部来自前面章节：

- **第 5 节的 `agent.stream()` 生成器**：本节 `onSubmit` 消费它。这是「Agent 输出」的接缝。
- **第 15 节的两个 global Manager（`subscribe`/`respond`）**：本节两个 `use*Manager` Hook 接它们。这是「人机交互」的接缝。
- **第 11 节装配好的 `agent` + 第 18 节读出的配置**：本节通过 `AgentLoopProvider` 的 prop 拿到 `agent`，直接用。这是「拿到成品 Agent」的接缝。
- **第 18 节的 `render(<App/>)` + `supportProjectWideAllow` 等 props**：本节是它 `render` 的那个 `<App/>` 的内部实现。这是「被谁挂载」的接缝。

**现在回答「换 Web 界面要重写什么」：**

- **必须重写的（因为是 Ink / 终端特有）**：所有 `.tsx` 组件（`<Box>`/`<Text>`/`useInput` 是 Ink 的，换 Web 要用 `<div>`/`onKeyDown` 或干脆用鼠标点击）、`useFlushToScrollback`（Web 没有终端 scrollback，要改成 DOM 滚动容器 + 虚拟滚动）、`messageToPlainText` 的 ANSI 上色（Web 用 CSS）、`<StreamingIndicator>` 的字符微光（Web 用 CSS 动画）。**本节这些「怎么画、怎么响应按键」的代码，是和「终端」这个具体平台绑定的，换平台就得重写。**
- **能几乎照搬的（状态编排的思想）**：`AgentLoopProvider` 那套「用 Context 分发状态 + `onSubmit` 消费 `agent.stream()` 事件 + 节流刷新 + 错误收编成消息」的**逻辑骨架**，在 Web 里几乎一模一样（React 在 Web 和终端通用）。两个 `use*Manager` Hook 的「`useEffect` 订阅 Manager」模式也完全通用。**因为这部分是「React 状态逻辑」，与「画到终端还是 DOM」无关。**
- **完全不用动的（前几节的引擎）**：`agent.stream()`、两个 Manager、所有工具、所有中间件、两套持久化、两个 Provider——**前 18 节的引擎一行都不用改**。Web 端的 `onSubmit` 照样 `for await (agent.stream())`；Web 端也能 `globalApprovalManager.subscribe(...)`，只是把请求通过 WebSocket 推给浏览器、把浏览器的点击通过 WebSocket 传回来调 `respond`。

**这就是本节适配层的深层价值**：它证明了「前面所有节的引擎，是真的与 UI 解耦的」——**换界面 = 重写『怎么画 + 怎么收按键』这层皮 + 复用『React 状态编排』的骨架 + 引擎零改动**。第 5 节把输出设计成生成器、第 15 节把交互设计成「Manager 队列 + 订阅」、第 18 节 Q5 预言「Web 也能 subscribe」，全都是为了**这一刻的可替换性**而埋的接缝。**本节是这些接缝的第一个「使用者」，也因此成了检验『前面的解耦是否真的成立』的试金石——而它证明了：成立。**

---

## 5. 参考资料

**本节精讲的源码（建议对照阅读）**：

- **Agent 循环 Hook（线一）**：[use-agent-loop.ts](../../src/cli/tui/hooks/use-agent-loop.ts)（189 行）
  - `AgentLoopState` 类型 + Context：[L11-L21](../../src/cli/tui/hooks/use-agent-loop.ts#L11-L21)
  - 状态 + `streamingRef` 同步：[L32-L40](../../src/cli/tui/hooks/use-agent-loop.ts#L32-L40)
  - `flushPendingMessages` / `enqueueMessage`（50ms 节流）：[L42-L73](../../src/cli/tui/hooks/use-agent-loop.ts#L42-L73)
  - `onSubmit`（斜杠命令分流 + 消费 `agent.stream()` + 错误收编）：[L83-L150](../../src/cli/tui/hooks/use-agent-loop.ts#L83-L150)
  - `useAgentLoop` 消费端 + `isAbortError` + `clearTerminal`：[L167-L189](../../src/cli/tui/hooks/use-agent-loop.ts#L167-L189)
- **两个 Manager Hook（线二 / 线三）**：[use-approval-manager.ts](../../src/cli/tui/hooks/use-approval-manager.ts)（25 行，`useEffect` 订阅 + `respond`）、[use-ask-user-question-manager.ts](../../src/cli/tui/hooks/use-ask-user-question-manager.ts)（28 行，逐字镜像）
- **两个弹窗组件（交互面）**：
  - [approval-prompt.tsx](../../src/cli/tui/components/approval-prompt.tsx)（90 行）——三选项对应 `ApprovalDecision`、`useInput` 方向键 + 快捷键、`supportProjectWideAllow` 控制选项
  - [ask-user-question-prompt.tsx](../../src/cli/tui/components/ask-user-question-prompt.tsx)（263 行）——多问题 tab、单选 / 多选、`stateRef` 读最新值、`canSubmit` 校验、`trySubmit` 打包 `AskUserQuestionResult`
- **界面总装 + scrollback 分工**：[app.tsx](../../src/cli/tui/app.tsx)（103 行）——三条线取状态、「互斥三选一」渲染、`useFlushToScrollback`（活动区 + scrollback）

**关联源码（本节引用但不精讲）**：

- 上游接缝：[agent.ts](../../src/agent/agent.ts#L140-L171)（第 5 节的 `stream` 生成器）、[agent-event.ts](../../src/agent/agent-event.ts)（`AgentEvent` 类型）、[approval-manager.ts](../../src/coding/permissions/approval-manager.ts) / [ask-user-question-manager.ts](../../src/coding/tools/ask-user-question-manager.ts)（第 15 节的两个 Manager）
- 被本节「摆位」但留给第 20 节的：[command-registry.ts](../../src/cli/tui/command-registry.ts)（`resolveBuiltinCommand`/`formatHelp`/斜杠命令）、[input-box.tsx](../../src/cli/tui/components/input-box.tsx)（输入框）、[message-history.tsx](../../src/cli/tui/components/message-history.tsx) / [message-text.ts](../../src/cli/tui/message-text.ts) / [markdown.tsx](../../src/cli/tui/components/markdown.tsx)（消息渲染）、[token-usage.ts](../../src/cli/tui/token-usage.ts)（用量统计）、[themes/index.ts](../../src/cli/tui/themes/index.ts)（主题）
- 辅助组件：[streaming-indicator.tsx](../../src/cli/tui/components/streaming-indicator.tsx)（微光，`useAnimationFrame` 驱动）、[header.tsx](../../src/cli/tui/components/header.tsx) / [footer.tsx](../../src/cli/tui/components/footer.tsx)、[todo-panel.tsx](../../src/cli/tui/components/todo-panel.tsx) / [todo-view.ts](../../src/cli/tui/todo-view.ts)（第 10 节 Todos 展示端）、[use-animation-frame.ts](../../src/cli/tui/hooks/use-animation-frame.ts)

**co-located 测试（[第 21 节](./00-roadmap.md) 会讲这套约定）**：

- [approval-manager.test.ts](../../src/coding/permissions/__tests__/approval-manager.test.ts)——队列排队、单活跃、`subscribe` 收到请求 / 队列空收到 null、`respond` resolve、取消订阅（这些正是本节 `use*Manager` Hook 所依赖的 Manager 行为）
- [ask-user-question-manager.test.ts](../../src/coding/tools/__tests__/ask-user-question-manager.test.ts)——提问 Manager 的同构行为

**上游依赖章节**：

- [第 5 节 · ReAct 主循环](./05-react-loop.md)：本节 `onSubmit` 消费的 `agent.stream()` 生成器与 `AgentEvent`（`message`/`progress`）——本节是它「谁来 for await」的答案
- [第 15 节 · Human-in-the-Loop](./15-human-in-the-loop.md)：本节两个 `use*Manager` Hook `subscribe` 的两个 global Manager——本节兑现它「等一个 UI 来 subscribe 并 respond」的伏笔
- [第 18 节 · CLI 入口与持久化](./18-cli-config-persistence.md)：本节是它第 ⑦ 步 `render(<AgentLoopProvider><App/></AgentLoopProvider>)` 之后的世界；`supportProjectWideAllow` 是它传入的 prop，`allow_always_project` 决定最终触发它的白名单落盘
- [第 11 节 · Lead Agent](./11-lead-agent.md)：本节通过 Context 分发的 `agent`，就是它 `createCodingAgent` 的产物
- [第 10 节 · Todos](./10-todos.md)：本节 `<TodoPanel>` / `buildTodoViewState` 展示的待办，来自它的 `todo_write` 工具

**下游承接章节（本节埋的接口）**：

- [第 20 节 · TUI 输入、命令面板与消息渲染](./00-roadmap.md)：本节「摆位即止」的 `<InputBox>`（输入框光标 / 历史 / 斜杠补全）、`command-registry`（斜杠命令解析）、`<MessageHistoryItem>` / `<Markdown>` / `messageToPlainText`（消息渲染器）、`token-usage`、`themes`——它们内部如何工作
- [第 21 节 · 工程实践](./00-roadmap.md)：本节大量 co-located 测试（如 `approval-manager.test.ts`）体现的「测试与源码同放」约定，以及整体质量保障

**外部资料**：

- Ink（React for CLI，`<Box>`/`<Text>`/`useInput`/`useStdout`）：[https://github.com/vadimdemedes/ink](https://github.com/vadimdemedes/ink)
- React Hooks（`useState`/`useEffect`/`useRef`/`useCallback`/`useMemo`/`useContext`）：[https://react.dev/reference/react/hooks](https://react.dev/reference/react/hooks)
- React「订阅外部数据源」的推荐模式（`useEffect` + 清理函数 / `useSyncExternalStore`）：[https://react.dev/reference/react/useSyncExternalStore](https://react.dev/reference/react/useSyncExternalStore)
- 节流（throttle）与防抖（debounce）的区别：[https://developer.mozilla.org/en-US/docs/Glossary/Throttle](https://developer.mozilla.org/en-US/docs/Glossary/Throttle)
- Yoga（Ink 底层的 Flexbox 布局引擎）：[https://www.yogalayout.dev/](https://www.yogalayout.dev/)
- 终端 ANSI 转义码（颜色 / 清屏 / 光标控制）：[https://en.wikipedia.org/wiki/ANSI_escape_code](https://en.wikipedia.org/wiki/ANSI_escape_code)

---

## 6. 小结与下一节预告

本节我们走进了 [第 18 节](./18-cli-config-persistence.md) 结尾 `render(<App/>)` 之后的世界，拆透了 Helixent 的「TUI 状态编排 + 人机交互回路」这半边，核心是**「一个数据流 + 两条交互回路」如何被 Ink + React 编织成一屏**：

- **Ink 的大前提**（1.2）：Ink 是「把 React 渲染到终端」的渲染器——终端成了一块「可以用 React 刷新的画布」，于是 `useState`/`useEffect`/`useContext`/自定义 Hook 这套状态管理武器全盘可用。**这是全节的地基假设。**
- **线一·Agent 数据流**（1.3–1.5）：`AgentLoopProvider` 用 Context 分发会话状态；`enqueueMessage` + 50ms 批量刷新的**节流渲染**避免「来一条渲染一帧」的闪烁；`onSubmit` 消费第 5 节的 `agent.stream()` 生成器——斜杠命令就地分流、message 事件进节流篮子、progress 事件故意忽略、错误收编成 assistant 消息、`streamingRef` 防重入。
- **线二 / 线三·交互回路**（1.6–1.7）：两个几乎同构的 `use*Manager` Hook 用 `useEffect(() => manager.subscribe(setRequest), [])` 把第 15 节 Manager 的「等待响应」翻译成一个 React state；两个弹窗组件（审批的单选菜单、提问的多问题表单）用 `useInput` 处理键盘、校验后调 `respond` 回传——**闭环：Manager 推请求 → Hook setState → App 渲染弹窗 → 用户操作 → respond → resolve Promise → Agent 继续。**
- **合流**（1.8）：`app.tsx` 把三条线取齐，用「互斥三选一」保证同一时刻底部只显示输入框 / 审批 / 提问之一（对应第 15 节的「单活跃请求」）；`useFlushToScrollback` 用「Ink 活动区 + 终端 scrollback 分工」把重绘成本压到 O(1)，让长对话依然流畅。

**一条主线**：**本节是一层「适配层」**——它把第 5 节的输出生成器、第 15 节的交互 Manager、第 11/18 节装配好的 Agent，用 React 状态编排接进了一个 Ink 终端界面。它兑现了第 15 节「等一个 UI 来 subscribe」和第 18 节「render 之后交给 TUI」的两处伏笔；更重要的是，它证明了前面所有节的「解耦」是真的成立——**换一种界面，只需重写这层『怎么画、怎么收按键』的皮，复用『React 状态编排』的骨架，而引擎零改动**（Q5）。至此，「Agent → 状态 → 弹窗」的**输出与交互回路**被彻底打通。

**承上启下（启下）**：本节始终守着一条边界——凡遇到「用户怎么把话打进去」（`<InputBox>` 的光标 / 历史 / 斜杠命令补全）和「消息怎么好看地显示出来」（`<MessageHistoryItem>` / `<Markdown>` / `messageToPlainText` 的渲染、主题、token 用量），一律「摆位即止」。可这些恰恰是「人机界面」的最后一块拼图：**输入框的光标移动、历史回溯、`/` 斜杠命令的解析与补全究竟怎么实现？为什么同一套工具调用要写两个渲染器（Ink 组件版 vs ANSI 纯文本版）？消息又是怎么被「上色」并滚出到终端历史的？**

**所以下一步，是补齐「输入」与「渲染」这两个子系统**——看纯函数 `input-editor` 如何做光标操作、`command-registry` 如何解析 / 补全斜杠命令、以及「ANSI 纯文本渲染器 vs Ink 组件渲染器」为何刻意不复用。这正是 [第 20 节](./00-roadmap.md) 的「TUI 输入、命令面板与消息渲染」：读完它，从数据结构到用户按键的**完整链路**就全部走通了。

👉 下一节 **第 20 节：TUI 输入、命令面板与消息渲染**。

准备好后，对我说「**生成第 20 节**」即可。
