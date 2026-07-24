# 第 20 节：TUI 输入、命令面板与消息渲染

> 本节属于 **第六部分 · CLI / TUI 层（人机交互界面）**，是这一部分的**收尾**，也是整套「源码精读」教程正文的**最后一节技术章**（第 21 节转向工程实践，站在「作品」视角回望全书）。[第 19 节](./19-tui-architecture.md) 在结尾把这个悬念交代得清清楚楚——它讲完「TUI 的状态编排 + 人机交互回路」这半边后，一路守着一条边界：凡遇到「用户**怎么把话打进去**」（`<InputBox>` 的光标 / 历史 / 斜杠命令补全）和「消息**怎么好看地显示出来**」（`<MessageHistoryItem>` / `<Markdown>` / `messageToPlainText` 的渲染），一律「摆位即止」。**本节就来补齐这最后一块拼图：拆开 `tui/` 目录剩下的那半边——「用户输入」与「消息渲染」两个子系统。**
>
> 对应 roadmap 为本节设定的**核心问题**：
>
> > 输入框的光标 / 历史 / 斜杠命令补全是怎么实现的？为什么同一套工具调用要写两个渲染器？消息如何「滚出」到终端历史？
>
> **一句边界声明**：本节精讲 **`src/cli/tui/` 下负责「输入 + 渲染」的那半边**——与 [第 19 节](./19-tui-architecture.md) 精讲的「状态编排 + 交互回路」半边**互补拼成完整的 `tui/`**。本节精讲的文件清单如下，可分为**两大子系统**：
>
> - **输入子系统（用户怎么把话打进去）**：
>   - **纯函数内核**：[input-editor.ts](../../src/cli/tui/input-editor.ts)（51 行，光标增删移的纯函数）、[command-registry.ts](../../src/cli/tui/command-registry.ts)（199 行，斜杠命令的注册 / 解析 / 过滤 / 补全 / `/help` 渲染）。
>   - **状态 Hook**：[use-input-history.ts](../../src/cli/tui/hooks/use-input-history.ts)（80 行，↑↓ 历史回溯 + 落盘）、[use-command-input.ts](../../src/cli/tui/hooks/use-command-input.ts)（185 行，把上面所有纯函数 + `useInput` 键盘事件编排成一个输入框大脑）。
>   - **组件（画出来）**：[input-box.tsx](../../src/cli/tui/components/input-box.tsx)（47 行）、[command-list.tsx](../../src/cli/tui/components/command-list.tsx)（81 行，命令面板）、[highlighted-input.tsx](../../src/cli/tui/components/highlighted-input.tsx)（47 行，带光标 / 高亮的输入行）。
> - **渲染子系统（消息怎么显示出来）**：
>   - **两个「刻意不复用」的渲染器**：[message-history.tsx](../../src/cli/tui/components/message-history.tsx)（229 行，**Ink 组件版**——活动区那一条用它）、[message-text.ts](../../src/cli/tui/message-text.ts)（78 行，**ANSI 纯文本版**——定稿消息 flush 进 scrollback 用它）。
>   - **Markdown 与配套**：[markdown.tsx](../../src/cli/tui/components/markdown.tsx)（13 行，`marked` + `marked-terminal`）、[token-usage.ts](../../src/cli/tui/token-usage.ts)（26 行，用量累加）、[themes/index.ts](../../src/cli/tui/themes/index.ts)（11 行，主题）。
>
> **本节最大的「啊哈时刻」**：**「同一套工具调用，为什么要写两个长得几乎一样的渲染器？」**——答案藏在 [第 19 节](./19-tui-architecture.md) 1.8 的 `useFlushToScrollback` 里：**Ink 只管「活动区」那一小块（用 `<MessageHistoryItem>` 这个 React 组件渲染），而「定稿并毕业进终端 scrollback」的历史消息用的是 `messageToPlainText`（一段纯 ANSI 转义码字符串）**。前者要参与 React diff、要能随状态刷新，所以必须是组件；后者是「一次性 `write` 到 stdout、之后永不再变」的死文本，用组件反而是负担。**两个渲染器不是重复代码，而是『同一份内容，喂给两种截然不同的输出机制』——一个给 React/Ink，一个给裸终端**。看懂这一点，你就理解了本节最反直觉的设计，也就真正读透了第 19 节那个「活动区 vs scrollback」分工的另一半。
>
> ⚠️ **一处「诚实标注」**：本节大量出现 `useInput`、`useState`、`useMemo`、`<Box>` / `<Text>`——这些「Ink = 把 React 渲染到终端」的大前提，[第 19 节](./19-tui-architecture.md) 1.2 已经讲透，本节**不再重复**，默认你已经接受了这个设定。本节也会回顾第 19 节的 `onSubmit`（斜杠命令在那里被「消费」），但只补讲第 19 节没细说的「命令是怎么被解析 / 补全出来的」——**两节合起来才是斜杠命令的完整故事**。凡引用第 19 节已讲清的机制，本节一律「点到为止 + 给链接」。

***

## 0. 承上启下

[第 19 节](./19-tui-architecture.md) 在结尾把这个悬念埋得明明白白，几乎是「点名」本节。它的原话是这样的：

> 本节始终守着一条边界——凡遇到「用户怎么把话打进去」（`<InputBox>` 的光标 / 历史 / 斜杠命令补全）和「消息怎么好看地显示出来」（`<MessageHistoryItem>` / `<Markdown>` / `messageToPlainText` 的渲染、主题、token 用量），一律「摆位即止」。可这些恰恰是「人机界面」的最后一块拼图：**输入框的光标移动、历史回溯、`/` 斜杠命令的解析与补全究竟怎么实现？为什么同一套工具调用要写两个渲染器（Ink 组件版 vs ANSI 纯文本版）？消息又是怎么被「上色」并滚出到终端历史的？**

本节就来一次性兑现这处伏笔。而在动手前，请先把**三条上游结论**装进脑子——它们是本节每一处设计的直接前提：

1. **[第 19 节](./19-tui-architecture.md) 的 `onSubmit`「消费」了斜杠命令，但没讲命令「从哪来」。** 回忆第 19 节 1.5：用户按回车，`<InputBox>` 调 `onSubmit(submission)`，`onSubmit` 里 `resolveBuiltinCommand(text)` 识别 `/exit` / `/clear` / `/help` 就地拦截。**但「`/` 一按下去，那个候选命令面板是怎么弹出来的？用户敲 `/sk` 怎么就过滤出 `skill-creator`？按 Tab 怎么补全？」——第 19 节完全没讲，它只用到了「解析结果」。本节的 [command-registry.ts](../../src/cli/tui/command-registry.ts) + [use-command-input.ts](../../src/cli/tui/hooks/use-command-input.ts) 就是那套「命令从注册到补全」的完整机制。**

2. **[第 19 节](./19-tui-architecture.md) 的 `useFlushToScrollback` 用到了两个「摆位即止」的渲染函数。** 回忆第 19 节 1.8：`App` **只用 `<MessageHistoryItem>` 渲染最后一条消息**（活动区），而「定稿」的历史消息用 `messageToPlainText(msg)` 转成纯文本、`write` 进终端 scrollback。**「这两个渲染器内部长什么样？为什么要有两个？」——第 19 节明说「留给第 20 节」。本节的 [message-history.tsx](../../src/cli/tui/components/message-history.tsx) 和 [message-text.ts](../../src/cli/tui/message-text.ts) 就是这两个渲染器的正身。**

3. **[第 19 节](./19-tui-architecture.md) 的 Footer 显示了 `tokenUsage`，它由 `messages` 派生。** 回忆第 19 节 1.5 结尾：`tokenUsage` 由一个 `useMemo` 从 `messages` 调 `calculateTokenUsage` 算出、挂进 Context。**「这个累加具体怎么算？」——第 19 节「只看它被挂进 Context」。本节的 [token-usage.ts](../../src/cli/tui/token-usage.ts) 补上这最后一小块。**

准备好了。我们同样先不看任何一个具体文件，而是先建立**「输入子系统」与「渲染子系统」两张分工图**——因为本节文件虽多，但只要抓住「**每个子系统都是『纯函数内核 → 状态 Hook → 组件外壳』三层**」这一个结构，就不会在十来个文件里迷路。

***

## 1. 主题内容

### 1.1 先建立地图：两个子系统，各自「纯函数 → Hook → 组件」三层

本节的十来个文件，看似零散，其实**严格分成两个子系统，且两个子系统内部是同一个三层结构**。先把这张图刻进脑子：

```
┌──────────────────────────── 输入子系统（用户 → 文字）────────────────────────────┐
│                                                                                  │
│  ① 纯函数内核（无 React、可单测）                                                 │
│     input-editor.ts        ── 光标增/删/移，输入输出都是 {text, cursorOffset}     │
│     command-registry.ts    ── 命令注册表 + 解析/过滤/补全/formatHelp（纯函数）     │
│                    │                                                              │
│                    ▼                                                              │
│  ② 状态 Hook（把纯函数接进 React state + 键盘事件）                                │
│     use-input-history.ts   ── ↑↓ 历史回溯，读写 ~/.helixent/history.txt           │
│     use-command-input.ts   ── 输入框「大脑」：useInput 分派按键 → 调①的纯函数      │
│                    │           产出 { text, cursorOffset, filteredCommands, ... }  │
│                    ▼                                                              │
│  ③ 组件外壳（把 Hook 的产出画到终端）                                              │
│     input-box.tsx          ── 组装：命令面板 + ❯ + 输入行                          │
│     command-list.tsx       ── 候选命令面板（带滚动窗口）                           │
│     highlighted-input.tsx  ── 输入行：光标反显 + 命令名高亮                        │
│                    │                                                              │
│                    ▼ onSubmit(PromptSubmission)                                   │
│              （交回第 19 节的 AgentLoopProvider.onSubmit）                         │
└──────────────────────────────────────────────────────────────────────────────────┘

┌──────────────────────────── 渲染子系统（消息 → 屏幕）────────────────────────────┐
│                                                                                  │
│  同一份 message（第 2 节的 NonSystemMessage），喂给两个「刻意不复用」的渲染器：     │
│                                                                                  │
│   ┌─ message-history.tsx（Ink 组件版）── 活动区那「最后一条」用它 ────┐            │
│   │    <MessageHistoryItem> → <UserMessageItem>/<AssistantMessageItem>│            │
│   │    工具调用 → <ToolUseContentItem>；文本 → <Markdown>             │            │
│   │    参与 React diff，随状态刷新                                    │            │
│   └───────────────────────────────────────────────────────────────────┘            │
│                                                                                  │
│   ┌─ message-text.ts（ANSI 纯文本版）── 定稿消息 flush 进 scrollback 用它 ┐        │
│   │    messageToPlainText(msg) → 一段带 \x1b[…m 转义码的死字符串         │        │
│   │    一次性 write 到 stdout，之后永不再变                             │        │
│   └─────────────────────────────────────────────────────────────────────┘        │
│                                                                                  │
│  配套：markdown.tsx（marked+marked-terminal）、token-usage.ts（用量累加）、        │
│        themes/index.ts（颜色常量）                                                │
└──────────────────────────────────────────────────────────────────────────────────┘
```

**这张图的两个「记忆锚点」**：

1. **输入子系统是「三层漏斗」**：底层是**与 React 无关的纯函数**（`input-editor` 只做字符串切片、`command-registry` 只做正则匹配），可以脱离界面单独测试（1.2、1.3 会看到它们的 co-located 测试）；中层是**把纯函数接进 React 的 Hook**（`use-command-input` 用 `useInput` 接键盘、把每次按键翻译成「调哪个纯函数」）；顶层是**只负责画的组件**（`input-box` 等，几乎没有逻辑）。**「逻辑往下沉成纯函数、React 只在中层做胶水、组件只管画」——这是本节输入子系统的设计总纲，也是它能被充分单测的原因。**

2. **渲染子系统的核心矛盾是「两个渲染器」**：同一份 `message`，`message-history.tsx` 把它渲染成**会刷新的 Ink 组件树**（给活动区那一条），`message-text.ts` 把它渲染成**一次性写死的 ANSI 字符串**（给 scrollback 的历史）。**为什么不复用？** 因为它们的输出目标根本不同——一个要参与 React 的 diff / 重绘循环，一个是脱离 React 的裸终端输出。1.7 会专门论证这个「刻意不复用」的取舍。

**本节的推进顺序**：先走完**输入子系统**（1.2 `input-editor` 纯函数内核 → 1.3 `command-registry` → 1.4 `use-input-history` → 1.5 `use-command-input` 大脑 → 1.6 三个组件），再走**渲染子系统**（1.7 「为什么两个渲染器」的总论 → 1.8 `message-history` Ink 版 → 1.9 `message-text` ANSI 版 → 1.10 `markdown` / `token-usage` / `themes`）。**每讲一个文件，我都会先标注它在上图的哪一层、属哪个子系统**，你就不会迷路。

### 1.2 `input-editor.ts`：光标操作的「纯函数内核」

> **这是输入子系统的最底层——第 ① 层「纯函数内核」的一半。** [input-editor.ts](../../src/cli/tui/input-editor.ts) 全文只有 51 行，且**没有一行 React**：它把「输入框的编辑操作」抽象成一组**纯函数**，每个函数的形状都是 `(state) => newState`，其中 `state` 就是一个朴素的 `{ text, cursorOffset }`。

先看它的状态类型和「插入」操作（[L1-L13](../../src/cli/tui/input-editor.ts#L1-L13)）：

```ts
export interface InputEditorState {
  text: string;
  cursorOffset: number;    // 光标在 text 中的字符偏移（0 = 最左，text.length = 最右）
}

export function insertTextAtCursor(state: InputEditorState, input: string): InputEditorState {
  if (input.length === 0) return state;

  return {
    text: state.text.slice(0, state.cursorOffset) + input + state.text.slice(state.cursorOffset),
    cursorOffset: state.cursorOffset + input.length,
  };
}
```

**这一段就定下了整个文件的「基因」**：

- **状态极简**：一个输入框的全部编辑状态，就是「当前文本 + 光标在哪」两个字段。**没有「选区」「多行」这些复杂概念**——Helixent 的输入框是单行、无选区的极简设计，`cursorOffset` 一个数字就够描述光标。
- **每个函数都返回「新对象」，绝不改原 `state`**：`insertTextAtCursor` 用 `slice` 把光标前后切开、把新输入插进中间，拼出一个**全新的** `{text, cursorOffset}`。**这是「不可变（immutable）更新」**——它天然契合 React 的 `setState`（React 靠「引用变了没」判断要不要重渲染，返回新对象正好让 React 察觉变化）。
- **`cursorOffset` 跟着内容走**：插入了 `input.length` 个字符，光标就往右挪 `input.length`——保证「打完字，光标停在刚打的字后面」这个符合直觉的行为。

再看「退格」和「左右移动」（[L15-L36](../../src/cli/tui/input-editor.ts#L15-L36)）：

```ts
export function removeCharacterBeforeCursor(state: InputEditorState): InputEditorState {
  if (state.cursorOffset === 0) return state;                       // ① 已在最左，退格无效

  return {
    text: state.text.slice(0, state.cursorOffset - 1) + state.text.slice(state.cursorOffset),
    cursorOffset: state.cursorOffset - 1,
  };
}

export function moveCursorLeft(state: InputEditorState): InputEditorState {
  return { ...state, cursorOffset: Math.max(0, state.cursorOffset - 1) };   // ② 左移，钳在 0
}

export function moveCursorRight(state: InputEditorState): InputEditorState {
  return { ...state, cursorOffset: Math.min(state.text.length, state.cursorOffset + 1) };  // ③ 右移，钳在末尾
}
```

**注意每个函数的「边界防御」**：退格在 `cursorOffset === 0` 时**原样返回**（第 ①，光标已在最左，没什么可删）；左移用 `Math.max(0, …)` 保证不会移到负数（第 ②）；右移用 `Math.min(text.length, …)` 保证不会越过文本末尾（第 ③）。**这些「钳位（clamp）」让光标永远停在 `[0, text.length]` 的合法区间内**——调用方（1.5 的 `use-command-input`）因此可以放心地「无脑调用」，不用自己判断边界。

最精巧的是「按单词跳」（[L38-L51](../../src/cli/tui/input-editor.ts#L38-L51)）：

```ts
export function moveCursorWordLeft(state: InputEditorState): InputEditorState {
  let pos = state.cursorOffset;
  while (pos > 0 && state.text[pos - 1] === " ") pos--;    // ① 先跳过左边连续的空格
  while (pos > 0 && state.text[pos - 1] !== " ") pos--;    // ② 再跳过左边连续的非空格（一个单词）
  return { ...state, cursorOffset: pos };
}

export function moveCursorWordRight(state: InputEditorState): InputEditorState {
  let pos = state.cursorOffset;
  const len = state.text.length;
  while (pos < len && state.text[pos] === " ") pos++;      // ① 先跳过右边连续的空格
  while (pos < len && state.text[pos] !== " ") pos++;      // ② 再跳过右边连续的非空格
  return { ...state, cursorOffset: pos };
}
```

**这是「按 Option/Alt + ← / →」按单词移动光标的实现**（1.5 会看到 `key.meta && input === "b"/"f"` 触发它）。逻辑是经典的「两段式扫描」：**先吃掉方向上的连续空格，再吃掉连续的非空格（一个完整单词）**。举例：`"hello world"` 光标在末尾（offset=11），`moveCursorWordLeft` 先没有空格可跳（第 ① 步 `text[10]='d'` 不是空格，不进循环），然后第 ② 步一路 `pos--` 越过 `world` 直到 `text[5]=' '` 停下，光标落在 offset=6（`world` 的 `w` 前）——正好是「跳到当前单词开头」。**这段逻辑就是 [input-editor.test.ts](../../src/cli/tui/__tests__/input-editor.test.ts) 里那一堆 `moveCursorWordLeft/Right` 测试用例覆盖的对象**（比如「跳过多个空格」`"foo   bar"` offset 9 → 6）。

> 💡 **为什么要把光标操作抽成「纯函数」而非塞进组件？** 三个理由，一个比一个重要：
> 1. **可单测**：纯函数 `(state) => newState` 不依赖 React、不依赖终端，`bun test` 里直接 `expect(moveCursorWordLeft({text, cursorOffset})).toEqual(...)` 就能验证——[input-editor.test.ts](../../src/cli/tui/__tests__/input-editor.test.ts) 正是这么测的（11 个用例覆盖各种边界）。如果这些逻辑埋在 `useInput` 回调里，就得渲染整个组件、模拟按键才能测，成本高得多。
> 2. **易推理**：每个函数只有「输入 state、输出 state」这一件事，没有副作用、没有隐藏状态，读一遍就懂。
> 3. **好复用**：`use-command-input` 里每次按键只要「取当前 state、调对应纯函数、把结果 setState」，胶水极薄。**这正是 1.1 说的「逻辑往下沉成纯函数」——把『算什么』和『何时算 / 画出来』彻底分开。** 这也和第 8 节 `normalizeToolResult`、第 14 节 `apply_patch` 解析器「核心逻辑做成纯函数便于测试」是同一种工程审美，本节在 UI 层再次践行。

### 1.3 `command-registry.ts`：斜杠命令的「注册 → 解析 → 过滤 → 补全」纯函数库

> **这是第 ① 层「纯函数内核」的另一半，也是本节最「密集」的一个文件。** [command-registry.ts](../../src/cli/tui/command-registry.ts)（199 行）**同样几乎没有 React**（除了导出的类型），它是一整套围绕「斜杠命令」的纯函数：定义命令、把内建命令和技能命令合并、按用户输入过滤 / 打分、解析用户敲的到底是不是命令、生成 `/help` 文本。第 19 节 `onSubmit` 用的 `resolveBuiltinCommand` / `formatHelp`，就出自这里。

先看**命令的数据模型**（[L4-L36](../../src/cli/tui/command-registry.ts#L4-L36)）：

```ts
export interface SlashCommand {
  name: string;
  description: string;
  type: "builtin" | "skill";          // ★ 两种来源：内建命令 / 技能
}

export interface PromptSubmission {
  text: string;
  requestedSkillName: string | null;   // ★ 若这次输入触发了某技能，记下它的名字
}

export const BUILTIN_COMMANDS: SlashCommand[] = [
  { name: "clear", description: "Clear the current conversation history", type: "builtin" },
  { name: "exit",  description: "Exit the TUI session", type: "builtin" },
  { name: "help",  description: "List available slash commands, ...", type: "builtin" },
  { name: "quit",  description: "Exit the TUI session", type: "builtin" },
];
```

**两个关键类型定下了全局**：

- **`SlashCommand.type` 区分「内建」和「技能」两种命令**。内建命令（`clear`/`exit`/`help`/`quit`）是**硬编码**的 4 条、由 TUI 本地处理（第 19 节 1.5 已看到它们被 `onSubmit` 就地拦截）；技能命令则是**动态发现**的——每个 [第 9 节](./09-skills.md) 的技能（`skills/*/SKILL.md`）都自动变成一条 `/技能名` 命令。**这就把「第 9 节的技能系统」和「斜杠命令」缝在了一起**：用户敲 `/skill-creator` = 请求激活那个技能。
- **`PromptSubmission` 是「输入框交给 Agent 的最终产物」**——除了原始 `text`，还多一个 `requestedSkillName`。这正是第 19 节 1.5 `onSubmit` 里 `agent.setRequestedSkillName(requestedSkillName)` 用到的那个字段（呼应 [第 9 节](./09-skills.md) 的「按需激活技能」）。**「用户敲的 `/xxx` 是不是一个技能」，就是在这里被判定并打包进 `PromptSubmission` 的。**

**命令是怎么「凑齐」的**——`loadAvailableCommands`（[L44-L48](../../src/cli/tui/command-registry.ts#L44-L48)）：

```ts
export async function loadAvailableCommands(skillsDirs?: string[]): Promise<SlashCommand[]> {
  const skills = await listSkills(skillsDirs);                              // ① 第 9 节的技能发现
  const skillCommands = skills.map(toSkillCommand).sort((l, r) => l.name.localeCompare(r.name));  // ② 技能→命令，按名排序
  return dedupeCommands([...BUILTIN_COMMANDS, ...skillCommands]);           // ③ 内建 + 技能，去重
}
```

**这行代码就是 [第 18 节](./18-cli-config-persistence.md) 第 ⑦ 步 `loadAvailableCommands()` 的正身**——它调 [第 9 节](./09-skills.md) 的 `listSkills` 拿到所有技能的 frontmatter，把每个技能 `toSkillCommand` 转成一条 `SlashCommand`，再和 4 条内建命令拼一起、`dedupeCommands` 去重（[L173-L185](../../src/cli/tui/command-registry.ts#L173-L185)，按小写名去重，**内建命令排在前面，所以同名时内建优先保留**）。**这就是第 18 节装配时传给 `<AgentLoopProvider commands={...}>` 的那份 `commands` 数组的来源**——它一路流到本节的 `use-command-input`，成为补全面板的候选池。

**核心是四个「解析 / 过滤」纯函数**，它们分工明确，逐个看：

**① `getSlashQuery`——判断「此刻要不要弹命令面板」**（[L63-L67](../../src/cli/tui/command-registry.ts#L63-L67)）：

```ts
export function getSlashQuery(text: string): string | null {
  if (!text.startsWith("/")) return null;    // 不以 / 开头 → 不是在打命令
  if (/\s/.test(text)) return null;          // 已经打了空格 → 命令名结束了，不再补全
  return text.slice(1);                      // 返回 / 后面的部分作为「查询词」
}
```

**这是「命令面板开不开」的开关**。它的两个判定极精准：**必须以 `/` 开头**（否则是普通对话），且**还没打空格**（`"/sk"` → 查询词 `"sk"`，会弹面板；`"/skill-creator foo"` → 已有空格，返回 `null`，面板收起——因为命令名已经打完、进入「给命令传参」阶段了）。1.5 会看到 `use-command-input` 用它的返回值（`slashQuery`）决定 `pickerOpen`。

**② `filterCommands`——按查询词过滤并「打分排序」**（[L50-L61](../../src/cli/tui/command-registry.ts#L50-L61) + `scoreCommandMatch` [L191-L199](../../src/cli/tui/command-registry.ts#L191-L199)）：

```ts
export function filterCommands(commands: SlashCommand[], filter: string): SlashCommand[] {
  const normalizedFilter = normalizeCommandName(filter);
  if (!normalizedFilter) return commands;                 // 查询词空 → 返回全部

  return commands
    .filter((command) => {                                // ① 名字或描述包含查询词才留下
      const name = command.name.toLowerCase();
      const description = command.description.toLowerCase();
      return name.includes(normalizedFilter) || description.includes(normalizedFilter);
    })
    .sort((l, r) => scoreCommandMatch(r, normalizedFilter) - scoreCommandMatch(l, normalizedFilter));  // ② 按匹配度降序
}

function scoreCommandMatch(command: SlashCommand, filter: string): number {
  const name = command.name.toLowerCase();
  const description = command.description.toLowerCase();
  if (name.startsWith(filter)) return 3;    // 名字前缀命中 → 最高分
  if (name.includes(filter)) return 2;      // 名字中间命中 → 次高
  if (description.includes(filter)) return 1;  // 只有描述命中 → 最低
  return 0;
}
```

**这是一个「模糊搜索 + 相关性排序」的精简实现**：先 `filter` 掉「名字和描述都不含查询词」的，再用 `scoreCommandMatch` 给剩下的打分排序——**名字前缀匹配（3 分）> 名字包含（2 分）> 仅描述包含（1 分）**。所以敲 `/sk`，`skill-creator`（名字以 `sk` 开头，3 分）会排在一个「描述里偶然含 sk」的命令前面。**这个分级排序，让「用户最可能想要的命令」浮到面板顶部**——是补全体验好不好的关键细节。

**③ `resolveBuiltinCommand`——判断「这是不是一条要本地执行的内建命令」**（[L83-L97](../../src/cli/tui/command-registry.ts#L83-L97)）：

```ts
export function resolveBuiltinCommand(text: string): BuiltinInvocation | null {
  const trimmed = text.trim();
  if (!trimmed) return null;

  const match = trimmed.match(/^\/?([^\s]+)(?:\s+([\s\S]*))?$/);   // ① /?命令名 (可选)参数
  if (!match) return null;
  const token = match[1];
  if (!token) return null;

  const normalized = normalizeCommandName(token);                  // ② 去掉前导 /、小写
  const builtin = BUILTIN_COMMANDS.find((c) => c.name === normalized);
  if (!builtin) return null;                                       // ③ 不在 4 条内建里 → null

  return { name: builtin.name, args: (match[2] ?? "").trim() };    // ④ 返回 {命令名, 参数}
}
```

**这就是第 19 节 1.5 `onSubmit` 开头调的那个函数**。它的正则 `^\/?([^\s]+)(?:\s+([\s\S]*))?$` 把输入拆成「命令名 + 可选参数」两部分。**注意 `\/?` 里的 `?`——前导斜杠是可选的**，所以 `resolveBuiltinCommand("/clear")` 和 `resolveBuiltinCommand("clear")` 等价（[command-registry.test.ts](../../src/cli/tui/__tests__/command-registry.test.ts) 专门测了这条）。只有匹配到 4 条内建命令之一才返回非 `null`——**这是「内建命令」与「普通对话 / 技能命令」的分水岭**：返回非 null，第 19 节 `onSubmit` 就走「本地处理（退出 / 清屏 / 帮助）」；返回 null，就走「真正跑 Agent」。参数（`args`）用于 `/help clear` 这种「查某条命令详情」。

**④ `buildPromptSubmission`——把输入打包成交给 Agent 的 `PromptSubmission`**（[L139-L163](../../src/cli/tui/command-registry.ts#L139-L163)）：

```ts
export function buildPromptSubmission(text: string, commands: SlashCommand[]): PromptSubmission {
  const match = text.match(/^\/([^\s]+)(?:\s|$)/);            // 开头是 /命令名（后跟空格或结束）
  if (!match) return { text, requestedSkillName: null };     // 不是命令形态 → 纯文本
  const commandToken = match[1];
  if (!commandToken) return { text, requestedSkillName: null };

  const requestedSkill = commands.find(                       // ★ 在命令表里找「同名的技能」
    (c) => c.type === "skill" && c.name.toLowerCase() === normalizeCommandName(commandToken),
  );

  return { text, requestedSkillName: requestedSkill?.name ?? null };
}
```

**这是「用户按回车那一刻」被调用的打包函数**（1.5 会看到 `use-command-input` 在 `key.return` 时调它）。它做一件事：**看用户敲的 `/xxx` 是不是一个技能命令**——是就把 `requestedSkillName` 设成技能名（连同原始 `text` 一起交给 Agent），Agent 那边（第 19 节 `onSubmit` → `agent.setRequestedSkillName`）就会去激活那个技能（[第 9 节](./09-skills.md)）。**注意它保留了完整 `text`**（不剥离 `/skill-creator`）——因为技能命令后面往往还跟着真正的指令（如 `/skill-creator 帮我写个 X`），那句指令要原样传给模型。

最后是 **`formatHelp`——生成 `/help` 的 Markdown 文本**（[L104-L137](../../src/cli/tui/command-registry.ts#L104-L137)）：

```ts
export function formatHelp(commands: SlashCommand[], target?: string): string {
  if (target) {                                              // /help <name>：查单条详情
    const match = commands.find((c) => c.name.toLowerCase() === normalizeCommandName(target));
    if (!match) return `Unknown command: \`/${target}\`. Run \`/help\` to see available commands.`;
    const kind = match.type === "builtin" ? "Built-in command" : "Skill";
    return `**/${match.name}** — _${kind}_\n\n${match.description}`;
  }
  // /help（无参）：按 内建 / 技能 两组，列出全部
  const builtins = commands.filter((c) => c.type === "builtin");
  const skills = commands.filter((c) => c.type === "skill");
  const lines: string[] = ["**Available slash commands**", ""];
  if (builtins.length > 0) { lines.push("_Built-in_"); for (const c of builtins) lines.push(`- \`/${c.name}\` — ${c.description}`); }
  if (skills.length > 0) { /* 同理列出技能 */ }
  lines.push("", "Run `/help <name>` for details on a single command.");
  return lines.join("\n");
}
```

**它返回的是一段 Markdown 字符串**——回到第 19 节 1.5：`onSubmit` 处理 `help` 命令时，把 `formatHelp(...)` 的结果包成一条 `AssistantMessage` 直接 `setMessages` 上屏。**而这条消息里的 Markdown（`**加粗**`、`- 列表`、`` `代码` ``），最终会被 1.10 的 `<Markdown>` 组件渲染成带格式的终端文本**——`/help` 的输出「伪装成 Agent 的一次回复」，复用了整套消息渲染管线，无需为帮助文本单开一条渲染路径。**这是「让特殊输出复用通用管线」的巧思**：`/help` 不是特例，它就是一条普通的 assistant 消息。

> 💡 **`command-registry` 全是纯函数 → 全可单测**：和 `input-editor` 一样，这个文件除了类型没有任何 React / 副作用，[command-registry.test.ts](../../src/cli/tui/__tests__/command-registry.test.ts) 因此能直接测 `resolveBuiltinCommand`（各种命令 / 参数 / 无斜杠 / 未知命令）和 `formatHelp`（列全部 / 查单条 / 容错大小写与前导斜杠 / 未知目标报错）。**「命令逻辑」和「命令 UI」被彻底分开——registry 只管『一个字符串意味着什么命令』，怎么弹面板 / 怎么高亮是 Hook 和组件的事。** 这层分离，让「命令解析」这个易错的正则密集区能被穷举测试，而不必去戳界面。

### 1.4 `use-input-history.ts`：↑↓ 历史回溯与磁盘持久化

> **进入第 ② 层「状态 Hook」。** [use-input-history.ts](../../src/cli/tui/hooks/use-input-history.ts)（80 行）负责一件事：**像 shell 那样，用 ↑ / ↓ 翻看「之前敲过的命令」**，并把历史存进 `~/.helixent/history.txt`，跨会话保留。它是 1.5 那个「输入框大脑」的一个子模块。

先看**磁盘读写**（[L8-L26](../../src/cli/tui/hooks/use-input-history.ts#L8-L26)）：

```ts
const HISTORY_FILENAME = "history.txt";
const MAX_HISTORY_LINES = 100;                              // ★ 最多存 100 条

function getHistoryFilePath(): string {
  return path.join(getHelixentHomePath(), HISTORY_FILENAME);   // 复用第 18 节的 ~/.helixent 目录
}

function loadHistoryFromDisk(): string[] {
  const filePath = getHistoryFilePath();
  if (!existsSync(filePath)) return [];                    // 文件不存在 → 空历史
  const content = readFileSync(filePath, "utf8").trim();
  if (!content) return [];
  return content.split("\n");                              // 一行一条
}

function saveHistoryToDisk(lines: string[]): void {
  const trimmed = lines.slice(-MAX_HISTORY_LINES);         // ★ 只保留最后 100 条
  writeFileSync(getHistoryFilePath(), trimmed.join("\n") + "\n", "utf8");
}
```

**注意 `getHelixentHomePath()`——它正是 [第 18 节](./18-cli-config-persistence.md) 讲的那个「解析 `~/.helixent`（可被 `HELIXENT_HOME` 覆盖）」函数**。历史文件和第 18 节的 `config.yaml`、`settings.local.json` 住在同一个目录里。**「一行一条命令、最多留 100 条」是极朴素的格式**——和 bash 的 `.bash_history` 一个思路，纯文本、可手动编辑、易调试。

**Hook 主体**（[L28-L79](../../src/cli/tui/hooks/use-input-history.ts#L28-L79)）：

```ts
export function useInputHistory() {
  const [historyIndex, setHistoryIndex] = useState<number | null>(null);   // 当前翻到第几条（null=没在翻）
  const historyRef = useRef<string[]>(loadHistoryFromDisk());              // 历史数组（初始化时读盘一次）

  const isBrowsing = historyIndex !== null;                                // 「正在翻历史」的标志
```

**两个状态字段各司其职**：

- **`historyRef`（用 ref 不用 state）存历史数组**——因为历史列表本身不需要触发重渲染，用 ref 即可；且 `loadHistoryFromDisk()` 作为 `useRef` 的初始值**只在组件首次挂载时读盘一次**（后续渲染不重复读）。
- **`historyIndex`（用 state）存「当前翻到哪一条」**——`null` 表示「没在翻历史，正在编辑新输入」，非 null 表示「正翻到第 index 条」。它需要触发重渲染（`isBrowsing` 变化会影响 1.5 的按键分派），所以用 state。

**`browseUp` / `browseDown`——↑↓ 的核心**（[L34-L56](../../src/cli/tui/hooks/use-input-history.ts#L34-L56)）：

```ts
const browseUp = useCallback((): string | null => {
  const history = historyRef.current;
  if (history.length === 0) return null;
  // 没在翻 → 从最后一条开始；已在翻 → 再往前一条（钳在 0）
  const nextIndex = historyIndex === null ? history.length - 1 : Math.max(0, historyIndex - 1);
  setHistoryIndex(nextIndex);
  return history[nextIndex] ?? null;
}, [historyIndex]);

const browseDown = useCallback((): string | null => {
  if (historyIndex === null) return null;               // 没在翻，↓ 无意义
  const history = historyRef.current;
  const nextIndex = historyIndex + 1;
  if (nextIndex >= history.length) {                    // ★ 翻过最新一条 → 退出浏览、清空输入
    setHistoryIndex(null);
    return "";
  }
  setHistoryIndex(nextIndex);
  return history[nextIndex] ?? null;
}, [historyIndex]);
```

**这就是 shell 里 ↑↓ 翻命令的经典行为**：`↑`（`browseUp`）从最新一条开始、每按一次往更早翻（钳在第 0 条不再往上）；`↓`（`browseDown`）往更新翻，**一旦翻过「最新一条」就退出浏览模式、返回空串**（`""`，即「回到一个空白的新输入」）——完全对齐 bash 的手感。返回值是「翻到的那条文本」，交给 1.5 填进输入框。

**`saveEntry`——回车提交时存一条**（[L64-L77](../../src/cli/tui/hooks/use-input-history.ts#L64-L77)）：

```ts
const saveEntry = useCallback((text: string) => {
  const trimmed = text.trim();
  if (!trimmed) return;                                            // 空输入不存
  const history = historyRef.current;
  if (history.length > 0 && history[history.length - 1] === trimmed) return;  // ★ 和上一条重复 → 不存
  history.push(trimmed);
  if (history.length > MAX_HISTORY_LINES) {
    historyRef.current = history.slice(-MAX_HISTORY_LINES);        // 超 100 条裁掉最老的
  }
  saveHistoryToDisk(historyRef.current);                          // 落盘
  setHistoryIndex(null);                                          // 提交后退出浏览模式
}, []);
```

**两个体贴的细节**：**空输入不存**（避免历史里塞一堆空行）；**与上一条完全相同则不存**（避免连按两次回车发同样的话，历史里出现两条重复——和 bash 的 `HISTCONTROL=ignoredups` 一个意思）。存完 `setHistoryIndex(null)` 复位浏览状态，下次 `↑` 又从最新开始。

> 💡 **为什么历史值得单独一个 Hook？** 因为「翻历史」是一块**自成一体、有磁盘副作用、有自己状态机（浏览中 / 未浏览）**的逻辑。把它抽成 `useInputHistory`，1.5 的 `use-command-input` 就能像用一个「黑盒」一样 `const { isBrowsing, browseUp, ... } = useInputHistory()`，不必关心「历史怎么存、index 怎么变」。**这是「按职责切分自定义 Hook」的典范**——和第 19 节把「订阅 Manager」切成 `use*Manager` Hook 是同一种模块化思路：**一个 Hook 管一件有内聚状态的事。**

### 1.5 `use-command-input.ts`：把纯函数与键盘事件编排成「输入框大脑」

> **这是输入子系统的「中枢」——第 ② 层最重的一块，也是 1.2/1.3/1.4 所有零件的「总装现场」。** [use-command-input.ts](../../src/cli/tui/hooks/use-command-input.ts)（185 行）做的事，是用 Ink 的 `useInput` 监听每一次按键，**把按键翻译成「该调哪个纯函数（`input-editor` / `command-registry`）、该翻历史还是该补全命令」**，再把结果 setState、最后产出「组件要画的一切」（当前文本、光标、候选命令、是否开面板……）。它就是 1.1 图里那个「把纯函数接进 React」的胶水层。

先看它管理的**一堆状态**（[L46-L61](../../src/cli/tui/hooks/use-command-input.ts#L46-L61)）：

```ts
const [firstMessage, setFirstMessage] = useState(true);                       // 是不是首条消息（决定 placeholder）
const [editorState, setEditorState] = useState<InputEditorState>({ text: "", cursorOffset: 0 });  // ★ 1.2 的编辑状态
const [dismissedQuery, setDismissedQuery] = useState<string | null>(null);    // 被 Esc 关掉的那个查询（防面板重开）
const [selectedIndex, setSelectedIndex] = useState(0);                        // 命令面板里高亮到第几条
const [welcomeMessage] = useState(() => WELCOME_MESSAGES[Math.floor(Math.random() * ...)] ?? ...);  // 随机欢迎语
const { isBrowsing, browseUp, browseDown, exitBrowsing, saveEntry } = useInputHistory();   // ★ 1.4 的历史 Hook

const slashQuery = getSlashQuery(editorState.text);                           // ★ 1.3：现在是不是在打命令
const filteredCommands = useMemo(
  () => (slashQuery === null ? [] : filterCommands(commands, slashQuery)),     // ★ 1.3：过滤+排序候选
  [commands, slashQuery],
);
const pickerOpen = slashQuery !== null && dismissedQuery !== slashQuery;       // 面板开不开
const highlightedCommandName = getHighlightedCommandName(editorState.text, commands);  // 已输入的命令名是否高亮
```

**这几行把前面所有零件「串了起来」**：`editorState` 是 1.2 的状态；`slashQuery`/`filteredCommands`/`highlightedCommandName` 分别调 1.3 的 `getSlashQuery`/`filterCommands`/`getHighlightedCommandName`；`isBrowsing` 等来自 1.4。**`pickerOpen` 是「命令面板是否显示」的最终判定**——`slashQuery !== null`（在打命令）**且** `dismissedQuery !== slashQuery`（这个查询没被用户 Esc 关掉过）。`dismissedQuery` 的存在是个体贴细节：**用户打着 `/cl` 时按了 Esc 想关面板，如果不记住「这个查询被关过」，面板会因为 `slashQuery` 仍非 null 立刻重开**——`dismissedQuery` 就是「记住用户关过它、别再自作主张弹出来」。

两个 `useEffect` 维护 `selectedIndex` 的合法性（[L63-L72](../../src/cli/tui/hooks/use-command-input.ts#L63-L72)）：候选列表变短时把高亮索引钳进范围（`Math.min(currentIndex, len-1)`）；查询词一变就把高亮重置到第 0 条。**这保证「高亮永远指向一个存在的候选」**，不会因为过滤后列表变短而指向越界。

**核心是那个大 `useInput` 回调**（[L92-L174](../../src/cli/tui/hooks/use-command-input.ts#L92-L174)）——它是一长串**「按优先级排列的 if-return」**，每个 if 处理一类按键、`return` 掉。**顺序至关重要**（前面的先匹配），我们按优先级读：

```ts
useInput((input, key) => {
  if (key.ctrl && input === "c") { onAbort?.(); return; }         // ① Ctrl+C：中断

  if (pickerOpen && key.escape) { setDismissedQuery(slashQuery); return; }  // ② 面板开时 Esc：只关面板
  if (key.escape) { onAbort?.(); return; }                        // ③ 否则 Esc：中断 Agent

  // ④ 面板开时，↑↓ 在候选间移动、Enter/Tab 补全
  if (pickerOpen && filteredCommands.length > 0 && key.upArrow)   { setSelectedIndex(...); return; }
  if (pickerOpen && filteredCommands.length > 0 && key.downArrow) { setSelectedIndex(...); return; }
  if (pickerOpen && filteredCommands.length > 0 && (key.return || key.tab)) { acceptSelectedCommand(); return; }

  if (key.return) {                                               // ⑤ 回车：提交
    saveEntry(editorState.text);
    onSubmit?.(buildPromptSubmission(editorState.text, commands));
    setEditorState({ text: "", cursorOffset: 0 });
    setDismissedQuery(null); setSelectedIndex(0); setFirstMessage(false);
    return;
  }

  if (key.leftArrow || (key.meta && input === "b")) {             // ⑥ ← / Alt+B：光标左移（词）
    updateEditorState(key.meta ? moveCursorWordLeft(editorState) : moveCursorLeft(editorState));
    return;
  }
  if (key.rightArrow || (key.meta && input === "f")) { /* → / Alt+F：右移 */ return; }

  if (key.backspace || key.delete) {                              // ⑦ 退格：删字符（并退出历史浏览）
    exitBrowsing();
    updateEditorState(removeCharacterBeforeCursor(editorState));
    return;
  }

  // ⑧ 输入为空 或 正在浏览历史 时，↑↓ 翻历史
  if (!pickerOpen && (editorState.text === "" || isBrowsing) && key.upArrow)   { const e = browseUp();   if (e !== null) setEditorState({ text: e, cursorOffset: e.length }); return; }
  if (!pickerOpen && isBrowsing && key.downArrow)                              { const e = browseDown(); if (e !== null) setEditorState({ text: e, cursorOffset: e.length }); return; }

  if (key.upArrow || key.downArrow || key.tab) return;            // ⑨ 其它情况的 ↑↓Tab：吞掉，不当字符输入

  exitBrowsing();                                                 // ⑩ 兜底：普通字符 → 插入
  updateEditorState(insertTextAtCursor(editorState, input));
}, { isActive: true });
```

**这个「优先级瀑布」是本节输入逻辑的精华，逐层理解它为什么这么排**：

- **① Ctrl+C / ③ Esc 中断优先级最高**——不管在干嘛，用户想停就能停（`onAbort` 接的是第 19 节的 `abort`）。
- **② 的巧妙——「面板开时 Esc 只关面板，不中断」**：同一个 Esc 键，**面板开着时**只是「关掉补全面板」（`setDismissedQuery`），**面板关着时**才升级为「中断 Agent」（③）。这个「同一个键在不同上下文语义不同」的分层，让 Esc 既能关面板又能中断，不冲突。
- **④ 面板开时，↑↓Enter/Tab 被「面板」抢走**：这几个键在面板开着时用于「选命令 / 补全」（`acceptSelectedCommand` 把选中命令补成 `/name ` 填进输入框，见 [L81-L90](../../src/cli/tui/hooks/use-command-input.ts#L81-L90)），**面板关着时它们才回归本职**（Enter 提交、↑↓ 翻历史）。**这就是「同一批键的上下文复用」——面板是不是开着，决定了 ↑↓Enter 是『在候选里选』还是『提交 / 翻历史』。** 这也是为什么 ④ 必须排在 ⑤⑧ 前面。
- **⑤ 回车提交**：这是输入框的「出口」——`saveEntry` 存历史（1.4）、`buildPromptSubmission` 打包（1.3）、`onSubmit` 交给第 19 节的 `AgentLoopProvider`、然后清空输入框。**第 19 节和本节在这里「接头」**：本节负责「收集并打包用户输入」，第 19 节负责「消费这个 `PromptSubmission` 去跑 Agent」。
- **⑥ 光标移动接 1.2 的纯函数**：`key.meta`（Alt/Option）区分「按词移」（`moveCursorWordLeft/Right`）还是「按字符移」（`moveCursorLeft/Right`）。**这里就是 1.2 那些纯函数的调用现场**——按键只负责「选哪个纯函数」，真正的字符串操作在纯函数里。
- **⑧ 翻历史的「触发条件」很讲究**：`!pickerOpen && (text === "" || isBrowsing)` ——**只有「面板没开」且「输入框为空 或 已经在翻历史」时**，↑ 才翻历史。**为什么要 `text === "" || isBrowsing`？** 因为如果输入框里已经打了半句话，用户按 ↑ 大概率是想「移动光标」而非「丢掉当前输入去翻历史」——所以只在「空输入」（刚开始）或「已经在翻历史途中」才允许 ↑↓ 翻历史。这个条件把「翻历史」和「其它 ↑↓ 用途」干净地区分开。
- **⑨ 兜底吞键**：走到这里还没被处理的 ↑↓Tab（比如输入框有内容、不在翻历史时的 ↑），直接 `return` **吞掉**——不能让它们当成普通字符插进文本（否则输入框里会冒出乱码控制字符）。
- **⑩ 最后的兜底：普通字符插入**——所有特殊键都没匹配上，那就是用户在打字，`insertTextAtCursor` 插进去（并 `exitBrowsing` 退出历史浏览，因为「一旦开始打字，就不再是在翻历史了」）。

**Hook 的返回值**（[L176-L184](../../src/cli/tui/hooks/use-command-input.ts#L176-L184)）就是「组件要画的一切」：

```ts
return {
  filteredCommands,          // 面板要显示的候选
  highlightedCommandName,    // 输入行里要高亮的命令名
  pickerOpen,                // 面板开不开
  placeholder: firstMessage ? welcomeMessage : "Input anything to continue. ...",  // 占位符
  selectedIndex,             // 面板高亮到第几条
  text: editorState.text,    // 当前文本
  cursorOffset: editorState.cursorOffset,  // 光标位置
};
```

**注意 `placeholder`**：首条消息时显示随机欢迎语（`WELCOME_MESSAGES` 里的 "To the moon!" 之类），之后变成常规提示。**这个 Hook 把「一个输入框的全部行为」封装成了一个『输入 commands + 回调，输出可渲染状态』的黑盒**——1.6 的组件只要消费这个返回值去画，不必碰任何按键逻辑。**这就是 1.1 图里「② 状态 Hook」层的完整职责：吸收所有键盘复杂度，向上只暴露『画什么』。**

### 1.6 三个输入组件：`InputBox` / `CommandList` / `HighlightedInput`

> **第 ③ 层「组件外壳」——它们几乎没有逻辑，只把 1.5 Hook 的产出画到终端。** 三个组件层层嵌套：[input-box.tsx](../../src/cli/tui/components/input-box.tsx) 是外壳（调 Hook + 组装），里面套 [command-list.tsx](../../src/cli/tui/components/command-list.tsx)（候选面板）和 [highlighted-input.tsx](../../src/cli/tui/components/highlighted-input.tsx)（带光标的输入行）。

**`InputBox`——组装外壳**（[input-box.tsx](../../src/cli/tui/components/input-box.tsx) 全文核心，[L20-L45](../../src/cli/tui/components/input-box.tsx#L20-L45)）：

```tsx
const { filteredCommands, highlightedCommandName, pickerOpen, placeholder, selectedIndex, text, cursorOffset } =
  useCommandInput({ commands, onSubmit, onAbort });        // ★ 全部逻辑都在这个 Hook 里

return (
  <Box flexDirection="column" rowGap={1}>
    {pickerOpen ? <CommandList commands={filteredCommands} selectedIndex={selectedIndex} /> : null}  {/* 面板 */}
    <Box borderLeft={false} borderRight={false} borderStyle="single" borderColor={...} columnGap={1}>
      <Text>❯</Text>                                        {/* 提示符 */}
      <HighlightedInput cursorOffset={cursorOffset} highlightedCommandName={highlightedCommandName}
        placeholder={placeholder} value={text} />           {/* 输入行 */}
    </Box>
  </Box>
);
```

**看这个组件多「薄」**：它调 `useCommandInput` 拿到所有状态（1.5），然后就只做布局——面板在上（`pickerOpen` 为真才渲染）、`❯` 提示符和输入行在下（一个上下无边框、只有上下横线的框）。**没有一行按键逻辑、没有一个 `useState`**——全部沉在 Hook 里。**这正是 1.1 说的「组件只管画」的极致体现**：`InputBox` 是一个纯粹的「装配 + 布局」组件。它接收的 `onSubmit`/`onAbort` 由第 19 节的 `App` 从 `AgentLoopProvider` 传下来（第 19 节 1.8 的 `<InputBox commands={commands} onSubmit={onSubmit} onAbort={abort} />`）。

**`HighlightedInput`——带光标反显与命令名高亮的输入行**（[highlighted-input.tsx](../../src/cli/tui/components/highlighted-input.tsx) 全文，[L16-L46](../../src/cli/tui/components/highlighted-input.tsx#L16-L46)）：

```tsx
if (value.length === 0) {                                  // ① 空输入 → 显示 placeholder（首字符反显当光标）
  return (
    <Text>
      <Text inverse dimColor>{placeholder[0] ?? " "}</Text>
      <Text dimColor>{placeholder.slice(1)}</Text>
    </Text>
  );
}

const highlightLength = highlightedCommandName ? highlightedCommandName.length + 1 : 0;  // /name 的长度

return (
  <Text>
    {value.split("").map((char, index) => {                // ② 逐字符渲染
      const highlighted = index < highlightLength;         //   命令名部分：高亮
      return (
        <Text key={`${char}-${index}`} bold={highlighted}
          color={highlighted ? currentTheme.colors.primary : undefined}
          inverse={index === cursorOffset}>                //   ★ 光标所在字符：反显（inverse）
          {char}
        </Text>
      );
    })}
    {cursorOffset === value.length ? <Text inverse>{" "}</Text> : null}  // ③ 光标在末尾 → 反显一个空格当光标
  </Text>
);
```

**这是「终端里怎么画一个光标」的经典技巧**：终端没有「插入符（caret）」这种原生控件，于是 Helixent 用 **`inverse`（反显，即前景背景色对调）标记光标所在的那个字符**（第 ②）——看起来就像一个「块状光标」压在那个字上。如果光标在文本**末尾**（后面没字符可反显了），就额外渲染一个「反显的空格」当光标（第 ③）。**空输入时**（第 ①）则把 placeholder 的首字符反显、其余变暗——既显示提示语、又保留一个「光标在开头」的视觉。此外，**已输入的合法命令名（`/clear` 这种）会被 `highlightedCommandName` 标记成粗体主题色**（第 ②的 `highlighted`），给用户「你打的这个命令有效」的即时反馈。

**`CommandList`——候选命令面板（带滚动窗口）**（[command-list.tsx](../../src/cli/tui/components/command-list.tsx)，核心 [L22-L59](../../src/cli/tui/components/command-list.tsx#L22-L59) + `getVisibleWindow` [L68-L81](../../src/cli/tui/components/command-list.tsx#L68-L81)）：

```tsx
const MAX_VISIBLE_COMMANDS = 5;                            // ★ 最多同时显示 5 条

const { endIndex, startIndex } = getVisibleWindow(commands.length, selectedIndex, MAX_VISIBLE_COMMANDS);
const visibleCommands = commands.slice(startIndex, endIndex);   // 只渲染窗口内的
// ... 渲染 visibleCommands，selectedIndex 那条加 "❯ " 前缀 + 高亮色

function getVisibleWindow(total, selectedIndex, maxVisible) {
  if (total <= maxVisible) return { startIndex: 0, endIndex: total };   // 不超 5 条全显示
  const halfWindow = Math.floor(maxVisible / 2);
  const maxStartIndex = total - maxVisible;
  const startIndex = Math.max(0, Math.min(selectedIndex - halfWindow, maxStartIndex));  // ★ 让高亮居中的滚动窗口
  return { startIndex, endIndex: startIndex + maxVisible };
}
```

**面板的关键是那个「滚动窗口」`getVisibleWindow`**：技能可能有几十个，命令面板不能一次全铺出来（会撑爆屏幕），所以**最多只显示 5 条**，并让**当前高亮项尽量居中**（`selectedIndex - halfWindow`），同时用 `Math.max(0, Math.min(..., maxStartIndex))` 钳位保证窗口不越界（顶部不小于 0、底部不超过 `total - maxVisible`）。**这就是「长列表只渲染一个可视窗口」的滑动窗口算法**——用户按 ↓ 时高亮下移、窗口跟着滚，始终能看到高亮项及其上下文。每条命令显示 `/名字 [类型] 描述`（描述超 72 字符会 `summarizeDescription` 截断加 `...`）。**这个面板组件也几乎无状态**——`selectedIndex` 由 1.5 的 Hook 传入，它只负责「根据 selectedIndex 算出该显示哪 5 条、把高亮那条画得亮一点」。

**至此输入子系统讲完**：用户按键 → `use-command-input` 的 `useInput` 瀑布分派 → 调 `input-editor` / `command-registry` 纯函数或 `use-input-history` → setState → `InputBox` / `CommandList` / `HighlightedInput` 把新状态画出来 → 回车时 `buildPromptSubmission` 打包、`onSubmit` 交给第 19 节。**「纯函数内核 → 状态 Hook → 组件外壳」这条三层漏斗，把「用户按键」稳稳变成了「Agent 收到的一条 `PromptSubmission`」。** 下面转向另一个子系统：消息怎么显示出来。

### 1.7 为什么「同一套工具调用」要写两个渲染器？

> **这是本节 roadmap 点名的核心疑问，也是渲染子系统的「总纲」。** 在拆任何一个渲染文件之前，必须先回答那个第一次读会觉得「这不是重复代码吗」的问题：**[message-history.tsx](../../src/cli/tui/components/message-history.tsx)（Ink 组件）和 [message-text.ts](../../src/cli/tui/message-text.ts)（ANSI 纯文本）几乎渲染同一批内容——一条 assistant 文本、各种工具调用的摘要——为什么要写两遍？**

答案要回到 [第 19 节](./19-tui-architecture.md) 1.8 的 `useFlushToScrollback`。回忆那个「活动区 vs scrollback」的分工：

- **Ink 只渲染「最后一条消息 + 弹窗 / 输入框 + 页脚」这一小块「活动区」**——这块会随状态频繁重绘（微光在转、输入框在打字）。活动区里那「最后一条消息」，用的是 **`<MessageHistoryItem>`（Ink 组件）**。
- **一旦一条消息「定稿」（后面又来了新消息），就用 `stdout.write` 把它打印进终端 scrollback、从 Ink 毕业**。打印用的，是 **`messageToPlainText(msg)`（返回一段纯 ANSI 字符串）**。

**看清楚了吗？两个渲染器面向的是两种完全不同的「输出机制」**：

| 维度 | `message-history.tsx`（Ink 组件版） | `message-text.ts`（ANSI 纯文本版） |
| --- | --- | --- |
| **服务对象** | Ink 的**活动区**（最后一条消息） | 终端 **scrollback**（已定稿的历史） |
| **产物** | React 组件树（`<Box>`/`<Text>`） | 一段带 `\x1b[…m` 转义码的**字符串** |
| **是否参与 React** | **是**——会被 diff、随状态重绘 | **否**——`write` 一次就脱离 React |
| **是否会再变** | 会（它是「正在进行」的那条，可能还在流式） | **永不再变**（定稿了才 flush） |
| **上色方式** | Ink 的 `<Text color=…>` 属性 | 手写 ANSI 码（`\x1b[37m` 等） |
| **Markdown** | 用 `<Markdown>` 组件（`marked-terminal`） | **不渲染 Markdown**，纯文本直出 |

**所以这不是「重复」，而是「同一份内容，翻译成两种目标语言」**——一份翻成「React 组件」（给 Ink 的渲染循环），一份翻成「ANSI 字符串」（给裸终端的 `write`）。**它们看起来像，是因为要显示的信息一样（都是「⏺ 某工具 + 参数摘要」）；它们不能复用，是因为输出机制的形态根本不同**：组件不能被 `stdout.write`，字符串也不能参与 React diff。

**「为什么不让活动区那条也用纯文本、或让历史也用组件，从而统一成一个？」**——两条路都不通：

- **全用组件（历史也交给 Ink）**：就退回第 19 节 Q4 批判的「全量渲染」——Ink 管辖区域随对话线性增长，越用越卡。scrollback 的意义正是「把定稿历史踢出 Ink」，而踢出去就只能是「死字符串」，不能是组件。
- **全用纯文本（活动区那条也 `write`）**：活动区那条**还在变**（流式输出、微光跟随），需要 React 的「状态一变就重绘」能力；纯文本 `write` 是「一次性输出、无法就地更新」，没法表达「正在进行」的动态。

**结论**：**两个渲染器对应第 19 节那个「活动区（在变、要 diff）vs scrollback（不变、已定稿）」分工的两端——一端天生要组件，一端天生要字符串，无法也不该合并。** 这就是「同一套工具调用写两个渲染器」的全部理由。理解了这个总纲，1.8 和 1.9 就是看这两端各自怎么实现。

> 💡 **一个「视觉一致性」的隐性契约**：既然是两个渲染器，就得保证它们**画出来长得一样**——否则一条消息「在活动区」和「滚进历史后」会突然变个样子，很突兀。所以你会看到 1.8 和 1.9 里，两个渲染器对每种工具的摘要格式（`⏺ 描述` + `└─ 细节`）是**刻意对齐**的。**这是「两份实现、一种外观」需要付出的维护成本**——改一处摘要格式，得记得同步改另一处。这也是「刻意不复用」的代价，Helixent 用「视觉对齐」的自觉来承担它。

### 1.8 `message-history.tsx`：活动区的 Ink 组件渲染器

> **这是渲染子系统的「组件版」——服务于活动区那「最后一条消息」。** [message-history.tsx](../../src/cli/tui/components/message-history.tsx)（229 行）把一条 `NonSystemMessage`（[第 2 节](./02-message.md) 的消息类型）渲染成一棵 Ink 组件树。它导出 `MessageHistory`（渲染整个数组）和 `MessageHistoryItem`（渲染单条）——第 19 节的 `App` 用的是后者（只渲染最后一条）。

先看**顶层分派**（[L36-L55](../../src/cli/tui/components/message-history.tsx#L36-L55)）：

```tsx
export const MessageHistoryItem = memo(function MessageHistoryItem({ message, messageIndex, todoSnapshots }) {
  switch (message.role) {
    case "user":      return <UserMessageItem message={message} />;
    case "assistant": return <AssistantMessageItem message={message} todoSnapshots={todoSnapshots} messageIndex={messageIndex} />;
    case "tool":      return null;                       // ★ 工具「结果」消息不单独渲染
    default:          return null;
  }
});
```

**注意两点**：

- **它按 `message.role`（[第 2 节](./02-message.md) 的可辨识联合）分派**——`user` / `assistant` 各有专门的子组件，`tool`（工具**结果**消息）**返回 `null` 不渲染**。**为什么工具结果不显示？** 因为界面只展示「Agent 决定调什么工具」（在 assistant 消息的 `tool_use` 里），而工具**返回的原始结果**（可能是几百行文件内容）不往屏幕上糊——这呼应第 19 节「MessageHistory 是工具调用的唯一真相源」以及第 8 节「结果只回喂给模型、不一定给人看」的取舍。
- **`memo` 包裹**：`MessageHistoryItem` 和下面所有子组件都用 `React.memo` 包住——**props 没变就跳过重渲染**。在活动区微光每 120ms 跳一次的场景下，`memo` 能让「消息内容没变的那条」不跟着微光一起重渲染，省一大笔开销。

**assistant 消息的渲染**（[L70-L110](../../src/cli/tui/components/message-history.tsx#L70-L110)）遍历它的 `content` 分段：

```tsx
{message.content.map((content, i) => {
  switch (content.type) {
    case "text":
      if (content.text) {
        return (
          <Box key={i} columnGap={1}>
            <Text color={currentTheme.colors.highlightedText}>⏺</Text>   {/* 亮色圆点 */}
            <Box flexDirection="column"><Markdown>{content.text}</Markdown></Box>  {/* ★ 文本走 Markdown */}
          </Box>
        );
      }
      return null;
    case "tool_use":
      return (
        <Box key={i} columnGap={1}>
          <Text color={currentTheme.colors.dimText}>⏺</Text>            {/* 暗色圆点 */}
          <Box flexDirection="column">
            <ToolUseContentItem content={content} todos={todoSnapshots.get(snapshotKey(messageIndex, i))} />
          </Box>
        </Box>
      );
  }
})}
```

**这里体现了「文本」和「工具调用」的视觉区分**：assistant 的**文本**用**亮色 `⏺`** 打头、且内容走 `<Markdown>`（1.10 讲）渲染成带格式的富文本；**工具调用**用**暗色 `⏺`** 打头、交给 `<ToolUseContentItem>` 渲染成「一句摘要」。**亮 / 暗两种圆点，一眼区分「模型在说话」还是「模型在调工具」。**

**`ToolUseContentItem` 是本文件的主体**（[L112-L213](../../src/cli/tui/components/message-history.tsx#L112-L213)）——它按 `content.name`（工具名）为**每一种工具**定制一行摘要。抓几个代表：

```tsx
switch (content.name) {
  case "bash":
    return (<Box flexDirection="column">
      <Text>{content.input.description as string}</Text>              {/* 第一行：description */}
      <Text color={currentTheme.colors.dimText}>└─ {content.input.command as string}</Text>  {/* 第二行：命令 */}
    </Box>);
  case "str_replace": case "read_file": case "write_file":
  case "list_files": case "file_info": case "mkdir":                 // ★ 一批「带 path」的工具共用一个分支
    return (<Box flexDirection="column">
      <Text>{content.input.description as string}</Text>
      <Text color={...dimText}>└─ {content.input.path as string}</Text>
    </Box>);
  case "todo_write": {                                               // ★ todo_write 特殊：展示待办进度
    const currentTodo = getCurrentTodo(todos); const nextTodo = getNextTodo(todos);
    const summaryTodo = currentTodo ?? nextTodo;
    const completedCount = todos?.filter((t) => t.status === "completed").length ?? 0;
    // ... 显示 "Working on: XXX" + "└─ N completed, M pending"
  }
  default:
    return (<Box flexDirection="column"><Text>Tool call</Text><Text color={...dimText}>└─ {content.name}</Text></Box>);
}
```

**这个大 `switch` 的设计要点**：

- **每种工具一行「人类友好」的摘要**，格式统一为 **`description`（第一行）+ `└─ 关键参数`（第二行，暗色）**。比如 `bash` 显示描述 + 具体命令，`read_file` 显示描述 + 文件路径，`grep_search` 显示描述 + `路径 :: 模式`。**这就是 1.2～1.6 那个 `⏺ 描述 / └─ 细节` 视觉的来源**——它把「模型调了个工具、传了一堆 JSON 参数」翻译成「一句人看得懂的话」。**注意这正是 [第 12 节](./12-tool-foundation-file-io.md) 强调的『description 作为第一参数的强约定』在 UI 层的兑现**：每个工具都强制要 `description`，就是为了在这里能显示一句自然语言摘要，而不是甩给用户一坨 JSON。
- **`todo_write` 是唯一「有状态」的特殊分支**：它不只显示「调了 todo_write」，而是**展示当前待办进度**（"Working on: X" + "N completed, M pending"）。这靠 `todoSnapshots`——从 `messageIndex` 那条消息「重放」出的待办快照（来自 [todo-view.ts](../../src/cli/tui/todo-view.ts)，[第 10 节](./10-todos.md) Todos 的展示端）。**这是「让工具调用的展示带上语义」的一例**：todo 不该只显示「写了个待办」，而该显示「待办清单现在什么样」。
- **`default` 兜底**：遇到未知工具，显示 `Tool call / └─ 工具名`——**永远有一个能显示的降级，不会因为「没为某工具写分支」而崩或空白**。

> 💡 **`memo` + 稳定 key 的性能考量**：本文件所有组件都 `memo`，且 `MessageHistory` 用 `getMessageKey`（[L216-L228](../../src/cli/tui/components/message-history.tsx#L216-L228)）给每条消息算一个「内容相关的 key」（user 消息用文本、assistant 用各 `tool_use` 的 id 拼接）。**稳定的 key 让 React 在列表更新时能精确复用没变的项**——虽然活动区只渲染最后一条，但 `MessageHistory`（渲染全列表的那个）在别处或测试中若被用到，这个 key 策略能避免「插一条消息导致整列表重渲染」。**这是 React 列表渲染的标准优化，本节顺手做足。**

### 1.9 `message-text.ts`：scrollback 的 ANSI 纯文本渲染器

> **这是渲染子系统的「纯文本版」——服务于「定稿消息 flush 进终端 scrollback」。** [message-text.ts](../../src/cli/tui/message-text.ts)（78 行）把一条 `NonSystemMessage` 转成**一段裸的 ANSI 字符串**，供第 19 节 `useFlushToScrollback` 里 `write(text + "\n")` 直接打印。它是 1.8 那个组件渲染器的「纯字符串镜像」。

先看它**手写的 ANSI 上色工具**（[L3-L12](../../src/cli/tui/message-text.ts#L3-L12)）：

```ts
const ESC = "\x1b[";
const RESET = `${ESC}0m`;
const BOLD = `${ESC}1m`;
const DIM = `${ESC}2m`;
const WHITE = `${ESC}37m`;
const GRAY = `${ESC}90m`;

const white = (s: string) => `${WHITE}${s}${RESET}`;      // 白色
const bold = (s: string) => `${BOLD}${s}${RESET}`;        // 粗体
const dim = (s: string) => `${DIM}${GRAY}${s}${RESET}`;   // 暗灰
```

**这就是 1.7 表格里「上色方式：手写 ANSI 码」的实体**。因为这份输出**不经过 Ink**（不能用 `<Text color=…>`），所以颜色只能靠**手写终端 ANSI 转义序列**：`\x1b[37m` 开白色、`\x1b[0m` 复位……每个 `white`/`bold`/`dim` 函数把文本用「开色码 + 内容 + 复位码」包起来。**这是「脱离框架、直接和终端对话」的原始形态**——第 19 节 `clearTerminal` 里那个 `\u001B[2J` 清屏码是同一个家族的东西。

**主函数 `messageToPlainText`**（[L14-L25](../../src/cli/tui/message-text.ts#L14-L25)）：

```ts
export function messageToPlainText(message: NonSystemMessage): string | null {
  switch (message.role) {
    case "user":      return userMessageText(message);
    case "assistant": return assistantMessageText(message);
    case "tool":      return null;                        // ★ 和 1.8 一致：工具结果不渲染
    default:          return null;
  }
}
```

**它的分派和 1.8 的 `MessageHistoryItem` 一一对应**——`user`/`assistant` 各有处理、`tool` 返回 `null`（第 19 节 `useFlushToScrollback` 里 `if (text)` 会跳过 null，不 flush 空行）。**这个「结构对齐」不是偶然——正是 1.7 说的『两份实现、一种外观』的契约**：两个渲染器必须对「哪些渲染、怎么分派」保持一致。

**工具调用的纯文本摘要**（[L49-L76](../../src/cli/tui/message-text.ts#L49-L76)）几乎是 1.8 `ToolUseContentItem` 的字符串翻版：

```ts
function toolUseText(content: ToolUseContent): string {
  switch (content.name) {
    case "bash":
      return `${dim("⏺")} ${content.input.description as string}\n  ${dim(`└─ ${content.input.command as string}`)}`;
    case "str_replace": case "read_file": case "write_file":
      return `${dim("⏺")} ${content.input.description as string}\n  ${dim(`└─ ${content.input.path as string}`)}`;
    case "todo_write":
      return `${dim("⏺")} Working on todos`;
    // ... 其它工具同理
    default:
      return `${dim("⏺")} Tool call\n  ${dim(`└─ ${content.name}`)}`;
  }
}
```

**对比 1.8 你会看到明显的「镜像关系」**：同样的 `⏺` 圆点、同样的 `description` + `└─ 细节` 两行格式、同样的 `default` 兜底——只是 1.8 用 `<Box>`/`<Text color>` 表达，这里用 `\n` 换行 + `dim()` ANSI 上色表达。**同一种视觉，两种载体**。

**但也有「刻意的简化」**：`todo_write` 在组件版（1.8）会显示详细进度（"Working on: X, N completed"），在纯文本版这里**只显示 "Working on todos"**。**为什么？** 因为纯文本版渲染的是**已定稿的历史消息**——它是「滚上去、供回看」的静态存档，不需要（也无法）实时反映「当前」待办进度（那份 `todoSnapshots` 是活动区才有的动态状态）。**这是「定稿版可以比活动版更简」的合理取舍**：历史只需「留个痕迹」，不需活动区那样的实时细节。

> 💡 **两个渲染器的「详略差异」恰恰印证了 1.7 的分工**：活动区（组件版）是「正在发生、需要丰富实时信息」的，所以 `todo_write` 显示完整进度、文本走 Markdown 富渲染；scrollback（纯文本版）是「已经过去、留档回看」的，所以 `todo_write` 只留一句、文本也不必再 Markdown（1.9 的 assistant 文本直接 `white(text)` 原样输出）。**不是纯文本版「偷懒」，而是它服务的场景本就不需要那么多动态细节。** 这再次说明：两个渲染器的差异，全都源于「服务的输出机制不同」这个根本区别。

### 1.10 `markdown.tsx` / `token-usage.ts` / `themes`：三个配套小件

> **收尾三个「小而关键」的配套模块。** 它们各自很短，但补全了渲染子系统的最后拼图：Markdown 富渲染、token 用量统计、颜色主题。

**`markdown.tsx`——把 Markdown 渲染成终端富文本**（[markdown.tsx](../../src/cli/tui/components/markdown.tsx) 全文，13 行）：

```tsx
import { marked } from "marked";
import TerminalRenderer from "marked-terminal";

marked.setOptions({ renderer: new TerminalRenderer() as never });   // ① 全局装一个「终端渲染器」

export const Markdown = memo(function Markdown({ children }: { children: string }) {
  const rendered = useMemo(() => marked(children).trimEnd(), [children]);  // ② 把 md 文本转成带 ANSI 的富文本
  return <Text>{rendered}</Text>;                                          // ③ 塞进一个 <Text>
});
```

**这就是 1.8 assistant 文本用的 `<Markdown>`**。它借两个库四两拨千斤：`marked`（解析 Markdown）+ `marked-terminal`（把解析结果渲染成**带 ANSI 颜色 / 样式的终端文本**，比如把 `**粗体**` 变成真的粗体、`` `代码` `` 变成带背景色的片段、`# 标题` 变成醒目大字）。**这里的巧思有两个**：① `marked` 的输出已经是「带 ANSI 码的字符串」，所以直接塞进一个 Ink `<Text>` 就行（Ink 能透传 ANSI）——**不需要 Helixent 自己实现 Markdown 渲染**；② `useMemo` 缓存渲染结果（依赖 `children`），避免每次重渲染都重新跑一遍 Markdown 解析（解析不便宜，而活动区重渲染很频繁）。**这是「站在成熟库肩上、只做最薄集成」的典范**——第 19 节的 `<Markdown>`、本节 `/help` 的 Markdown，全靠这 13 行。

**`token-usage.ts`——累加 token 用量**（[token-usage.ts](../../src/cli/tui/token-usage.ts) 全文，[L8-L22](../../src/cli/tui/token-usage.ts#L8-L22)）：

```ts
export function calculateTokenUsage(messages: NonSystemMessage[]): TokenUsageSummary {
  return messages.reduce<TokenUsageSummary>(
    (summary, message) => {
      if (!isAssistantMessage(message) || !message.usage) return summary;   // ① 只看带 usage 的 assistant 消息
      return {
        latestInputTokens: message.usage.promptTokens,                      // ② 最新一条的输入 token（覆盖）
        sessionTotalTokens: summary.sessionTotalTokens + message.usage.totalTokens,  // ③ 全会话累加
      };
    },
    { latestInputTokens: 0, sessionTotalTokens: 0 },
  );
}
```

**这就是第 19 节 1.5 那个「`useMemo` 从 messages 派生 `tokenUsage`」调的函数**。它 `reduce` 遍历所有消息，只挑「带 `usage` 的 assistant 消息」（`usage` 来自 [第 3 节](./03-model.md) 模型返回、[第 16～17 节](./16-openai-provider.md) Provider 填充），算两个数：**`latestInputTokens`（最近一次的输入 token，每遇到一条就覆盖 → 最终是最后一条的值）** 和 **`sessionTotalTokens`（整个会话累加）**。这两个数最终显示在第 19 节的 `<Footer>`（"last input 1.2k · session 5.6k"）。**注意它是纯函数**——所以 [token-usage.test.ts](../../src/cli/tui/__tests__/token-usage.test.ts) 能直接测（无 usage 返回 0、取最新输入 + 累加总量、忽略无 usage 的 assistant 消息）。**这又是一个「逻辑沉成纯函数、便于单测」的例子**，和 1.2/1.3 一脉相承。

**`themes/index.ts`——颜色主题**（[themes/index.ts](../../src/cli/tui/themes/index.ts) 全文，11 行）：

```ts
export const darkTheme = {
  colors: {
    primary: "blue",
    secondaryBackground: "#3a3a3a",
    highlightedText: "white",
    dimText: "gray",
    borderColor: "gray",
  },
};

export const currentTheme = darkTheme;
```

**这是全 TUI 颜色的「单一来源」**。你在本节和第 19 节看到的所有 `currentTheme.colors.primary`（命令高亮的蓝）、`.dimText`（工具摘要的灰）、`.highlightedText`（assistant 圆点的白）、`.borderColor`（输入框边框的灰），都来自这里。**它的设计很朴素——一个对象、一个 `currentTheme` 指向它**，目前只有 `darkTheme` 一种。**但这个「集中定义颜色 + 一个 `currentTheme` 别名」的结构，为『将来支持多主题 / 亮色模式』留了扩展点**：只要多定义几个 theme、把 `currentTheme` 改成「根据配置选一个」，全 TUI 就能换肤，无需改任何组件（组件都只认 `currentTheme.colors.X`）。**这是「用一层间接换取未来可扩展」的最小成本投资**——即便现在只有一个主题，这层间接也让「加主题」这件事从「改几十处颜色」降为「改一处 `currentTheme`」。

**至此渲染子系统讲完**：同一份 `message`，活动区那条走 `message-history.tsx`（Ink 组件、`<Markdown>` 富渲染、`todo` 实时进度），定稿的历史走 `message-text.ts`（手写 ANSI 字符串、简化摘要）；两者视觉对齐、分派对齐，只因服务的输出机制不同而各自实现。配套的 `markdown` / `token-usage` / `themes` 分别补上「富文本 / 用量 / 配色」。**这就是第 19 节那个「活动区 vs scrollback」分工的『渲染侧』全貌。**

***

## 2. 亮点与关键设计

回顾全节，把散落的「妙笔」和「关键决策」拎出来，明确标注哪些是**关键决策**（架构层面、影响深远）、哪些是**妙笔**（局部精巧、值得抄作业）：

1. **【关键决策】两个「刻意不复用」的渲染器，对应「活动区 vs scrollback」两端**：`message-history.tsx`（Ink 组件版）服务「正在变、要 diff」的活动区，`message-text.ts`（ANSI 纯文本版）服务「已定稿、永不变」的终端 scrollback。**它们不能合并——组件不能被 `stdout.write`、字符串不能参与 React diff**。这是本节最反直觉、也最能体现「让实现形态匹配输出机制」的设计（1.7）。它是第 19 节 `useFlushToScrollback` 分工的必然结果。

2. **【关键决策】输入子系统的「纯函数内核 → 状态 Hook → 组件外壳」三层漏斗**：逻辑往下沉成**无 React 的纯函数**（`input-editor` 光标操作、`command-registry` 命令解析），React 只在中层做胶水（`use-command-input` 把按键翻译成「调哪个纯函数」），组件只管画。**这让最易错的核心逻辑（正则、光标边界）能被穷举单测，而组件保持极薄。** 是「关注点分离」在 TUI 层的彻底贯彻（1.1、1.2、1.3）。

3. **【关键决策】斜杠命令统一「内建 + 技能」两种来源**：`SlashCommand.type` 区分 `builtin`/`skill`，`loadAvailableCommands` 把 4 条硬编码内建命令和[第 9 节](./09-skills.md) 动态发现的技能命令合并成一份候选池。**这把「技能系统」无缝接进了「斜杠命令」——用户敲 `/skill-creator` 就是请求激活那个技能**，`buildPromptSubmission` 负责把它打包成 `requestedSkillName`（1.3）。

4. **【妙笔】`use-command-input` 的「优先级瀑布」按键分派**：一长串 `if-return` 按优先级排列，让**同一批键在不同上下文语义不同**——Esc 在面板开时关面板、面板关时中断 Agent；↑↓Enter 在面板开时选命令、面板关时翻历史 / 提交。**顺序即逻辑**，前面的先匹配（1.5）。

5. **【妙笔】`inverse` 反显模拟终端光标**：终端没有原生插入符，`HighlightedInput` 用「反显光标所在字符」模拟块状光标，光标在末尾时补一个「反显的空格」。同时用 `highlightedCommandName` 把合法命令名标成粗体主题色，给「你打的命令有效」的即时反馈（1.6）。

6. **【妙笔】`dismissedQuery` 记住「被 Esc 关掉的查询」**：用户打着 `/cl` 按 Esc 关面板后，若不记住「这个查询关过」，面板会因 `slashQuery` 仍非 null 立刻重开。`dismissedQuery` 这个小状态精准解决了「关了又弹」的恼人问题（1.5）。

7. **【妙笔】`CommandList` 的滑动窗口 `getVisibleWindow`**：技能可能几十个，面板最多显示 5 条并让高亮居中、钳位防越界——「长列表只渲染可视窗口」的经典算法，避免命令面板撑爆屏幕（1.6）。

8. **【妙笔】历史回溯对齐 shell 手感**：`useInputHistory` 的 ↑ 从最新往早翻、↓ 翻过最新则清空、空输入 / 已浏览中才触发、连续重复不入库——处处对齐 bash 的 `.bash_history` 行为，用户零学习成本（1.4、1.5）。

9. **【妙笔】`/help` 复用消息渲染管线**：`formatHelp` 返回 Markdown 字符串，被包成一条 assistant 消息 `setMessages` 上屏，经 `<Markdown>` 渲染——**帮助文本不是特例，就是一条普通对话消息**，无需单开渲染路径（1.3）。

10. **【妙笔】`<Markdown>` 站在 `marked` + `marked-terminal` 肩上**：13 行代码借成熟库把 Markdown 渲染成带 ANSI 的终端富文本，`useMemo` 缓存避免重复解析。**不重复造轮子，只做最薄集成**（1.10）。

11. **【妙笔】`description` 作为工具第一参数在 UI 层兑现**：两个渲染器都用 `content.input.description` 作为工具摘要首行——[第 12 节](./12-tool-foundation-file-io.md) 强制每个工具带 `description`，正是为了这里能显示「一句人话」而非一坨 JSON（1.8、1.9）。

***

## 3. 工业对比

把 Helixent 本节的做法，与业界主流 CLI / TUI / 编辑器方案对照，看它的取舍落在哪。

### 3.1 终端行编辑：手写纯函数 `input-editor` vs readline / ink-text-input

「在终端里编辑一行文本」看似简单，实则是个有历史的问题。

| 方案 | 谁提供 | 能力 | 可控性 |
| --- | --- | --- | --- |
| **Helixent 手写 `input-editor`** | 自己（51 行纯函数） | 光标增删移、按词跳 | **完全可控**，可单测，可深度定制 |
| **Node `readline`** | Node 标准库 | 完整行编辑 + 历史 | 命令式、和 Ink 的声明式渲染不搭 |
| **`ink-text-input`（社区组件）** | Ink 生态 | 基础输入框 | 够用但难深度定制（斜杠补全、命令高亮） |
| **`readline`-vendored（如 Claude Code）** | 移植改造 | 完整 | 重，但功能全 |

**Helixent 选「手写纯函数」的理由，是它的输入框有『非标准需求』**：斜杠命令补全面板、命令名高亮、`@技能` 请求、历史与补全共享 ↑↓——这些都不是通用输入框组件能开箱满足的。**与其用一个通用组件再和它「对抗」（覆盖它的按键、hack 它的渲染），不如自己用 51 行纯函数把「光标操作」这块攥在手里**，再在 `use-command-input` 里自由编排。**代价**是要自己处理边界（钳位、按词跳），但这些逻辑简单且**被单测覆盖**（[input-editor.test.ts](../../src/cli/tui/__tests__/input-editor.test.ts)）。**关键洞察**：当你的交互需求「比通用组件复杂、但比通用组件的全部功能又用不上」时，「手写一个恰好够用的纯函数内核」往往比「驯服一个大而全的组件」更省心——**这与第 14 节「手写 apply_patch 而非引第三方 diff 库」是同一种判断**：需求足够特殊时，自己写一个小而精确的，胜过背一个大而通用的。

### 3.2 命令补全：Helixent 的「注册表 + 打分过滤」 vs shell 补全 vs fzf

「敲几个字，补全出命令」是 CLI 的标配体验。

- **Helixent 的做法——「静态注册表 + `filterCommands` 打分排序」**：所有命令（内建 + 技能）先 `loadAvailableCommands` 汇成一份 `SlashCommand[]`，用户敲字时 `filterCommands` 用「名字前缀 3 分 / 名字包含 2 分 / 描述包含 1 分」打分排序。**简单、同步、够用**。
- **shell 补全（bash/zsh completion）**：靠 shell 的 completion 脚本，能力强（可补文件、补参数）但**配置复杂、跨 shell 不一致**。
- **fzf 式模糊匹配**：用 fuzzy 算法（子序列匹配 + 复杂评分），能「敲 `scr` 匹配 `skill-creator`」。**更智能，但要引入一个模糊匹配库**。

**Helixent 的取舍是「够用即止」**：它的命令数量有限（几条内建 + 几十个技能），用「包含 + 三级打分」这种 O(n) 的简单过滤完全够用，没必要上 fzf 那套子序列模糊匹配。**这与它整体的克制一脉相承**——不为「命令可能多到需要模糊搜索」这种小概率场景，预付一个模糊匹配库的复杂度。**如果哪天技能数量爆炸到几百个，把 `scoreCommandMatch` 换成一个 fuzzy 库即可，`filterCommands` 的接口不用变**——这层「过滤逻辑集中在一个纯函数里」的设计，给未来升级留了余地。

### 3.3 消息渲染：Helixent 的「双渲染器」 vs 纯组件 vs 纯 print

「聊天式 CLI 怎么显示历史消息」有几种典型架构。

- **Helixent——「Ink 组件（活动区）+ ANSI 纯文本（scrollback）」双渲染器**：只有「正在进行」的那条用组件（能刷新），定稿的历史 print 进终端原生滚动缓冲。**兼顾「动态刷新」与「长对话不卡」，代价是维护两个视觉对齐的渲染器**（1.7）。
- **纯组件（全量 Ink 渲染）**：所有消息都是组件，全交给 Ink。**最简单、只一套渲染逻辑，但对话长了会卡**（第 19 节 Q4 已论证）。
- **纯 print（每条消息直接 `console.log`，不用 Ink）**：像传统 CLI 那样一条条打印。**极简、极快、天然利用 scrollback，但无法做「流式刷新最后一条 / 弹窗交互」这些动态 UI**。

**Helixent 的「双渲染器」本质是前两者的融合**：**用「纯 print」的思路处理历史（借终端 scrollback），用「Ink 组件」的能力处理当下（流式刷新 + 交互）**。这正是「取两者之长」——历史部分享受 print 的高效与原生滚动，当下部分享受组件的动态。**代价**是「同一内容两套渲染 + 保持视觉一致」的维护负担（1.7 的隐性契约）。**关键洞察**：很多「聊天式 TUI」其实都面临这个「历史要高效、当下要动态」的张力，而 Helixent 给出的答案——「按『会不会再变』把内容一分为二，变的给框架、不变的给平台」——是一个值得借鉴的通用模式。**它和第 19 节 Q4 的『活动区 vs scrollback』是同一枚硬币的两面**：那里从「状态编排」角度讲为什么这么分，这里从「渲染实现」角度讲这么分导致了两个渲染器。

### 3.4 主题系统：Helixent 的「一个 `currentTheme` 常量」 vs Context 主题 vs CSS 变量

「怎么管理全局配色」在任何 UI 里都是个问题。

- **Helixent——「一个导出的 `currentTheme` 常量」**：所有组件 `import { currentTheme }` 直接读 `currentTheme.colors.X`。**极简，零运行时开销，但『换主题』需要改这个模块（目前只有一个 darkTheme）**。
- **React Context 主题（如 styled-components 的 `ThemeProvider`）**：主题放 Context，组件 `useContext` 读，能**运行时动态切换**。**灵活，但每个组件多一次 `useContext`、切换时全树重渲染**。
- **CSS 变量（网页）**：`var(--primary)`，切换主题只改 `:root` 的变量值。**终端没有 CSS，不适用**。

**Helixent 目前选最轻的「常量」，是因为它还不需要运行时换肤**——只有一个暗色主题。但它留了一手：**所有组件都通过 `currentTheme.colors.X` 这层间接读颜色，从不硬编码 `"blue"`**。**这意味着「升级到运行时主题」的成本极低**：把 `currentTheme` 从常量改成「一个 Context 或一个根据配置选择的值」，组件一行不用动。**这是 YAGNI（You Aren't Gonna Need It）原则的漂亮实践**——现在不做运行时切换（因为不需要），但用「一层 `currentTheme` 间接」保证「将来需要时能低成本加上」。**与第 18 节「用 Commander 而非 oclif」、3.2「不上 fzf」是同一种判断哲学：为当下的真实需求选最轻的方案，同时用一层薄薄的间接为未来的可能性留门。**

***

## 4. 深度解释：为什么这样设计？不这样会怎样？

用五个「Q&A」把本节最容易产生疑问、也最见设计功力的点讲透。

### Q1：`input-editor` 和 `command-registry` 为什么要做成「没有 React 的纯函数」？塞进 `use-command-input` 的 `useInput` 回调里不是更省一层吗？

**因为「纯函数内核」换来的『可单测 + 可推理 + 可复用』，远超「少一层文件」省下的那点便利。把逻辑埋进 `useInput` 回调，等于把它焊死在一个难测、难读、难复用的位置。**

设想「反面做法」——把光标操作和命令解析全写进 `use-command-input` 的 `useInput` 回调里：

```ts
// 反面示范：逻辑内联在回调里
useInput((input, key) => {
  if (key.leftArrow) {
    setEditorState((s) => ({ ...s, cursorOffset: Math.max(0, s.cursorOffset - 1) }));  // 光标逻辑内联
  }
  if (key.meta && input === "b") {
    setEditorState((s) => {
      let pos = s.cursorOffset;
      while (pos > 0 && s.text[pos-1] === " ") pos--;   // 按词跳逻辑内联
      while (pos > 0 && s.text[pos-1] !== " ") pos--;
      return { ...s, cursorOffset: pos };
    });
  }
  // ... 几十个 if，每个都内联一坨逻辑
});
```

**这样会带来三个具体的痛**：

1. **没法单测**：`moveCursorWordLeft` 的逻辑现在藏在一个 `useInput` 回调的一个 `if` 分支里的一个 `setEditorState` 更新函数里——**要测它，你得渲染整个 `InputBox` 组件、模拟一次 Alt+B 按键、再断言渲染结果**。这是「集成测试」的成本，去测一个本该「单元测试」的纯逻辑。而现在 [input-editor.test.ts](../../src/cli/tui/__tests__/input-editor.test.ts) 只需 `expect(moveCursorWordLeft({text:"foo   bar", cursorOffset:9})).toEqual({..., cursorOffset:6})` 一行。
2. **没法复用**：`useInput` 回调里，`moveCursorLeft`（单字符左移）和 `moveCursorWordLeft`（按词左移）的逻辑无法互相调用、无法被别处引用。抽成纯函数后，它们是一等公民，谁都能调。
3. **难推理**：一个塞了几十个「内联逻辑」的 `useInput` 回调，会长到几百行、每个分支都混着「按键判断 + 状态计算 + setState」三件事。抽出纯函数后，回调只剩「按键判断 + 调哪个纯函数」——**回调变成一张清爽的『路由表』**（1.5 那个优先级瀑布），一眼看清「哪个键干什么」。

**「不这样会怎样」的本质**：UI 代码最容易腐化的地方，就是「把业务逻辑和渲染 / 事件处理搅在一起」——一旦搅在一起，逻辑就被「渲染」这个难测、易变的东西污染了。**Helixent 用「纯函数内核」这道防线，把『算什么』从『何时算 / 怎么画』里剥离出来**——`input-editor`/`command-registry` 只回答「给定输入，结果是什么」，`use-command-input` 只回答「什么按键该调哪个纯函数」，组件只回答「这个状态怎么画」。**三层各司其职，每层都简单到能一眼看懂、能被恰当地测试。** 这不是「多此一举的一层」，而是「让 UP 代码可维护」的关键结构——它和第 8 节把结果处理拆成 `normalize`/`policy`/`summary` 纯函数、第 14 节把 diff 解析做成纯函数，是贯穿全书的同一种工程纪律。

### Q2：为什么活动区「只渲染最后一条消息」用组件、历史用纯文本，而不干脆「全部渲染成纯文本一路 print」？那样连 Ink 都不用了，岂不更简单？

**因为「最后一条消息」是活的——它可能正在流式变化、要跟着 `streaming` 微光刷新、要能被上方的弹窗覆盖。这些『动态』只有 React/Ink 能表达；纯 print 是『一次性泼出去、无法收回重画』的，做不了动态 UI。**

先说「全部 print」为什么诱人：它确实极简——每来一条消息就 `console.log` 一下，利用终端天然的 scrollback，不用 Ink、不用 React、不用管什么活动区。**传统 CLI 工具大多这么干**。

但 Helixent 的 TUI 有三个「print 做不到」的动态需求：

1. **最后一条消息可能『正在长大』**：虽然第 19 节说「界面不搞逐字打字机」，但一个回合里 Agent 可能先吐一条文本、紧接着追加工具调用——**活动区那条消息的内容会在 50ms 节流刷新里多次更新**。print 是「打了就固定在那」，无法「就地把刚才那行改掉重画」；而 Ink 组件「状态一变就重绘那一小块」，天生能表达「这条消息又变了」。
2. **微光 / 待办面板要叠在消息下方、实时跳动**：`<StreamingIndicator>` 每 120ms 跳一帧、`<TodoPanel>` 随待办变化——**这些和「最后一条消息」同属一个需要频繁重绘的『活动区』**。print 出去的文本无法「在它下面挂一个会跳动的微光、还能随时更新」。
3. **弹窗要能『覆盖』输入区**：审批 / 提问弹窗（第 19 节）出现时，要替换掉输入框。这种「同一块区域，此刻显示 A、下一刻显示 B」的**互斥切换**，是 React 条件渲染的拿手好戏；print 做不到「收回刚打的输入框、换成弹窗」。

**所以「最后一条 + 交互区」必须交给能『就地重绘』的 Ink**；而已经定稿、永不再变的历史，才交给「一次性 print」。**这就是第 19 节 `useFlushToScrollback` 分工的根本原因，也是本节两个渲染器存在的根本原因**（1.7）。

**「那为什么不反过来，全部用 Ink 组件（连历史也是）？」**——第 19 节 Q4 已论证：Ink 管辖区域随对话线性增长，微光每跳一次就要 diff + 重绘整个历史，**越用越卡**。**两个极端（全 print / 全组件）各有致命伤——全 print 做不了动态，全组件长对话会卡**。Helixent 的「双渲染器」正是为了同时避开这两个坑：**动态的一小块给组件（不会卡，因为就一条），静态的一大片给 print（不占 Ink，享受原生 scrollback）**。代价是维护两个视觉对齐的渲染器——但这个代价，换来的是「既动态又不卡」，值。

### Q3：`use-command-input` 那个「优先级瀑布」里，为什么面板开着时 ↑↓Enter 要被面板抢走？直接让它们永远「翻历史 / 提交」不行吗？

**不行——因为『面板开着』时，用户的意图明确是『在候选命令里选』，而非『翻历史 / 提交』。同一批键的语义必须随上下文切换，否则补全面板就成了摆设。**

设想「不抢」会怎样——↑↓ 永远翻历史、Enter 永远提交：

1. 用户敲 `/`，命令面板弹出，列出 `clear`/`exit`/`help`/`skill-creator`...
2. 用户想选第三个，按 ↓ ↓——**但 ↓ 被「翻历史」抢走了**，输入框里 `/` 变成了上一条历史命令，面板里的高亮纹丝不动。用户懵了：「我明明想在面板里往下选，怎么输入框内容变了？」
3. 就算用户用别的方式移到了想要的命令，按 Enter 想「选中它」——**但 Enter 被「提交」抢走了**，直接把 `/skill` 这个残缺输入提交给了 Agent。补全根本没发生。

**这就是「不抢」的荒谬后果：补全面板存在，却没有任何键能操作它。** 面板必须「借用」↑↓（在候选间移动）和 Enter/Tab（确认选中）——而这几个键，恰好也是「翻历史 / 提交」要用的。**冲突不可避免，解法就是『按上下文分配』**：`pickerOpen` 为真时，这几个键归面板；为假时，归历史 / 提交。

**这正是 1.5 那个「优先级瀑布」的价值——它用『if 的先后顺序』编码了『上下文优先级』**：面板相关的 `if`（都带 `pickerOpen &&`）排在历史 / 提交的 `if` 前面，所以「面板开着」时先被面板的分支捕获、`return` 掉，根本走不到后面的历史 / 提交分支。**顺序即优先级，前面的先赢。** 如果把顺序打乱（比如把 `if (key.return) 提交` 放到面板分支前面），面板的 Enter 补全就会被提交抢走——**瀑布的每一行顺序都是精心排的，不能随便调**。

**「同一批键、多种语义、靠上下文分配」是所有复杂键盘界面（编辑器、游戏、TUI）的通用课题**，Helixent 的答案——「用带上下文条件的 if 瀑布，顺序编码优先级」——简单直接、易读易改。**它没有引入什么「键盘模式状态机」的重型抽象，就用一串有序 if 解决了**，这是对「问题规模」的准确判断（键盘状态没复杂到需要状态机）。

### Q4：两个渲染器要「视觉对齐」，这不是明摆着的重复代码、违反 DRY 吗？就不怕改一个忘了改另一个？

**这是一个『DRY 不总是对的』的经典案例。两个渲染器看似重复，但它们因『不同原因、可能朝不同方向变化』，强行合并反而会制造更坏的耦合。这里的『重复』是可控的、甚至是健康的。**

先承认问题的真实性：`message-history.tsx` 和 `message-text.ts` 确实对每种工具都写了一遍摘要格式，改 `bash` 的显示格式得改两处——**这是真实的维护成本，不否认**。

但「合并成一个」会更糟，因为两个渲染器**会因不同原因朝不同方向演化**：

- **组件版（活动区）的变化方向**：加更丰富的实时交互——比如未来给 `todo_write` 加个进度条、给 `bash` 加个「实时输出预览」、给文本加语法高亮。**这些都依赖 React 的动态能力、依赖活动区特有的 `todoSnapshots` 等状态。**
- **纯文本版（scrollback）的变化方向**：保持精简、保证 `write` 出去的字符串在各种终端里都能正确显示——比如处理某些终端不支持的 ANSI 码、控制行宽避免折行错乱。**这些是「静态文本存档」特有的关切，和 React 无关。**

**看出来了吗？两者「现在长得像」，但「未来会因完全不同的关切朝不同方向长」**——组件版往「更动态更丰富」走，纯文本版往「更精简更兼容」走（1.9 已看到 `todo_write` 在两版里详略不同，就是这种分化的开端）。**如果强行合并成「一个渲染器 + 两个输出适配器」，就会造出一个『既要伺候 React 的动态、又要伺候纯文本的精简』的四不像抽象**——每次给组件版加动态特性，都得在共享逻辑里加一堆 `if (isTextMode)` 的分支，最终比「两份清爽的独立实现」更难维护。

**这就是 DRY 原则的边界——DRY 说的是『不要重复知识』，而不是『不要重复代码』**。这里两个渲染器共享的「知识」其实只有一条：**「每种工具的摘要该显示哪些字段」**（`bash` 显示 command、`read_file` 显示 path……）。**这条知识确实重复了，但它稳定、简单、且『视觉对齐』这个约束本身就在提醒你同步**。而两个渲染器**不共享**的是「怎么把这些字段变成输出」（组件 vs 字符串）——这部分本就该不同。**Rob Pike 的名言「A little copying is better than a little dependency（一点复制好过一点依赖）」正适用于此**：与其为了消除这点表面重复而制造一个别扭的共享抽象（一个坏依赖），不如接受这点可控的复制。**Helixent 用『视觉对齐』这个人工约束来管理复制**（1.7 的隐性契约）——这是一个清醒的工程取舍，不是偷懒。

> **补充：怎么防「改一个忘另一个」？** 实践中有几种缓解：其一，两个文件都在 `tui/` 下、命名相近（`message-history` / `message-text`），改动时容易联想到；其二，可以加一个「两个渲染器对同一条消息的输出、去掉 ANSI 后文本一致」的快照测试来兜底（本项目目前靠 review 保证）。**关键是：这点重复是『显式、局部、易发现』的，而非『合并后隐藏在抽象里的隐式耦合』——前者可控，后者才危险。**

### Q5：读完这一节，整个 Helixent 的「用户按一个键 → 屏幕上出现回应」全链路是怎么走通的？请把第 2/5/15/18/19/20 节串成一条线。

**这个问题是整套教程的『收官验收』——如果你能把这条链路完整讲出来，就说明你真正吃透了 Helixent 的分层架构。答案是一条贯穿七个部分的『输入 → 处理 → 输出』闭环。**

让我们跟着「用户敲下 `帮我读一下 README` 并回车」这一个动作，走完全链路（括号标注是哪一节的知识）：

**上行（用户输入 → Agent）**：

1. **用户按键** → [第 20 节·本节] `use-command-input` 的 `useInput` 瀑布逐键分派：普通字符调 `insertTextAtCursor`（`input-editor` 纯函数）插进 `editorState`，`HighlightedInput` 用 `inverse` 画出光标。
2. **用户按回车** → [第 20 节] `saveEntry` 存历史（`use-input-history` → `~/.helixent/history.txt`）、`buildPromptSubmission` 打包成 `{text, requestedSkillName}`（`command-registry`）、调 `onSubmit`。
3. **`onSubmit` 接棒** → [第 19 节] `AgentLoopProvider.onSubmit`：`resolveBuiltinCommand` 发现不是内建命令 → `setStreaming(true)` → 把用户消息立刻 `setMessages` 上屏 → `agent.stream(userMessage)`。

**处理（Agent 循环）**：

4. **`agent.stream()` 跑起来** → [第 5 节] ReAct 主循环 `_think`：把消息交给模型（[第 3 节] `Model` → [第 16/17 节] Provider 翻译成 wire 格式、调厂商 API、流式拼回 `AssistantMessage`）。
5. **模型决定调 `read_file`** → [第 5/6 节] `_act` 执行工具（[第 12 节] `read_file` 读文件），结果经 [第 8 节] 归一化后作为 tool 消息喂回模型。**若读的是危险操作**，[第 15 节] 审批中间件 `beforeToolUse` 短路 → `globalApprovalManager.askUser()` 阻塞。
6. **每产生一条消息，`yield` 一个 `message` 事件** → [第 5 节] `AgentEvent`。

**下行（Agent → 屏幕）**：

7. **`onSubmit` 的 `for await` 收到 message 事件** → [第 19 节] `enqueueMessage` 进 50ms 节流篮子 → 批量 `setMessages`。
8. **`messages` 变了，React 重渲染** → [第 19 节] `App`：活动区那条走 [第 20 节·本节] `<MessageHistoryItem>`（Ink 组件、`<Markdown>` 富渲染 `read_file` 的摘要 `⏺ 读取 README / └─ README.md`），定稿的历史 flush 进 scrollback（[第 20 节] `messageToPlainText` ANSI 字符串）。
9. **若第 5 步触发了审批** → [第 19 节] `useApprovalManager` 订阅到请求 → `App` 互斥地渲染 `<ApprovalPrompt>`（覆盖输入框）→ 用户按 `y` → `respond` → resolve Promise → Agent 继续。
10. **回合结束** → [第 19 节] `finally` 里 `flushPendingMessages` + `setStreaming(false)`，微光熄灭，输入框回归，等待下一次按键。

**这条链路，正是 [第 1 节](./01-overview.md) 那张『四层架构 + 单向依赖』图的动态演绎**：

- **数据形态**：全程是 [第 2 节] 那份 `Message`（`foundation` 层）——从「用户输入打包成 UserMessage」到「模型产出 AssistantMessage」到「渲染器读它的 `role`/`content`」，**一份数据结构贯穿始终**（第 1 节点出的「单一数据源」）。
- **依赖方向**：`cli`（18/19/20 节）依赖 `coding`（11-15 节）依赖 `agent`（5-10 节）依赖 `foundation`（2-4 节），**严格单向**——本节的渲染器 `import` 了 `foundation` 的 `Message` 类型，但 `foundation` 绝不会反过来知道有个 TUI 在渲染它。
- **可替换性**：[第 19 节 Q5] 说过「换 Web 界面，引擎零改动」——本节的输入 / 渲染子系统，正是那个「可替换的皮」的另一半。换成 Web，`input-editor` 的纯函数、`command-registry` 的解析、`token-usage` 的累加**都能照搬**（它们无 React、无终端依赖）；要重写的只是「怎么收按键、怎么画」的那层组件。

**所以本节是全链路的『第一棒（收按键）』和『最后一棒（画出来）』**——它和第 19 节合起来，构成了「用户 ↔ Agent」之间那道完整的人机界面。**读到这里，从『用户按下一个键』到『屏幕上浮现 Agent 的回应』，中间经过的每一层、每一个数据结构、每一次转换，你都能说出它在哪一节讲过、为什么那样设计。这，就是这套教程想带你抵达的终点。**

***

## 5. 参考资料

**本节精讲的源码（建议对照阅读）**：

- **输入子系统 · 纯函数内核**：
  - [input-editor.ts](../../src/cli/tui/input-editor.ts)（51 行）——`insertTextAtCursor`/`removeCharacterBeforeCursor`/`moveCursorLeft-Right`/`moveCursorWordLeft-Right`，全是 `(state)=>newState` 纯函数
  - [command-registry.ts](../../src/cli/tui/command-registry.ts)（199 行）——`BUILTIN_COMMANDS`、`loadAvailableCommands`、`getSlashQuery`/`filterCommands`/`resolveBuiltinCommand`/`buildPromptSubmission`/`formatHelp`
- **输入子系统 · 状态 Hook**：
  - [use-input-history.ts](../../src/cli/tui/hooks/use-input-history.ts)（80 行）——`browseUp`/`browseDown`/`saveEntry`，读写 `~/.helixent/history.txt`
  - [use-command-input.ts](../../src/cli/tui/hooks/use-command-input.ts)（185 行）——`useInput` 优先级瀑布 [L92-L174](../../src/cli/tui/hooks/use-command-input.ts#L92-L174)、`pickerOpen`/`dismissedQuery` 逻辑、返回可渲染状态
- **输入子系统 · 组件**：
  - [input-box.tsx](../../src/cli/tui/components/input-box.tsx)（47 行）、[command-list.tsx](../../src/cli/tui/components/command-list.tsx)（81 行，`getVisibleWindow` 滑动窗口）、[highlighted-input.tsx](../../src/cli/tui/components/highlighted-input.tsx)（47 行，`inverse` 光标 + 命令名高亮）
- **渲染子系统 · 两个渲染器**：
  - [message-history.tsx](../../src/cli/tui/components/message-history.tsx)（229 行，Ink 组件版）——`MessageHistoryItem` 分派、`ToolUseContentItem` 每工具摘要、`memo` + `getMessageKey`
  - [message-text.ts](../../src/cli/tui/message-text.ts)（78 行，ANSI 纯文本版）——手写 ANSI `white`/`bold`/`dim`、`messageToPlainText`、`toolUseText`
- **渲染子系统 · 配套**：
  - [markdown.tsx](../../src/cli/tui/components/markdown.tsx)（13 行，`marked`+`marked-terminal`）、[token-usage.ts](../../src/cli/tui/token-usage.ts)（26 行，`calculateTokenUsage`）、[themes/index.ts](../../src/cli/tui/themes/index.ts)（11 行，`darkTheme`/`currentTheme`）

**co-located 测试（[第 21 节](./00-roadmap.md) 会讲这套约定）**：

- [input-editor.test.ts](../../src/cli/tui/__tests__/input-editor.test.ts)——光标增删移 / 按词跳的边界（钳位、跳空格、到边界停）
- [command-registry.test.ts](../../src/cli/tui/__tests__/command-registry.test.ts)——`resolveBuiltinCommand`（命令 / 参数 / 无斜杠 / 未知）、`formatHelp`（列全部 / 查单条 / 容错）
- [token-usage.test.ts](../../src/cli/tui/__tests__/token-usage.test.ts)——无 usage 返回 0、取最新输入 + 累加、忽略无 usage 的 assistant 消息
- **注意这三个测试文件对应的都是「纯函数」**——正是 1.2/1.3/1.10 强调的「逻辑沉成纯函数 → 可单测」的直接受益

**上游依赖章节**：

- [第 19 节 · TUI 架构与状态编排](./19-tui-architecture.md)：本节是它的「另一半」——它讲「状态编排 + 交互回路」，本节讲「输入 + 渲染」；本节的 `<InputBox>`/`<MessageHistoryItem>`/`messageToPlainText` 都是它「摆位即止」、点名留给本节的
- [第 18 节 · CLI 入口与持久化](./18-cli-config-persistence.md)：本节 `loadAvailableCommands`（命令池来源）、`getHelixentHomePath`（历史文件位置）都建立在它之上
- [第 9 节 · Skills](./09-skills.md)：本节的技能斜杠命令（`/skill-creator`）来自它的 `listSkills`；`requestedSkillName` 触发它的「按需激活」
- [第 12 节 · 工具地基与文件读写](./12-tool-foundation-file-io.md)：本节两个渲染器都靠工具的 `description` 字段做摘要——正是它强调的「description 作为第一参数的强约定」
- [第 10 节 · Todos](./10-todos.md)：本节 `message-history` 里 `todo_write` 的进度展示，用它的待办数据（经 `todo-view` 重放）
- [第 2 节 · Message](./02-message.md)：本节两个渲染器分派的 `message.role`/`content.type`，就是它定义的可辨识联合

**外部资料**：

- Ink（`useInput` 键盘、`<Text inverse>` 反显、`useStdout`）：<https://github.com/vadimdemedes/ink>
- `marked`（Markdown 解析器）：<https://marked.js.org/>
- `marked-terminal`（把 Markdown 渲染成终端 ANSI 富文本）：<https://github.com/mikaelbr/marked-terminal>
- 终端 ANSI 转义码（颜色 `\x1b[37m`、反显 `\x1b[7m`、复位 `\x1b[0m`）：<https://en.wikipedia.org/wiki/ANSI_escape_code>
- 终端 scrollback（回滚缓冲区）概念：<https://en.wikipedia.org/wiki/Scrollback>
- Rob Pike「A little copying is better than a little dependency」（Go 谚语，呼应 Q4）：<https://go-proverbs.github.io/>
- DRY 原则的边界与 WET 反思：<https://en.wikipedia.org/wiki/Don%27t_repeat_yourself>

***

## 6. 小结与全书回望

本节我们拆开了 [第 19 节](./19-tui-architecture.md) 「摆位即止」留下的最后半边 `tui/`——**「用户输入」与「消息渲染」两个子系统**，核心是**两个子系统各自的三层结构，以及「一份内容两个渲染器」的取舍**：

- **输入子系统**（1.2–1.6）：**「纯函数内核 → 状态 Hook → 组件外壳」三层漏斗**。`input-editor`（光标增删移）+ `command-registry`（命令解析 / 过滤 / 补全 / `/help`）是**无 React 的纯函数内核**（可单测）；`use-input-history`（↑↓ 历史）+ `use-command-input`（`useInput` 优先级瀑布）是**把纯函数接进 React 的状态 Hook**；`InputBox`/`CommandList`/`HighlightedInput` 是**只管画的组件外壳**（`inverse` 模拟光标、滑动窗口面板）。用户按键，就这样一路被翻译成一条 `PromptSubmission` 交给第 19 节。
- **渲染子系统**（1.7–1.10）：**两个「刻意不复用」的渲染器**。`message-history.tsx`（Ink 组件版）服务「活动区那条会变的消息」，`message-text.ts`（ANSI 纯文本版）服务「flush 进 scrollback 的定稿历史」——**它们视觉对齐、分派对齐，却因『服务的输出机制不同（React diff vs 裸终端 write）』而无法合并**（Q4 论证了这不违反 DRY）。配套的 `<Markdown>`（借 `marked-terminal`）、`token-usage`（用量累加）、`themes`（配色单一来源）补齐富文本、统计与主题。

**一条主线**：**本节是第 19 节那个「活动区 vs scrollback」分工的『另一半兑现』**——第 19 节从「状态编排」角度讲了为什么把界面分成「会变的活动区」和「不变的历史」，本节从「输入采集 + 渲染实现」角度讲了这个分法落到代码上是什么样子：输入子系统把「用户按键」喂进第 19 节的状态循环，渲染子系统则是那个循环「画出来」的两支笔（一支给活动区、一支给 scrollback）。**至此，从『用户按下一个键』到『Agent 的回应浮现在屏幕上』的完整人机界面，全部走通。**

**承上启下（全书回望）**：还记得 [第 1 节](./01-overview.md) 那张四层架构图吗？我们从最底层的 [第 2 节·Message](./02-message.md) 出发，一层层往上垒——[第 3 节·Model](./03-model.md) 产出消息、[第 4 节·Tool](./04-tool.md) 定义工具、[第 5-10 节] 把它们串成会思考会行动的 Agent 大脑、[第 11-15 节] 特化成会写代码的 Coding Agent、[第 16-17 节] 接上真实模型厂商、[第 18-20 节] 交到用户手里成为一个能对话能审批的终端程序。**Q5 那条『用户按键 → Agent → 屏幕』的全链路，正是这整座架构的动态演绎**——一份 `Message` 贯穿始终，严格单向的依赖让每一层都可独立理解、可替换。**读到这里，你不仅看懂了 Helixent 的每一行关键代码，更理解了『一个现代 Coding Agent 由哪些零件组成、为什么这样组装』。**

**最后一步，是跳出「读代码」，站在「作品」视角审视它**：这个项目如何用**测试**保证每一层的质量约束？那些贯穿全书、被反复提及的 **co-located 测试**（`__tests__/*`）是怎么组织的？它如何被 `bun build --compile` 打包成**一个单文件二进制**分发出去？pre-commit hook + CI 的 `bun run check` 双保险，又是如何守住[第 1 节·code-convention](./01-overview.md) 立下的那些规矩的？**为什么整个项目选 Bun 而不是 Node / Deno？** 这些「工程手艺」的问题，是 [第 21 节](./00-roadmap.md) 的主题——**它是全书的终点，也是回到起点的闭环：读完它，建议回到 [第 1 节](./01-overview.md) 重读那张全景图，你会有全新的理解。**

👉 下一节 **第 21 节：测试、代码规范、构建与发布**（全书收尾）。

准备好后，对我说「**生成第 21 节**」即可。

